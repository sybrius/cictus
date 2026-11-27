import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TargetConfigSchema } from '@/lib/postgres';
import { executeMigration, resolveSourceConfig, type MigrationJob, type ProgressEvent } from '@/lib/run-migration';
import { resolveSource, resolveTarget } from '@/lib/resolve-connector';
import { parseSourceConfig } from '@/lib/source-dispatch';
import { hasuraConfigForConnector } from '@/lib/hasura';
import { requireUser } from '@/lib/api-auth';

const BodySchema = z.object({
  // Raw form values, accepted as-is: when a connector id is given,
  // these are the wizard's untouched defaults (empty password /
  // empty connection string) and the resolver below replaces them
  // with the saved connector's credentials. Validating them here
  // was the bug behind the 400 on /api/migrate with a connector
  // selected — the resolved config is validated instead, below.
  source: z.unknown().optional(),
  sourceConnectorId: z.string().optional(),
  target: z.unknown().optional(),
  targetConnectorId: z.string().optional(),
  tables: z.array(z.string()).min(1, 'Select at least one table'),
  views: z.array(z.string()).default([]),
  overrides: z.record(z.string()).default({}),
  includeData: z.boolean().default(true),
  dropExisting: z.boolean().default(false),
  useCopy: z.boolean().default(true),
  trackInHasura: z.boolean().default(false),
  // Display names for the Turso history record (not credentials).
  sourceName: z.string().optional(),
  targetName: z.string().optional(),
  targetType: z.string().optional(),
});

type OutEvent =
  | ProgressEvent
  | { type: 'phase'; phase: string }
  | { type: 'view-done'; view: string; notes: string[] }
  | { type: 'validation'; table: string; source: number; target: number; match: boolean }
  | { type: 'done'; summary: { tables: number; rowsCopied: number; views: number; errors: string[]; hasura?: { tracked: string[]; alreadyTracked: string[]; failed: { table: string; error: string }[] } } };

/**
 * POST → Server-Sent Events stream (text/event-stream).
 * The work itself lives in the shared engine in
 * src/lib/run-migration.ts (the scheduler calls the same function);
 * this route only resolves connectors, forwards engine events to
 * the browser stream, and sends the final summary.
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  // Resolve saved connectors server-side (passwords never leave the
  // server) or fall back to the form values the wizard sent.
  // The source type comes from the connector or the form's sourceType
  // field; the config is validated against the matching schema.
  let job: MigrationJob;
  try {
    const s = await resolveSource({ sourceConnectorId: parsed.data.sourceConnectorId, source: parsed.data.source }, user.id);
    const t = await resolveTarget({ targetConnectorId: parsed.data.targetConnectorId, target: parsed.data.target }, user.id);
    const sParsed = parseSourceConfig(s.sourceType, s.config);
    const tParsed = TargetConfigSchema.safeParse({ connectionString: t.connectionString });
    if (!tParsed.success) throw new Error(tParsed.error.issues.map((i) => i.message).join('; '));
    const srcCfg = sParsed as { host?: string; database?: string; filePath?: string; service?: string; connectionString?: string };
    const sourceName =
      parsed.data.sourceName ||
      s.connectorName ||
      (s.sourceType === 'sqlite' && srcCfg.filePath
        ? `SQLite ${srcCfg.filePath.split(/[\\/]/).pop()}`
        : s.sourceType === 'postgres' && srcCfg.connectionString
          ? 'PostgreSQL source'
          : s.sourceType === 'oracle' && srcCfg.host
            ? `${srcCfg.host}/${srcCfg.service ?? ''}`
            : `${srcCfg.host ?? ''}/${srcCfg.database ?? ''}`);
    job = {
      source: resolveSourceConfig(s.sourceType, sParsed),
      target: tParsed.data,
      tables: parsed.data.tables,
      views: parsed.data.views,
      overrides: parsed.data.overrides,
      includeData: parsed.data.includeData,
      dropExisting: parsed.data.dropExisting,
      useCopy: parsed.data.useCopy,
      trackInHasura: parsed.data.trackInHasura,
      hasura: hasuraConfigForConnector(t.connector),
      sourceName,
      targetName: parsed.data.targetName || t.connectorName || 'Postgres target',
      targetType: parsed.data.targetType || t.connectorType || 'postgres',
      trigger: 'manual',
    };
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // A failed enqueue must never kill the migration. controller.enqueue
      // throws once the stream is closed or errored (e.g. the browser
      // connection drops mid-run) — and every log/progress call goes
      // through send(), so one throw used to poison the whole run:
      // the outer catch's sends threw too, then controller.close()
      // in finally threw, the stream errored, and the browser
      // reported "network error" instead of the per-table
      // skip-and-continue behaviour. Now a dead stream just stops
      // receiving events; the migration keeps going server-side and
      // its result is still recorded in the Turso history.
      let streamAlive = true;
      const send = (e: OutEvent) => {
        if (!streamAlive) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          streamAlive = false;
        }
      };
      try {
        const summary = await executeMigration(job, {
          log: (message) => send({ type: 'log', message }),
          phase: (phase) => send({ type: 'phase', phase }),
          event: (e) => send(e),
          viewDone: (view, notes) => send({ type: 'view-done', view, notes }),
          validation: (row) => send({ type: 'validation', ...row }),
        });
        send({ type: 'done', summary });
      } catch (err) {
        // executeMigration already returns a summary instead of
        // throwing; this is only a last-resort guard.
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: 'error', table: '', message: msg });
        send({ type: 'done', summary: { tables: 0, rowsCopied: 0, views: 0, errors: [msg] } });
      } finally {
        try {
          controller.close();
        } catch {
          // Stream already closed/errored — see the safe send() above.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
