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
 *
 * Degraded mode: the DuckDB native module (`duckdb.node`) is loaded
 * lazily, on first use — never at import time. If the machine blocks
 * the native file (e.g. a Windows Application Control policy), the
 * import fails and the app keeps running without persisted history:
 * migrations still work, runs are simply not recorded, and schedules
 * live only in memory until the server restarts. The History page
 * shows a notice in that case (see `historyUnavailableReason()`).
 * This matters because a failed static import would otherwise kill
 * the whole server at startup — the instrumentation hook imports
 * the scheduler, which imports this module.
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

type DuckDBModule = typeof import('@duckdb/node-api');
type DuckDBInstanceType = Awaited<ReturnType<DuckDBModule['DuckDBInstance']['create']>>;
type DuckDBConnectionType = Awaited<ReturnType<DuckDBInstanceType['connect']>>;

interface DuckDbGlobal {
  instancePromise?: Promise<DuckDBInstanceType> | null;
  initPromise?: Promise<void> | null;
  /** Cached result of the lazy native-module import (null = failed). */
  modulePromise?: Promise<DuckDBModule | null> | null;
  /** Set when the native module failed to load; null while untested. */
  moduleError?: string | null;
  /** Schedules kept in memory while DuckDB is unavailable. */
  memorySchedules?: Map<string, Schedule>;
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
/** Load the DuckDB native module lazily, on first use — never at
 * import time. If the file is blocked (e.g. a Windows Application
 * Control policy refuses `duckdb.node`), the import rejects, the
 * reason is cached on the shared store, and every history/schedule
 * call degrades gracefully instead of crashing the server. */
async function loadDuckDbModule(): Promise<DuckDBModule | null> {
  const store = getStore();
  if (store.modulePromise) return store.modulePromise;
  store.modulePromise = import('@duckdb/node-api')
    .then((mod) => {
      store.moduleError = null;
      return mod;
    })
    .catch((e) => {
      // Keep only the first line — the raw message can carry a long
      // Node require stack that would look awful in the UI banner.
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      store.moduleError = msg;
      console.warn(
        '[cictus] DuckDB native module could not be loaded — migration history will not be recorded ' +
          'and schedules will only live in memory until the server restarts. Migrations themselves ' +
          `still work. Reason: ${msg}`,
      );
      return null;
    });
  return store.modulePromise;
}

/** Non-null when the DuckDB native module failed to load in this
 * process. Read it after a history call (e.g. listRuns) so the
 * load has been attempted. */
export function historyUnavailableReason(): string | null {
  return getStore().moduleError ?? null;
}

function getMemorySchedules(): Map<string, Schedule> {
  const store = getStore();
  if (!store.memorySchedules) store.memorySchedules = new Map();
  return store.memorySchedules;
}

async function openWithRetry(mod: DuckDBModule, file: string, attempts = 5): Promise<DuckDBInstanceType> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await mod.DuckDBInstance.create(file);
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

/** The shared instance, or null when the native module could not be
 * loaded (degraded mode — callers fall back, see withConnection). */
async function getInstance(): Promise<DuckDBInstanceType | null> {
  const mod = await loadDuckDbModule();
  if (!mod) return null;
  const store = getStore();
  if (!store.instancePromise) {
    const dir = path.dirname(dbPath());
    fs.mkdirSync(dir, { recursive: true });
    store.instancePromise = openWithRetry(mod, dbPath()).catch((e) => {
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
  // Columns added after the first release — keep them optional so
  // older history files pick them up without a migration script.
  await conn.run(`ALTER TABLE migrations ADD COLUMN IF NOT EXISTS trigger VARCHAR`);
  await conn.run(`ALTER TABLE migrations ADD COLUMN IF NOT EXISTS run_name VARCHAR`);
  await conn.run(`ALTER TABLE migrations ADD COLUMN IF NOT EXISTS schedule_id VARCHAR`);
  await conn.run(`CREATE TABLE IF NOT EXISTS schedules (
      id VARCHAR PRIMARY KEY,
      name VARCHAR,
      source_connector_id VARCHAR,
      target_connector_id VARCHAR,
      tables_json VARCHAR,
      views_json VARCHAR,
      include_data BOOLEAN,
      drop_existing BOOLEAN,
      use_copy BOOLEAN,
      cron VARCHAR,
      enabled BOOLEAN,
      last_run_at TIMESTAMPTZ,
      last_status VARCHAR,
      last_run_id VARCHAR,
      next_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ
    )`);
  await conn.run(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS track_in_hasura BOOLEAN`);
}

/** Run `fn` on a fresh connection from the shared instance, creating
 *  the tables once. The connection is always closed afterwards.
 * Returns null when DuckDB is unavailable (degraded mode) — callers
 * fall back instead of throwing, so a blocked native module never
 * breaks a migration or a page load. */
async function withConnection<T>(fn: (conn: DuckDBConnectionType) => Promise<T>): Promise<T | null> {
  const instance = await getInstance();
  if (!instance) return null;
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
  trigger?: 'manual' | 'schedule';
  runName?: string | null;
  scheduleId?: string | null;
}): Promise<void> {
  await withConnection(async (conn) => {
    await conn.run(
      `INSERT INTO migrations VALUES (${esc(run.id)}, now(), NULL, 'running', ${esc(run.sourceName)}, ${esc(run.targetName)}, ${esc(run.targetType)}, ${run.tablesTotal}, 0, 0, 0, ${run.viewsTotal}, 0, ${esc(run.trigger ?? 'manual')}, ${run.runName ? esc(run.runName) : 'NULL'}, ${run.scheduleId ? esc(run.scheduleId) : 'NULL'})`,
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
  const rows = await withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(
      `SELECT id, started_at, finished_at, status, source_name, target_name, target_type,
       tables_total, tables_succeeded, rows_copied, views_created, views_total, errors_count,
       trigger, run_name, schedule_id
       FROM migrations ORDER BY started_at DESC LIMIT ${limit}`,
    );
    return normaliseRows(reader.getRowObjects() as unknown as Record<string, unknown>[]) as unknown as MigrationRun[];
  });
  return rows ?? [];
}

export async function getRun(id: string): Promise<{
  run: MigrationRun | null;
  tables: MigrationTableResult[];
  errors: MigrationError[];
}> {
  const result = await withConnection(async (conn) => {
    const runs = await conn.runAndReadAll(
      `SELECT id, started_at, finished_at, status, source_name, target_name, target_type,
       tables_total, tables_succeeded, rows_copied, views_created, views_total, errors_count,
       trigger, run_name, schedule_id
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
  const stats = await withConnection(async (conn) => {
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
    includeData: row.include_data !== false,
    dropExisting: row.drop_existing === true,
    useCopy: row.use_copy !== false,
    trackInHasura: row.track_in_hasura === true,
    cron: String(row.cron ?? ''),
    enabled: row.enabled !== false,
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
  const rows = await withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(`SELECT ${SCHEDULE_COLS} FROM schedules ORDER BY created_at DESC`);
    return normaliseRows(reader.getRowObjects() as unknown as Record<string, unknown>[]).map(scheduleRowToSchedule);
  });
  if (rows !== null) return rows;
  // Degraded mode: schedules created while DuckDB is unavailable live
  // only in memory, until the server restarts.
  return [...getMemorySchedules().values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const found = await withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(`SELECT ${SCHEDULE_COLS} FROM schedules WHERE id = ${esc(id)}`);
    const rows = normaliseRows(reader.getRowObjects() as unknown as Record<string, unknown>[]);
    return rows[0] ? scheduleRowToSchedule(rows[0]) : null;
  });
  return found ?? getMemorySchedules().get(id) ?? null;
}

/** Insert or replace a schedule (delete + insert keeps it simple and
 *  avoids relying on ON CONFLICT support). */
export async function saveSchedule(s: Schedule): Promise<void> {
  const ran = await withConnection(async (conn) => {
    await conn.run(`DELETE FROM schedules WHERE id = ${esc(s.id)}`);
    await conn.run(
      `INSERT INTO schedules
       (id, name, source_connector_id, target_connector_id, tables_json, views_json,
        include_data, drop_existing, use_copy, track_in_hasura, cron, enabled,
        last_run_at, last_status, last_run_id, next_run_at, created_at)
       VALUES (${esc(s.id)}, ${esc(s.name)}, ${esc(s.sourceConnectorId)}, ${esc(s.targetConnectorId)},
       ${esc(JSON.stringify(s.tables))}, ${esc(JSON.stringify(s.views))},
       ${s.includeData}, ${s.dropExisting}, ${s.useCopy}, ${s.trackInHasura ?? false}, ${esc(s.cron)}, ${s.enabled},
       ${s.lastRunAt ? esc(s.lastRunAt) : 'NULL'}, ${s.lastStatus ? esc(s.lastStatus) : 'NULL'},
       ${s.lastRunId ? esc(s.lastRunId) : 'NULL'}, ${s.nextRunAt ? esc(s.nextRunAt) : 'NULL'},
       ${s.createdAt ? esc(s.createdAt) : 'now()'})`,
    );
  });
  if (ran === null) getMemorySchedules().set(s.id, s);
}

export async function deleteSchedule(id: string): Promise<void> {
  const ran = await withConnection(async (conn) => {
    await conn.run(`DELETE FROM schedules WHERE id = ${esc(id)}`);
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
  const ran = await withConnection(async (conn) => {
    const sets: string[] = [];
    if (patch.lastRunAt !== undefined) sets.push(`last_run_at = ${patch.lastRunAt ? esc(patch.lastRunAt) : 'NULL'}`);
    if (patch.lastStatus !== undefined) sets.push(`last_status = ${patch.lastStatus ? esc(patch.lastStatus) : 'NULL'}`);
    if (patch.lastRunId !== undefined) sets.push(`last_run_id = ${patch.lastRunId ? esc(patch.lastRunId) : 'NULL'}`);
    if (patch.nextRunAt !== undefined) sets.push(`next_run_at = ${patch.nextRunAt ? esc(patch.nextRunAt) : 'NULL'}`);
    if (patch.enabled !== undefined) sets.push(`enabled = ${patch.enabled}`);
    if (!sets.length) return;
    await conn.run(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ${esc(id)}`);
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
