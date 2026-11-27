import { NextResponse } from 'next/server';
import {
  getConnector, markTested, targetConnectionString, sourceFormValues,
} from '@/lib/connectors';
import { testTargetConnection } from '@/lib/postgres';
import { testSourceConnection } from '@/lib/source-dispatch';
import type { SourceKind } from '@/lib/type-map';
import { requireUser } from '@/lib/api-auth';

/** POST { id } — test a saved connector with the password stored in Turso. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  const id = body?.id ? String(body.id) : '';
  const c = await getConnector(user.id, id);
  if (!c) return NextResponse.json({ ok: false, error: 'Connector not found' }, { status: 404 });
  try {
    let result: { ok: boolean; version?: string; database?: string; error?: string };
    if (c.kind === 'source') {
      const sourceType: SourceKind =
        c.type === 'mysql' ? 'mysql'
        : c.type === 'postgres-source' ? 'postgres'
        : c.type === 'oracle' ? 'oracle'
        : c.type === 'sqlite' ? 'sqlite'
        : 'sqlserver';
      result = await testSourceConnection(sourceType, sourceFormValues(c));
    } else {
      result = await testTargetConnection({ connectionString: targetConnectionString(c) });
    }
    await markTested(user.id, c.id, result.ok, result.ok ? result.version ?? 'Connected' : result.error ?? 'Failed');
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markTested(user.id, c.id, false, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
