import { withTurso, tursoUnavailableReason } from './turso';

/**
 * Migration history and schedules, stored in Turso (libsql/SQLite).
 *
 * Every migration run is recorded here — in the Turso database from
 * `TURSO_DATABASE_URL` — so the Dashboard and History pages can show
 * past runs, row counts, per-table validation and errors without
 * touching the source or target databases again. Schedules live in
 * the same database. This used to be a local DuckDB file
 * (`data/migrations.duckdb`); Turso replaces it so history survives
 * restarts, is shared by every process pointing at the same database,
 * and has no single-writer file lock and no native module to be
 * blocked by a Windows Application Control policy.
 *
 * The old local history file does NOT carry over — history starts
 * fresh in Turso. The file can be deleted once the switch is done.
 *
 * Degraded mode: when Turso is unavailable (env vars missing, or the
 * database unreachable), every function below falls back instead of
 * throwing — runs are not recorded, `listRuns` returns `[]`, and
 * schedules live only in memory until the server restarts. Migrations
 * themselves still work. The History page shows a notice in that
 * case (see `historyUnavailableReason()`).
 *
 * All queries are parameterised — values are never interpolated
 * into SQL. Timestamps are ISO strings (TEXT), booleans are 1/0
 * (INTEGER), counts are INTEGER.
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
  /** 'manual' for wizard runs, 'schedule' for scheduled runs. */
  trigger?: string | null;
  /** Display name of the run (schedule name for scheduled runs). */
  runName?: string | null;
  scheduleId?: string | null;
}

/** A recurring migration: a saved source → target pair, a table/view
 *  selection and a cron expression. The background scheduler
 *  (src/lib/scheduler.ts) ticks once a minute and runs every
 *  enabled schedule whose next run is due. */
export interface Schedule {
  id: string;
  name: string;
  sourceConnectorId: string;
  targetConnectorId: string;
  tables: string[];
  views: string[];
  includeData: boolean;
  dropExisting: boolean;
  useCopy: boolean;
  /** Track created tables/views in Hasura after each scheduled run. */
  trackInHasura?: boolean;
  cron: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastRunId: string | null;
  nextRunAt: string | null;
  createdAt: string;
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

/** Non-null when Turso is unavailable in this process. Read it after
 *  a history call (e.g. listRuns) so the load has been attempted. */
export function historyUnavailableReason(): string | null {
  return tursoUnavailableReason();
}

/** SQLite stores booleans as 1/0; libsql returns them as numbers. */
function toBool(v: unknown, defaultValue: boolean): boolean {
  if (v === 1 || v === true) return true;
  if (v === 0 || v === false) return false;
  return defaultValue;
}

interface MemoryStore {
  memorySchedules?: Map<string, Schedule>;
}
const memoryGlobal = globalThis as typeof globalThis & { __cictusHistoryMemory?: MemoryStore };

function getMemorySchedules(): Map<string, Schedule> {
  if (!memoryGlobal.__cictusHistoryMemory) memoryGlobal.__cictusHistoryMemory = {};
  const store = memoryGlobal.__cictusHistoryMemory;
  if (!store.memorySchedules) store.memorySchedules = new Map();
  return store.memorySchedules;
}

export async function recordRunStart(run: {
  id: string;
  sourceName: string;
  targetName: string;
  targetType: string;
  tablesTotal: number;
  viewsTotal: number;
  trigger?: 'manual' | 'schedule';
  runName?: string | null;
  scheduleId?: string | null;
}): Promise<void> {
  await withTurso(async (client) => {
    await client.execute({
      sql: `INSERT INTO migrations
        (id, started_at, finished_at, status, source_name, target_name, target_type,
         tables_total, tables_succeeded, rows_copied, views_created, views_total, errors_count,
         trigger, run_name, schedule_id)
        VALUES (?, ?, NULL, 'running', ?, ?, ?, ?, 0, 0, 0, ?, 0, ?, ?, ?)`,
      args: [
        run.id,
        new Date().toISOString(),
        run.sourceName,
        run.targetName,
        run.targetType,
        run.tablesTotal,
        run.viewsTotal,
        run.trigger ?? 'manual',
        run.runName ?? null,
        run.scheduleId ?? null,
      ],
    });
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
  await withTurso(async (client) => {
    await client.execute({
      sql: `UPDATE migrations SET finished_at = ?, status = ?,
        tables_succeeded = ?, rows_copied = ?, views_created = ?, errors_count = ?
        WHERE id = ?`,
      args: [
        new Date().toISOString(),
        run.status,
        run.tablesSucceeded,
        run.rowsCopied,
        run.viewsCreated,
        run.errorsCount,
        run.id,
      ],
    });
    for (const t of run.tables) {
      await client.execute({
        sql: `INSERT INTO migration_tables VALUES (?, ?, ?, ?, ?, ?)`,
        args: [run.id, t.tableName, t.sourceRows, t.targetRows, t.matched ? 1 : 0, t.status],
      });
    }
    for (const e of run.errors) {
      await client.execute({
        sql: `INSERT INTO migration_errors VALUES (?, ?, ?)`,
        args: [run.id, e.scope, e.message],
      });
    }
  });
}

const RUN_COLS = `id, started_at, finished_at, status, source_name, target_name, target_type,
  tables_total, tables_succeeded, rows_copied, views_created, views_total, errors_count,
  trigger, run_name, schedule_id`;

export async function listRuns(limit = 50): Promise<MigrationRun[]> {
  const rows = await withTurso(async (client) => {
    const result = await client.execute({
      sql: `SELECT ${RUN_COLS} FROM migrations ORDER BY started_at DESC LIMIT ?`,
      args: [limit],
    });
    return result.rows as unknown as MigrationRun[];
  });
  return rows ?? [];
}

export async function getRun(id: string): Promise<{
  run: MigrationRun | null;
  tables: MigrationTableResult[];
  errors: MigrationError[];
}> {
  const result = await withTurso(async (client) => {
    const runs = await client.execute({
      sql: `SELECT ${RUN_COLS} FROM migrations WHERE id = ?`,
      args: [id],
    });
    const tables = await client.execute({
      sql: `SELECT run_id, table_name, source_rows, target_rows, matched, status FROM migration_tables WHERE run_id = ? ORDER BY table_name`,
      args: [id],
    });
    const errors = await client.execute({
      sql: `SELECT run_id, scope, message FROM migration_errors WHERE run_id = ?`,
      args: [id],
    });
    return {
      run: (runs.rows[0] as unknown as MigrationRun) ?? null,
      tables: (tables.rows as unknown as Record<string, unknown>[]).map((t) => ({
        runId: String(t.run_id ?? ''),
        tableName: String(t.table_name ?? ''),
        sourceRows: Number(t.source_rows ?? 0),
        targetRows: Number(t.target_rows ?? 0),
        matched: t.matched === 1 || t.matched === true,
        status: String(t.status ?? ''),
      })),
      errors: errors.rows as unknown as MigrationError[],
    };
  });
  return result ?? { run: null, tables: [], errors: [] };
}

export async function historyStats(): Promise<{
  totalRuns: number;
  completedRuns: number;
  totalRows: number;
  totalTables: number;
  totalErrors: number;
  lastRunAt: string | null;
}> {
  const stats = await withTurso(async (client) => {
    const result = await client.execute(
      `SELECT count(*) AS total_runs,
       sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
       coalesce(sum(rows_copied), 0) AS total_rows,
       coalesce(sum(tables_succeeded), 0) AS total_tables,
       coalesce(sum(errors_count), 0) AS total_errors,
       max(started_at) AS last_run_at
       FROM migrations`,
    );
    const row = result.rows[0] as unknown as Record<string, unknown>;
    return {
      totalRuns: Number(row.total_runs ?? 0),
      completedRuns: Number(row.completed_runs ?? 0),
      totalRows: Number(row.total_rows ?? 0),
      totalTables: Number(row.total_tables ?? 0),
      totalErrors: Number(row.total_errors ?? 0),
      lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    };
  });
  return stats ?? { totalRuns: 0, completedRuns: 0, totalRows: 0, totalTables: 0, totalErrors: 0, lastRunAt: null };
}

/* ── Schedules ─────────────────────────────────────────────── */

function scheduleRowToSchedule(row: Record<string, unknown>): Schedule {
  const parseList = (v: unknown): string[] => {
    if (Array.isArray(v)) return v as string[];
    try {
      const parsed = JSON.parse(String(v ?? '[]'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    sourceConnectorId: String(row.source_connector_id ?? ''),
    targetConnectorId: String(row.target_connector_id ?? ''),
    tables: parseList(row.tables_json),
    views: parseList(row.views_json),
    includeData: toBool(row.include_data, true),
    dropExisting: toBool(row.drop_existing, false),
    useCopy: toBool(row.use_copy, true),
    trackInHasura: toBool(row.track_in_hasura, false),
    cron: String(row.cron ?? ''),
    enabled: toBool(row.enabled, true),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    lastStatus: row.last_status ? String(row.last_status) : null,
    lastRunId: row.last_run_id ? String(row.last_run_id) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    createdAt: row.created_at ? String(row.created_at) : '',
  };
}

const SCHEDULE_COLS = `id, name, source_connector_id, target_connector_id, tables_json, views_json,
  include_data, drop_existing, use_copy, track_in_hasura, cron, enabled, last_run_at, last_status, last_run_id,
  next_run_at, created_at`;

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await withTurso(async (client) => {
    const result = await client.execute(`SELECT ${SCHEDULE_COLS} FROM schedules ORDER BY created_at DESC`);
    return (result.rows as unknown as Record<string, unknown>[]).map(scheduleRowToSchedule);
  });
  if (rows !== null) return rows;
  // Degraded mode: schedules created while Turso is unavailable live
  // only in memory, until the server restarts.
  return [...getMemorySchedules().values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const found = await withTurso(async (client) => {
    const result = await client.execute({
      sql: `SELECT ${SCHEDULE_COLS} FROM schedules WHERE id = ?`,
      args: [id],
    });
    const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
    return row ? scheduleRowToSchedule(row) : null;
  });
  return found ?? getMemorySchedules().get(id) ?? null;
}

/** Insert or replace a schedule (delete + insert keeps it simple and
 *  avoids relying on ON CONFLICT support). */
export async function saveSchedule(s: Schedule): Promise<void> {
  const ran = await withTurso(async (client) => {
    await client.execute({ sql: `DELETE FROM schedules WHERE id = ?`, args: [s.id] });
    await client.execute({
      sql: `INSERT INTO schedules
        (id, name, source_connector_id, target_connector_id, tables_json, views_json,
         include_data, drop_existing, use_copy, track_in_hasura, cron, enabled,
         last_run_at, last_status, last_run_id, next_run_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        s.id,
        s.name,
        s.sourceConnectorId,
        s.targetConnectorId,
        JSON.stringify(s.tables),
        JSON.stringify(s.views),
        s.includeData ? 1 : 0,
        s.dropExisting ? 1 : 0,
        s.useCopy ? 1 : 0,
        s.trackInHasura ? 1 : 0,
        s.cron,
        s.enabled ? 1 : 0,
        s.lastRunAt ?? null,
        s.lastStatus ?? null,
        s.lastRunId ?? null,
        s.nextRunAt ?? null,
        s.createdAt || new Date().toISOString(),
      ],
    });
  });
  if (ran === null) getMemorySchedules().set(s.id, s);
}

export async function deleteSchedule(id: string): Promise<void> {
  const ran = await withTurso(async (client) => {
    await client.execute({ sql: `DELETE FROM schedules WHERE id = ?`, args: [id] });
  });
  if (ran === null) getMemorySchedules().delete(id);
}

export async function updateScheduleRun(id: string, patch: {
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastRunId?: string | null;
  nextRunAt?: string | null;
  enabled?: boolean;
}): Promise<void> {
  const ran = await withTurso(async (client) => {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.lastRunAt !== undefined) {
      sets.push(`last_run_at = ?`);
      args.push(patch.lastRunAt);
    }
    if (patch.lastStatus !== undefined) {
      sets.push(`last_status = ?`);
      args.push(patch.lastStatus);
    }
    if (patch.lastRunId !== undefined) {
      sets.push(`last_run_id = ?`);
      args.push(patch.lastRunId);
    }
    if (patch.nextRunAt !== undefined) {
      sets.push(`next_run_at = ?`);
      args.push(patch.nextRunAt);
    }
    if (patch.enabled !== undefined) {
      sets.push(`enabled = ?`);
      args.push(patch.enabled ? 1 : 0);
    }
    if (!sets.length) return;
    args.push(id);
    await client.execute({ sql: `UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`, args });
  });
  if (ran === null) {
    const s = getMemorySchedules().get(id);
    if (!s) return;
    if (patch.lastRunAt !== undefined) s.lastRunAt = patch.lastRunAt;
    if (patch.lastStatus !== undefined) s.lastStatus = patch.lastStatus;
    if (patch.lastRunId !== undefined) s.lastRunId = patch.lastRunId;
    if (patch.nextRunAt !== undefined) s.nextRunAt = patch.nextRunAt;
    if (patch.enabled !== undefined) s.enabled = patch.enabled;
  }
}
