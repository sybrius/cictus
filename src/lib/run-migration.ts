import crypto from 'crypto';
import { createTargetPool, executeDdlInTransaction, targetRowCount } from './postgres';
import type { TargetConfig } from './postgres';
import { schemaStatements, pgSchema } from './ddl';
import { mapSourceType, type SourceKind } from './type-map';
import { copyTableData, fixIdentitySequences, type ProgressEvent, type SourceConnection } from './migrate-data';
import { recordRunStart, recordRunFinish } from './history-db';
import { introspectSource, viewDatabaseArg } from './source-dispatch';
import { trackTablesInHasura, type HasuraConfig, type HasuraTrackResult } from './hasura';

export type { ProgressEvent } from './migrate-data';

/**
 * The migration engine, shared by the manual wizard run (SSE stream)
 * and scheduled runs (background scheduler). Both call
 * executeMigration() with the same job shape; only the callbacks
 * differ — the wizard forwards events to the browser stream, the
 * scheduler collects them for the history record.
 *
 * Phases: schema (tables → indexes) → data (COPY bulk load for
 * large tables, batched INSERT otherwise) → foreign keys (after
 * data, so orphans / copy order cannot lose rows) → views →
 * validate (row counts source vs target).
 */

export interface MigrationJob {
  source: SourceConnection;
  target: TargetConfig;
  tables: string[]; // 'schema.name'
  views: string[]; // 'schema.name'
  overrides: Record<string, string>;
  includeData: boolean;
  dropExisting: boolean;
  useCopy: boolean;
  sourceName: string;
  targetName: string;
  targetType: string;
  trigger: 'manual' | 'schedule';
  runName?: string;
  scheduleId?: string;
  /** Track created tables/views in Hasura after the run (NHost). */
  trackInHasura?: boolean;
  hasura?: HasuraConfig | null;
}

export interface MigrationCallbacks {
  log(message: string): void;
  phase(phase: string): void;
  event(e: ProgressEvent): void;
  viewDone(view: string, notes: string[]): void;
  validation(row: { table: string; source: number; target: number; match: boolean }): void;
}

export interface MigrationSummary {
  runId: string;
  tables: number;
  rowsCopied: number;
  views: number;
  errors: string[];
  hasura?: HasuraTrackResult;
}

export function resolveSourceConfig(kind: SourceKind, config: SourceConnection['config']): SourceConnection {
  return { kind, config } as SourceConnection;
}

export async function executeMigration(job: MigrationJob, cb: MigrationCallbacks): Promise<MigrationSummary> {
  const { overrides, includeData, dropExisting } = job;
  const sourceKind = job.source.kind;
  const sourceConfig = job.source.config;
  const pool = createTargetPool(job.target);
  const runId = crypto.randomUUID();
  const errors: string[] = [];
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
    // Record the run BEFORE introspection: if the source is
    // unreachable the run still shows in History (failed, with the
    // connection error) instead of vanishing silently. The counts
    // here are the requested tables/views; the finish record
    // carries the actuals.
    try {
      await recordRunStart({
        id: runId, sourceName: job.sourceName, targetName: job.targetName, targetType: job.targetType,
        tablesTotal: job.tables.length, viewsTotal: job.views.length,
        trigger: job.trigger, runName: job.runName ?? null, scheduleId: job.scheduleId ?? null,
      });
      runRecorded = true;
    } catch { /* history is best-effort */ }

    const full = await introspectSource(sourceKind, sourceConfig);
    const tables = full.tables.filter((t) => job.tables.includes(`${t.schema}.${t.name}`));
    const views = full.views.filter((v) => job.views.includes(`${v.schema}.${v.name}`));
    const stmts = schemaStatements(tables, views, overrides, sourceKind, viewDatabaseArg(sourceKind, sourceConfig));

    // ── Phase 1: schema ────────────────────────────────────────
    cb.phase('schema');
    if (dropExisting) {
      cb.log('Dropping existing target tables (dropExisting=true)…');
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
        cb.event({ type: 'error', table: '', message: `Drop existing tables failed: ${msg}` });
        cb.log(`Drop existing tables failed, continuing: ${msg}`);
      }
    }
    cb.log(`Creating ${stmts.tables.length} table(s)…`);
    // Create tables one at a time, each in its own transaction.
    // Previously all tables ran in a single transaction, so one
    // untranslatable DEFAULT (e.g. SYSUTCDATETIME()) rolled back
    // every table and aborted the whole migration.
    const createdTables = new Set<string>();
    const failedTables = new Set<string>();
    for (let i = 0; i < stmts.tables.length; i++) {
      const tableName = `${tables[i].schema}.${tables[i].name}`;
      try {
        await executeDdlInTransaction(pool, [stmts.tables[i]], (s) => cb.log(`DDL: ${s.split('\n')[0]}`));
        createdTables.add(tableName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failedTables.add(tableName);
        errors.push(`${tableName}: ${msg}`);
        cb.event({ type: 'error', table: tableName, message: msg });
        cb.log(`Table failed, continuing with the next table: ${tableName} — ${msg}`);
      }
    }
    cb.log(`Tables created: ${createdTables.size} succeeded, ${failedTables.size} failed.`);
    // Indexes BEFORE foreign keys: a FK may reference a column that
    // is unique only via a UNIQUE index, and Postgres requires that
    // index to exist before the FK is created. Each statement runs
    // on its own so one bad FK/index no longer aborts the migration
    // (previously the whole FK batch ran in one transaction and a
    // single failure — "no unique constraint matching given keys
    // for referenced table CallLog" — ended the run with 0 rows).
    if (stmts.indexes.length) {
      cb.log(`Creating ${stmts.indexes.length} index(es)…`);
      for (const ix of stmts.indexes) {
        try {
          await executeDdlInTransaction(pool, [ix]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`index: ${msg}`);
          cb.event({ type: 'error', table: '', message: `Index failed: ${msg}` });
          cb.log(`Index failed, continuing: ${ix.split('\n')[0]} — ${msg}`);
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
      cb.phase('data');
      for (const table of tables) {
        // Skip tables whose CREATE TABLE failed — there is no
        // target table to insert into.
        if (failedTables.has(`${table.schema}.${table.name}`)) {
          cb.log(`Skipping data copy for failed table ${table.schema}.${table.name}.`);
          continue;
        }
        // The real mapped Postgres type per column (an override
        // wins). COPY formatting and value coercion both depend on
        // it — e.g. bit → boolean, json → jsonb — so it must be the
        // mapped type, not a blanket 'text'.
        const pgTypes: Record<string, string> = {};
        for (const c of table.columns) {
          pgTypes[c.name] = overrides[`${c.schema}.${c.table}.${c.name}`] ?? mapSourceType(sourceKind, c).pgType;
        }
        try {
          const n = await copyTableData(job.source, pool, table, pgTypes, (e) => cb.event(e), { useCopy: job.useCopy });
          rowsCopied += n;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // A dropped connection to SQL Server (socket hang up,
          // ECONNRESET, timeout) is usually transient — QYLA is on
          // Wi-Fi — so retry the table once before giving up on it.
          // A retry that also fails is recorded and the run moves
          // on to the next table, as before.
          if (/socket hang up|connection lost|ECONNRESET|ESOCKET|ETIMEDOUT|timed out|network/i.test(msg)) {
            cb.log(`Connection error copying ${table.schema}.${table.name} — retrying once: ${msg}`);
            try {
              const n = await copyTableData(job.source, pool, table, pgTypes, (e) => cb.event(e), { useCopy: job.useCopy });
              rowsCopied += n;
              cb.log(`Retry succeeded for ${table.schema}.${table.name}: ${n.toLocaleString()} rows.`);
              continue;
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              errors.push(`${table.schema}.${table.name}: ${retryMsg} (after 1 retry)`);
              cb.event({ type: 'error', table: `${table.schema}.${table.name}`, message: retryMsg });
              continue;
            }
          }
          errors.push(`${table.schema}.${table.name}: ${msg}`);
          cb.event({ type: 'error', table: `${table.schema}.${table.name}`, message: msg });
        }
      }
      await fixIdentitySequences(pool, tables.filter((t) => createdTables.has(`${t.schema}.${t.name}`)), (e) => cb.event(e));
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
      cb.log(`Adding ${stmts.fks.length} foreign key(s)…`);
      for (const fk of stmts.fks) {
        try {
          await executeDdlInTransaction(pool, [fk]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const name = fk.split('ADD CONSTRAINT')[1]?.trim().split(' ')[0] ?? '';
          errors.push(`foreign key ${name}: ${msg}`);
          cb.event({ type: 'error', table: '', message: `Foreign key failed: ${msg}` });
          cb.log(`Foreign key failed, continuing: ${name} — ${msg} — data is already copied; check for orphaned rows in the source for this constraint, then re-add it or drop it.`);
        }
      }
    }

    // ── Phase 3: views ─────────────────────────────────────────
    cb.phase('views');
    // Make sure each view's schema exists (e.g. dbhkuser) before
    // creating views in it; tables live in public, views may not.
    {
      const viewSchemas = [...new Set(views.map((v) => (v.schema === 'dbo' ? 'public' : v.schema.toLowerCase())))];
      for (const s of viewSchemas) {
        try {
          await pool.query(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
        } catch (err) {
          cb.log(`Could not create schema "${s}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    for (const v of stmts.views) {
      try {
        await pool.query(v.sql);
        viewsCreated++;
        cb.viewDone(v.name, v.notes);
        cb.log(`View created: ${v.name}${v.notes.length ? ` (${v.notes.length} note(s) — review)` : ''}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`view ${v.name}: ${msg}`);
        cb.event({ type: 'error', table: v.name, message: msg });
        // Log the converted SQL so the next run shows exactly what
        // Postgres choked on — a bare "syntax error at or near CL"
        // cannot be diagnosed without it.
        cb.log(`View failed: ${v.name} — ${msg} — converted SQL: ${v.sql.slice(0, 2000)}`);
      }
    }

    // ── Phase 4: validation ────────────────────────────────────
    cb.phase('validate');
    for (const table of tables) {
      if (failedTables.has(`${table.schema}.${table.name}`)) continue;
      try {
        const targetCount = await targetRowCount(
          pool,
          pgSchema(table.schema),
          table.name,
        );
        const row = {
          table: `${table.schema}.${table.name}`,
          source: table.rowCount,
          target: targetCount,
          match: targetCount === table.rowCount,
        };
        validationRows.push(row);
        cb.validation(row);
      } catch (err) {
        errors.push(`validate ${table.schema}.${table.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Phase 5: Hasura auto-track (best-effort) ───────────────
    // Tracking never fails the migration: a Hasura outage or a bad
    // admin secret is logged per table and reported in the summary.
    let hasura: HasuraTrackResult | undefined;
    if (job.trackInHasura && job.hasura && createdTables.size > 0) {
      cb.phase('hasura');
      const toTrack = tables
        .filter((t) => createdTables.has(`${t.schema}.${t.name}`))
        .map((t) => ({ schema: pgSchema(t.schema), name: t.name }));
      const createdViews = stmts.views
        .filter((v) => !errors.some((e) => e.startsWith(`view ${v.name}:`)))
        .map((v) => {
          const [schema, name] = v.name.split('.');
          return { schema: pgSchema(schema), name };
        });
      cb.log(`Tracking ${toTrack.length + createdViews.length} table(s)/view(s) in Hasura…`);
      hasura = await trackTablesInHasura(job.hasura, [...toTrack, ...createdViews]);
      if (hasura.tracked.length) {
        cb.log(`Hasura: tracked ${hasura.tracked.length} table(s): ${hasura.tracked.slice(0, 5).join(', ')}${hasura.tracked.length > 5 ? '…' : ''}`);
      }
      if (hasura.alreadyTracked.length) cb.log(`Hasura: ${hasura.alreadyTracked.length} already tracked.`);
      for (const f of hasura.failed) cb.log(`Hasura: could not track ${f.table} — ${f.error}`);
    }

    await finishHistory(errors.length ? 'failed' : 'completed', createdTables.size, rowsCopied);
    return { runId, tables: createdTables.size, rowsCopied, views: stmts.views.length, errors, hasura };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    cb.event({ type: 'error', table: '', message: msg });
    await finishHistory('failed', 0, 0);
    return { runId, tables: 0, rowsCopied: 0, views: 0, errors };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
