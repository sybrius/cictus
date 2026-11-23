import { NextResponse } from 'next/server';
import {
  loadConnectors, saveConnector, deleteConnector, publicConnector,
  CONNECTOR_TYPES, type ConnectorInput,
} from '@/lib/connectors';

export async function GET() {
  return NextResponse.json({ ok: true, connectors: loadConnectors().map(publicConnector) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }
  const type = body.type as keyof typeof CONNECTOR_TYPES;
  if (!CONNECTOR_TYPES[type]) {
    return NextResponse.json({ ok: false, error: 'Unknown connector type' }, { status: 400 });
  }
  const input: ConnectorInput = {
    name: String(body.name ?? '').trim(),
    kind: CONNECTOR_TYPES[type].kind,
    type,
    projectRef: String(body.projectRef ?? '').trim(),
    region: String(body.region ?? '').trim(),
    host: String(body.host ?? '').trim(),
    port: Number(body.port) || (type === 'sqlserver' ? 1433 : type === 'mysql' ? 3306 : type === 'oracle' ? 1521 : 5432),
    database: String(body.database ?? '').trim(),
    user: String(body.user ?? '').trim(),
    password: String(body.password ?? ''),
    connectionString: String(body.connectionString ?? '').trim(),
    ssl: body.ssl === true,
    instance: String(body.instance ?? '').trim(),
    encrypt: body.encrypt !== false,
    trustCert: body.trustCert !== false,
    service: String(body.service ?? '').trim(),
    filePath: String(body.filePath ?? '').trim(),
    hasuraAdminSecret: String(body.hasuraAdminSecret ?? ''),
    hasuraEndpoint: String(body.hasuraEndpoint ?? '').trim(),
  };
  if (!input.name) return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 });
  if ((input.type === 'sqlserver' || input.type === 'mysql' || input.type === 'oracle') && !input.host) {
    return NextResponse.json({ ok: false, error: 'Host is required' }, { status: 400 });
  }
  if (input.type === 'oracle' && !input.service) {
    return NextResponse.json({ ok: false, error: 'Service name is required' }, { status: 400 });
  }
  if (input.type === 'sqlite' && !input.filePath) {
    return NextResponse.json({ ok: false, error: 'File path is required' }, { status: 400 });
  }
  if (input.type !== 'sqlserver' && input.type !== 'mysql' && input.type !== 'oracle' && input.type !== 'sqlite' && !input.connectionString && !input.host && !input.projectRef) {
    return NextResponse.json({ ok: false, error: 'Host, project ref, or a connection string is required' }, { status: 400 });
  }
  try {
    // Keep the existing password when editing without re-typing it.
    const existing = body.id ? loadConnectors().find((c) => c.id === body.id) : undefined;
    if (existing && !input.password) input.password = existing.password;
    if (existing && !input.hasuraAdminSecret) input.hasuraAdminSecret = existing.hasuraAdminSecret ?? '';
    const saved = saveConnector(input, body.id ? String(body.id) : undefined);
    return NextResponse.json({ ok: true, connector: publicConnector(saved) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  deleteConnector(id);
  return NextResponse.json({ ok: true });
}
