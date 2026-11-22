import { z } from 'zod';
import { SqlServerConfigSchema, introspectSchema } from '@/lib/sqlserver';
import { TargetConfigSchema, createTargetPool, executeDdlInTransaction, targetRowCount } from '@/lib/postgres';
import { schemaStatements } from '@/lib/ddl';
import { copyTableData, fixIdentitySequences, type ProgressEvent } from '@/lib/migrate-data';

const BodySchema = z.object({
  source: SqlServerConfigSchema,
  target: TargetConfigSchema,
  tables: z.array(z.string()).min(1, 'Select at least one table'),
  views: z.array(z.string()).default([]),
  overrides: z.record(z.string()).default({}),
  includeData: z.boolean().default(true),
  dropExisting: z.boolean().default(false),
});

type OutEvent =
  | ProgressEvent
  | { type: 'phase'; phase: string }
  | { type: 'view-done'; view: string; notes: string[] }
  | { type: 'validation'; table: string; source: number; target: number; match: boolean }
  | { type: 'done'; summary: { tables: number; rowsCopied: number; views: number; errors: string[] } };

/**
 * POST → Server-Sent Events stream (text/event-stream).
 * Phases: schema (tables → FKs → indexes) → data (batched copy) →
 * views → validate (row counts source vs target).
 * The client reads the stream with fetch + ReadableStream and renders
 * live progress; the response only ends when migration is complete.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const { source, target, overrides, includeData, dropExisting } = parsed.data;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: OutEvent) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      const log = (message: string) => send({ type: 'log', message });
      const errors: string[] = [];
      const pool = createTargetPool(target);
      try {
        const full = await introspectSchema(source);
        const tables = full.tables.filter((t) => parsed.data.tables.includes(`${t.schema}.${t.name}`));
        const views = full.views.filter((v) => parsed.data.views.includes(`${v.schema}.${v.name}`));
        const stmts = schemaStatements(tables, views, overrides);

        // ── Phase 1: schema ────────────────────────────────────────
        send({ type: 'phase', phase: 'schema' });
        if (dropExisting) {
          log('Dropping existing target tables (dropExisting=true)…');
          await executeDdlInTransaction(
            pool,
            tables.map((t) => `DROP TABLE IF EXISTS "${t.schema === 'dbo' ? 'public' : t.schema}"."${t.name}" CASCADE;`),
          );
        }
        log(`Creating ${stmts.tables.length} table(s)…`);
        // Create tables one at a time, each in its own transaction.
        // Previously all tables ran in a single transaction, so one
        // untranslatable DEFAULT (e.g. SYSUTCDATETIME()) rolled back
        // every table and aborted the whole migration.
        const createdTables = new Set<string>();
        const failedTables = new Set<string>();
        for (let i = 0; i < stmts.tables.length; i++) {
          const tableName = `${tables[i].schema}.${tables[i].name}`;
          try {
            await executeDdlInTransaction(pool, [stmts.tables[i]], (s) => log(`DDL: ${s.split('\n')[0]}`));
            createdTables.add(tableName);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failedTables.add(tableName);
            errors.push(`${tableName}: ${msg}`);
            send({ type: 'error', table: tableName, message: msg });
            log(`Table failed, continuing with the next table: ${tableName} — ${msg}`);
          }
        }
        log(`Tables created: ${createdTables.size} succeeded, ${failedTables.size} failed.`);
        // Indexes BEFORE foreign keys: a FK may reference a column that
        // is unique only via a UNIQUE index, and Postgres requires that
        // index to exist before the FK is created. Each statement runs
        // on its own so one bad FK/index no longer aborts the migration
        // (previously the whole FK batch ran in one transaction and a
        // single failure — "no unique constraint matching given keys
        // for referenced table CallLog" — ended the run with 0 rows).
        if (stmts.indexes.length) {
          log(`Creating ${stmts.indexes.length} index(es)…`);
          for (const ix of stmts.indexes) {
            try {
              await executeDdlInTransaction(pool, [ix]);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`index: ${msg}`);
              send({ type: 'error', table: '', message: `Index failed: ${msg}` });
              log(`Index failed, continuing: ${ix.split('\n')[0]} — ${msg}`);
            }
          }
        }
        if (stmts.fks.length) {
          log(`Adding ${stmts.fks.length} foreign key(s)…`);
          for (const fk of stmts.fks) {
            try {
              await executeDdlInTransaction(pool, [fk]);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`foreign key: ${msg}`);
              send({ type: 'error', table: '', message: `Foreign key failed: ${msg}` });
              log(`Foreign key failed, continuing: ${fk.split('ADD CONSTRAINT')[1]?.trim().split(' ')[0] ?? ''} — ${msg}`);
            }
          }
        }

        // ── Phase 2: data ──────────────────────────────────────────
        let rowsCopied = 0;
        if (includeData) {
          send({ type: 'phase', phase: 'data' });
          for (const table of tables) {
            // Skip tables whose CREATE TABLE failed — there is no
            // target table to insert into.
            if (failedTables.has(`${table.schema}.${table.name}`)) {
              log(`Skipping data copy for failed table ${table.schema}.${table.name}.`);
              continue;
            }
            try {
              const pgTypes: Record<string, string> = {};
              for (const c of table.columns) {
                pgTypes[c.name] = overrides[`${c.schema}.${c.table}.${c.name}`] ?? 'text';
              }
              const n = await copyTableData(source, pool, table, pgTypes, (e) => send(e));
              rowsCopied += n;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`${table.schema}.${table.name}: ${msg}`);
              send({ type: 'error', table: `${table.schema}.${table.name}`, message: msg });
            }
          }
          await fixIdentitySequences(pool, tables.filter((t) => createdTables.has(`${t.schema}.${t.name}`)), (e) => send(e));
        }

        // ── Phase 3: views ─────────────────────────────────────────
        send({ type: 'phase', phase: 'views' });
        for (const v of stmts.views) {
          try {
            await pool.query(v.sql);
            send({ type: 'view-done', view: v.name, notes: v.notes });
            log(`View created: ${v.name}${v.notes.length ? ` (${v.notes.length} note(s) — review)` : ''}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`view ${v.name}: ${msg}`);
            send({ type: 'error', table: v.name, message: msg });
          }
        }

        // ── Phase 4: validation ────────────────────────────────────
        send({ type: 'phase', phase: 'validate' });
        for (const table of tables) {
          if (failedTables.has(`${table.schema}.${table.name}`)) continue;
          try {
            const targetCount = await targetRowCount(
              pool,
              table.schema === 'dbo' ? 'public' : table.schema,
              table.name,
            );
            send({
              type: 'validation',
              table: `${table.schema}.${table.name}`,
              source: table.rowCount,
              target: targetCount,
              match: targetCount === table.rowCount,
            });
          } catch (err) {
            errors.push(`validate ${table.schema}.${table.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        send({
          type: 'done',
          summary: { tables: createdTables.size, rowsCopied, views: stmts.views.length, errors },
        });
      } catch (err) {
        send({
          type: 'error',
          table: '',
          message: err instanceof Error ? err.message : String(err),
        });
        send({
          type: 'done',
          summary: { tables: 0, rowsCopied: 0, views: 0, errors: [err instanceof Error ? err.message : String(err)] },
        });
      } finally {
        await pool.end().catch(() => undefined);
        controller.close();
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
