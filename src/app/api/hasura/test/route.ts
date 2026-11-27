import { NextResponse } from 'next/server';
import { loadConnectors } from '@/lib/connectors';
import { hasuraConfigForConnector, testHasuraConnection } from '@/lib/hasura';
import { requireAuth } from '@/lib/api-auth';

/** POST { id } — test a saved NHost / Postgres connector's Hasura
 *  endpoint + admin secret (export_metadata round-trip, no changes). */
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth) return auth;
  const body = await req.json().catch(() => null);
  const id = body?.id ? String(body.id) : '';
  const c = loadConnectors().find((x) => x.id === id);
  if (!c) return NextResponse.json({ ok: false, error: 'Connector not found' }, { status: 404 });
  const cfg = hasuraConfigForConnector(c);
  if (!cfg) {
    return NextResponse.json(
      { ok: false, error: 'No Hasura admin secret saved on this connector — add one on the Connectors page first.' },
      { status: 400 },
    );
  }
  const result = await testHasuraConnection(cfg);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
