import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSchema, TableInfo, ViewInfo } from './sqlserver';

/**
 * SQLite as a migration source — a local file, not a server.
 *
 * Uses Node's built-in `node:sqlite` (no native dependency). The
 * file is opened READ-ONLY, so migration never writes to the user's
 * database file. The file path comes from the wizard (typed in, or
 * uploaded through /api/source/upload, which stores it under
 * data/uploads/) or from a saved connector.
 *
 * SQLite has no schemas: every table lands in Postgres `public`.
 * A column's declared type is free text, so the type mapper parses
 * it (see mapSqliteType). `INTEGER PRIMARY KEY` columns are the
 * rowid alias and auto-increment — they map to identity columns.
 */

export const SqliteConfigSchema = z.object({
  filePath: z.string().min(1, 'SQLite file path is required'),
});

export type SqliteConfig = z.infer<typeof SqliteConfigSchema>;

const UPLOADS_DIR = 'uploads';

export function uploadsDir(): string {
  return path.join(process.cwd(), 'data', UPLOADS_DIR);
}

function openDb(cfg: SqliteConfig): DatabaseSync {
  const p = cfg.filePath;
  if (!fs.existsSync(p)) {
    throw new Error(`SQLite file not found: ${p}. Check the path — the app reads the file from the machine it runs on.`);
  }
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch (err) {
    throw new Error(explainSqliteError(err));
  }
}

export async function testSqliteConnection(cfg: SqliteConfig): Promise<{
  ok: boolean;
  version?: string;
  database?: string;
  error?: string;
}> {
  let db: DatabaseSync | null = null;
  try {
    db = openDb(cfg);
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    const count = db.prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    ).get() as { n: number };
    return { ok: true, version: `SQLite ${row.v}`, database: `${path.basename(cfg.filePath)} (${count.n} tables)` };
  } catch (err) {
    return { ok: false, error: explainSqliteError(err) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** File check only — no network for a local file. */
export async function diagnoseSqlite(cfg: SqliteConfig): Promise<{
  dns: { ok: boolean; address?: string };
  tcp: { ok: boolean };
  hint: string;
}> {
  const exists = fs.existsSync(cfg.filePath);
  let readable = false;
  if (exists) {
    try {
      fs.accessSync(cfg.filePath, fs.constants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }
  }
  return {
    dns: { ok: true, address: 'local file' },
    tcp: { ok: exists && readable },
    hint: !exists
      ? `No file at ${cfg.filePath}. The path is read on the machine the app runs on — use an absolute path, or upload the file in the wizard.`
      : !readable
        ? `The file exists but is not readable by the app. Check file permissions.`
        : 'The file exists and is readable — if the test still fails, it may not be a SQLite database file.',
  };
}

export function explainSqliteError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/CANTOPEN/i.test(msg)) return `Cannot open the SQLite file — check the path and that the app can read it. (${msg})`;
  if (/NOTADB|file is not a database/i.test(msg)) return 'That file is not a SQLite database (SQLITE_NOTADB).';
  if (/readonly/i.test(msg)) return 'The SQLite file is read-only or locked by another process.';
  return msg;
}

interface PragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | number | null;
  pk: number;
}

interface PragmaFk {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

interface PragmaIndex {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface PragmaIndexInfo {
  seqno: number;
  cid: number;
  name: string;
}

export async function introspectSqliteSchema(cfg: SqliteConfig): Promise<DatabaseSchema> {
  let db: DatabaseSync | null = null;
  try {
    db = openDb(cfg);
    const tableRows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string }[];
    const viewRows = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name`,
    ).all() as { name: string; sql: string | null }[];

    const tables: TableInfo[] = [];
    for (const t of tableRows) {
      const name = t.name;
      const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as unknown as PragmaColumn[];
      const fks = db.prepare(`PRAGMA foreign_key_list("${name.replace(/"/g, '""')}")`).all() as unknown as PragmaFk[];
      const idxList = db.prepare(`PRAGMA index_list("${name.replace(/"/g, '""')}")`).all() as unknown as PragmaIndex[];
      const indexes = [];
      for (const ix of idxList) {
        if (ix.origin === 'pk') continue; // PK is already in primaryKey
        const info = db.prepare(`PRAGMA index_info("${ix.name.replace(/"/g, '""')}")`).all() as unknown as PragmaIndexInfo[];
        const colNames = info
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => cols[c.cid]?.name)
          .filter((n): n is string => Boolean(n));
        if (colNames.length) {
          indexes.push({ name: ix.name, isUnique: ix.unique === 1, isPrimaryKey: false, columns: colNames });
        }
      }
      let rowCount = 0;
      try {
        const c = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number };
        rowCount = Number(c?.n ?? 0);
      } catch {
        rowCount = 0;
      }
      tables.push({
        schema: 'public',
        name,
        columns: cols.map((c) => ({
          schema: 'public',
          table: name,
          name: c.name,
          ordinal: c.cid,
          dataType: (c.type || '').trim().split(/\s*\(/)[0].toUpperCase() || 'BLOB',
          maxLength: null,
          numericPrecision: null,
          numericScale: null,
          datetimePrecision: null,
          isNullable: c.notnull === 0,
          // INTEGER PRIMARY KEY is the rowid alias: auto-incrementing.
          isIdentity: c.pk === 1 && /INT/i.test(c.type || ''),
          defaultValue: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
          collation: null,
          sourceExtra: (c.type || '').trim().toUpperCase() || null,
        })),
        primaryKey: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
        foreignKeys: fks.map((f) => ({
          name: `fk_${name}_${f.from}`,
          column: f.from,
          referencedSchema: 'public',
          referencedTable: f.table,
          referencedColumn: f.to ?? 'id',
          onDelete: (f.on_delete || 'NO ACTION').toUpperCase(),
          onUpdate: (f.on_update || 'NO ACTION').toUpperCase(),
        })),
        indexes,
        rowCount,
      });
    }
    const views: ViewInfo[] = viewRows.map((v) => ({
      schema: 'public',
      name: v.name,
      definition: v.sql ?? '',
    }));
    return { database: path.basename(cfg.filePath), tables, views };
  } catch (err) {
    throw new Error(explainSqliteError(err));
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export async function streamSqliteTableRows(
  cfg: SqliteConfig,
  schema: string,
  table: string,
  batchSize: number,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<number> {
  if (!/^[A-Za-z0-9_]+$/.test(schema) || !/^[A-Za-z0-9_ \-]+$/.test(table)) {
    throw new Error(`Unsafe table name: ${schema}.${table}`);
  }
  let db: DatabaseSync | null = null;
  try {
    db = openDb(cfg);
    const stmt = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ? OFFSET ?`);
    let offset = 0;
    let total = 0;
    for (;;) {
      const rows = stmt.all(batchSize, offset) as Record<string, unknown>[];
      if (rows.length === 0) break;
      // node:sqlite returns BLOBs as Uint8Array — normalise to Buffer
      // so the COPY formatter and pg driver see bytea.
      for (const row of rows) {
        for (const [k, v] of Object.entries(row)) {
          if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v);
        }
      }
      total += rows.length;
      await onBatch(rows);
      if (rows.length < batchSize) break;
      offset += rows.length;
    }
    return total;
  } catch (err) {
    throw new Error(explainSqliteError(err));
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
