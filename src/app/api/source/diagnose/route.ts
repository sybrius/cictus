import { NextResponse } from 'next/server';
import { resolveSource } from '@/lib/resolve-connector';
import { diagnoseSource } from '@/lib/source-dispatch';
import { requireUser } from '@/lib/api-auth';

// POST /api/source/diagnose — network-only check (DNS + TCP), no login.
// Tells the user whether the failure is DNS, TCP/port, or login/TLS.
// For SQLite it checks the file exists and is readable instead.
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  try {
    const { config, sourceType } = await resolveSource((body ?? {}) as Record<string, unknown>, user.id);
    const result = await diagnoseSource(sourceType, config);
    return NextResponse.json({ ok: result.dns.ok && result.tcp.ok, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
