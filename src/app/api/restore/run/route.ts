import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { requireUser } from '@/lib/api-auth';
import { resolveTarget } from '@/lib/resolve-connector';
import { TargetConfigSchema, createTargetPool } from '@/lib/postgres';
import { recordRunFinish, recordRunStart } from '@/lib/history-db';
import {
  deleteRestoreUpload,
  executeRestore,
  restoreUploadPath,
  splitSqlStatements,
  stripLeadingComments,
  summarizeRestore,
} from '@/lib/restore';

const BodySchema = z.object({
  fileId: z.string().min(1, 'fileId is required'),
  fileName: z.string().default('backup.sql'),
  targetConnectorId: z.string().optional(),
  target: z.unknown().optional(),
  stopOnError: z.boolean().default(false),
});

/**
 * POST → Server-Sent Events stream (text/event-stream).
 * Restores a dump parsed by /api/restore/parse into the resolved
 * target (saved connector or manual connection string). Statements
 * run one at a time; a failed statement is reported and — unless
 * stopOnError is set — the run moves on, since dumps routinely
 * contain a few statements the target rejects (extensions, owners,
 * already-existing objects).
 *
 * The run is recorded in History (run name "Restore <file>") the
 * way migrations are, and the uploaded dump is deleted when the
 * run finishes, whether it succeeded or not.
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }
  const { fileId, fileName, stopOnError } = parsed.data;

  let connectionString: string;
  let targetName: string;
  let targetType: string;
  try {
    const t = await resolveTarget(
      { targetConnectorId: parsed.data.targetConnectorId, target: parsed.data.target },
      user.id,
    );
    const tParsed = TargetConfigSchema.safeParse({ connectionString: t.connectionString });
    if (!tParsed.success) throw new Error(tParsed.error.issues.map((i) => i.message).join('; '));
    connectionString = tParsed.data.connectionString;
    targetName = t.connectorName ?? 'Postgres target';
    targetType = t.connectorType ?? 'postgres';
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const uploadPath = restoreUploadPath(fileId);
  if (!uploadPath || !fs.existsSync(uploadPath)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Upload expired — the dump file is no longer on the server (on serverless hosts the temp file may not survive between requests). Upload it again from the Restore page.',
      },
      { status: 400 },
    );
  }
  const sql = fs.readFileSync(uploadPath, 'utf-8');
  const statements = splitSqlStatements(sql);
  const summary = summarizeRestore(statements);
  if (statements.length === 0) {
    return NextResponse.json({ ok: false, error: 'No statements found in the dump.' }, { status: 400 });
  }

  const pool = createTargetPool({ connectionString });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    await pool.end().catch(() => undefined);
    return NextResponse.json(
      { ok: false, error: `Could not connect to the target: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const runId = crypto.randomUUID();
  // History is best-effort: a Turso failure must never break a restore.
  try {
    await recordRunStart({
      id: runId,
      sourceName: `Restore ${fileName}`,
      targetName,
      targetType,
      tablesTotal: summary.tables.length,
      viewsTotal: summary.views.length,
      trigger: 'manual',
      runName: `Restore ${fileName}`,
    });
  } catch {
    /* ignore */
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let alive = true;
      const send = (e: unknown) => {
        if (!alive) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          alive = false;
        }
      };
      try {
        const result = await executeRestore(pool, statements, {
          stopOnError,
          onProgress: (p) => send({ type: 'progress', done: p.done, total: p.total, label: p.label }),
          onError: (e) => send({ type: 'error', index: e.index, statement: e.statement, message: e.message }),
        });
        const failedCreateTable = result.errors.filter((e) =>
          /^CREATE\s+TABLE\b/i.test(stripLeadingComments(e.statement)),
        ).length;
        const failedCreateView = result.errors.filter((e) =>
          /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(stripLeadingComments(e.statement)),
        ).length;
        const aborted = stopOnError && result.failed > 0;
        try {
          await recordRunFinish({
            id: runId,
            status: aborted ? 'failed' : 'completed',
            tablesSucceeded: summary.tables.length - failedCreateTable,
            rowsCopied: result.rowsRestored,
            viewsCreated: summary.views.length - failedCreateView,
            errorsCount: result.failed,
            tables: [],
            errors: result.errors.map((e) => ({ scope: e.statement.slice(0, 120), message: e.message })),
          });
        } catch {
          /* ignore */
        }
        send({
          type: 'done',
          summary: {
            statements: statements.length,
            succeeded: result.succeeded,
            failed: result.failed,
            rowsRestored: result.rowsRestored,
            aborted,
            errors: result.errors.map((e) => `${e.statement}: ${e.message}`),
          },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send({ type: 'error', message });
        try {
          await recordRunFinish({
            id: runId,
            status: 'failed',
            tablesSucceeded: 0,
            rowsCopied: 0,
            viewsCreated: 0,
            errorsCount: 1,
            tables: [],
            errors: [{ scope: 'restore', message }],
          });
        } catch {
          /* ignore */
        }
      } finally {
        deleteRestoreUpload(fileId);
        await pool.end().catch(() => undefined);
        if (alive) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
