import crypto from 'crypto';
import { once } from 'events';
import { from as copyFrom } from 'pg-copy-streams';
import type { Pool } from 'pg';
import type { ColumnInfo, TableInfo } from './sqlserver';
import { streamTableRows } from './sqlserver';
import type { SqlServerConfig } from './sqlserver';
import { streamMysqlTableRows } from './mysql';
import type { MysqlConfig } from './mysql';
import { streamPostgresTableRows } from './postgres-source';
import type { PostgresSourceConfig } from './postgres-source';
import { streamOracleTableRows } from './oracle';
import type { OracleConfig } from './oracle';
import { streamSqliteTableRows } from './sqlite';
import type { SqliteConfig } from './sqlite';
import { pgIdent, pgSchema } from './ddl';

/** A migration source: SQL Server, MySQL, Postgres, Oracle or SQLite, with its config. */
export type SourceConnection =
  | { kind: 'sqlserver'; config: SqlServerConfig }
  | { kind: 'mysql'; config: MysqlConfig }
  | { kind: 'postgres'; config: PostgresSourceConfig }
  | { kind: 'oracle'; config: OracleConfig }
  | { kind: 'sqlite'; config: SqliteConfig };

export const BATCH_SIZE = 1000;
/** Tables with at least this many source rows use the COPY bulk load
 *  (when enabled) instead of batched INSERTs. */
export const COPY_THRESHOLD = 5000;
/** Source rows streamed per COPY write batch. */
const COPY_BATCH_SIZE = 5000;

/** Format one (already coerced) value for PostgreSQL COPY text format
 *  (tab-delimited, `\N` for NULL, backslash escapes). */
export function formatCopyValue(value: unknown, pgType: string): string {
  if (value === null || value === undefined) return '\\N';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '\\N';
    if (pgType === 'date') {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
    }
    if (pgType === 'time' || pgType.startsWith('time(')) {
      const p = (n: number, l = 2) => String(n).padStart(l, '0');
      return `${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}.${p(value.getMilliseconds(), 3)}`;
    }
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    if (pgType === 'boolean' && value.length === 1) return value[0] !== 0 ? 't' : 'f';
    return `\\x${value.toString('hex')}`;
  }
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (pgType === 'boolean') {
    if (typeof value === 'number') return value !== 0 ? 't' : 'f';
    if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true' ? 't' : 'f';
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') return escapeCopyText(JSON.stringify(value));
  return escapeCopyText(String(value));
}

function escapeCopyText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** COPY text format cannot carry spatial values: there is no text
 *  representation for a WKB buffer, so tables with geography /
 *  geometry columns stay on the INSERT path. */
function copySafe(table: TableInfo, pgTypes: Record<string, string>): boolean {
  return table.columns.every((c) => {
    const pg = (pgTypes[c.name] ?? '').toLowerCase();
    const sql = c.dataType.toLowerCase();
    return pg !== 'geography' && pg !== 'geometry' && sql !== 'geography' && sql !== 'geometry';
  });
}

/**
 * Bulk-load one table with COPY: stream the source rows into a
 * same-shape TEMP staging table with `COPY ... FROM STDIN` (one
 * round trip per batch instead of one per row), then
 * `INSERT INTO target SELECT ... ON CONFLICT DO NOTHING` from the
 * staging table. That keeps the INSERT path's idempotency (re-runs
 * skip rows that are already there) while the transfer itself runs
 * at COPY speed. Runs on a single pooled client because TEMP tables
 * are per-session.
 */
export async function copyTableDataViaCopy(
  source: SourceConnection,
  target: Pool,
  table: TableInfo,
  pgTypes: Record<string, string>,
  onEvent: (e: ProgressEvent) => void,
): Promise<number> {
  const schema = pgSchema(table.schema);
  const cols = table.columns;
  const colList = cols.map((c) => pgIdent(c.name)).join(', ');
  const stage = `_cictus_stage_${crypto.randomBytes(8).toString('hex')}`;
  const client = await target.connect();
  let copied = 0;
  onEvent({ type: 'table-start', table: `${table.schema}.${table.name}`, total: table.rowCount });
  try {
    await client.query(`CREATE TEMP TABLE ${pgIdent(stage)} (LIKE ${pgIdent(schema)}.${pgIdent(table.name)})`);
    const stream = client.query(copyFrom(`COPY ${pgIdent(stage)} (${colList}) FROM STDIN`));
    const streamError = new Promise<never>((_, reject) => {
      stream.once('error', reject);
    });
    const writeLine = async (line: string): Promise<void> => {
      if (!stream.write(`${line}\n`)) await Promise.race([once(stream, 'drain'), streamError]);
    };
    const streamRows = streamRowsFor(source, table);
    await streamRows(COPY_BATCH_SIZE, async (rows) => {
      for (const row of rows) {
        const line = cols
          .map((col) => formatCopyValue(coerceValue(row[col.name], pgTypes[col.name] ?? 'text', col.dataType), pgTypes[col.name] ?? 'text'))
          .join('\t');
        await writeLine(line);
      }
      copied += rows.length;
      onEvent({ type: 'table-progress', table: `${table.schema}.${table.name}`, copied, total: table.rowCount });
    });
    stream.end();
    await Promise.race([once(stream, 'finish'), streamError]);
    await client.query(
      `INSERT INTO ${pgIdent(schema)}.${pgIdent(table.name)} (${colList}) SELECT ${colList} FROM ${pgIdent(stage)} ON CONFLICT DO NOTHING`,
    );
    onEvent({ type: 'table-done', table: `${table.schema}.${table.name}`, copied });
    return copied;
  } finally {
    await client.query(`DROP TABLE IF EXISTS ${pgIdent(stage)}`).catch(() => undefined);
    client.release();
  }
}

export type ProgressEvent =
  | { type: 'log'; message: string }
  | { type: 'table-start'; table: string; total: number }
  | { type: 'table-progress'; table: string; copied: number; total: number }
  | { type: 'table-done'; table: string; copied: number }
  | { type: 'error'; table: string; message: string };

/** Stream rows from whichever source this migration uses. */
function streamRowsFor(source: SourceConnection, table: TableInfo) {
  return (batchSize: number, onBatch: (rows: Record<string, unknown>[]) => Promise<void>) => {
    switch (source.kind) {
      case 'mysql':
        return streamMysqlTableRows(source.config, table.schema, table.name, batchSize, onBatch);
      case 'postgres':
        return streamPostgresTableRows(source.config, table.schema, table.name, batchSize, onBatch);
      case 'oracle':
        return streamOracleTableRows(source.config, table.schema, table.name, batchSize, onBatch);
      case 'sqlite':
        return streamSqliteTableRows(source.config, table.schema, table.name, batchSize, onBatch);
      default:
        return streamTableRows(source.config, table.schema, table.name, batchSize, onBatch);
    }
  };
}

/** Coerce one source value to something `pg` can send.
 *  - Buffer -> Buffer (bytea) unchanged; a 1-byte Buffer into a
 *    boolean column (MySQL BIT(1)) becomes a boolean.
 *  - Date -> Date (timestamptz / timestamp) unchanged; an invalid
 *    Date (MySQL zero date) becomes NULL.
 *  - boolean-ish bit (0/1) -> boolean when the target column is boolean
 *  - uniqueidentifier string -> string (uuid) unchanged
 *  - object into a json/jsonb column -> JSON string
 *  - everything else passes through; pg serialises numbers/strings. */
export function coerceValue(value: unknown, pgType: string, sqlType: string): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (Buffer.isBuffer(value)) {
    if (pgType === 'boolean' && value.length === 1) return value[0] !== 0;
    return value;
  }
  if (pgType === 'boolean' && typeof value === 'number') return value !== 0;
  if (pgType === 'boolean' && typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true';
  }
  if (sqlType.toLowerCase() === 'uniqueidentifier' && typeof value === 'string') {
    return value.toLowerCase();
  }
  if ((pgType === 'jsonb' || pgType === 'json') && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Copy one table's data. Large tables (rowCount >= COPY_THRESHOLD)
 * use the COPY bulk load when enabled; anything the COPY path
 * cannot handle — spatial columns, or a COPY failure mid-stream —
 * falls back to the batched INSERT path, so a fast-path failure
 * never loses the table.
 */
export async function copyTableData(
  source: SourceConnection,
  target: Pool,
  table: TableInfo,
  pgTypes: Record<string, string>,
  onEvent: (e: ProgressEvent) => void,
  opts?: { useCopy?: boolean; copyThreshold?: number },
): Promise<number> {
  const useCopy = opts?.useCopy !== false;
  const threshold = opts?.copyThreshold ?? COPY_THRESHOLD;
  if (useCopy && table.rowCount >= threshold && copySafe(table, pgTypes)) {
    try {
      const n = await copyTableDataViaCopy(source, target, table, pgTypes, onEvent);
      onEvent({ type: 'log', message: `COPY bulk load: ${table.schema}.${table.name} — ${n.toLocaleString()} rows.` });
      return n;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'log', message: `COPY bulk load failed for ${table.schema}.${table.name} — falling back to batched INSERT: ${msg}` });
    }
  }
  return copyTableDataViaInsert(source, target, table, pgTypes, onEvent);
}

async function copyTableDataViaInsert(
  source: SourceConnection,
  target: Pool,
  table: TableInfo,
  pgTypes: Record<string, string>,
  onEvent: (e: ProgressEvent) => void,
): Promise<number> {
  const schema = pgSchema(table.schema);
  const cols = table.columns;
  const colList = cols.map((c) => pgIdent(c.name)).join(', ');
  const placeholders = (rowIdx: number, n: number) =>
    `(${cols.map((_, i) => `$${rowIdx * n + i + 1}`).join(', ')})`;

  let copied = 0;
  onEvent({ type: 'table-start', table: `${table.schema}.${table.name}`, total: table.rowCount });

  const streamRows = streamRowsFor(source, table);

  await streamRows(BATCH_SIZE, async (rows) => {
    const values: unknown[] = [];
    const valueGroups: string[] = [];
    rows.forEach((row, r) => {
      valueGroups.push(placeholders(r, cols.length));
      for (const col of cols) {
        values.push(coerceValue(row[col.name], pgTypes[col.name] ?? 'text', col.dataType));
      }
    });
    const sqlText =
      `INSERT INTO ${pgIdent(schema)}.${pgIdent(table.name)} (${colList}) ` +
      `VALUES ${valueGroups.join(', ')} ` +
      `ON CONFLICT DO NOTHING`;
    const client = await target.connect();
    try {
      await client.query('BEGIN');
      await client.query(sqlText, values);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    copied += rows.length;
    onEvent({ type: 'table-progress', table: `${table.schema}.${table.name}`, copied, total: table.rowCount });
  });

  onEvent({ type: 'table-done', table: `${table.schema}.${table.name}`, copied });
  return copied;
}

/** After loading, restart each identity sequence past the max value, so
 *  later Hasura inserts do not collide with migrated keys. */
export async function fixIdentitySequences(
  target: Pool,
  tables: TableInfo[],
  onEvent: (e: ProgressEvent) => void,
): Promise<void> {
  for (const table of tables) {
    for (const col of table.columns.filter((c) => c.isIdentity)) {
      const schema = pgSchema(table.schema);
      try {
      // pg_get_serial_sequence takes the table as a regclass string.
      // It must be double-quoted: passing public.CallLog unquoted folds
      // to public.calllog, and Postgres then reports relation
      // "public.calllog" does not exist — the table is actually
      // "CallLog" (mixed case, quoted at creation). Same for hyphenated
      // names like "CallLog-BKP". Skip silently when there is no
      // sequence (pg_get_serial_sequence returns NULL).
      const seq = await target.query<{ seq: string | null }>(
        'SELECT pg_get_serial_sequence($1, $2) AS seq',
        [`"${schema}"."${table.name}"`, col.name],
      );
      const seqName = seq.rows[0]?.seq;
      if (!seqName) {
        onEvent({
          type: 'log',
          message: `No sequence for ${table.schema}.${table.name}.${col.name} — skipping.`,
        });
        continue;
      }
      await target.query(
        `SELECT setval($1::regclass, COALESCE((SELECT MAX(${pgIdent(col.name)}) FROM ${pgIdent(schema)}.${pgIdent(table.name)}), 1))`,
        [seqName],
      );
        onEvent({
          type: 'log',
          message: `Sequence fixed for ${table.schema}.${table.name}.${col.name}`,
        });
      } catch (err) {
        onEvent({
          type: 'log',
          message: `Could not fix sequence for ${table.schema}.${table.name}.${col.name}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
}

export type { ColumnInfo };
