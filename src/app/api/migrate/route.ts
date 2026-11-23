import { z } from 'zod';
import crypto from 'crypto';
import { SqlServerConfigSchema, introspectSchema } from '@/lib/sqlserver';
import { MysqlConfigSchema, introspectMysqlSchema } from '@/lib/mysql';
import { TargetConfigSchema, createTargetPool, executeDdlInTransaction, targetRowCount } from '@/lib/postgres';
import { schemaStatements } from '@/lib/ddl';
import { copyTableData, fixIdentitySequences, type ProgressEvent, type SourceConnection } from '@/lib/migrate-data';
import { recordRunStart, recordRunFinish } from '@/lib/history-db';
import { resolveSource, resolveTarget } from '@/lib/resolve-connector';

const BodySchema = z.object({
  // Raw form values, accepted as-is: when a connector id is given,
  // these are the wizard's untouched defaults (empty password /
  // empty connection string) and the resolver below replaces them
  // with the saved connector's credentials. Validating them here
  // was the bug behind the 400 on /api/migrate with a connector
  // selected — the resolved config is validated instead, below.
  source: z.unknown().optional(),
  sourceConnectorId: z.string().optional(),
  target: z.unknown().optional(),
  targetConnectorId: z.string().optional(),
  tables: z.array(z.string()).min(1, 'Select at least one table'),
  views: z.array(z.string()).default([]),
  overrides: z.record(z.string()).default({}),
  includeData: z.boolean().default(true),
  dropExisting: z.boolean().default(false),
  // Display names for the local DuckDB history record (not credentials).
  sourceName: z.string().optional(),
  targetName: z.string().optional(),
  targetType: z.string().optional(),
});

type OutEvent =
  | ProgressEvent
  | { type: 'phase'; phase: string }
  | { type: 'view-done'; view: string; notes: string[] }
  | { type: 'validation'; table: string; source: number; target: number; match: boolean }
  | { type: 'done'; summary: { tables: number; rowsCopied: number; views: number; errors: string[] } };

/**
 * POST → Server-Sent Events stream (text/event-stream).
 * Phases: schema (tables → indexes) → data (batched copy) →
 * foreign keys (after data, so orphans / copy order cannot lose
 * rows) → views → validate (row counts source vs target).
 * The client reads the stream with fetch + ReadableStream and renders
 * live progress; the response only ends when migration is complete.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const { overrides, includeData, dropExisting } = parsed.data;
  // Resolve saved connectors server-side (passwords never leave the
  // server) or fall back to the form values the wizard sent.
  // The source type (sqlserver | mysql) comes from the connector or
  // the form's sourceType field; the config is validated against the
  // matching schema.
  let resolvedSource: { kind: 'sqlserver' | 'mysql'; config: z.infer<typeof SqlServerConfigSchema> | z.infer<typeof MysqlConfigSchema> };
  let resolvedTarget: z.infer<typeof TargetConfigSchema>;
  let connectorTargetType: string | null = null;
  try {
    const s = resolveSource({ sourceConnectorId: parsed.data.sourceConnectorId, source: parsed.data.source });
    const t = resolveTarget({ targetConnectorId: parsed.data.targetConnectorId, target: parsed.data.target });
    const sParsed = s.sourceType === 'mysql'
      ? MysqlConfigSchema.safeParse(s.config)
      : SqlServerConfigSchema.safeParse(s.config);
    const tParsed = TargetConfigSchema.safeParse({ connectionString: t.connectionString });
    if (!sParsed.success) throw new Error(sParsed.error.issues.map((i) => i.message).join('; '));
    if (!tParsed.success) throw new Error(tParsed.error.issues.map((i) => i.message).join('; '));
    resolvedSource = { kind: s.sourceType, config: sParsed.data };
    resolvedTarget = tParsed.data;
    connectorTargetType = t.connectorType;
    if (s.connectorName && !parsed.data.sourceName) parsed.data.sourceName = s.connectorName;
    if (t.connectorName && !parsed.data.targetName) parsed.data.targetName = t.connectorName;
    if (connectorTargetType && !parsed.data.targetType) parsed.data.targetType = connectorTargetType;
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const source = resolvedSource.config;
  const sourceConn: SourceConnection = resolvedSource.kind === 'mysql'
    ? { kind: 'mysql', config: source as z.infer<typeof MysqlConfigSchema> }
    : { kind: 'sqlserver', config: source as z.infer<typeof SqlServerConfigSchema> };
  const target = resolvedTarget;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // A failed enqueue must never kill the migration. controller.enqueue
      // throws once the stream is closed or errored (e.g. the browser
      // connection drops mid-run) — and every log/progress call in the
      // phases below goes through send(), so one throw used to poison
      // the whole run: the outer catch's sends threw too, then
      // controller.close() in finally threw, the stream errored, and
      // the browser reported "network error" instead of the per-table
      // skip-and-continue behaviour. Now a dead stream just stops
      // receiving events; the migration keeps going server-side and
      // its result is still recorded in the DuckDB history.
      let streamAlive = true;
      const send = (e: OutEvent) => {
        if (!streamAlive) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          streamAlive = false;
        }
      };
      const log = (message: string) => send({ type: 'log', message });
      const errors: string[] = [];
      const pool = createTargetPool(target);
      // Local DuckDB history: one run record per migration, so the
      // Dashboard / History pages can show it later. A history
      // failure must never break the migration itself.
      const runId = crypto.randomUUID();
      const sourceName = parsed.data.sourceName || `${source.host}/${source.database}`;
      const targetName = parsed.data.targetName || 'Postgres target';
      const targetType = parsed.data.targetType || 'postgres';
      const validationRows: { table: string; source: number; target: number; match: boolean }[] = [];
      let viewsCreated = 0;
      let runRecorded = false;
      const finishHistory = async (status: 'completed' | 'failed', tablesSucceeded: number, rowsCopied: number) => {
        if (!runRecorded) return;
        try {
          await recordRunFinish({
            id: runId, status, tablesSucceeded, rowsCopied, viewsCreated,
            errorsCount: errors.length,
            tables: validationRows.map((v) => ({
              runId, tableName: v.table, sourceRows: v.source, targetRows: v.target, matched: v.match,
              status: v.match ? 'ok' : 'mismatch',
            })),
            errors: errors.map((m) => ({ scope: m.split(':')[0] || 'migration', message: m })),
          });
        } catch { /* history is best-effort */ }
      };
      try {
        const full = resolvedSource.kind === 'mysql'
          ? await introspectMysqlSchema(source as z.infer<typeof MysqlConfigSchema>)
          : await introspectSchema(source as z.infer<typeof SqlServerConfigSchema>);
        const tables = full.tables.filter((t) => parsed.data.tables.includes(`${t.schema}.${t.name}`));
        const views = full.views.filter((v) => parsed.data.views.includes(`${v.schema}.${v.name}`));
        const stmts = schemaStatements(tables, views, overrides, resolvedSource.kind, source.database);
        try {
          await recordRunStart({ id: runId, sourceName, targetName, targetType, tablesTotal: tables.length, viewsTotal: views.length });
          runRecorded = true;
        } catch { /* history is best-effort */ }

        // ── Phase 1: schema ────────────────────────────────────────
        send({ type: 'phase', phase: 'schema' });
        if (dropExisting) {
          log('Dropping existing target tables (dropExisting=true)…');
          try {
            await executeDdlInTransaction(
              pool,
              tables.map((t) => `DROP TABLE IF EXISTS "${t.schema === 'dbo' ? 'public' : t.schema}"."${t.name}" CASCADE;`),
            );
          } catch (err) {
            // A failed DROP used to escape every per-table catch and
            // abort the whole run with 0 tables. Record it and go on.
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`drop existing tables: ${msg}`);
            send({ type: 'error', table: '', message: `Drop existing tables failed: ${msg}` });
            log(`Drop existing tables failed, continuing: ${msg}`);
          }
        }
        log(`Creating ${stmts.tables.length} table(s)…`);
        // Create tables one at a time, each in its own transaction.
        // Previously all tables ran in a single transaction, so one
        // untranslatable DEFAULT (e.g. SYSUTCDATETIME()) rolled back
        // every table and aborted the whole migration.
        const createdTables = new Set<string>();
        const failedTables = new Set<string>();
        for (let i = 0; i < stmts.tables.length; i++) {
          const tableName = `${tables[i].schema}.${tables[i].name}`;
          try {
            await executeDdlInTransaction(pool, [stmts.tables[i]], (s) => log(`DDL: ${s.split('\n')[0]}`));
            createdTables.add(tableName);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failedTables.add(tableName);
            errors.push(`${tableName}: ${msg}`);
            send({ type: 'error', table: tableName, message: msg });
            log(`Table failed, continuing with the next table: ${tableName} — ${msg}`);
          }
        }
        log(`Tables created: ${createdTables.size} succeeded, ${failedTables.size} failed.`);
        // Indexes BEFORE foreign keys: a FK may reference a column that
        // is unique only via a UNIQUE index, and Postgres requires that
        // index to exist before the FK is created. Each statement runs
        // on its own so one bad FK/index no longer aborts the migration
        // (previously the whole FK batch ran in one transaction and a
        // single failure — "no unique constraint matching given keys
        // for referenced table CallLog" — ended the run with 0 rows).
        if (stmts.indexes.length) {
          log(`Creating ${stmts.indexes.length} index(es)…`);
          for (const ix of stmts.indexes) {
            try {
              await executeDdlInTransaction(pool, [ix]);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`index: ${msg}`);
              send({ type: 'error', table: '', message: `Index failed: ${msg}` });
              log(`Index failed, continuing: ${ix.split('\n')[0]} — ${msg}`);
            }
          }
        }
        // Foreign keys are NOT created here any more. They are created
        // AFTER the data copy (see below): with FKs in place first,
        // rows that reference a parent copied later in alphabetical
        // order (UserRoles before Users) or orphaned rows in SQL
        // Server (CommunityMethod1/2/3.WorkerId → CommunityWorkers,
        // which has 0 rows) failed the whole batch copy and those rows
        // were lost. Deferring FKs lets all data land; an FK that
        // still cannot be created afterwards is reported by name and
        // the data stays in place.
        void stmts.fks;

        // ── Phase 2: data ──────────────────────────────────────────
        let rowsCopied = 0;
        if (includeData) {
          send({ type: 'phase', phase: 'data' });
          for (const table of tables) {
            // Skip tables whose CREATE TABLE failed — there is no
            // target table to insert into.
            if (failedTables.has(`${table.schema}.${table.name}`)) {
              log(`Skipping data copy for failed table ${table.schema}.${table.name}.`);
              continue;
            }
            try {
              const pgTypes: Record<string, string> = {};
              for (const c of table.columns) {
                pgTypes[c.name] = overrides[`${c.schema}.${c.table}.${c.name}`] ?? 'text';
              }
              const n = await copyTableData(sourceConn, pool, table, pgTypes, (e) => send(e));
              rowsCopied += n;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // A dropped connection to SQL Server (socket hang up,
              // ECONNRESET, timeout) is usually transient — QYLA is on
              // Wi-Fi — so retry the table once before giving up on it.
              // A retry that also fails is recorded and the run moves
              // on to the next table, as before.
              if (/socket hang up|connection lost|ECONNRESET|ESOCKET|ETIMEDOUT|timed out|network/i.test(msg)) {
                log(`Connection error copying ${table.schema}.${table.name} — retrying once: ${msg}`);
                try {
                  const pgTypes: Record<string, string> = {};
                  for (const c of table.columns) {
                    pgTypes[c.name] = overrides[`${c.schema}.${c.table}.${c.name}`] ?? 'text';
                  }
                  const n = await copyTableData(sourceConn, pool, table, pgTypes, (e) => send(e));
                  rowsCopied += n;
                  log(`Retry succeeded for ${table.schema}.${table.name}: ${n.toLocaleString()} rows.`);
                  continue;
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  errors.push(`${table.schema}.${table.name}: ${retryMsg} (after 1 retry)`);
                  send({ type: 'error', table: `${table.schema}.${table.name}`, message: retryMsg });
                  continue;
                }
              }
              errors.push(`${table.schema}.${table.name}: ${msg}`);
              send({ type: 'error', table: `${table.schema}.${table.name}`, message: msg });
            }
          }
          await fixIdentitySequences(pool, tables.filter((t) => createdTables.has(`${t.schema}.${t.name}`)), (e) => send(e));
        }

        // ── Phase 2b: foreign keys (after data) ────────────────────
        // See the note in the schema phase: FKs are added only now
        // that all rows are in place, so copy order and orphaned rows
        // in the source cannot lose data. A FK that still fails
        // (e.g. orphaned WorkerId values with no parent row in
        // CommunityWorkers) is reported by constraint name; the data
        // stays, and the FK can be added after cleaning the orphans,
        // or dropped from the target.
        if (stmts.fks.length) {
          log(`Adding ${stmts.fks.length} foreign key(s)…`);
          for (const fk of stmts.fks) {
            try {
              await executeDdlInTransaction(pool, [fk]);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const name = fk.split('ADD CONSTRAINT')[1]?.trim().split(' ')[0] ?? '';
              errors.push(`foreign key ${name}: ${msg}`);
              send({ type: 'error', table: '', message: `Foreign key failed: ${msg}` });
              log(`Foreign key failed, continuing: ${name} — ${msg} — data is already copied; check for orphaned rows in the source for this constraint, then re-add it or drop it.`);
            }
          }
        }

        // ── Phase 3: views ─────────────────────────────────────────
        send({ type: 'phase', phase: 'views' });
        // Make sure each view's schema exists (e.g. dbhkuser) before
        // creating views in it; tables live in public, views may not.
        {
          const viewSchemas = [...new Set(views.map((v) => (v.schema === 'dbo' ? 'public' : v.schema.toLowerCase())))];
          for (const s of viewSchemas) {
            try {
              await pool.query(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
            } catch (err) {
              log(`Could not create schema "${s}": ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        for (const v of stmts.views) {
          try {
            await pool.query(v.sql);
            viewsCreated++;
            send({ type: 'view-done', view: v.name, notes: v.notes });
            log(`View created: ${v.name}${v.notes.length ? ` (${v.notes.length} note(s) — review)` : ''}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`view ${v.name}: ${msg}`);
            send({ type: 'error', table: v.name, message: msg });
            // Log the converted SQL so the next run shows exactly what
            // Postgres choked on — a bare "syntax error at or near CL"
            // cannot be diagnosed without it.
            log(`View failed: ${v.name} — ${msg} — converted SQL: ${v.sql.slice(0, 2000)}`);
          }
        }

        // ── Phase 4: validation ────────────────────────────────────
        send({ type: 'phase', phase: 'validate' });
        for (const table of tables) {
          if (failedTables.has(`${table.schema}.${table.name}`)) continue;
          try {
            const targetCount = await targetRowCount(
              pool,
              table.schema === 'dbo' ? 'public' : table.schema,
              table.name,
            );
            const row = {
              table: `${table.schema}.${table.name}`,
              source: table.rowCount,
              target: targetCount,
              match: targetCount === table.rowCount,
            };
            validationRows.push(row);
            send({ type: 'validation', ...row });
          } catch (err) {
            errors.push(`validate ${table.schema}.${table.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        send({
          type: 'done',
          summary: { tables: createdTables.size, rowsCopied, views: stmts.views.length, errors },
        });
        await finishHistory(errors.length ? 'failed' : 'completed', createdTables.size, rowsCopied);
      } catch (err) {
        send({
          type: 'error',
          table: '',
          message: err instanceof Error ? err.message : String(err),
        });
        send({
          type: 'done',
          summary: { tables: 0, rowsCopied: 0, views: 0, errors: [err instanceof Error ? err.message : String(err)] },
        });
        errors.push(err instanceof Error ? err.message : String(err));
        await finishHistory('failed', 0, 0);
      } finally {
        await pool.end().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // Stream already closed/errored — see the safe send() above.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
