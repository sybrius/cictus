import { NextResponse } from 'next/server';
import { deleteSchedule, getSchedule, updateScheduleRun } from '@/lib/history-db';
import { nextRunAfter } from '@/lib/cron';
import { requireAuth } from '@/lib/api-auth';

/** DELETE /api/schedules/:id — remove a schedule. */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth();
  if (auth) return auth;
  try {
    await deleteSchedule(params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** PATCH /api/schedules/:id — enable / disable a schedule. */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth();
  if (auth) return auth;
  const body = await req.json().catch(() => null);
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'enabled must be true or false' }, { status: 400 });
  }
  try {
    const schedule = await getSchedule(params.id);
    if (!schedule) return NextResponse.json({ ok: false, error: 'Schedule not found' }, { status: 404 });
    const next = body.enabled ? nextRunAfter(schedule.cron, new Date()) : null;
    await updateScheduleRun(params.id, {
      enabled: body.enabled,
      nextRunAt: body.enabled ? (next ? next.toISOString() : null) : null,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
