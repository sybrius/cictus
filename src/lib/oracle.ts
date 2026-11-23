import { z } from 'zod';
import dns from 'node:dns/promises';
import net from 'net';
import oracledb from 'oracledb';
import type { DatabaseSchema, TableInfo, ViewInfo } from './sqlserver';

/**
 * Oracle as a migration source (oracledb thin mode — no Oracle
 * Instant Client needed on the machine running the app).
 *
 * Scope: tables owned by the connecting user (OWNER = the login
 * user, upper-cased). Cross-schema migration is not supported — the
 * Oracle user should be the schema owner, which is the usual setup
 * for a migration account.
 *
 * Known limits (documented, not hidden): Oracle column defaults are
 * carried only when they translate cleanly (SYSDATE → now()); a
 * sequence default (`SEQ.NEXTVAL`) is dropped rather than failing
 * the table — the target column keeps its values from the data copy
 * and its identity sequence is re-seeded afterwards. Oracle
 * `NUMBER` values stream as strings so 38-digit precision is never
 * lost to JS numbers.
 */

export const OracleConfigSchema = z.object({
  host: z.string().min(1, 'Oracle host is required'),
  port: z.number().int().min(1).max(65535).default(1521),
  service: z.string().min(1, 'Service name (or SID) is required'),
  user: z.string().min(1, 'Oracle user is required'),
  password: z.string().min(1, 'Oracle password is required'),
});

export type OracleConfig = z.infer<typeof OracleConfigSchema>;

function connectString(cfg: OracleConfig): string {
  return `${cfg.host}:${cfg.port}/${cfg.service}`;
}

async function connect(cfg: OracleConfig) {
  return oracledb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: connectString(cfg),
  });
}

export async function testOracleConnection(cfg: OracleConfig): Promise<{
  ok: boolean;
  version?: string;
  database?: string;
  error?: string;
}> {
  let conn: oracledb.Connection | null = null;
  try {
    conn = await connect(cfg);
    const version = await conn.execute<{ BANNER: string }>(
      `SELECT BANNER FROM v$version WHERE ROWNUM = 1`,
    );
    return {
      ok: true,
      version: version.rows?.[0]?.BANNER?.split('\n')[0],
      database: cfg.service,
    };
  } catch (err) {
    return { ok: false, error: explainOracleError(err) };
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

export async function diagnoseOracle(cfg: OracleConfig): Promise<{
  dns: { ok: boolean; address?: string; error?: string };
  tcp: { ok: boolean; error?: string };
  hint: string;
}> {
  let dnsResult: { ok: boolean; address?: string; error?: string } = { ok: false };
  try {
    const addrs = await dns.lookup(cfg.host);
    dnsResult = { ok: true, address: addrs.address };
  } catch (err) {
    dnsResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return {
      dns: dnsResult,
      tcp: { ok: false, error: 'Skipped — DNS failed' },
      hint: `Host "${cfg.host}" does not resolve from where the app is running. Check the host.`,
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
    socket.connect(cfg.port, cfg.host);
  });
  return {
    dns: dnsResult,
    tcp,
    hint: tcp.ok
      ? `DNS and TCP to ${cfg.host}:${cfg.port} are fine — if the test still fails, it is a login or service-name problem (ORA-01017 / ORA-12514).`
      : `Nothing is listening on ${cfg.host}:${cfg.port}. Check the host and port, and that the Oracle listener is running (lsnrctl status on the server).`,
  };
}

export function explainOracleError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ORA-01017/.test(msg)) return 'Invalid Oracle username or password (ORA-01017).';
  if (/ORA-12154/.test(msg)) return 'Could not resolve the connect identifier (ORA-12154) — check the host, port and service name.';
  if (/ORA-12514/.test(msg)) return `The listener does not know the service "${''}" (ORA-12514) — the service name is wrong, or the database is not registered with the listener.`;
  if (/ORA-12541/.test(msg)) return 'No listener on that host:port (ORA-12541) — the Oracle listener is not running there.';
  if (/ORA-12545/.test(msg)) return 'Connect failed — the target host does not exist (ORA-12545). Check the host.';
  if (/ORA-28000/.test(msg)) return 'The Oracle account is locked (ORA-28000) — unlock it on the server.';
  if (/ORA-28001/.test(msg)) return 'The Oracle password has expired (ORA-28001) — reset it on the server.';
  if (/ORA-00942/.test(msg)) return 'Table or view does not exist (ORA-00942) — the connecting user cannot see it (wrong owner, or missing SELECT grant).';
  if (/NJS-/.test(msg)) return `Oracle network error: ${msg}`;
  if (/ECONNREFUSED/i.test(msg)) return 'Connection refused — nothing is listening on that host:port.';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'Host does not resolve (DNS) — check the host.';
  if (/ETIMEDOUT|timeout/i.test(msg)) return 'Connection timed out — the host is unreachable or the port is filtered.';
  return msg;
}

/** Oracle LONG columns (DATA_DEFAULT, view TEXT) come back as strings
 *  from oracledb; be defensive anyway. */
function longToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return null;
}

export async function introspectOracleSchema(cfg: OracleConfig): Promise<DatabaseSchema> {
  let conn: oracledb.Connection | null = null;
  try {
    conn = await connect(cfg);
    const owner = cfg.user.toUpperCase();
    const tablesRes = await conn.execute<{ TABLE_NAME: string }>(
      `SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = :owner ORDER BY TABLE_NAME`,
      [owner],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const colsRes = await conn.execute<{
      TABLE_NAME: string; COLUMN_NAME: string; COLUMN_ID: number; DATA_TYPE: string;
      DATA_LENGTH: number | null; CHAR_LENGTH: number | null; DATA_PRECISION: number | null;
      DATA_SCALE: number | null; NULLABLE: string; DATA_DEFAULT: unknown; IDENTITY_COLUMN: string;
    }>(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_ID, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH,
       DATA_PRECISION, DATA_SCALE, NULLABLE, DATA_DEFAULT, IDENTITY_COLUMN
       FROM ALL_TAB_COLUMNS WHERE OWNER = :owner ORDER BY TABLE_NAME, COLUMN_ID`,
      [owner],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const pkRes = await conn.execute<{ TABLE_NAME: string; COLUMN_NAME: string }>(
      `SELECT cc.TABLE_NAME, cc.COLUMN_NAME
       FROM ALL_CONSTRAINTS c JOIN ALL_CONS_COLUMNS cc
         ON c.OWNER = cc.OWNER AND c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
       WHERE c.OWNER = :owner AND c.CONSTRAINT_TYPE = 'P'
       ORDER BY cc.TABLE_NAME, cc.POSITION`,
      [owner],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const fkRes = await conn.execute<{
      TABLE_NAME: string; CONSTRAINT_NAME: string; COLUMN_NAME: string;
      R_TABLE_NAME: string; R_COLUMN_NAME: string; DELETE_RULE: string;
    }>(
      `SELECT c.TABLE_NAME, c.CONSTRAINT_NAME, cc.COLUMN_NAME,
       rc.TABLE_NAME AS R_TABLE_NAME, rcc.COLUMN_NAME AS R_COLUMN_NAME,
       c.DELETE_RULE
       FROM ALL_CONSTRAINTS c
       JOIN ALL_CONS_COLUMNS cc ON c.OWNER = cc.OWNER AND c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
       JOIN ALL_CONSTRAINTS rc ON c.R_OWNER = rc.OWNER AND c.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME
       JOIN ALL_CONS_COLUMNS rcc ON rc.OWNER = rcc.OWNER AND rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME
         AND cc.POSITION = rcc.POSITION
       WHERE c.OWNER = :owner AND c.CONSTRAINT_TYPE = 'R'
       ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`,
      [owner],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const ixRes = await conn.execute<{
      TABLE_NAME: string; INDEX_NAME: string; UNIQUENESS: string; COLUMN_NAME: string;
    }>(
      `SELECT i.TABLE_NAME, i.INDEX_NAME, i.UNIQUENESS, ic.COLUMN_NAME
       FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS ic
         ON i.OWNER = ic.INDEX_OWNER AND i.INDEX_NAME = ic.INDEX_NAME
       WHERE i.OWNER = :owner AND i.INDEX_NAME NOT IN (
         SELECT CONSTRAINT_NAME FROM ALL_CONSTRAINTS WHERE OWNER = :owner AND CONSTRAINT_TYPE = 'P'
       )
       ORDER BY i.TABLE_NAME, i.INDEX_NAME, ic.COLUMN_POSITION`,
      [owner, owner],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const viewsRes = await conn.execute<{ VIEW_NAME: string; TEXT: unknown }>(
      `SELECT VIEW_NAME, TEXT FROM ALL_VIEWS WHERE OWNER = :owner ORDER BY VIEW_NAME`,
      [owner],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );

    const tables: TableInfo[] = [];
    for (const t of tablesRes.rows ?? []) {
      const tableName = t.TABLE_NAME;
      const cols = (colsRes.rows ?? []).filter((c) => c.TABLE_NAME === tableName);
      const pk = (pkRes.rows ?? [])
        .filter((r) => r.TABLE_NAME === tableName)
        .map((r) => r.COLUMN_NAME);
      const fks = (fkRes.rows ?? [])
        .filter((r) => r.TABLE_NAME === tableName)
        .map((r) => ({
          name: r.CONSTRAINT_NAME,
          column: r.COLUMN_NAME,
          referencedSchema: owner,
          referencedTable: r.R_TABLE_NAME,
          referencedColumn: r.R_COLUMN_NAME,
          onDelete: r.DELETE_RULE ?? 'NO ACTION',
          onUpdate: 'NO ACTION', // Oracle has no ON UPDATE
        }));
      const ixByName = new Map<string, { name: string; isUnique: boolean; columns: string[] }>();
      for (const r of ixRes.rows ?? []) {
        if (r.TABLE_NAME !== tableName) continue;
        const cur = ixByName.get(r.INDEX_NAME) ?? { name: r.INDEX_NAME, isUnique: r.UNIQUENESS === 'UNIQUE', columns: [] };
        cur.columns.push(r.COLUMN_NAME);
        ixByName.set(r.INDEX_NAME, cur);
      }
      let rowCount = 0;
      try {
        const c = await conn.execute<{ N: number }>(
          `SELECT COUNT(*) AS N FROM "${owner}"."${tableName}"`,
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        rowCount = Number(c.rows?.[0]?.N ?? 0);
      } catch {
        rowCount = 0;
      }
      tables.push({
        schema: owner,
        name: tableName,
        columns: cols.map((c) => ({
          schema: owner,
          table: tableName,
          name: c.COLUMN_NAME,
          ordinal: c.COLUMN_ID,
          dataType: c.DATA_TYPE,
          maxLength: c.CHAR_LENGTH,
          numericPrecision: c.DATA_PRECISION,
          numericScale: c.DATA_SCALE,
          datetimePrecision: null,
          isNullable: c.NULLABLE === 'Y',
          isIdentity: c.IDENTITY_COLUMN === 'YES',
          defaultValue: longToString(c.DATA_DEFAULT),
          collation: null,
          sourceExtra: c.DATA_TYPE,
        })),
        primaryKey: pk,
        foreignKeys: fks,
        indexes: [...ixByName.values()].map((ix) => ({
          name: ix.name,
          isUnique: ix.isUnique,
          isPrimaryKey: false,
          columns: ix.columns,
        })),
        rowCount,
      });
    }
    const views: ViewInfo[] = (viewsRes.rows ?? []).map((v) => ({
      schema: owner,
      name: v.VIEW_NAME,
      definition: longToString(v.TEXT) ?? '',
    }));
    return { database: cfg.service, tables, views };
  } catch (err) {
    throw new Error(explainOracleError(err));
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

export async function streamOracleTableRows(
  cfg: OracleConfig,
  schema: string,
  table: string,
  batchSize: number,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<number> {
  if (!/^[A-Za-z0-9_]+$/.test(schema) || !/^[A-Za-z0-9_]+$/.test(table)) {
    throw new Error(`Unsafe table name: ${schema}.${table}`);
  }
  let conn: oracledb.Connection | null = null;
  try {
    conn = await connect(cfg);
    const pk = await conn.execute<{ COLUMN_NAME: string }>(
      `SELECT cc.COLUMN_NAME FROM ALL_CONSTRAINTS c JOIN ALL_CONS_COLUMNS cc
         ON c.OWNER = cc.OWNER AND c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
       WHERE c.OWNER = :owner AND c.TABLE_NAME = :t AND c.CONSTRAINT_TYPE = 'P'
       ORDER BY cc.POSITION`,
      [schema, table],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const orderBy = (pk.rows?.length ?? 0) > 0
      ? ` ORDER BY ${(pk.rows ?? []).map((r) => `"${r.COLUMN_NAME}"`).join(', ')}`
      : '';
    const result = await conn.execute<Record<string, unknown>>(
      `SELECT * FROM "${schema}"."${table}"${orderBy}`,
      [],
      {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        resultSet: true,
        fetchArraySize: batchSize,
        // fetchAsString / fetchAsBuffer are valid runtime options
        // (NUMBER as string keeps 38-digit precision; CLOBs as
        // strings, BLOBs as Buffers) but @types/oracledb omits them
        // from ExecuteOptions, so the cast below is needed.
        fetchAsString: [oracledb.NUMBER, oracledb.CLOB, oracledb.NCLOB],
        fetchAsBuffer: [oracledb.BLOB],
      } as oracledb.ExecuteOptions,
    );
    const rs = result.resultSet;
    if (!rs) return 0;
    let total = 0;
    try {
      for (;;) {
        // Server-side cursor paging: getRows pulls the next batch
        // from the open result set until it is empty.
        const rows = await rs.getRows(batchSize);
        if (rows.length === 0) break;
        total += rows.length;
        await onBatch(rows as Record<string, unknown>[]);
      }
    } finally {
      await rs.close().catch(() => undefined);
    }
    return total;
  } catch (err) {
    throw new Error(explainOracleError(err));
  } finally {
    await conn?.close().catch(() => undefined);
  }
}
