import { z } from 'zod';
import { Pool } from 'pg';
import dns from 'node:dns/promises';
import net from 'net';
import type { DatabaseSchema, TableInfo, ViewInfo } from './sqlserver';
import { testTargetConnection } from './postgres';

/**
 * PostgreSQL as a migration SOURCE — same engine, different source.
 *
 * The target is also Postgres, so the type mapping is mostly
 * normalisation (see mapPostgresType). Introspection reads
 * information_schema + pg_catalog (indexes live in pg_catalog —
 * information_schema has no usable index view).
 *
 * The source connection is a plain Postgres connection string, the
 * same shape as a target: `postgres://user:pw@host:5432/db`.
 */

export const PostgresSourceConfigSchema = z.object({
  connectionString: z
    .string()
    .min(1, 'Postgres source connection string is required')
    .refine((s) => s.startsWith('postgres://') || s.startsWith('postgresql://'), {
      message: 'Connection string must start with postgres://',
    }),
});

export type PostgresSourceConfig = z.infer<typeof PostgresSourceConfigSchema>;

function poolFor(cfg: PostgresSourceConfig): Pool {
  return new Pool({ connectionString: cfg.connectionString, max: 5, connectionTimeoutMillis: 15_000 });
}

export async function testPostgresSourceConnection(cfg: PostgresSourceConfig) {
  const result = await testTargetConnection({ connectionString: cfg.connectionString });
  if (result.ok) return result;
  return { ...result, error: explainPostgresSourceError(new Error(result.error ?? 'Connection failed')) };
}

function hostPort(cfg: PostgresSourceConfig): { host: string; port: number } {
  try {
    const u = new URL(cfg.connectionString);
    return { host: u.hostname, port: Number(u.port) || 5432 };
  } catch {
    return { host: '', port: 5432 };
  }
}

export async function diagnosePostgresSource(cfg: PostgresSourceConfig): Promise<{
  dns: { ok: boolean; address?: string; error?: string };
  tcp: { ok: boolean; error?: string };
  hint: string;
}> {
  const { host, port } = hostPort(cfg);
  if (!host) {
    return {
      dns: { ok: false, error: 'Could not parse a host from the connection string' },
      tcp: { ok: false, error: 'Skipped — no host' },
      hint: 'The connection string must look like postgres://user:password@host:5432/database.',
    };
  }
  let dnsResult: { ok: boolean; address?: string; error?: string } = { ok: false };
  try {
    const addrs = await dns.lookup(host);
    dnsResult = { ok: true, address: addrs.address };
  } catch (err) {
    dnsResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return {
      dns: dnsResult,
      tcp: { ok: false, error: 'Skipped — DNS failed' },
      hint: `Host "${host}" does not resolve from where the app is running. Check the host in the connection string.`,
    };
  }
  const tcp: { ok: boolean; error?: string } = await new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'Timed out after 5s — port is filtered or the host is unreachable' });
    }, 5000);
    socket.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true });
    });
    socket.connect(port, host);
  });
  return {
    dns: dnsResult,
    tcp,
    hint: tcp.ok
      ? `DNS and TCP to ${host}:${port} are fine — if the test still fails, it is a login, database or SSL problem.`
      : `Nothing is listening on ${host}:${port}. Check the host and port, and that Postgres accepts TCP connections there.`,
  };
}

export function explainPostgresSourceError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? '';
  if (code === '28P01' || /password authentication failed/i.test(msg)) return 'Wrong password for this Postgres user (28P01).';
  if (code === '3D000' || /database .* does not exist/i.test(msg)) return 'The database in the connection string does not exist on this server (3D000).';
  if (code === '28000') return 'Login failed (28000) — the user does not exist or is not allowed to connect from this host (check pg_hba.conf).';
  if (code === '42501' || /permission denied/i.test(msg)) return 'The Postgres user lacks permission to read the schema (42501) — it needs SELECT on information_schema / pg_catalog for the tables being migrated.';
  if (/ECONNREFUSED/i.test(msg)) return 'Connection refused — nothing is listening on that host:port, or a firewall is blocking it.';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'Host does not resolve (DNS) — check the host in the connection string.';
  if (/ETIMEDOUT|timeout/i.test(msg)) return 'Connection timed out — the host is unreachable or the port is filtered.';
  if (/self-signed certificate|SSL/i.test(msg)) return 'SSL/TLS problem — if the server uses a self-signed certificate, add ?sslmode=no-verify (or sslmode=require) to the connection string.';
  return msg;
}

export async function introspectPostgresSchema(cfg: PostgresSourceConfig): Promise<DatabaseSchema> {
  const pool = poolFor(cfg);
  try {
    const db = await pool.query<{ db: string }>('SELECT current_database() AS db');
    const database = db.rows[0]?.db ?? '';
    const tablesRes = await pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name`,
    );
    const colsRes = await pool.query<{
      table_schema: string; table_name: string; column_name: string; ordinal_position: number;
      data_type: string; udt_name: string; character_maximum_length: number | null;
      numeric_precision: number | null; numeric_scale: number | null; datetime_precision: number | null;
      is_nullable: string; column_default: string | null; is_identity: string;
    }>(
      `SELECT table_schema, table_name, column_name, ordinal_position, data_type, udt_name,
       character_maximum_length, numeric_precision, numeric_scale, datetime_precision,
       is_nullable, column_default, is_identity
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position`,
    );
    const pkRes = await pool.query<{ table_schema: string; table_name: string; column_name: string }>(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
    );
    const fkRes = await pool.query<{
      table_schema: string; table_name: string; constraint_name: string; column_name: string;
      ref_schema: string; ref_table: string; ref_column: string; delete_rule: string; update_rule: string;
    }>(
      `SELECT tc.table_schema, tc.table_name, tc.constraint_name, kcu.column_name,
       ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column,
       rc.delete_rule, rc.update_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`,
    );
    // Indexes live in pg_catalog. Expression indexes (indkey contains
    // 0) have no column to join, so they are skipped — documented.
    const ixRes = await pool.query<{
      schema: string; table: string; name: string; isunique: boolean; isprimary: boolean; cols: string[];
    }>(
      `SELECT n.nspname AS schema, t.relname AS table, i.relname AS name,
       ix.indisunique AS isunique, ix.indisprimary AS isprimary,
       array_agg(a.attname ORDER BY k.ord) AS cols
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       GROUP BY n.nspname, t.relname, i.relname, ix.indisunique, ix.indisprimary
       ORDER BY n.nspname, t.relname, i.relname`,
    );
    const viewsRes = await pool.query<{ table_schema: string; table_name: string; view_definition: string }>(
      `SELECT table_schema, table_name, view_definition FROM information_schema.views
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`,
    );

    const tables: TableInfo[] = [];
    for (const t of tablesRes.rows) {
      const cols = colsRes.rows.filter((c) => c.table_schema === t.table_schema && c.table_name === t.table_name);
      const pk = pkRes.rows
        .filter((r) => r.table_schema === t.table_schema && r.table_name === t.table_name)
        .map((r) => r.column_name);
      const fks = fkRes.rows
        .filter((r) => r.table_schema === t.table_schema && r.table_name === t.table_name)
        .map((r) => ({
          name: r.constraint_name,
          column: r.column_name,
          referencedSchema: r.ref_schema,
          referencedTable: r.ref_table,
          referencedColumn: r.ref_column,
          onDelete: r.delete_rule,
          onUpdate: r.update_rule,
        }));
      const indexes = ixRes.rows
        .filter((r) => r.schema === t.table_schema && r.table === t.table_name && !r.isprimary)
        .map((r) => ({ name: r.name, isUnique: r.isunique, isPrimaryKey: false, columns: r.cols }));
      let rowCount = 0;
      try {
        const c = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${t.table_schema}"."${t.table_name}"`,
        );
        rowCount = Number(c.rows[0]?.n ?? 0);
      } catch {
        rowCount = 0;
      }
      tables.push({
        schema: t.table_schema,
        name: t.table_name,
        columns: cols.map((c) => ({
          schema: t.table_schema,
          table: t.table_name,
          name: c.column_name,
          ordinal: c.ordinal_position,
          dataType: c.data_type,
          maxLength: c.character_maximum_length,
          numericPrecision: c.numeric_precision,
          numericScale: c.numeric_scale,
          datetimePrecision: c.datetime_precision,
          isNullable: c.is_nullable === 'YES',
          isIdentity: c.is_identity === 'YES',
          defaultValue: c.column_default,
          collation: null,
          sourceExtra: c.udt_name,
        })),
        primaryKey: pk,
        foreignKeys: fks,
        indexes,
        rowCount,
      });
    }
    const views: ViewInfo[] = viewsRes.rows.map((v) => ({
      schema: v.table_schema,
      name: v.table_name,
      definition: v.view_definition,
    }));
    return { database, tables, views };
  } catch (err) {
    throw new Error(explainPostgresSourceError(err));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Stream one table's rows in batches. Ordered by PK when the table
 *  has one, so LIMIT/OFFSET pages are stable. */
export async function streamPostgresTableRows(
  cfg: PostgresSourceConfig,
  schema: string,
  table: string,
  batchSize: number,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<number> {
  if (!/^[A-Za-z0-9_]+$/.test(schema) || !/^[A-Za-z0-9_ \-]+$/.test(table)) {
    throw new Error(`Unsafe table name: ${schema}.${table}`);
  }
  const pool = poolFor(cfg);
  try {
    const pk = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [schema, table],
    );
    const orderBy = pk.rows.length
      ? ` ORDER BY ${pk.rows.map((r) => `"${r.column_name.replace(/"/g, '""')}"`).join(', ')}`
      : '';
    let offset = 0;
    let total = 0;
    for (;;) {
      const res = await pool.query<Record<string, unknown>>(
        `SELECT * FROM "${schema}"."${table}"${orderBy} LIMIT $1 OFFSET $2`,
        [batchSize, offset],
      );
      if (res.rows.length === 0) break;
      total += res.rows.length;
      await onBatch(res.rows);
      if (res.rows.length < batchSize) break;
      offset += res.rows.length;
    }
    return total;
  } catch (err) {
    throw new Error(explainPostgresSourceError(err));
  } finally {
    await pool.end().catch(() => undefined);
  }
}
