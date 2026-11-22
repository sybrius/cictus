import { NextResponse } from 'next/server';
import { TargetConfigSchema, testTargetConnection } from '@/lib/postgres';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = TargetConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }
  const result = await testTargetConnection(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
