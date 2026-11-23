import { NextResponse } from 'next/server';
import { SqlServerConfigSchema, testSqlServerConnection } from '@/lib/sqlserver';
import { MysqlConfigSchema, testMysqlConnection } from '@/lib/mysql';
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
      const result = await testMysqlConnection(parsed.data);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }
    const parsed = SqlServerConfigSchema.safeParse(config);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      );
    }
    const result = await testSqlServerConnection(parsed.data);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
