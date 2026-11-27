import { NextResponse } from 'next/server';
import { TargetConfigSchema, testTargetConnection } from '@/lib/postgres';
import { resolveTarget } from '@/lib/resolve-connector';
import { requireUser } from '@/lib/api-auth';

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  try {
    const { connectionString } = await resolveTarget((body ?? {}) as Record<string, unknown>, user.id);
    const parsed = TargetConfigSchema.safeParse({ connectionString });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      );
    }
    const result = await testTargetConnection(parsed.data);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
