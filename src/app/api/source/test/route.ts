import { NextResponse } from 'next/server';
import { resolveSource } from '@/lib/resolve-connector';
import { parseSourceConfig, testSourceConnection } from '@/lib/source-dispatch';
import { requireUser } from '@/lib/api-auth';

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  try {
    const { config, sourceType } = await resolveSource((body ?? {}) as Record<string, unknown>, user.id);
    parseSourceConfig(sourceType, config); // 400 on a bad config, before connecting
    const result = await testSourceConnection(sourceType, config);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
