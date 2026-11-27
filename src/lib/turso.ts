import { createClient, type Client } from '@libsql/client';

/**
 * Turso (libsql) store for migration history, schedules and accounts.
 *
 * This replaces the old local DuckDB file (`data/migrations.duckdb`).
 * History, schedules and now user accounts live in one Turso database,
 * so they survive restarts, are shared by every process that points
 * at the same database, and there is no single-writer file lock and
 * no native module for Windows Application Control to block.
 *
 * Configuration (`.env.local`, never committed):
 *   TURSO_DATABASE_URL   e.g. libsql://<db-name>-<org>.turso.io
 *   TURSO_AUTH_TOKEN     the database's auth token
 *
 * The client is created lazily, on first use — never at import time —
 * so a missing or bad configuration degrades gracefully instead of
 * crashing the server at startup. When Turso is unavailable the app
 * keeps running: migrations still work, runs are simply not recorded,
 * and schedules live only in memory until the server restarts. The
 * Dashboard and History pages show a notice in that case (see
 * `tursoUnavailableReason()`). Accounts, however, need Turso: without
 * it nobody can sign in, and the login page says so.
 *
 * A local SQLite file also works as the URL (`file:path/to/db.sqlite`)
 * — handy for a smoke test without touching the real database. The
 * SQL below is plain SQLite, so it runs identically against a local
 * file and against Turso.
 *
 * Tables are created on first use (`ensureTursoSchema`), and columns
 * added after the first release are added the same way, so an older
 * database picks them up without a migration script. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so `ensureColumn` checks
 * `PRAGMA table_info` first.
 *
 * All queries are parameterised (`?` placeholders) — values are never
 * interpolated into SQL.
 */

interface TursoGlobal {
  /** Lazily created libsql client (null = env missing / creation failed). */
  client?: Client | null;
  /** Shared schema-creation promise; reset on failure so a later call retries. */
  initPromise?: Promise<void> | null;
  /** Set when Turso is unavailable; null while untested or healthy. */
  unavailableReason?: string | null;
}
const tursoGlobal = globalThis as typeof globalThis & { __cictusTurso?: TursoGlobal };

function getStore(): TursoGlobal {
  if (!tursoGlobal.__cictusTurso) tursoGlobal.__cictusTurso = {};
  return tursoGlobal.__cictusTurso;
}

/** Non-null when Turso is unavailable in this process. Read it after a
 *  store call (e.g. listRuns) so the load has been attempted. */
export function tursoUnavailableReason(): string | null {
  return getStore().unavailableReason ?? null;
}

/** The shared client, or null when it cannot be created (missing env
 *  vars or an invalid URL). The reason is cached on the shared store. */
export function getTursoClient(): Client | null {
  const store = getStore();
  if (store.client !== undefined) return store.client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    store.unavailableReason =
      'TURSO_DATABASE_URL is not set. Add it (and TURSO_AUTH_TOKEN) to .env.local and restart the server — see .env.example.';
    store.client = null;
    return null;
  }
  try {
    store.client = createClient({ url, authToken });
    store.unavailableReason = null;
    return store.client;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    store.unavailableReason = `Could not connect to Turso: ${msg}`;
    console.warn(`[cictus] Turso client could not be created. Reason: ${msg}`);
    store.client = null;
    return null;
  }
}

async function ensureColumn(client: Client, table: string, column: string, type: string): Promise<void> {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const names = new Set(info.rows.map((r) => String((r as Record<string, unknown>).name)));
  if (!names.has(column)) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

async function ensureTursoSchema(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    started_at TEXT,
    finished_at TEXT,
    status TEXT,
    source_name TEXT,
    target_name TEXT,
    target_type TEXT,
    tables_total INTEGER,
    tables_succeeded INTEGER,
    rows_copied INTEGER,
    views_created INTEGER,
    views_total INTEGER,
    errors_count INTEGER
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS migration_tables (
    run_id TEXT,
    table_name TEXT,
    source_rows INTEGER,
    target_rows INTEGER,
    matched INTEGER,
    status TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS migration_errors (
    run_id TEXT,
    scope TEXT,
    message TEXT
  )`);
  // Columns added after the first release — added here so older
  // databases pick them up without a migration script.
  await ensureColumn(client, 'migrations', 'trigger', 'TEXT');
  await ensureColumn(client, 'migrations', 'run_name', 'TEXT');
  await ensureColumn(client, 'migrations', 'schedule_id', 'TEXT');
  await client.execute(`CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT,
    source_connector_id TEXT,
    target_connector_id TEXT,
    tables_json TEXT,
    views_json TEXT,
    include_data INTEGER,
    drop_existing INTEGER,
    use_copy INTEGER,
    cron TEXT,
    enabled INTEGER,
    last_run_at TEXT,
    last_status TEXT,
    last_run_id TEXT,
    next_run_at TEXT,
    created_at TEXT
  )`);
  await ensureColumn(client, 'schedules', 'track_in_hasura', 'INTEGER');
  await client.execute(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

/** True for errors that mean "Turso cannot be reached right now"
 *  (as opposed to a bad query, which should surface as a bug). */
function isConnectionError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket|timeout|502|503|unauthorized|invalid auth|expired token/i.test(msg);
}

/** Run `fn` against the Turso client, creating the tables once.
 *  Returns null when Turso is unavailable (degraded mode) — callers
 *  fall back instead of throwing, so a missing database never breaks
 *  a migration or a page load. A genuine query error (not a
 *  connectivity problem) still throws, so bugs stay visible. */
export async function withTurso<T>(fn: (client: Client) => Promise<T>): Promise<T | null> {
  const client = getTursoClient();
  if (!client) return null;
  const store = getStore();
  try {
    if (!store.initPromise) {
      store.initPromise = ensureTursoSchema(client).catch((e) => {
        store.initPromise = null;
        throw e;
      });
    }
    await store.initPromise;
    const result = await fn(client);
    store.unavailableReason = null;
    return result;
  } catch (e) {
    if (!isConnectionError(e)) throw e;
    const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    store.unavailableReason = `Could not reach Turso: ${msg}`;
    console.warn(
      '[cictus] Turso is unreachable — migration history will not be recorded ' +
        'and schedules will only live in memory until the server restarts. ' +
        'Migrations themselves still work. ' +
        `Reason: ${msg}`,
    );
    return null;
  }
}
