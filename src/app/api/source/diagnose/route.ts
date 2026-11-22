import { NextResponse } from 'next/server';
import { SqlServerConfigSchema, diagnoseSqlServer } from '@/lib/sqlserver';

// POST /api/source/diagnose — network-only check (DNS + TCP), no login.
// Tells the user whether the failure is DNS, TCP/port, or login/TLS.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = SqlServerConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }
  const result = await diagnoseSqlServer(parsed.data);
  return NextResponse.json({ ok: result.dns.ok && result.tcp.ok, ...result });
}
