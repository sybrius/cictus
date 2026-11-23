import { TargetConfigSchema } from './postgres';
import { executeMigration, resolveSourceConfig, type MigrationJob } from './run-migration';
import { resolveSource, resolveTarget } from './resolve-connector';
import { parseSourceConfig } from './source-dispatch';
import { hasuraConfigForConnector } from './hasura';
import { listSchedules, getSchedule, updateScheduleRun, type Schedule } from './history-db';
import { nextRunAfter } from './cron';

/**
 * Background scheduler for recurring migrations.
 *
 * Started once per server process from instrumentation.ts
 * (register() runs when the Next.js server starts). It ticks every
 * minute, and runs each enabled schedule whose next run is due.
 * A run is the same executeMigration() engine the wizard uses, so
 * scheduled runs get the same phases, COPY bulk load, FK-after-data
 * behaviour and DuckDB history record (trigger: 'schedule').
 *
 * The scheduler only runs while the dev server is running — this is
 * a local tool, so a schedule cannot fire while the machine or the
 * server is off. A run that came due while the server was down
 * fires once on the next tick (catch-up), and next_run_at is
 * advanced before the run starts, so a long run or a restart
 * mid-run never double-fires the same slot.
 */

const TICK_MS = 60_000;
/** Schedule ids currently executing (in-memory; guards overlaps). */
const running = new Set<string>();

interface SchedulerGlobal {
  started?: boolean;
  timer?: ReturnType<typeof setInterval> | null;
}
const schedulerGlobal = globalThis as typeof globalThis & { __cictusScheduler?: SchedulerGlobal };

export function ensureSchedulerStarted(): void {
  const store = schedulerGlobal.__cictusScheduler ?? (schedulerGlobal.__cictusScheduler = {});
  if (store.started) return;
  store.started = true;
  // One tick shortly after start (catch-up for missed runs), then
  // every minute.
  setTimeout(() => void tickOnce().catch(() => undefined), 5_000);
  store.timer = setInterval(() => void tickOnce().catch(() => undefined), TICK_MS);
  // Do not keep the process alive for the timer alone.
  if (typeof store.timer === 'object' && store.timer !== null && 'unref' in store.timer) {
    (store.timer as { unref(): void }).unref();
  }
}

export function isScheduleRunning(id: string): boolean {
  return running.has(id);
}

/** One scheduler pass: start every due, enabled, not-already-running schedule. */
export async function tickOnce(): Promise<{ checked: number; started: string[]; skipped: string[] }> {
  const schedules = await listSchedules();
  const now = new Date();
  const started: string[] = [];
  const skipped: string[] = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    const next = s.nextRunAt ? new Date(s.nextRunAt) : nextRunAfter(s.cron, now);
    if (!next || next.getTime() > now.getTime()) continue;
    if (running.has(s.id)) {
      skipped.push(s.id);
      continue;
    }
    // Advance next_run_at BEFORE running — see the module comment.
    const following = nextRunAfter(s.cron, now);
    await updateScheduleRun(s.id, { nextRunAt: following ? following.toISOString() : null });
    started.push(s.id);
    void runSchedule(s.id).catch(() => undefined);
  }
  return { checked: schedules.length, started, skipped };
}

/** Run one schedule now (used by the tick and by Run now). */
export async function runSchedule(id: string): Promise<{ runId: string | null; error?: string }> {
  if (running.has(id)) return { runId: null, error: 'Schedule is already running' };
  const schedule = await getSchedule(id);
  if (!schedule) return { runId: null, error: 'Schedule not found' };
  running.add(id);
  try {
    const job = buildJob(schedule);
    const summary = await executeMigration(job, {
      log: () => undefined,
      phase: () => undefined,
      event: () => undefined,
      viewDone: () => undefined,
      validation: () => undefined,
    });
    await updateScheduleRun(id, {
      lastRunAt: new Date().toISOString(),
      lastStatus: summary.errors.length ? 'failed' : 'completed',
      lastRunId: summary.runId,
    });
    return { runId: summary.runId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateScheduleRun(id, { lastRunAt: new Date().toISOString(), lastStatus: 'failed' }).catch(() => undefined);
    return { runId: null, error: msg };
  } finally {
    running.delete(id);
  }
}

function buildJob(s: Schedule): MigrationJob {
  const src = resolveSource({ sourceConnectorId: s.sourceConnectorId });
  const tgt = resolveTarget({ targetConnectorId: s.targetConnectorId });
  let sParsed: ReturnType<typeof parseSourceConfig>;
  try {
    sParsed = parseSourceConfig(src.sourceType, src.config);
  } catch (e) {
    throw new Error(`Source connector "${src.connectorName ?? s.sourceConnectorId}" is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
  const tParsed = TargetConfigSchema.safeParse({ connectionString: tgt.connectionString });
  if (!tParsed.success) throw new Error(`Target connector "${tgt.connectorName ?? s.targetConnectorId}" is invalid: ${tParsed.error.issues.map((i) => i.message).join('; ')}`);
  return {
    source: resolveSourceConfig(src.sourceType, sParsed),
    target: tParsed.data,
    tables: s.tables,
    views: s.views,
    overrides: {},
    includeData: s.includeData,
    dropExisting: s.dropExisting,
    useCopy: s.useCopy,
    trackInHasura: s.trackInHasura ?? false,
    hasura: hasuraConfigForConnector(tgt.connector),
    sourceName: src.connectorName ?? 'Scheduled source',
    targetName: tgt.connectorName ?? 'Scheduled target',
    targetType: tgt.connectorType ?? 'postgres',
    trigger: 'schedule',
    runName: s.name,
    scheduleId: s.id,
  };
}
