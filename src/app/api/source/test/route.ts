import { NextResponse } from 'next/server';
import { resolveSource } from '@/lib/resolve-connector';
import { parseSourceConfig, testSourceConnection } from '@/lib/source-dispatch';
import { requireAuth } from '@/lib/api-auth';

export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth) return auth;
  const body = await req.json().catch(() => null);
  try {
    const { config, sourceType } = resolveSource((body ?? {}) as Record<string, unknown>);
    parseSourceConfig(sourceType, config); // 400 on a bad config, before connecting
    const result = await testSourceConnection(sourceType, config);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
