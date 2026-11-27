import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { uploadsDir } from '@/lib/sqlite';
import { requireAuth } from '@/lib/api-auth';

/**
 * POST a SQLite file (multipart form, field `file`) — stores it under
 * data/uploads/ and returns its server-side path, which the wizard
 * then uses as the SQLite source filePath. The file is never
 * executed, only opened read-only by the SQLite source.
 *
 * Filenames are sanitised to a basename; an existing upload with the
 * same name is overwritten. Max 2 GB (a SQLite file can be large).
 */
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth) return auth;
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return NextResponse.json({ ok: false, error: 'No file uploaded' }, { status: 400 });
    }
    const f = file as File;
    const name = path.basename(f.name || 'database.sqlite').replace(/[^\w.\-]/g, '_');
    if (!/\.(sqlite3?|db)$/i.test(name)) {
      return NextResponse.json({ ok: false, error: 'Expected a .sqlite, .sqlite3 or .db file' }, { status: 400 });
    }
    const dir = uploadsDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    const buf = Buffer.from(await f.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return NextResponse.json({ ok: true, filePath: dest, size: buf.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
