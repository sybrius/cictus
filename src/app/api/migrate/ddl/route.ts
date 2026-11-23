import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SqlServerConfigSchema, introspectSchema } from '@/lib/sqlserver';
import { MysqlConfigSchema, introspectMysqlSchema } from '@/lib/mysql';
import { generateMigrationScript } from '@/lib/ddl';
import { resolveSource } from '@/lib/resolve-connector';

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
    // Parse against the matching source schema (the union cannot be
    // narrowed from the ternary, so each branch validates and runs
    // on its own).
    if (sourceType === 'mysql') {
      const p = MysqlConfigSchema.safeParse(config);
      if (!p.success) {
        return NextResponse.json(
          { ok: false, error: p.error.issues.map((i) => i.message).join('; ') },
          { status: 400 },
        );
      }
      const full = await introspectMysqlSchema(p.data);
      const tables = full.tables.filter((t) => parsed.data.tables.includes(`${t.schema}.${t.name}`));
      const views = full.views.filter((v) => parsed.data.views.includes(`${v.schema}.${v.name}`));
      const { script, viewNotes } = generateMigrationScript(tables, views, parsed.data.overrides, 'mysql', p.data.database);
      return NextResponse.json({ ok: true, script, viewNotes });
    }
    const p = SqlServerConfigSchema.safeParse(config);
    if (!p.success) {
      return NextResponse.json(
        { ok: false, error: p.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      );
    }
    const full = await introspectSchema(p.data);
    const tables = full.tables.filter((t) => parsed.data.tables.includes(`${t.schema}.${t.name}`));
    const views = full.views.filter((v) => parsed.data.views.includes(`${v.schema}.${v.name}`));
    const { script, viewNotes } = generateMigrationScript(tables, views, parsed.data.overrides, 'sqlserver', p.data.database);
    return NextResponse.json({ ok: true, script, viewNotes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
