import { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export const TargetConfigSchema = z.object({
  connectionString: z
    .string()
    .min(1, 'NHost Postgres connection string is required')
    .refine((s) => s.startsWith('postgres://') || s.startsWith('postgresql://'), {
      message: 'Connection string must start with postgres://',
    }),
});

export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export function createTargetPool(cfg: TargetConfig): Pool {
  return new Pool({
    connectionString: cfg.connectionString,
    max: 5,
    connectionTimeoutMillis: 15_000,
    // NHost Postgres requires SSL on the public endpoint.
    ssl: { rejectUnauthorized: false },
  });
}

export async function testTargetConnection(cfg: TargetConfig): Promise<{
  ok: boolean;
  version?: string;
  database?: string;
  postgis?: boolean;
  error?: string;
}> {
  const pool = createTargetPool(cfg);
  try {
    const version = await pool.query<{ version: string }>('SELECT version() AS version');
    const db = await pool.query<{ db: string }>('SELECT current_database() AS db');
    const postgis = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_extension WHERE extname = 'postgis'",
    );
    return {
      ok: true,
      version: version.rows[0]?.version?.split(' ').slice(0, 2).join(' '),
      database: db.rows[0]?.db,
      postgis: Number(postgis.rows[0]?.n ?? 0) > 0,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Run a list of DDL statements inside a single transaction. */
export async function executeDdlInTransaction(
  pool: Pool,
  statements: string[],
  onStatement?: (sql: string) => void,
): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const stmt of statements) {
      onStatement?.(stmt);
      await client.query(stmt);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Row count for a target table (schema-qualified, validated identifiers). */
export async function targetRowCount(
  pool: Pool,
  schema: string,
  table: string,
): Promise<number> {
  if (!/^[A-Za-z0-9_]+$/.test(schema) || !/^[A-Za-z0-9_ \-]+$/.test(table)) {
    throw new Error(`Unsafe table name: ${schema}.${table}`);
  }
  const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM "${schema}"."${table}"`);
  return Number(r.rows[0]?.n ?? 0);
}
