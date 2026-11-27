/**
 * Restore engine tests — run with `npm test`
 * (node --experimental-strip-types, no test framework needed).
 *
 * Covers the SQL splitter (the part that must not break on
 * semicolons inside strings, dollar-quoted bodies and COPY data),
 * the dump summarizer, and the restore engine — once against a
 * fake client (including COPY, which pg-mem cannot parse) and once
 * end-to-end against pg-mem, a real in-memory Postgres.
 */
import { newDb } from 'pg-mem';
import { splitSqlStatements, summarizeRestore, executeRestore, describeStatement } from '../src/lib/restore.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log('PASS', name);
  } else {
    fail++;
    console.log('FAIL', name, detail);
  }
}

// --- splitter ---
check('basic two statements', splitSqlStatements('CREATE TABLE a (id int); INSERT INTO a VALUES (1);').length === 2);
check('semicolon in quoted string', splitSqlStatements(`INSERT INTO t VALUES ('it''s; fine');`).length === 1);
check('dollar-quoted function body', splitSqlStatements(`CREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE NOTICE 'x;y'; END; $$ LANGUAGE plpgsql;`).length === 1);
check('tagged dollar quote', splitSqlStatements(`CREATE FUNCTION f() RETURNS void AS $func$ BEGIN RAISE NOTICE 'a;b'; END; $func$ LANGUAGE plpgsql;`).length === 1);
check('line comment with semicolon', splitSqlStatements(`-- comment with ;\nSELECT 1;`).length === 1);
check('comment-only file is empty', splitSqlStatements(`-- just a comment\n/* and a block ; */\n`).length === 0);
check('block comment with semicolon', splitSqlStatements(`/* ; */ SELECT 1;`).length === 1);
check('nested block comment', splitSqlStatements(`/* outer /* inner ; */ outer */ SELECT 1;`).length === 1);
check('double-quoted identifier with semicolon', splitSqlStatements(`CREATE TABLE "we;ird" (id int);`).length === 1);
check('no trailing semicolon', splitSqlStatements(`SELECT 1`).length === 1);
check('empty input', splitSqlStatements('').length === 0);
check('E string backslash escape', splitSqlStatements(`SELECT E'a\\'b; c';`).length === 1);
check('standard string backslash is literal', splitSqlStatements(`SELECT 'a\\'; SELECT 2;`).length === 2);

const copyDump = `COPY public."CallLog" (id, name) FROM stdin;\n1\tAlice\n2\tBob; has ;\n3\tCarol\n\\.\nCREATE INDEX ix ON public."CallLog" (id);\n`;
const copyStmts = splitSqlStatements(copyDump);
check('COPY block is one statement + index', copyStmts.length === 2, copyStmts.length);
check('COPY block keeps data lines', copyStmts[0].includes('2\tBob; has ;') && copyStmts[0].trimEnd().endsWith('\\.'));
check('statement after COPY is intact', copyStmts[1].startsWith('CREATE INDEX'));

// --- summarizer on a realistic pg_dump fragment ---
const dump = `
-- PostgreSQL database dump
SET statement_timeout = 0;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE TABLE public."CallLog" (
    "CallLogID" bigint NOT NULL,
    "ClientName" text
);
CREATE SEQUENCE public."CallLog_CallLogID_seq" AS integer START WITH 1;
ALTER TABLE public."CallLog" OWNER TO postgres;
COPY public."CallLog" ("CallLogID", "ClientName") FROM stdin;
1\tAlice; with semicolon
2\tBob
\\.
INSERT INTO public."CallLog" ("CallLogID", "ClientName") VALUES (3, 'Carol; again');
CREATE INDEX "IX_CallLog_Name" ON public."CallLog" USING btree ("ClientName");
CREATE VIEW public."vwCallLogs" AS SELECT * FROM public."CallLog";
GRANT SELECT ON TABLE public."CallLog" TO app_user;
`;
const stmts = splitSqlStatements(dump);
const sum = summarizeRestore(stmts);
check('summary total', sum.total === 10, sum.total);
check('summary tables', sum.tables.length === 1 && sum.tables[0] === 'public.CallLog', sum.tables);
check('summary sequences', sum.sequences.length === 1 && sum.sequences[0] === 'public.CallLog_CallLogID_seq', sum.sequences);
check('summary views', sum.views.length === 1 && sum.views[0] === 'public.vwCallLogs', sum.views);
check('summary copy rows', sum.copyTables.length === 1 && sum.copyTables[0].rows === 2, sum.copyTables);
check('summary inserts', sum.insertStatements === 1, sum.insertStatements);
check('summary warnings cover extension+owner+grant', sum.warnings.length === 3, sum.warnings);
check('summary empty dump warns', summarizeRestore([]).warnings.length === 1);
check('describe COPY', describeStatement(copyStmts[0]) === 'COPY public.CallLog', describeStatement(copyStmts[0]));

// --- engine against a fake client (covers COPY, which pg-mem cannot parse) ---
const ran: string[] = [];
const fake = {
  async query(sql: string) {
    ran.push(sql);
    if (sql.includes('FAIL_ME')) throw new Error('relation "nope" does not exist');
    if (/^COPY/i.test(sql)) return { rowCount: 2 };
    if (/^INSERT/i.test(sql)) return { rowCount: 1 };
    return { rowCount: 0 };
  },
};
const labels: string[] = [];
const r1 = await executeRestore(
  fake,
  ['CREATE TABLE t (id int);', 'INSERT INTO t VALUES (1);', 'COPY t FROM stdin;\n1\n\\.\n'],
  { stopOnError: false, onProgress: (p) => labels.push(p.label) },
);
check('engine all succeed', r1.succeeded === 3 && r1.failed === 0 && r1.rowsRestored === 3, r1);
check('engine progress labels', labels.length === 3 && labels[2] === 'COPY t', labels);

ran.length = 0;
const r2 = await executeRestore(fake, ['CREATE TABLE t (id int);', 'SELECT FAIL_ME;', 'INSERT INTO t VALUES (1);'], { stopOnError: false });
check('engine continues after failure', r2.succeeded === 2 && r2.failed === 1 && ran.length === 3, r2);
check('engine error preview', r2.errors[0].statement.includes('FAIL_ME') && r2.errors[0].message.includes('does not exist'), r2.errors);

ran.length = 0;
const r3 = await executeRestore(fake, ['CREATE TABLE t (id int);', 'SELECT FAIL_ME;', 'INSERT INTO t VALUES (1);'], { stopOnError: true });
check('engine stops on error', r3.succeeded === 1 && r3.failed === 1 && ran.length === 2, r3);

// --- engine end-to-end against pg-mem (INSERT-based data: pg-mem
// cannot parse COPY ... FROM stdin, so COPY is covered by the fake
// client above and by the splitter tests) ---
type PgMemClient = { query: (sql: string) => Promise<{ rowCount?: number | null; rows?: unknown[] }> };
const pgDump = `
CREATE TABLE public."CallLog" (
    "CallLogID" bigint NOT NULL,
    "ClientName" text
);
CREATE SEQUENCE public."CallLog_CallLogID_seq" AS integer START WITH 1;
INSERT INTO public."CallLog" ("CallLogID", "ClientName") VALUES (1, 'Alice; with semicolon'), (2, 'Bob');
INSERT INTO public."CallLog" ("CallLogID", "ClientName") VALUES (3, 'Carol; again');
CREATE INDEX "IX_CallLog_Name" ON public."CallLog" ("ClientName");
CREATE VIEW public."vwCallLogs" AS SELECT "CallLogID", "ClientName" FROM public."CallLog";
`;
const pgStmts = splitSqlStatements(pgDump);
const db = newDb();
const pool = db.adapters.createPg().Pool as unknown as new () => PgMemClient;
const client = new pool();
const pgResult = await executeRestore(client, pgStmts, { stopOnError: false });
check('pg-mem restore ran all statements', pgResult.succeeded === pgStmts.length && pgResult.failed === 0, pgResult);
const count = (await client.query('SELECT count(*) AS n FROM public."CallLog"')) as { rows: { n: string }[] };
check('pg-mem 3 rows landed in CallLog', Number(count.rows[0].n) === 3, count);
const view = (await client.query('SELECT "ClientName" FROM public."vwCallLogs" ORDER BY "CallLogID"')) as {
  rows: { ClientName: string }[];
};
check(
  'pg-mem view returns the 3 names',
  JSON.stringify(view.rows.map((r) => r.ClientName)) === JSON.stringify(['Alice; with semicolon', 'Bob', 'Carol; again']),
  view,
);

const db2 = newDb();
const client2 = new (db2.adapters.createPg().Pool as unknown as new () => PgMemClient)();
const r4 = await executeRestore(client2, ['CREATE TABLE t (id int);', 'CREATE TABLE t (id int);', 'INSERT INTO t VALUES (1);'], {
  stopOnError: false,
});
check('pg-mem duplicate table fails but insert still runs', r4.succeeded === 2 && r4.failed === 1, r4);
const tcount = (await client2.query('SELECT count(*) AS n FROM t')) as { rows: { n: string }[] };
check('pg-mem row landed despite the failed statement', Number(tcount.rows[0].n) === 1, tcount);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
