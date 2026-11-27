import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Restore a pg_dump plain-text dump (.sql, optionally .gz) into a
 * Postgres target (NHost / Supabase / plain Postgres).
 *
 * Only plain-text dumps are supported: pg_dump's custom format
 * (.dump / .backup) needs the pg_restore binary, which is not
 * available in this runtime. A plain dump is a stream of SQL
 * statements, so it can be executed statement by statement over
 * the pg driver — with progress and per-statement errors, the way
 * migrations already report.
 *
 * The dump is stored under the OS temp dir between the parse step
 * (upload → preview) and the run step, then deleted. On serverless
 * hosts the temp dir is not guaranteed to survive between requests,
 * so a missing file is a clean "upload it again" error, never a
 * silent half-restore.
 */

export const MAX_RESTORE_BYTES = 200 * 1024 * 1024;

/** Split a SQL script into statements.
 *
 *  A naive split on `;` breaks real dumps: semicolons appear inside
 *  string literals ('it''s; fine'), dollar-quoted function bodies
 *  ($$ ... ; ... $$), comments, and COPY data rows. This scanner
 *  tracks those states, so only a top-level `;` ends a statement.
 *  A `COPY ... FROM stdin` command keeps its data lines (up to the
 *  line that is exactly `\.`) as part of the same statement, the
 *  way psql treats it. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  const flush = () => {
    const s = buf.trim();
    // A chunk that is only comments/whitespace is not a statement.
    if (s && stripLeadingComments(s)) statements.push(s);
    buf = '';
  };

  while (i < n) {
    const ch = sql[i];
    const nxt = i + 1 < n ? sql[i + 1] : '';

    // -- line comment
    if (ch === '-' && nxt === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // /* block comment — nested, as in Postgres */
    if (ch === '/' && nxt === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // '...' string literal. A backslash only escapes the next char
    // in an E'...' escape string (E not part of an identifier).
    if (ch === "'") {
      const prev = i > 0 ? sql[i - 1] : '';
      const prevPrev = i > 1 ? sql[i - 2] : '';
      const isEscape = (prev === 'E' || prev === 'e') && !/[A-Za-z0-9_$]/.test(prevPrev);
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        if (isEscape && sql[j] === '\\') { j += 2; continue; }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // "..." quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // $tag$ ... $tag$ dollar-quoted string
    if (ch === '$') {
      const m = /^\$[A-Za-z_\x80-\xff][A-Za-z0-9_$\x80-\xff]*\$|^\$\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const delim = m[0];
        const close = sql.indexOf(delim, i + delim.length);
        const end = close === -1 ? n : close + delim.length;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    // Statement terminator (top level only — quotes, comments and
    // dollar-quotes above already consumed their semicolons).
    if (ch === ';') {
      buf += ch;
      i++;
      const stmt = buf.trim();
      flush();
      if (isCopyFromStdin(stmt)) {
        // The COPY data lines follow the command, up to a line that
        // is exactly \. — consume them as part of this statement.
        // The ; ends the command line, so skip to the next line
        // first (otherwise the rest of that line reads as an
        // empty data row).
        let j = i;
        if (sql[j] === '\r' && sql[j + 1] === '\n') j += 2;
        else if (sql[j] === '\n') j += 1;
        let block = '';
        while (j < n) {
          const eol = sql.indexOf('\n', j);
          const lineEnd = eol === -1 ? n : eol + 1;
          const line = sql.slice(j, lineEnd);
          block += line;
          j = lineEnd;
          if (line.trim() === '\\.') break;
        }
        const idx = statements.length - 1;
        // Keep exactly one trailing newline after the \. line — the
        // COPY data terminator must sit on its own line.
        if (idx >= 0) statements[idx] = statements[idx] + '\n' + block.replace(/\s+$/, '\n');
        i = j;
      }
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return statements;
}

/** Leading comments (and whitespace) stripped — pg_dump puts a
 *  `-- Data for Name: ...` comment ahead of most statements. */
export function stripLeadingComments(s: string): string {
  let t = s;
  for (;;) {
    t = t.replace(/^\s+/, '');
    if (t.startsWith('--')) {
      const eol = t.indexOf('\n');
      t = eol === -1 ? '' : t.slice(eol + 1);
      continue;
    }
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      t = end === -1 ? '' : t.slice(end + 2);
      continue;
    }
    return t;
  }
}

function firstWord(stmt: string): string {
  const m = /^[A-Za-z]+/.exec(stripLeadingComments(stmt));
  return m ? m[0].toUpperCase() : '';
}

/** Parse a (possibly schema-qualified) name after a keyword, e.g.
 *  `CREATE TABLE public."CallLog"` → `public.CallLog`. */
function parseQualifiedName(head: string, keyword: RegExp): string | null {
  const m = keyword.exec(head);
  if (!m) return null;
  const rest = head.slice(m[0].length);
  const parts: string[] = [];
  const re = /\s*(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*(\.)?/y;
  re.lastIndex = 0;
  for (;;) {
    const p = re.exec(rest);
    if (!p) break;
    parts.push(p[1] ?? p[2]);
    if (p[3] !== '.') break;
    if (parts.length >= 2) break;
  }
  return parts.length ? parts.join('.') : null;
}

function isCopyFromStdin(stmt: string): boolean {
  const head = stripLeadingComments(stmt);
  return /^COPY\b/i.test(head) && /\bFROM\s+STDIN\b/i.test(head);
}

function copyRowCount(stmt: string): number {
  const lines = stmt.split('\n');
  let rows = 0;
  for (let k = 1; k < lines.length; k++) {
    if (lines[k].trim() === '\\.') break;
    rows++;
  }
  return rows;
}

export interface RestoreSummary {
  total: number;
  tables: string[];
  views: string[];
  sequences: string[];
  copyTables: { table: string; rows: number }[];
  insertStatements: number;
  kinds: Record<string, number>;
  warnings: string[];
}

/** What a parsed dump contains, for the review step before running. */
export function summarizeRestore(statements: string[]): RestoreSummary {
  const tables: string[] = [];
  const views: string[] = [];
  const sequences: string[] = [];
  const copyTables: { table: string; rows: number }[] = [];
  const kinds: Record<string, number> = {};
  const warnings: string[] = [];
  let insertStatements = 0;
  let hasDrop = false;
  let hasExtension = false;
  let hasOwner = false;
  let hasGrant = false;
  let hasCreateDb = false;

  for (const stmt of statements) {
    const head = stripLeadingComments(stmt);
    const word = firstWord(stmt);
    if (word) kinds[word] = (kinds[word] ?? 0) + 1;
    if (/^CREATE\s+TABLE\b/i.test(head)) {
      const name = parseQualifiedName(head, /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i);
      if (name) tables.push(name);
    } else if (/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(head)) {
      const name = parseQualifiedName(head, /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+/i);
      if (name) views.push(name);
    } else if (/^CREATE\s+SEQUENCE\b/i.test(head)) {
      const name = parseQualifiedName(head, /^CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i);
      if (name) sequences.push(name);
    } else if (isCopyFromStdin(stmt)) {
      const name = parseQualifiedName(head, /^COPY\s+/i);
      copyTables.push({ table: name ?? 'unknown', rows: copyRowCount(stmt) });
    } else if (/^INSERT\b/i.test(head)) {
      insertStatements++;
    }
    if (/^DROP\b/i.test(head)) hasDrop = true;
    if (/^CREATE\s+EXTENSION\b/i.test(head)) hasExtension = true;
    if (/^ALTER\b/i.test(head) && /\bOWNER\s+TO\b/i.test(head)) hasOwner = true;
    if (/^(GRANT|REVOKE)\b/i.test(head)) hasGrant = true;
    if (/^CREATE\s+DATABASE\b/i.test(head)) hasCreateDb = true;
  }

  if (statements.length === 0) {
    warnings.push(
      'No statements found — is this a plain-text .sql dump? Custom-format dumps (.dump / .backup) need pg_restore and are not supported here.',
    );
  }
  if (hasDrop) {
    warnings.push(
      'The dump contains DROP statements — existing objects with the same names will be deleted before they are recreated.',
    );
  }
  if (hasExtension) {
    warnings.push(
      'The dump creates extensions — the target login must be allowed to create them (NHost and Supabase restrict some extensions).',
    );
  }
  if (hasOwner) {
    warnings.push('The dump changes object owners — the named roles must exist on the target database.');
  }
  if (hasGrant) {
    warnings.push('The dump grants or revokes privileges — the named roles must exist on the target database.');
  }
  if (hasCreateDb) {
    warnings.push(
      'The dump creates a database, but the restore runs against the database in the connection string — the created database is ignored.',
    );
  }
  return { total: statements.length, tables, views, sequences, copyTables, insertStatements, kinds, warnings };
}

/** One-line label for progress, e.g. "COPY public.CallLog". */
export function describeStatement(stmt: string): string {
  const head = stripLeadingComments(stmt);
  const word = firstWord(stmt);
  const name = parseQualifiedName(
    head,
    /^(?:CREATE\s+TABLE|CREATE\s+(?:OR\s+REPLACE\s+)?VIEW|CREATE\s+SEQUENCE|COPY|ALTER\s+TABLE|DROP\s+TABLE|INSERT\s+INTO|CREATE\s+INDEX|CREATE\s+UNIQUE\s+INDEX)\s+/i,
  );
  return name ? `${word} ${name}` : word || 'SQL';
}

function previewStatement(stmt: string): string {
  const one = stripLeadingComments(stmt).replace(/\s+/g, ' ').trim();
  return one.length > 200 ? one.slice(0, 200) + '…' : one;
}

export interface RestoreQueryResult {
  rowCount?: number | null;
}

/** Minimal client surface the engine needs — the real pg client
 *  and a fake one in tests both satisfy it. */
export interface RestoreClient {
  query(sql: string): Promise<RestoreQueryResult>;
}

export interface RestoreResult {
  succeeded: number;
  failed: number;
  rowsRestored: number;
  errors: { index: number; statement: string; message: string }[];
}

/** Run statements in order, one at a time, each in its own
 *  implicit transaction (a restore must not roll the whole file
 *  back because one statement failed). With stopOnError off — the
 *  default, since dumps routinely contain a few statements the
 *  target rejects (extensions, owners, already-existing objects) —
 *  a failure is recorded and the run moves on. */
export async function executeRestore(
  client: RestoreClient,
  statements: string[],
  opts: {
    stopOnError: boolean;
    onProgress?: (p: { done: number; total: number; label: string }) => void;
    onError?: (e: { index: number; statement: string; message: string }) => void;
  },
): Promise<RestoreResult> {
  const errors: RestoreResult['errors'] = [];
  let succeeded = 0;
  let rowsRestored = 0;
  for (let idx = 0; idx < statements.length; idx++) {
    const stmt = statements[idx];
    const label = describeStatement(stmt);
    try {
      const r = await client.query(stmt);
      succeeded++;
      if (typeof r?.rowCount === 'number') rowsRestored += r.rowCount;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failure = { index: idx, statement: previewStatement(stmt), message };
      errors.push(failure);
      opts.onError?.(failure);
      if (opts.stopOnError) {
        opts.onProgress?.({ done: idx + 1, total: statements.length, label });
        break;
      }
    }
    opts.onProgress?.({ done: idx + 1, total: statements.length, label });
  }
  return { succeeded, failed: errors.length, rowsRestored, errors };
}

// ---- Uploaded dump storage (between parse and run) ----

const RESTORE_TMP_DIR = path.join(os.tmpdir(), 'cictus-restore');

export function saveRestoreUpload(fileName: string, contents: Buffer): { fileId: string; filePath: string } {
  fs.mkdirSync(RESTORE_TMP_DIR, { recursive: true });
  const fileId = crypto.randomUUID();
  const filePath = path.join(RESTORE_TMP_DIR, `${fileId}.sql`);
  fs.writeFileSync(filePath, contents);
  void fileName;
  return { fileId, filePath };
}

/** Null when the id is not a UUID we issued — never let a client
 *  supply an arbitrary path. */
export function restoreUploadPath(fileId: string): string | null {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(fileId)) return null;
  return path.join(RESTORE_TMP_DIR, `${fileId}.sql`);
}

export function deleteRestoreUpload(fileId: string): void {
  const p = restoreUploadPath(fileId);
  if (p) fs.rmSync(p, { force: true });
}
