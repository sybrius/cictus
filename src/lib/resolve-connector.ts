import { loadConnectors, sourceFormValues, targetConnectionString } from '@/lib/connectors';
import type { SourceFormValues } from '@/components/ConnectionForm';

/**
 * Resolve a connection from either a saved connector id or a form
 * payload. Connectors keep their password on the server (in
 * data/connectors.json) — the browser only ever sends the connector
 * id, never the password. This is what lets the wizard use a saved
 * NHost / Supabase / Postgres / SQL Server / MySQL connector without
 * re-typing credentials.
 *
 * The source type (sqlserver | mysql) comes from the connector when
 * one is used, or from the form's `sourceType` field otherwise
 * (defaulting to sqlserver for older payloads).
 */
export function resolveSource(body: Record<string, unknown>): { config: SourceFormValues; connectorName: string | null; sourceType: 'sqlserver' | 'mysql' } {
  const id = typeof body.sourceConnectorId === 'string' ? body.sourceConnectorId : '';
  if (id) {
    const c = loadConnectors().find((x) => x.id === id && x.kind === 'source');
    if (!c) throw new Error('Source connector not found');
    return {
      config: sourceFormValues(c),
      connectorName: c.name,
      sourceType: c.type === 'mysql' ? 'mysql' : 'sqlserver',
    };
  }
  const src = (body.source ?? body) as SourceFormValues;
  const sourceType =
    (src as { sourceType?: unknown }).sourceType === 'mysql' ||
    (body as { sourceType?: unknown }).sourceType === 'mysql'
      ? 'mysql' as const
      : 'sqlserver' as const;
  return { config: src, connectorName: null, sourceType };
}

export function resolveTarget(body: Record<string, unknown>): { connectionString: string; connectorName: string | null; connectorType: string | null } {
  const id = typeof body.targetConnectorId === 'string' ? body.targetConnectorId : '';
  if (id) {
    const c = loadConnectors().find((x) => x.id === id && x.kind === 'target');
    if (!c) throw new Error('Target connector not found');
    return { connectionString: targetConnectionString(c), connectorName: c.name, connectorType: c.type };
  }
  const tgt = (body.target ?? body) as { connectionString: string };
  return { connectionString: tgt.connectionString ?? '', connectorName: null, connectorType: null };
}
