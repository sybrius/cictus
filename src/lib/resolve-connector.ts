import { loadConnectors, sourceFormValues, targetConnectionString } from '@/lib/connectors';
import type { Connector } from '@/lib/connectors';
import type { SourceFormValues } from '@/components/ConnectionForm';
import type { SourceKind } from '@/lib/type-map';

/**
 * Resolve a connection from either a saved connector id or a form
 * payload. Connectors keep their password on the server (in Turso,
 * scoped to the signed-in user) — the browser only ever sends the
 * connector id, never the password. This is what lets the wizard use
 * a saved NHost / Supabase / Postgres / SQL Server / MySQL / Oracle /
 * SQLite connector without re-typing credentials.
 *
 * The source type comes from the connector when one is used, or from
 * the form's `sourceType` field otherwise (defaulting to sqlserver
 * for older payloads).
 *
 * `userId` scopes the lookup to the signed-in user's connectors; a
 * connector id belonging to another user resolves as "not found".
 * The scheduler passes the schedule owner's id; an empty userId
 * only ever matches form payloads, never a saved connector.
 */

function sourceTypeFromConnector(c: Connector): SourceKind {
  switch (c.type) {
    case 'mysql': return 'mysql';
    case 'postgres-source': return 'postgres';
    case 'oracle': return 'oracle';
    case 'sqlite': return 'sqlite';
    default: return 'sqlserver';
  }
}

function sourceTypeFromValue(v: unknown): SourceKind {
  if (v === 'mysql' || v === 'postgres' || v === 'oracle' || v === 'sqlite') return v;
  return 'sqlserver';
}

export async function resolveSource(body: Record<string, unknown>, userId = ''): Promise<{ config: SourceFormValues; connectorName: string | null; sourceType: SourceKind }> {
  const id = typeof body.sourceConnectorId === 'string' ? body.sourceConnectorId : '';
  if (id) {
    const c = (await loadConnectors(userId)).find((x) => x.id === id && x.kind === 'source');
    if (!c) throw new Error('Source connector not found');
    return {
      config: sourceFormValues(c),
      connectorName: c.name,
      sourceType: sourceTypeFromConnector(c),
    };
  }
  const src = (body.source ?? body) as SourceFormValues & { sourceType?: unknown };
  const sourceType = sourceTypeFromValue(
    src.sourceType ?? (body as { sourceType?: unknown }).sourceType,
  );
  return { config: src, connectorName: null, sourceType };
}

export async function resolveTarget(body: Record<string, unknown>, userId = ''): Promise<{ connectionString: string; connectorName: string | null; connectorType: string | null; connector: Connector | null }> {
  const id = typeof body.targetConnectorId === 'string' ? body.targetConnectorId : '';
  if (id) {
    const c = (await loadConnectors(userId)).find((x) => x.id === id && x.kind === 'target');
    if (!c) throw new Error('Target connector not found');
    return { connectionString: targetConnectionString(c), connectorName: c.name, connectorType: c.type, connector: c };
  }
  const tgt = (body.target ?? body) as { connectionString: string };
  return { connectionString: tgt.connectionString ?? '', connectorName: null, connectorType: null, connector: null };
}
