import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs';
import path from 'path';

/**
 * Local DuckDB store for migration history.
 *
 * Every migration run is recorded here — on this machine only, in
 * `data/migrations.duckdb` — so the Dashboard and History pages can
 * show past runs, row counts, per-table validation and errors without
 * touching the source or target databases again.
 *
 * Why DuckDB: it is a single local file, needs no server, and the
 * history can be queried with plain SQL (e.g. from the DuckDB CLI)
 * for ad-hoc reporting. It stores results only — never credentials.
 *
 * One DuckDB file can only be opened by ONE instance at a time
 * (single-writer lock). The instance is therefore kept as a
 * process-wide singleton on `globalThis` — NOT in a module-level
 * variable. In Next.js dev mode each route handler gets its own
 * copy of this module, so a module-level singleton was opened once
 * by the migrate route and once by the history route, and the
 * second open failed with: IO Error: Cannot open file
 * "...\data\migrations.duckdb": The process cannot access the file
 * because it is being used by another process. `globalThis` is
 * shared across all route bundles in the same process, so the file
 * is opened exactly once. Each operation still gets its own
 * connection from that instance (closed afterwards), so concurrent
 * reads — e.g. the History page loading runs and stats together —
 * do not share one connection.
 */

export interface MigrationRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  sourceName: string;
  targetName: string;
  targetType: string;
  tablesTotal: number;
  tablesSucceeded: number;
  rowsCopied: number;
  viewsCreated: number;
  viewsTotal: number;
  errorsCount: number;
}

export interface MigrationTableResult {
  runId: string;
  tableName: string;
  sourceRows: number;
  targetRows: number;
  matched: boolean;
  status: string;
}

export interface MigrationError {
  runId: string;
  scope: string;
  message: string;
}

function dbPath(): string {
  return process.env.HISTORY_DB_PATH || path.join(process.cwd(), 'data', 'migrations.duckdb');
}

function esc(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** DuckDB returns BIGINT as JS BigInt and timestamps as
 *  DuckDBTimestampTZValue (with a BigInt `micros` field) — neither
 *  survives JSON.stringify, so normalise row objects before returning. */
function normaliseRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'bigint') out[k] = Number(v);
      else if (v instanceof Date) out[k] = v.toISOString();
      else if (v && typeof v === 'object' && 'micros' in v && typeof (v as { micros: unknown }).micros === 'bigint') {
        // DuckDBTimestampTZValue / DuckDBTimestampValue: micros since epoch.
        out[k] = new Date(Number((v as { micros: bigint }).micros) / 1000).toISOString();
      } else if (v && typeof v === 'object' && 'days' in v && typeof (v as { days: unknown }).days === 'number') {
        // DuckDBDateValue: days since epoch.
        out[k] = new Date((v as { days: number }).days * 86400000).toISOString().slice(0, 10);
      } else out[k] = v;
    }
    return out as T;
  });
}

type DuckDBInstanceType = Awaited<ReturnType<typeof DuckDBInstance.create>>;
type DuckDBConnectionType = Awaited<ReturnType<DuckDBInstanceType['connect']>>;

interface DuckDbGlobal {
  instancePromise?: Promise<DuckDBInstanceType> | null;
  initPromise?: Promise<void> | null;
}
const duckDbGlobal = globalThis as typeof globalThis & { __cictusDuckDb?: DuckDbGlobal };

function getStore(): DuckDbGlobal {
  if (!duckDbGlobal.__cictusDuckDb) duckDbGlobal.__cictusDuckDb = {};
  return duckDbGlobal.__cictusDuckDb;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open the file, retrying briefly if another process is momentarily
 *  holding the lock (e.g. a just-stopped dev server still closing).
 *  If it stays locked, fail with a message that says what to do
 *  instead of the raw DuckDB IO error. */
async function openWithRetry(file: string, attempts = 5): Promise<DuckDBInstanceType> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await DuckDBInstance.create(file);
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/already open|IO Error|lock|cannot access/i.test(msg)) throw e;
      await sleep(300 * (i + 1));
    }
  }
  throw new Error(
    `Cannot open the migration history file ${file}: it is locked by another process. ` +
      `Stop the other dev server (another "npm run dev" or node.exe still running) and reload the page. ` +
      `Original error: ${String((last as Error)?.message ?? last)}`,
  );
}

async function getInstance(): Promise<DuckDBInstanceType> {
  const store = getStore();
  if (!store.instancePromise) {
    const dir = path.dirname(dbPath());
    fs.mkdirSync(dir, { recursive: true });
    store.instancePromise = openWithRetry(dbPath()).catch((e) => {
      store.instancePromise = null; // allow a later call to retry
      throw e;
    });
  }
  return store.instancePromise;
}

async function ensureSchema(conn: DuckDBConnectionType): Promise<void> {
  await conn.run(`CREATE TABLE IF NOT EXISTS migrations (
      id VARCHAR PRIMARY KEY,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      status VARCHAR,
      source_name VARCHAR,
      target_name VARCHAR,
      target_type VARCHAR,
      tables_total INTEGER,
      tables_succeeded INTEGER,
      rows_copied BIGINT,
      views_created INTEGER,
      views_total INTEGER,
      errors_count INTEGER
    )`);
  await conn.run(`CREATE TABLE IF NOT EXISTS migration_tables (
      run_id VARCHAR,
      table_name VARCHAR,
      source_rows BIGINT,
      target_rows BIGINT,
      matched BOOLEAN,
      status VARCHAR
    )`);
  await conn.run(`CREATE TABLE IF NOT EXISTS migration_errors (
      run_id VARCHAR,
      scope VARCHAR,
      message VARCHAR
    )`);
}

/** Run `fn` on a fresh connection from the shared instance, creating
 *  the tables once. The connection is always closed afterwards. */
async function withConnection<T>(fn: (conn: DuckDBConnectionType) => Promise<T>): Promise<T> {
  const instance = await getInstance();
  const conn = await instance.connect();
  try {
    const store = getStore();
    if (!store.initPromise) {
      store.initPromise = ensureSchema(conn).catch((e) => {
        store.initPromise = null;
        throw e;
      });
    }
    await store.initPromise;
    return await fn(conn);
  } finally {
    conn.closeSync();
  }
}

export async function recordRunStart(run: {
  id: string;
  sourceName: string;
  targetName: string;
  targetType: string;
  tablesTotal: number;
  viewsTotal: number;
}): Promise<void> {
  await withConnection(async (conn) => {
    await conn.run(
      `INSERT INTO migrations VALUES (${esc(run.id)}, now(), NULL, 'running', ${esc(run.sourceName)}, ${esc(run.targetName)}, ${esc(run.targetType)}, ${run.tablesTotal}, 0, 0, 0, ${run.viewsTotal}, 0)`,
    );
  });
}

export async function recordRunFinish(run: {
  id: string;
  status: 'completed' | 'failed';
  tablesSucceeded: number;
  rowsCopied: number;
  viewsCreated: number;
  errorsCount: number;
  tables: MigrationTableResult[];
  errors: { scope: string; message: string }[];
}): Promise<void> {
  await withConnection(async (conn) => {
    await conn.run(
      `UPDATE migrations SET finished_at = now(), status = ${esc(run.status)},
       tables_succeeded = ${run.tablesSucceeded}, rows_copied = ${run.rowsCopied},
       views_created = ${run.viewsCreated}, errors_count = ${run.errorsCount}
       WHERE id = ${esc(run.id)}`,
    );
    for (const t of run.tables) {
      await conn.run(
        `INSERT INTO migration_tables VALUES (${esc(run.id)}, ${esc(t.tableName)}, ${t.sourceRows}, ${t.targetRows}, ${t.matched}, ${esc(t.status)})`,
      );
    }
    for (const e of run.errors) {
      await conn.run(
        `INSERT INTO migration_errors VALUES (${esc(run.id)}, ${esc(e.scope)}, ${esc(e.message)})`,
      );
    }
  });
}

export async function listRuns(limit = 50): Promise<MigrationRun[]> {
  return withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(
      `SELECT id, started_at, finished_at, status, source_name, target_name, target_type,
       tables_total, tables_succeeded, rows_copied, views_created, views_total, errors_count
       FROM migrations ORDER BY started_at DESC LIMIT ${limit}`,
    );
    return normaliseRows(reader.getRowObjects() as unknown as Record<string, unknown>[]) as unknown as MigrationRun[];
  });
}

export async function getRun(id: string): Promise<{
  run: MigrationRun | null;
  tables: MigrationTableResult[];
  errors: MigrationError[];
}> {
  return withConnection(async (conn) => {
    const runs = await conn.runAndReadAll(
      `SELECT id, started_at, finished_at, status, source_name, target_name, target_type,
       tables_total, tables_succeeded, rows_copied, views_created, views_total, errors_count
       FROM migrations WHERE id = ${esc(id)}`,
    );
    const rows = runs.getRowObjects() as unknown as MigrationRun[];
    const tables = await conn.runAndReadAll(
      `SELECT run_id, table_name, source_rows, target_rows, matched, status FROM migration_tables WHERE run_id = ${esc(id)} ORDER BY table_name`,
    );
    const errors = await conn.runAndReadAll(
      `SELECT run_id, scope, message FROM migration_errors WHERE run_id = ${esc(id)}`,
    );
    return {
      run: rows[0] ? normaliseRows(rows as unknown as Record<string, unknown>[])[0] as unknown as MigrationRun : null,
      tables: normaliseRows(tables.getRowObjects() as unknown as Record<string, unknown>[]) as unknown as MigrationTableResult[],
      errors: normaliseRows(errors.getRowObjects() as unknown as Record<string, unknown>[]) as unknown as MigrationError[],
    };
  });
}

export async function historyStats(): Promise<{
  totalRuns: number;
  completedRuns: number;
  totalRows: number;
  totalTables: number;
  totalErrors: number;
  lastRunAt: string | null;
}> {
  return withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(
      `SELECT count(*) AS total_runs,
       sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
       coalesce(sum(rows_copied), 0) AS total_rows,
       coalesce(sum(tables_succeeded), 0) AS total_tables,
       coalesce(sum(errors_count), 0) AS total_errors,
       max(started_at) AS last_run_at
       FROM migrations`,
    );
    const row = normaliseRows(reader.getRowObjects() as unknown as Record<string, unknown>[])[0] as unknown as Record<string, unknown>;
    return {
      totalRuns: Number(row.total_runs ?? 0),
      completedRuns: Number(row.completed_runs ?? 0),
      totalRows: Number(row.total_rows ?? 0),
      totalTables: Number(row.total_tables ?? 0),
      totalErrors: Number(row.total_errors ?? 0),
      lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    };
  });
}
