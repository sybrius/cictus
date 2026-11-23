import type { Connector } from './connectors';

/**
 * Hasura Metadata API integration — auto-track migrated tables (and
 * views) in Hasura after a migration, so they appear in the GraphQL
 * API without opening the Hasura console.
 *
 * Uses the Metadata API v2: POST /v1/metadata with
 * {"type": "pg_track_table", "args": {"source": "default",
 * "table": {"schema": "public", "name": "CallLog"}}} and the
 * x-hasura-admin-secret header. A table that is already tracked
 * returns 400 `already-tracked` — that is treated as success, not
 * an error.
 *
 * Endpoint: NHost derives it from the subdomain + region —
 * https://<subdomain>.hasura.<region>.nhost.run/v1/metadata.
 * A plain Postgres target with a Hasura instance uses the
 * connector's hasuraEndpoint instead (base URL or full
 * …/v1/metadata URL). Supabase has no Hasura — nothing is tracked
 * there.
 *
 * Caveat (NHost, 2026): NHost is rolling out Constellation, its own
 * GraphQL engine, alongside Hasura. Constellation does not implement
 * the metadata HTTP API — metadata authoring still goes through the
 * Hasura host above, which is what this calls.
 *
 * The admin secret lives on the connector (data/connectors.json,
 * like the password) and is never sent to the browser. Tracking is
 * best-effort: if Hasura is unreachable or rejects a table, the
 * failure is logged and reported per table — the migration itself
 * is never failed by it.
 */

export interface HasuraConfig {
  endpoint: string; // full …/v1/metadata URL
  adminSecret: string;
}

function metadataUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1/metadata') ? trimmed : `${trimmed}/v1/metadata`;
}

export function hasuraConfigForConnector(c: Connector | null | undefined): HasuraConfig | null {
  if (!c || !c.hasuraAdminSecret) return null;
  if (c.type === 'nhost' && c.projectRef) {
    const region = c.region || 'eu-central-1';
    const base = c.hasuraEndpoint?.trim() || `https://${c.projectRef}.hasura.${region}.nhost.run`;
    return { endpoint: metadataUrl(base), adminSecret: c.hasuraAdminSecret };
  }
  if (c.type === 'postgres' && c.hasuraEndpoint?.trim()) {
    return { endpoint: metadataUrl(c.hasuraEndpoint), adminSecret: c.hasuraAdminSecret };
  }
  return null;
}

export interface HasuraTrackResult {
  tracked: string[];
  alreadyTracked: string[];
  failed: { table: string; error: string }[];
}

async function postMetadata(cfg: HasuraConfig, body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': cfg.adminSecret,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

export async function trackTablesInHasura(
  cfg: HasuraConfig,
  tables: { schema: string; name: string }[],
): Promise<HasuraTrackResult> {
  const result: HasuraTrackResult = { tracked: [], alreadyTracked: [], failed: [] };
  for (const t of tables) {
    const label = `${t.schema}.${t.name}`;
    try {
      const r = await postMetadata(cfg, {
        type: 'pg_track_table',
        args: { source: 'default', table: { schema: t.schema, name: t.name } },
      });
      if (r.ok) {
        result.tracked.push(label);
        continue;
      }
      let code = '';
      try {
        code = (JSON.parse(r.text) as { code?: string }).code ?? '';
      } catch {
        code = '';
      }
      if (code === 'already-tracked' || /already tracked/i.test(r.text)) {
        result.alreadyTracked.push(label);
      } else {
        result.failed.push({ table: label, error: r.text.slice(0, 300) || `HTTP ${r.status}` });
      }
    } catch (err) {
      result.failed.push({ table: label, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Check the endpoint + secret work, without changing anything. */
export async function testHasuraConnection(cfg: HasuraConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await postMetadata(cfg, { type: 'export_metadata', args: {} });
    if (r.ok) return { ok: true };
    return { ok: false, error: `Hasura returned HTTP ${r.status}: ${r.text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
