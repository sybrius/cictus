import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { listSchedules, saveSchedule, type Schedule } from '@/lib/history-db';
import { loadConnectors } from '@/lib/connectors';
import { validateCron, nextRunAfter } from '@/lib/cron';
import { requireAuth } from '@/lib/api-auth';

const ScheduleBodySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Name is required'),
  sourceConnectorId: z.string().min(1, 'Pick a source connector'),
  targetConnectorId: z.string().min(1, 'Pick a target connector'),
  tables: z.array(z.string()).min(1, 'Select at least one table'),
  views: z.array(z.string()).default([]),
  includeData: z.boolean().default(true),
  dropExisting: z.boolean().default(false),
  useCopy: z.boolean().default(true),
  trackInHasura: z.boolean().default(false),
  cron: z.string().min(1, 'A schedule is required'),
  enabled: z.boolean().default(true),
});

export async function GET() {
  const auth = await requireAuth();
  if (auth) return auth;
  try {
    const [schedules, connectors] = await Promise.all([listSchedules(), Promise.resolve(loadConnectors())]);
    const names = new Map(connectors.map((c) => [c.id, c.name]));
    return NextResponse.json({
      ok: true,
      schedules: schedules.map((s) => ({
        ...s,
        sourceName: names.get(s.sourceConnectorId) ?? null,
        targetName: names.get(s.targetConnectorId) ?? null,
      })),
      connectors: connectors.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        type: c.type,
        hasuraReady: Boolean(c.hasuraAdminSecret) && (c.type === 'nhost' || (c.type === 'postgres' && Boolean(c.hasuraEndpoint?.trim()))),
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth) return auth;
  const body = await req.json().catch(() => null);
  const parsed = ScheduleBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }
  const cronError = validateCron(parsed.data.cron);
  if (cronError) {
    return NextResponse.json({ ok: false, error: cronError }, { status: 400 });
  }
  try {
    const connectors = loadConnectors();
    if (!connectors.some((c) => c.id === parsed.data.sourceConnectorId && c.kind === 'source')) {
      return NextResponse.json({ ok: false, error: 'Source connector not found' }, { status: 400 });
    }
    if (!connectors.some((c) => c.id === parsed.data.targetConnectorId && c.kind === 'target')) {
      return NextResponse.json({ ok: false, error: 'Target connector not found' }, { status: 400 });
    }
    const now = new Date();
    const next = nextRunAfter(parsed.data.cron, now);
    const existing = parsed.data.id ? (await listSchedules()).find((s) => s.id === parsed.data.id) : undefined;
    const schedule: Schedule = {
      id: parsed.data.id ?? crypto.randomUUID(),
      name: parsed.data.name,
      sourceConnectorId: parsed.data.sourceConnectorId,
      targetConnectorId: parsed.data.targetConnectorId,
      tables: parsed.data.tables,
      views: parsed.data.views,
      includeData: parsed.data.includeData,
      dropExisting: parsed.data.dropExisting,
      useCopy: parsed.data.useCopy,
      trackInHasura: parsed.data.trackInHasura,
      cron: parsed.data.cron,
      enabled: parsed.data.enabled,
      lastRunAt: existing?.lastRunAt ?? null,
      lastStatus: existing?.lastStatus ?? null,
      lastRunId: existing?.lastRunId ?? null,
      nextRunAt: next ? next.toISOString() : null,
      createdAt: existing?.createdAt ?? now.toISOString(),
    };
    await saveSchedule(schedule);
    return NextResponse.json({ ok: true, schedule });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
