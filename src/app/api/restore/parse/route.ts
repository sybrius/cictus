import { NextResponse } from 'next/server';
import zlib from 'node:zlib';
import { requireUser } from '@/lib/api-auth';
import {
  MAX_RESTORE_BYTES,
  saveRestoreUpload,
  splitSqlStatements,
  summarizeRestore,
} from '@/lib/restore';

/**
 * POST a pg_dump plain-text dump (multipart form, field `file`) —
 * parses it and returns a preview: statement count, tables/views
 * to create, COPY/INSERT row counts, and warnings (DROP, extension,
 * owner, grant). The file itself is kept under the OS temp dir for
 * the run step and identified by `fileId`; nothing is executed here.
 *
 * Accepted: .sql, .sql.gz. Custom-format dumps (.dump / .backup)
 * need pg_restore and are rejected with a plain-English error.
 * On Vercel the request body is limited by the platform (~4.5 MB),
 * so large dumps should be restored from a local run of the app.
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return NextResponse.json({ ok: false, error: 'No file uploaded' }, { status: 400 });
    }
    const f = file as File;
    const name = (f.name || 'backup.sql').replace(/[^\w.\-]/g, '_');
    const gzipped = /\.sql\.gz$/i.test(name);
    if (!gzipped && !/\.sql$/i.test(name)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Expected a plain-text pg_dump file (.sql, or .sql.gz). Custom-format dumps (.dump / .backup) need the pg_restore binary and are not supported — re-dump with pg_dump in plain format.',
        },
        { status: 400 },
      );
    }
    let buf = Buffer.from(await f.arrayBuffer());
    if (buf.length > MAX_RESTORE_BYTES) {
      return NextResponse.json(
        { ok: false, error: `Dump is larger than ${MAX_RESTORE_BYTES / 1024 / 1024} MB — split it or restore it with psql.` },
        { status: 400 },
      );
    }
    if (gzipped) {
      try {
        buf = zlib.gunzipSync(buf);
      } catch {
        return NextResponse.json({ ok: false, error: 'Could not decompress the .gz file — is it a valid gzip dump?' }, { status: 400 });
      }
      if (buf.length > MAX_RESTORE_BYTES) {
        return NextResponse.json(
          { ok: false, error: `Decompressed dump is larger than ${MAX_RESTORE_BYTES / 1024 / 1024} MB — split it or restore it with psql.` },
          { status: 400 },
        );
      }
    }
    const sql = buf.toString('utf-8');
    const statements = splitSqlStatements(sql);
    const summary = summarizeRestore(statements);
    const { fileId } = saveRestoreUpload(name, buf);
    return NextResponse.json({
      ok: true,
      fileId,
      fileName: name,
      sizeBytes: buf.length,
      ...summary,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
