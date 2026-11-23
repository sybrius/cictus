import { NextResponse } from 'next/server';
import {
  loadConnectors, markTested, targetConnectionString, sourceFormValues,
} from '@/lib/connectors';
import { testTargetConnection } from '@/lib/postgres';
import { testSourceConnection } from '@/lib/source-dispatch';
import type { SourceKind } from '@/lib/type-map';

/** POST { id } — test a saved connector with the password stored on this machine. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const id = body?.id ? String(body.id) : '';
  const c = loadConnectors().find((x) => x.id === id);
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
    markTested(c.id, result.ok, result.ok ? result.version ?? 'Connected' : result.error ?? 'Failed');
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markTested(c.id, false, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
