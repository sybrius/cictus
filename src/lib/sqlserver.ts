import sql from 'mssql';
import { z } from 'zod';
import dns from 'node:dns/promises';
import net from 'node:net';

/** Connection settings supplied by the wizard (never stored server-side
 *  beyond the request that uses them). */
export const SqlServerConfigSchema = z.object({
  host: z.string().min(1, 'Host is required'),
  port: z.coerce.number().int().min(1).max(65535).default(1433),
  user: z.string().min(1, 'User is required'),
  password: z.string().min(1, 'Password is required'),
  database: z.string().min(1, 'Database is required'),
  trustCert: z.boolean().default(true),
  encrypt: z.boolean().default(true),
  instance: z.string().optional(),
});

export type SqlServerConfig = z.infer<typeof SqlServerConfigSchema>;

export interface ColumnInfo {
  schema: string;
  table: string;
  name: string;
  ordinal: number;
  dataType: string;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  datetimePrecision: number | null;
  isNullable: boolean;
  isIdentity: boolean;
  defaultValue: string | null;
  collation: string | null;
  /** Source-specific extra type text. MySQL sets this to COLUMN_TYPE
   *  (e.g. `tinyint(1)`, `int unsigned`, `enum('a','b')`) — what
   *  DATA_TYPE drops and the MySQL type mapper needs. SQL Server
   *  leaves it undefined. */
  sourceExtra?: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
  onDelete: string;
  onUpdate: string;
}

export interface IndexInfo {
  name: string;
  isUnique: boolean;
  isPrimaryKey: boolean;
  columns: string[];
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  rowCount: number;
}

export interface ViewInfo {
  schema: string;
  name: string;
  definition: string;
}

export interface DatabaseSchema {
  database: string;
  tables: TableInfo[];
  views: ViewInfo[];
}

function toConfig(cfg: SqlServerConfig, encryptOverride?: boolean): sql.config {
  const encrypt = encryptOverride ?? cfg.encrypt ?? true;
  return {
    server: cfg.host,
    // When a named instance is given, tedious resolves its port via the
    // SQL Browser (UDP 1434). Sending an explicit port as well makes
    // tedious ignore the instance lookup, so omit it in that case.
    ...(cfg.instance ? {} : { port: cfg.port }),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    options: {
      encrypt,
      trustServerCertificate: cfg.trustCert,
      ...(cfg.instance ? { instanceName: cfg.instance } : {}),
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: 120_000,
  };
}

/** Plain-English explanation for the cryptic tedious/mssql errors.
 *  "Could not connect (sequence)" is the pre-login handshake failing:
 *  TCP opened (or was reset) but SQL Server never completed login —
 *  almost always TCP/IP disabled, a named instance on a dynamic port,
 *  the service stopped, a firewall, or a TLS handshake failure. */
export function explainSqlServerError(err: unknown): string {
  const e = err as { code?: string; message?: string; originalError?: { code?: string } };
  const msg = e?.message ?? String(err);
  const code = e?.code ?? e?.originalError?.code ?? '';
  if (/could not connect \(sequence\)/i.test(msg) || code === 'ESOCKET') {
    return (
      `${msg} — the pre-login handshake failed. ` +
      `This usually means: (1) SQL Server is not listening on that host:port — ` +
      `check SQL Server Configuration Manager → SQL Server Network Configuration → ` +
      `Protocols → TCP/IP is Enabled, IPAll TCP Port is 1433, and the service was restarted; ` +
      `(2) it is a named instance (e.g. QYLA\\SQLEXPRESS) on a dynamic port, not 1433 — ` +
      `put SQLEXPRESS in the Instance field and leave Port blank, and make sure the ` +
      `SQL Server Browser service is running; (3) the service is stopped or Windows ` +
      `Firewall is blocking 1433 — test with: Test-NetConnection QYLA -Port 1433; ` +
      `(4) TLS: the app first tries encryption on, then retries with it off — if the ` +
      `retry also fails, it is not a TLS problem. Try Host "localhost" instead of "QYLA" ` +
      `if the app runs on the same PC.`
    );
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return `${msg} — nothing is listening on that host:port. SQL Server is stopped, TCP/IP is disabled, or it listens on a different (dynamic) port. See the TCP/IP / named-instance checks above.`;
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/i.test(msg)) {
    return `${msg} — the host name "${''}" could not be resolved. If the app runs on the same PC as SQL Server, use "localhost" or "127.0.0.1" instead of the PC name; if it runs in Docker/WSL, use the PC's IP address or host.docker.internal.`;
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
    return `${msg} — no reply within 15s. The host may be unreachable, the port blocked by a firewall, or SQL Server is starting up. Test with: Test-NetConnection <host> -Port <port>.`;
  }
  if (code === 'ELOGIN' || /login failed/i.test(msg)) {
    return `${msg} — the server answered, but the login was rejected. Check the username/password, that SQL Server authentication (not only Windows auth) is enabled, and that the login has access to the database.`;
  }
  return msg;
}

/** Step-by-step network diagnosis, without attempting a login.
 *  Lets the UI tell the user whether DNS, TCP:1433, or the login itself failed. */
export async function diagnoseSqlServer(cfg: SqlServerConfig): Promise<{
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
      hint: `Host "${cfg.host}" does not resolve from where the app is running. If the app runs on the same PC as SQL Server, use "localhost" or "127.0.0.1". If it runs in Docker/WSL, use the PC's LAN IP or host.docker.internal.`,
    };
  }

  const port = cfg.instance ? 1434 : cfg.port;
  const tcp: { ok: boolean; error?: string } = await new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, error: 'Timed out after 5s — port is filtered or the host is unreachable' }); }, 5000);
    socket.once('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ ok: true }); });
    socket.connect(cfg.instance ? 1434 : cfg.port, cfg.host);
  });
  void port;

  if (!tcp.ok) {
    return {
      dns: dnsResult,
      tcp,
      hint: cfg.instance
        ? `Could not reach the SQL Browser on ${cfg.host}:1434 (${tcp.error}). The Browser service must be running for a named instance, or use the instance's actual TCP port instead of the instance name.`
        : `Could not open TCP ${cfg.host}:${cfg.port} (${tcp.error}). SQL Server is not listening there — enable TCP/IP in SQL Server Configuration Manager, set IPAll TCP Port to ${cfg.port}, restart the SQL Server service, and allow ${cfg.port} through Windows Firewall. Test from PowerShell: Test-NetConnection ${cfg.host} -Port ${cfg.port}`,
    };
  }
  return {
    dns: dnsResult,
    tcp,
    hint: `DNS and TCP ${cfg.host}:${cfg.port} both work, so the network path is fine — the failure is at login / TLS. Check the username/password, SQL Server authentication mode, and try with "Use encryption" off.`,
  };
}

/** Open a pool, run `fn`, always close it. Keeps credentials request-scoped. */
export async function withSqlServer<T>(
  cfg: SqlServerConfig,
  fn: (pool: sql.ConnectionPool) => Promise<T>,
): Promise<T> {
  const pool = new sql.ConnectionPool(toConfig(cfg));
  try {
    await pool.connect();
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

export async function testSqlServerConnection(cfg: SqlServerConfig): Promise<{
  ok: boolean;
  version?: string;
  database?: string;
  error?: string;
  encryption?: string;
}> {
  // Try the requested encryption setting first; if the pre-login / TLS
  // handshake fails ("Could not connect (sequence)"), retry with
  // encryption off — local SQL Server with a self-signed cert is the
  // most common cause, and the retry distinguishes TLS from TCP failure.
  const attempts: (boolean | undefined)[] = cfg.encrypt === false ? [false] : [undefined, false];
  let lastError: unknown = null;
  for (const encryptOverride of attempts) {
    try {
      const pool = new sql.ConnectionPool(toConfig(cfg, encryptOverride));
      try {
        await pool.connect();
        const r = await pool
          .request()
          .query<{ version: string; db: string }>(
            'SELECT @@VERSION AS version, DB_NAME() AS db',
          );
        return {
          ok: true,
          version: r.recordset[0]?.version?.split('\n')[0],
          database: r.recordset[0]?.db,
          encryption: encryptOverride === false ? 'off (encryption disabled — retry succeeded)' : 'on',
        };
      } finally {
        await pool.close().catch(() => undefined);
      }
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only a handshake/TLS failure is worth retrying unencrypted.
      if (!/could not connect \(sequence\)/i.test(msg) && (err as { code?: string })?.code !== 'ESOCKET') break;
      if (encryptOverride === false) break;
    }
  }
  return { ok: false, error: explainSqlServerError(lastError) };
}

const SCHEMA_SQL = `
SELECT
  c.TABLE_SCHEMA AS [schema], c.TABLE_NAME AS [table], c.COLUMN_NAME AS [name],
  c.ORDINAL_POSITION AS ordinal, c.DATA_TYPE AS dataType,
  c.CHARACTER_MAXIMUM_LENGTH AS maxLength,
  c.NUMERIC_PRECISION AS numericPrecision, c.NUMERIC_SCALE AS numericScale,
  c.DATETIME_PRECISION AS datetimePrecision,
  CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS isNullable,
  CASE WHEN COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') = 1 THEN 1 ELSE 0 END AS isIdentity,
  c.COLUMN_DEFAULT AS defaultValue, c.COLLATION_NAME AS collation
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN INFORMATION_SCHEMA.TABLES t
  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE t.TABLE_TYPE = 'BASE TABLE'
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;
`;

const PK_SQL = `
SELECT tc.TABLE_SCHEMA AS [schema], tc.TABLE_NAME AS [table], kcu.COLUMN_NAME AS [column]
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
 AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
ORDER BY tc.TABLE_SCHEMA, tc.TABLE_NAME, kcu.ORDINAL_POSITION;
`;

const FK_SQL = `
SELECT
  fk.name AS fkName, s.name AS [schema], t.name AS [table], c.name AS [column],
  rs.name AS refSchema, rt.name AS refTable, rc.name AS refColumn,
  fk.delete_referential_action_desc AS onDelete,
  fk.update_referential_action_desc AS onUpdate
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables t ON t.object_id = fk.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
ORDER BY fk.name;
`;

const INDEX_SQL = `
SELECT
  s.name AS [schema], t.name AS [table], i.name AS indexName,
  i.is_unique AS isUnique, i.is_primary_key AS isPrimaryKey,
  c.name AS [column], ic.key_ordinal AS [ord]
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.name IS NOT NULL AND i.is_primary_key = 0
ORDER BY s.name, t.name, i.name, ic.key_ordinal;
`;

const VIEWS_SQL = `
SELECT s.name AS [schema], v.name AS [name], m.definition AS definition
FROM sys.views v
JOIN sys.schemas s ON s.schema_id = v.schema_id
JOIN sys.sql_modules m ON m.object_id = v.object_id
ORDER BY s.name, v.name;
`;

const ROWCOUNT_SQL = `
SELECT s.name AS [schema], t.name AS [table], p.[rows] AS [rowCount]
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
ORDER BY s.name, t.name;
`;

export async function introspectSchema(cfg: SqlServerConfig): Promise<DatabaseSchema> {
  return withSqlServer(cfg, async (pool) => {
    const [cols, pks, fks, idxs, views, counts] = await Promise.all([
      pool.request().query(SCHEMA_SQL),
      pool.request().query(PK_SQL),
      pool.request().query(FK_SQL),
      pool.request().query(INDEX_SQL),
      pool.request().query(VIEWS_SQL),
      pool.request().query(ROWCOUNT_SQL),
    ]);

    const tables = new Map<string, TableInfo>();
    const key = (schema: string, table: string) => `${schema}.${table}`;

    for (const c of cols.recordset as Record<string, unknown>[]) {
      const k = key(String(c.schema), String(c.table));
      if (!tables.has(k)) {
        tables.set(k, {
          schema: String(c.schema),
          name: String(c.table),
          columns: [],
          primaryKey: [],
          foreignKeys: [],
          indexes: [],
          rowCount: 0,
        });
      }
      tables.get(k)!.columns.push({
        schema: String(c.schema),
        table: String(c.table),
        name: String(c.name),
        ordinal: Number(c.ordinal),
        dataType: String(c.dataType),
        maxLength: c.maxLength == null ? null : Number(c.maxLength),
        numericPrecision: c.numericPrecision == null ? null : Number(c.numericPrecision),
        numericScale: c.numericScale == null ? null : Number(c.numericScale),
        datetimePrecision: c.datetimePrecision == null ? null : Number(c.datetimePrecision),
        isNullable: Boolean(c.isNullable),
        isIdentity: Boolean(c.isIdentity),
        defaultValue: c.defaultValue == null ? null : String(c.defaultValue),
        collation: c.collation == null ? null : String(c.collation),
      });
    }

    for (const r of pks.recordset as Record<string, unknown>[]) {
      tables.get(key(String(r.schema), String(r.table)))?.primaryKey.push(String(r.column));
    }

    for (const r of fks.recordset as Record<string, unknown>[]) {
      tables.get(key(String(r.schema), String(r.table)))?.foreignKeys.push({
        name: String(r.fkName),
        column: String(r.column),
        referencedSchema: String(r.refSchema),
        referencedTable: String(r.refTable),
        referencedColumn: String(r.refColumn),
        onDelete: String(r.onDelete),
        onUpdate: String(r.onUpdate),
      });
    }

    const indexMap = new Map<string, IndexInfo>();
    for (const r of idxs.recordset as Record<string, unknown>[]) {
      const k = `${String(r.schema)}.${String(r.table)}.${String(r.indexName)}`;
      if (!indexMap.has(k)) {
        const info: IndexInfo = {
          name: String(r.indexName),
          isUnique: Boolean(r.isUnique),
          isPrimaryKey: Boolean(r.isPrimaryKey),
          columns: [],
        };
        indexMap.set(k, info);
        tables.get(key(String(r.schema), String(r.table)))?.indexes.push(info);
      }
      indexMap.get(k)!.columns.push(String(r.column));
    }

    for (const r of counts.recordset as Record<string, unknown>[]) {
      const t = tables.get(key(String(r.schema), String(r.table)));
      if (t) t.rowCount = Number(r.rowCount);
    }

    return {
      database: cfg.database,
      tables: [...tables.values()],
      views: (views.recordset as Record<string, unknown>[]).map((v) => ({
        schema: String(v.schema),
        name: String(v.name),
        definition: String(v.definition ?? ''),
      })),
    };
  });
}

/** Stream one table's rows in batches for the data-copy phase. */
export async function streamTableRows(
  cfg: SqlServerConfig,
  schema: string,
  table: string,
  batchSize: number,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<number> {
  // Bracket-quoted identifiers only; schema/table come from the
  // introspected list, never raw user input, and are validated here.
  if (!/^[A-Za-z0-9_]+$/.test(schema) || !/^[A-Za-z0-9_ \-]+$/.test(table)) {
    throw new Error(`Unsafe table name: ${schema}.${table}`);
  }
  let total = 0;
  await withSqlServer(cfg, async (pool) => {
    const count = await pool
      .request()
      .query<{ n: number }>(`SELECT COUNT(*) AS n FROM [${schema}].[${table}]`);
    const totalRows = count.recordset[0]?.n ?? 0;
    for (let offset = 0; offset < totalRows; offset += batchSize) {
      const r = await pool
        .request()
        .query(
          `SELECT * FROM [${schema}].[${table}] ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${batchSize} ROWS ONLY`,
        );
      const rows = r.recordset as Record<string, unknown>[];
      if (rows.length === 0) break;
      await onBatch(rows);
      total += rows.length;
    }
  });
  return total;
}
