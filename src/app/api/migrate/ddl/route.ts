import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SqlServerConfigSchema, introspectSchema } from '@/lib/sqlserver';
import { generateMigrationScript } from '@/lib/ddl';

const BodySchema = z.object({
  source: SqlServerConfigSchema,
  tables: z.array(z.string()).min(1, 'Select at least one table'),
  views: z.array(z.string()).default([]),
  overrides: z.record(z.string()).default({}),
});

/**
 * POST → { script, viewNotes }
 * The wizard also offers this as a download: the client turns the
 * returned script into a .sql file. Nothing is executed by this route.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }
  try {
    const full = await introspectSchema(parsed.data.source);
    const tables = full.tables.filter((t) => parsed.data.tables.includes(`${t.schema}.${t.name}`));
    const views = full.views.filter((v) => parsed.data.views.includes(`${v.schema}.${v.name}`));
    const { script, viewNotes } = generateMigrationScript(tables, views, parsed.data.overrides);
    return NextResponse.json({ ok: true, script, viewNotes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
