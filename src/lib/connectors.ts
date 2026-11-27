import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { withTurso, tursoUnavailableReason } from './turso';

/**
 * Saved connectors — the enterprise bit.
 *
 * A connector is a named, reusable connection to one database:
 * a SQL Server source, or a Postgres target hosted on NHost,
 * Supabase, or any plain PostgreSQL server. Connectors are stored
 * per user in Turso (the `connectors` table, scoped by `user_id`),
 * and the migration wizard can pick one instead of re-typing host
 * / password every time. The same account's connectors follow
 * them to any machine or deployment that points at the same Turso
 * database.
 *
 * Turso is also what makes connectors work on a serverless host:
 * the old local `data/connectors.json` file cannot be written on
 * Vercel (read-only filesystem — saving failed with
 * `ENOENT: no such file or directory, mkdir '/var/task/data'`).
 * A one-time import copies that file's entries into Turso the
 * first time a user lists their connectors (see
 * importLegacyConnectors); afterwards the file is never read or
 * written again.
 *
 * Supabase is plain Postgres: the direct connection is
 * `db.<project-ref>.supabase.co:5432`, user `postgres`, database
 * `postgres`. The pooled connection (`6543`, pooler host) is for
 * short-lived app connections — use the direct 5432 string for DDL
 * and bulk loads, exactly like NHost's direct string.
 *
 * NHost is also plain Postgres: the connection string appears in
 * the NHost dashboard only after public access is enabled, in the
 * form `postgres://postgres:<password>@<subdomain>.db.<region>.nhost.run:5432/postgres`.
 */

export type ConnectorType = 'nhost' | 'supabase' | 'postgres' | 'sqlserver' | 'mysql' | 'postgres-source' | 'oracle' | 'sqlite';
export type ConnectorKind = 'source' | 'target';

export interface Connector {
  id: string;
  name: string;
  kind: ConnectorKind;
  type: ConnectorType;
  /** NHost subdomain, or Supabase project ref. Empty for plain Postgres / SQL Server. */
  projectRef: string;
  region: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Full connection string, when the user pasted one instead of fields. Takes precedence for targets. */
  connectionString: string;
  ssl: boolean;
  /** SQL Server only. */
  instance: string;
  encrypt: boolean;
  trustCert: boolean;
  /** Oracle only: service name (or SID). */
  service: string;
  /** SQLite only: path to the .sqlite / .db file on this machine. */
  filePath: string;
  /** Hasura admin secret for auto-tracking tables after migration
   *  (NHost targets, or a plain Postgres target with a Hasura
   *  endpoint below). Stored like the password — never sent to the
   *  browser, never committed. */
  hasuraAdminSecret: string;
  /** Optional Hasura endpoint override (plain Postgres targets only;
   *  NHost derives https://<subdomain>.hasura.<region>.nhost.run).
   *  May be a base URL (…nhost.run) or a full …/v1/metadata URL. */
  hasuraEndpoint: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

export type ConnectorInput = Omit<Connector, 'id' | 'createdAt' | 'updatedAt' | 'lastTestedAt' | 'lastTestOk' | 'lastTestMessage'>;

export const CONNECTOR_TYPES: Record<ConnectorType, { label: string; kind: ConnectorKind; hint: string }> = {
  nhost: {
    label: 'NHost (Postgres)',
    kind: 'target',
    hint: 'NHost Dashboard → Database → Connection string. Enable public access first; the string appears as postgres://postgres:…@<subdomain>.db.<region>.nhost.run:5432/postgres',
  },
  supabase: {
    label: 'Supabase (Postgres)',
    kind: 'target',
    hint: 'Supabase Dashboard → Project Settings → Database → Connection string (direct, port 5432). Host is db.<project-ref>.supabase.co, user postgres, database postgres.',
  },
  postgres: {
    label: 'PostgreSQL (generic)',
    kind: 'target',
    hint: 'Any Postgres server: host, port (usually 5432), database, user and password.',
  },
  sqlserver: {
    label: 'SQL Server',
    kind: 'source',
    hint: 'Source database. Host, port (1433), database, user and password. Named instance goes in Instance; leave Port at 1433 for a named instance.',
  },
  mysql: {
    label: 'MySQL',
    kind: 'source',
    hint: 'Source database. Host, port (3306), database, user and password. Enable SSL only if the server requires it.',
  },
  'postgres-source': {
    label: 'PostgreSQL (source)',
    kind: 'source',
    hint: 'A Postgres database as a migration source: paste its connection string (postgres://user:…@host:5432/db). Same engine, different database — or a different Postgres server entirely.',
  },
  oracle: {
    label: 'Oracle',
    kind: 'source',
    hint: 'Oracle 12c+ as a migration source (thin driver — no Oracle client needed). Host, port (1521), service name, and the schema-owner user and password. Only tables owned by that user are migrated.',
  },
  sqlite: {
    label: 'SQLite (file)',
    kind: 'source',
    hint: 'A local .sqlite / .db file. Give the path on the machine the app runs on, or upload the file in the wizard. The file is opened read-only.',
  },
};

/** Columns of the `connectors` table, in INSERT order. */
const CONNECTOR_COLS = `id, user_id, name, kind, type, project_ref, region, host, port,
  database, user, password, connection_string, ssl, instance, encrypt, trust_cert,
  service, file_path, hasura_admin_secret, hasura_endpoint, created_at, updated_at,
  last_tested_at, last_test_ok, last_test_message`;

/** The 26 INSERT values for a connector row, in CONNECTOR_COLS order.
 *  Defensive about missing fields: legacy file entries predate
 *  some columns (service, filePath, Hasura fields), so every value
 *  is coerced instead of passed through as undefined. */
function connectorArgs(userId: string, c: Connector): (string | number | null)[] {
  const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v === undefined || v === null ? d : String(v));
  const b = (v: unknown, d: boolean): number => (v === 1 || v === true ? 1 : v === 0 || v === false ? 0 : d ? 1 : 0);
  return [
    s(c.id), userId, s(c.name), c.kind === 'target' ? 'target' : 'source', s(c.type, 'postgres'),
    s(c.projectRef), s(c.region), s(c.host), Number(c.port ?? 0) || 0,
    s(c.database), s(c.user), s(c.password), s(c.connectionString), b(c.ssl, false), s(c.instance),
    b(c.encrypt, true), b(c.trustCert, true), s(c.service), s(c.filePath), s(c.hasuraAdminSecret),
    s(c.hasuraEndpoint), s(c.createdAt), s(c.updatedAt), c.lastTestedAt ? s(c.lastTestedAt) : null,
    c.lastTestOk === null || c.lastTestOk === undefined ? null : c.lastTestOk ? 1 : 0,
    c.lastTestMessage ? s(c.lastTestMessage) : null,
  ];
}

function rowToConnector(row: Record<string, unknown>): Connector {
  const toBool = (v: unknown, d: boolean): boolean =>
    v === 1 || v === true ? true : v === 0 || v === false ? false : d;
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    kind: row.kind === 'target' ? 'target' : 'source',
    type: String(row.type ?? 'postgres') as ConnectorType,
    projectRef: String(row.project_ref ?? ''),
    region: String(row.region ?? ''),
    host: String(row.host ?? ''),
    port: Number(row.port ?? 0),
    database: String(row.database ?? ''),
    user: String(row.user ?? ''),
    password: String(row.password ?? ''),
    connectionString: String(row.connection_string ?? ''),
    ssl: toBool(row.ssl, false),
    instance: String(row.instance ?? ''),
    encrypt: toBool(row.encrypt, true),
    trustCert: toBool(row.trust_cert, true),
    service: String(row.service ?? ''),
    filePath: String(row.file_path ?? ''),
    hasuraAdminSecret: String(row.hasura_admin_secret ?? ''),
    hasuraEndpoint: String(row.hasura_endpoint ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    lastTestedAt: row.last_tested_at ? String(row.last_tested_at) : null,
    lastTestOk:
      row.last_test_ok === null || row.last_test_ok === undefined
        ? null
        : toBool(row.last_test_ok, false),
    lastTestMessage: row.last_test_message ? String(row.last_test_message) : null,
  };
}

/** Error for a connector write attempted while Turso is
 *  unavailable. Reads degrade to [] instead, so pages still load. */
function tursoRequiredError(): Error {
  return new Error(
    'Connectors need Turso — ' +
      (tursoUnavailableReason() ??
        'the database is unreachable right now. Check TURSO_DATABASE_URL / TURSO_AUTH_TOKEN in .env.local and restart the server.'),
  );
}

function legacyFilePath(): string {
  return process.env.CONNECTORS_PATH || path.join(process.cwd(), 'data', 'connectors.json');
}

/** Users whose legacy import was already attempted in this process
 *  (the meta flag below covers other processes and restarts). */
const legacyImportAttempted = new Set<string>();

/** One-time import of the old local `data/connectors.json`
 *  (localhost checkouts created before the Turso move). Runs once
 *  per user, the first time their connectors are listed: entries
 *  are copied into Turso under that user, keeping their ids so
 *  existing schedules keep pointing at the same connectors. A meta
 *  flag records that the import ran, so a user who later deletes
 *  all their connectors does not get them back. On a host with no
 *  local file (e.g. Vercel) the read fails and this is a silent
 *  no-op. */
async function importLegacyConnectors(userId: string): Promise<void> {
  if (!userId || legacyImportAttempted.has(userId)) return;
  const flag = `legacy_connectors_imported:${userId}`;
  const already = await withTurso(async (client) => {
    const result = await client.execute({ sql: `SELECT value FROM meta WHERE key = ?`, args: [flag] });
    return result.rows.length > 0;
  });
  if (already === null) return; // Turso down — retry on a later load.
  legacyImportAttempted.add(userId);
  if (already) return;
  let list: unknown = null;
  try {
    list = JSON.parse(fs.readFileSync(legacyFilePath(), 'utf8'));
  } catch {
    list = null; // No local file (serverless host) — nothing to import.
  }
  await withTurso(async (client) => {
    // Import first, flag last: if the loop throws midway, the flag
    // stays unset and a later load retries (INSERT OR IGNORE skips
    // the entries that already landed).
    if (Array.isArray(list)) {
      for (const raw of list as Record<string, unknown>[]) {
        if (!raw || typeof raw.id !== 'string') continue;
        const c = raw as unknown as Connector;
        await client.execute({
          sql: `INSERT OR IGNORE INTO connectors (${CONNECTOR_COLS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: connectorArgs(userId, {
            ...c,
            kind: c.kind === 'target' ? 'target' : 'source',
            createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date().toISOString(),
            updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : new Date().toISOString(),
            lastTestedAt: (c.lastTestedAt as string | null) ?? null,
            lastTestOk: (c.lastTestOk as boolean | null) ?? null,
            lastTestMessage: (c.lastTestMessage as string | null) ?? null,
          }),
        });
      }
    }
    await client.execute({
      sql: `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
      args: [flag, new Date().toISOString()],
    });
  });
}

/** All connectors belonging to one user, oldest first. Returns []
 *  when Turso is unavailable (degraded mode) instead of throwing,
 *  so pages still load. */
export async function loadConnectors(userId: string): Promise<Connector[]> {
  if (!userId) return [];
  await importLegacyConnectors(userId);
  const rows = await withTurso(async (client) => {
    const result = await client.execute({
      sql: `SELECT ${CONNECTOR_COLS} FROM connectors WHERE user_id = ? ORDER BY created_at ASC`,
      args: [userId],
    });
    return result.rows as unknown as Record<string, unknown>[];
  });
  return (rows ?? []).map(rowToConnector);
}

/** One connector, only when it belongs to this user. */
export async function getConnector(userId: string, id: string): Promise<Connector | null> {
  const list = await loadConnectors(userId);
  return list.find((c) => c.id === id) ?? null;
}

export async function saveConnector(userId: string, input: ConnectorInput, id?: string): Promise<Connector> {
  if (!userId) throw tursoRequiredError();
  const now = new Date().toISOString();
  if (id) {
    const existing = await getConnector(userId, id);
    if (!existing) throw new Error('Connector not found');
    const updated: Connector = { ...existing, ...input, id, updatedAt: now };
    // Delete + insert keeps it simple and avoids relying on
    // ON CONFLICT support (same pattern as saveSchedule).
    const ran = await withTurso(async (client) => {
      await client.execute({ sql: `DELETE FROM connectors WHERE id = ? AND user_id = ?`, args: [id, userId] });
      await client.execute({
        sql: `INSERT INTO connectors (${CONNECTOR_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: connectorArgs(userId, updated),
      });
    });
    if (ran === null) throw tursoRequiredError();
    return updated;
  }
  const created: Connector = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    lastTestedAt: null,
    lastTestOk: null,
    lastTestMessage: null,
  };
  const ran = await withTurso(async (client) => {
    await client.execute({
      sql: `INSERT INTO connectors (${CONNECTOR_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: connectorArgs(userId, created),
    });
  });
  if (ran === null) throw tursoRequiredError();
  return created;
}

export async function deleteConnector(userId: string, id: string): Promise<void> {
  await withTurso(async (client) => {
    await client.execute({ sql: `DELETE FROM connectors WHERE id = ? AND user_id = ?`, args: [id, userId] });
  });
}

export async function markTested(userId: string, id: string, ok: boolean, message: string): Promise<void> {
  await withTurso(async (client) => {
    await client.execute({
      sql: `UPDATE connectors SET last_tested_at = ?, last_test_ok = ?, last_test_message = ?
        WHERE id = ? AND user_id = ?`,
      args: [new Date().toISOString(), ok ? 1 : 0, message, id, userId],
    });
  });
}

/** The stored record without the password or Hasura secret, for
 *  sending to the browser. `hasHasuraSecret` tells the UI whether a
 *  secret is saved, without revealing it. */
export function publicConnector(c: Connector): Omit<Connector, 'password' | 'hasuraAdminSecret'> & { password: ''; hasuraAdminSecret: ''; hasHasuraSecret: boolean } {
  return { ...c, password: '', hasuraAdminSecret: '', hasHasuraSecret: Boolean(c.hasuraAdminSecret) };
}

/** Build the Postgres connection string for a target connector. */
export function targetConnectionString(c: Connector): string {
  if (c.connectionString.trim()) return c.connectionString.trim();
  const pw = encodeURIComponent(c.password);
  if (c.type === 'nhost' && c.projectRef) {
    const region = c.region || 'eu-central-1';
    return `postgres://postgres:${pw}@${c.projectRef}.db.${region}.nhost.run:5432/postgres`;
  }
  if (c.type === 'supabase' && c.projectRef) {
    const host = c.host || `db.${c.projectRef}.supabase.co`;
    return `postgres://postgres:${pw}@${host}:${c.port || 5432}/postgres`;
  }
  return `postgres://${encodeURIComponent(c.user)}:${pw}@${c.host}:${c.port || 5432}/${c.database || 'postgres'}`;
}

/** Source config for a connector, in the wizard's form shape. */
export function sourceFormValues(c: Connector) {
  if (c.type === 'mysql') {
    return {
      host: c.host,
      port: c.port || 3306,
      user: c.user,
      password: c.password,
      database: c.database,
      trustCert: false,
      encrypt: false,
      instance: '',
      ssl: c.ssl,
      connectionString: '',
      service: '',
      filePath: '',
      sourceType: 'mysql' as const,
    };
  }
  if (c.type === 'postgres-source') {
    return {
      host: c.host,
      port: c.port || 5432,
      user: c.user,
      password: c.password,
      database: c.database,
      trustCert: false,
      encrypt: false,
      instance: '',
      ssl: c.ssl,
      connectionString: c.connectionString,
      service: '',
      filePath: '',
      sourceType: 'postgres' as const,
    };
  }
  if (c.type === 'oracle') {
    return {
      host: c.host,
      port: c.port || 1521,
      user: c.user,
      password: c.password,
      database: c.database,
      trustCert: false,
      encrypt: false,
      instance: '',
      ssl: false,
      connectionString: '',
      service: c.service,
      filePath: '',
      sourceType: 'oracle' as const,
    };
  }
  if (c.type === 'sqlite') {
    return {
      host: '',
      port: 0,
      user: '',
      password: '',
      database: '',
      trustCert: false,
      encrypt: false,
      instance: '',
      ssl: false,
      connectionString: '',
      service: '',
      filePath: c.filePath,
      sourceType: 'sqlite' as const,
    };
  }
  return {
    host: c.host,
    port: c.port || 1433,
    user: c.user,
    password: c.password,
    database: c.database,
    trustCert: c.trustCert,
    encrypt: c.encrypt,
    instance: c.instance,
    ssl: false,
    connectionString: '',
    service: '',
    filePath: '',
    sourceType: 'sqlserver' as const,
  };
}
