import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Saved connectors — the enterprise bit.
 *
 * A connector is a named, reusable connection to one database:
 * a SQL Server source, or a Postgres target hosted on NHost,
 * Supabase, or any plain PostgreSQL server. Connectors are stored
 * locally in `data/connectors.json` (git-ignored, never committed,
 * never sent to any other service) and the migration wizard can
 * pick one instead of re-typing host / password every time.
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

function filePath(): string {
  return process.env.CONNECTORS_PATH || path.join(process.cwd(), 'data', 'connectors.json');
}

export function loadConnectors(): Connector[] {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Connector[]) : [];
  } catch {
    return [];
  }
}

function saveAll(list: Connector[]): void {
  const dir = path.dirname(filePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(list, null, 2), 'utf8');
}

export function saveConnector(input: ConnectorInput, id?: string): Connector {
  const list = loadConnectors();
  const now = new Date().toISOString();
  if (id) {
    const idx = list.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error('Connector not found');
    const updated: Connector = { ...list[idx], ...input, id, updatedAt: now };
    list[idx] = updated;
    saveAll(list);
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
  list.push(created);
  saveAll(list);
  return created;
}

export function deleteConnector(id: string): void {
  saveAll(loadConnectors().filter((c) => c.id !== id));
}

export function markTested(id: string, ok: boolean, message: string): void {
  const list = loadConnectors();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  c.lastTestedAt = new Date().toISOString();
  c.lastTestOk = ok;
  c.lastTestMessage = message;
  saveAll(list);
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
