import { NextResponse } from 'next/server';
import { SqlServerConfigSchema, introspectSchema } from '@/lib/sqlserver';
import { MysqlConfigSchema, introspectMysqlSchema } from '@/lib/mysql';
import { resolveSource } from '@/lib/resolve-connector';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  try {
    const { config, sourceType } = resolveSource((body ?? {}) as Record<string, unknown>);
    if (sourceType === 'mysql') {
      const parsed = MysqlConfigSchema.safeParse(config);
      if (!parsed.success) {
        return NextResponse.json(
          { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
          { status: 400 },
        );
      }
      const schema = await introspectMysqlSchema(parsed.data);
      return NextResponse.json({ ok: true, schema });
    }
    const parsed = SqlServerConfigSchema.safeParse(config);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      );
    }
    const schema = await introspectSchema(parsed.data);
    return NextResponse.json({ ok: true, schema });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
