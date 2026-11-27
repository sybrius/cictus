import { NextResponse } from 'next/server';
import { listRuns, historyStats, historyUnavailableReason } from '@/lib/history-db';
import { requireAuth } from '@/lib/api-auth';

function serialise(run: Record<string, unknown>) {
  return {
    ...run,
    startedAt: run.started_at ? new Date(String(run.started_at)).toISOString() : null,
    finishedAt: run.finished_at ? new Date(String(run.finished_at)).toISOString() : null,
  };
}

export async function GET() {
  const auth = await requireAuth();
  if (auth) return auth;
  try {
    const [runs, stats] = await Promise.all([listRuns(50), historyStats()]);
    const reason = historyUnavailableReason();
    return NextResponse.json({
      ok: true,
      runs: runs.map((r) => serialise(r as unknown as Record<string, unknown>)),
      stats,
      ...(reason ? { historyUnavailable: true, historyReason: reason } : {}),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
