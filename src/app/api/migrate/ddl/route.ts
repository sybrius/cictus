import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generateMigrationScript } from '@/lib/ddl';
import { resolveSource } from '@/lib/resolve-connector';
import { introspectSource, viewDatabaseArg } from '@/lib/source-dispatch';

const BodySchema = z.object({
  // Same as /api/migrate: raw form values accepted as-is, so a
  // connector run (empty password / connection string in the form)
  // is not rejected with a 400 before the resolver runs.
  source: z.unknown().optional(),
  sourceConnectorId: z.string().optional(),
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
    const { config, sourceType } = resolveSource({
      sourceConnectorId: parsed.data.sourceConnectorId,
      source: parsed.data.source,
    });
    const full = await introspectSource(sourceType, config);
    const tables = full.tables.filter((t) => parsed.data.tables.includes(`${t.schema}.${t.name}`));
    const views = full.views.filter((v) => parsed.data.views.includes(`${v.schema}.${v.name}`));
    const { script, viewNotes } = generateMigrationScript(
      tables,
      views,
      parsed.data.overrides,
      sourceType,
      viewDatabaseArg(sourceType, config),
    );
    return NextResponse.json({ ok: true, script, viewNotes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
