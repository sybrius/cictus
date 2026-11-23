import { NextResponse } from 'next/server';
import {
  loadConnectors, markTested, targetConnectionString, sourceFormValues,
} from '@/lib/connectors';
import { testTargetConnection } from '@/lib/postgres';
import { testSqlServerConnection } from '@/lib/sqlserver';
import { testMysqlConnection } from '@/lib/mysql';

/** POST { id } — test a saved connector with the password stored on this machine. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const id = body?.id ? String(body.id) : '';
  const c = loadConnectors().find((x) => x.id === id);
  if (!c) return NextResponse.json({ ok: false, error: 'Connector not found' }, { status: 404 });
  try {
    const result =
      c.type === 'mysql'
        ? await testMysqlConnection(sourceFormValues(c))
        : c.kind === 'source'
          ? await testSqlServerConnection(sourceFormValues(c))
          : await testTargetConnection({ connectionString: targetConnectionString(c) });
    markTested(c.id, result.ok, result.ok ? result.version ?? 'Connected' : result.error ?? 'Failed');
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markTested(c.id, false, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
