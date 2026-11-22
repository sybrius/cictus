import { NextResponse } from 'next/server';
import { SqlServerConfigSchema, testSqlServerConnection } from '@/lib/sqlserver';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = SqlServerConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }
  const result = await testSqlServerConnection(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
