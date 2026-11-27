import { NextResponse } from 'next/server';
import { getSchedule } from '@/lib/history-db';
import { isScheduleRunning, runSchedule } from '@/lib/scheduler';
import { requireUser } from '@/lib/api-auth';

/** POST /api/schedules/:id/run — start a run now, in the background.
 *  Returns immediately; the result lands in History (trigger:
 *  'schedule') and on the schedule's last-run fields. */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const schedule = await getSchedule(params.id, user.id);
    if (!schedule) return NextResponse.json({ ok: false, error: 'Schedule not found' }, { status: 404 });
    if (isScheduleRunning(params.id)) {
      return NextResponse.json({ ok: false, error: 'This schedule is already running' }, { status: 409 });
    }
    void runSchedule(params.id);
    return NextResponse.json({ ok: true, message: 'Schedule started — watch History for the result.' });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
