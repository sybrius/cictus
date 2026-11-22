import { NextResponse } from 'next/server';
import { SqlServerConfigSchema, introspectSchema } from '@/lib/sqlserver';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = SqlServerConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }
  try {
    const schema = await introspectSchema(parsed.data);
    return NextResponse.json({ ok: true, schema });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
