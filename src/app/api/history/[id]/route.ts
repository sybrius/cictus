import { NextResponse } from 'next/server';
import { getRun } from '@/lib/history-db';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { run, tables, errors } = await getRun(params.id);
    if (!run) return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });
    const r = run as unknown as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      run: {
        ...r,
        startedAt: r.started_at ? new Date(String(r.started_at)).toISOString() : null,
        finishedAt: r.finished_at ? new Date(String(r.finished_at)).toISOString() : null,
      },
      tables: tables.map((t) => {
        const x = t as unknown as Record<string, unknown>;
        return { tableName: x.table_name, sourceRows: x.source_rows, targetRows: x.target_rows, matched: x.matched, status: x.status };
      }),
      errors: errors.map((e) => {
        const x = e as unknown as Record<string, unknown>;
        return { scope: x.scope, message: x.message };
      }),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
