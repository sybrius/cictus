import { NextResponse } from 'next/server';
import { tickOnce } from '@/lib/scheduler';

/** POST /api/schedules/tick — run one scheduler pass on demand.
 *  Useful for testing and for a "Check now" button; the server
 *  also ticks on its own every minute. */
export async function POST() {
  try {
    const result = await tickOnce();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
