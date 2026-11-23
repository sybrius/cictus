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

export type ConnectorType = 'nhost' | 'supabase' | 'postgres' | 'sqlserver' | 'mysql';
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

/** The stored record without the password, for sending to the browser. */
export function publicConnector(c: Connector): Omit<Connector, 'password'> & { password: '' } {
  return { ...c, password: '' };
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

/** Source config for a connector, in the wizard's form shape.
 *  MySQL connectors return ssl + sourceType 'mysql'; SQL Server ones
 *  return the TLS / instance fields with sourceType 'sqlserver'. */
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
      sourceType: 'mysql' as const,
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
    sourceType: 'sqlserver' as const,
  };
}
