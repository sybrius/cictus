import { SqlServerConfigSchema, introspectSchema, testSqlServerConnection, diagnoseSqlServer } from './sqlserver';
import { MysqlConfigSchema, introspectMysqlSchema, testMysqlConnection, diagnoseMysql } from './mysql';
import { PostgresSourceConfigSchema, introspectPostgresSchema, testPostgresSourceConnection, diagnosePostgresSource } from './postgres-source';
import { OracleConfigSchema, introspectOracleSchema, testOracleConnection, diagnoseOracle } from './oracle';
import { SqliteConfigSchema, introspectSqliteSchema, testSqliteConnection, diagnoseSqlite } from './sqlite';
import type { SourceKind } from './type-map';
import type { DatabaseSchema } from './sqlserver';
import type { SourceConnection } from './migrate-data';

/**
 * One dispatch point for all five sources, so the API routes, the
 * migration engine and the connector test do not each grow their
 * own five-way if/else. Each function validates the config against
 * the matching zod schema and throws a plain-English error on
 * failure; the callers map that to a 400 (validation) or 502
 * (connection / introspection failure).
 */

export function parseSourceConfig(sourceType: SourceKind, config: unknown): SourceConnection['config'] {
  let parsed: { success: boolean; data?: unknown; error?: { issues: { message: string }[] } };
  switch (sourceType) {
    case 'mysql': parsed = MysqlConfigSchema.safeParse(config); break;
    case 'postgres': parsed = PostgresSourceConfigSchema.safeParse(config); break;
    case 'oracle': parsed = OracleConfigSchema.safeParse(config); break;
    case 'sqlite': parsed = SqliteConfigSchema.safeParse(config); break;
    default: parsed = SqlServerConfigSchema.safeParse(config); break;
  }
  if (!parsed.success) {
    throw new Error(parsed.error!.issues.map((i) => i.message).join('; '));
  }
  return parsed.data as SourceConnection['config'];
}

export async function introspectSource(sourceType: SourceKind, config: unknown): Promise<DatabaseSchema> {
  const cfg = parseSourceConfig(sourceType, config);
  switch (sourceType) {
    case 'mysql': return introspectMysqlSchema(cfg as Parameters<typeof introspectMysqlSchema>[0]);
    case 'postgres': return introspectPostgresSchema(cfg as Parameters<typeof introspectPostgresSchema>[0]);
    case 'oracle': return introspectOracleSchema(cfg as Parameters<typeof introspectOracleSchema>[0]);
    case 'sqlite': return introspectSqliteSchema(cfg as Parameters<typeof introspectSqliteSchema>[0]);
    default: return introspectSchema(cfg as Parameters<typeof introspectSchema>[0]);
  }
}

export async function testSourceConnection(
  sourceType: SourceKind,
  config: unknown,
): Promise<{ ok: boolean; version?: string; database?: string; postgis?: boolean; error?: string }> {
  const cfg = parseSourceConfig(sourceType, config);
  switch (sourceType) {
    case 'mysql': return testMysqlConnection(cfg as Parameters<typeof testMysqlConnection>[0]);
    case 'postgres': return testPostgresSourceConnection(cfg as Parameters<typeof testPostgresSourceConnection>[0]);
    case 'oracle': return testOracleConnection(cfg as Parameters<typeof testOracleConnection>[0]);
    case 'sqlite': return testSqliteConnection(cfg as Parameters<typeof testSqliteConnection>[0]);
    default: return testSqlServerConnection(cfg as Parameters<typeof testSqlServerConnection>[0]);
  }
}

export async function diagnoseSource(
  sourceType: SourceKind,
  config: unknown,
): Promise<{
  dns: { ok: boolean; address?: string; error?: string };
  tcp: { ok: boolean; error?: string };
  hint: string;
}> {
  const cfg = parseSourceConfig(sourceType, config);
  switch (sourceType) {
    case 'mysql': return diagnoseMysql(cfg as Parameters<typeof diagnoseMysql>[0]);
    case 'postgres': return diagnosePostgresSource(cfg as Parameters<typeof diagnosePostgresSource>[0]);
    case 'oracle': return diagnoseOracle(cfg as Parameters<typeof diagnoseOracle>[0]);
    case 'sqlite': return diagnoseSqlite(cfg as Parameters<typeof diagnoseSqlite>[0]);
    default: return diagnoseSqlServer(cfg as Parameters<typeof diagnoseSqlServer>[0]);
  }
}

/** The `database` argument for view conversion: MySQL database name,
 *  Oracle owner, otherwise ''. */
export function viewDatabaseArg(sourceType: SourceKind, config: unknown): string {
  const cfg = config as { database?: string; user?: string };
  if (sourceType === 'mysql') return cfg?.database ?? '';
  if (sourceType === 'oracle') return (cfg?.user ?? '').toUpperCase();
  return '';
}
