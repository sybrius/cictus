import { NextResponse } from 'next/server';
import { resolveSource } from '@/lib/resolve-connector';
import { introspectSource } from '@/lib/source-dispatch';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  try {
    const { config, sourceType } = resolveSource((body ?? {}) as Record<string, unknown>);
    const schema = await introspectSource(sourceType, config);
    return NextResponse.json({ ok: true, schema });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
