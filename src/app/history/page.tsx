'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Run {
  id: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  source_name: string;
  target_name: string;
  target_type: string;
  tables_total: number;
  tables_succeeded: number;
  rows_copied: number;
  views_created: number;
  views_total: number;
  errors_count: number;
}

interface Detail {
  run: Run;
  tables: { tableName: string; sourceRows: number; targetRows: number; matched: boolean; status: string }[];
  errors: { scope: string; message: string }[];
}

export default function HistoryPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    fetch('/api/history').then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error ?? 'Could not load history');
      setRuns(j.runs ?? []);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false));
  }, []);

  async function toggle(id: string) {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id);
    setDetailLoading(true);
    const j = await fetch(`/api/history/${id}`).then((r) => r.json());
    setDetailLoading(false);
    if (j.ok) setDetail(j);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Migration history</h1>
      <p className="mt-1 text-sm text-slate-600">
        Every run is recorded in the local DuckDB file (<span className="font-mono">data/migrations.duckdb</span>) — source, target, tables, row counts, per-table validation and errors. Click a run for its detail.
      </p>
      {error && <div className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Loading…</p>
      ) : runs.length === 0 ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm">
          No runs recorded yet. <Link href="/migrate" className="text-blue-600">Run a migration</Link> and it will be stored here.
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {runs.map((r) => (
            <div key={r.id} className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <button onClick={() => toggle(r.id)} className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left text-sm">
                <span className="font-medium">{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</span>
                <span className="font-mono text-xs">{r.source_name} → {r.target_name} <span className="text-slate-400">({r.target_type})</span></span>
                <span className="tabular-nums">{r.tables_succeeded}/{r.tables_total} tables · {r.rows_copied.toLocaleString()} rows · {r.views_created}/{r.views_total} views</span>
                <span className={`font-medium ${r.status === 'completed' ? 'text-green-700' : r.status === 'running' ? 'text-amber-700' : 'text-red-700'}`}>{r.status} · {r.errors_count} error(s)</span>
              </button>
              {openId === r.id && (
                <div className="border-t px-4 py-3 text-sm">
                  {detailLoading ? <p className="text-slate-500">Loading detail…</p> : detail ? (
                    <>
                      {detail.tables.length > 0 && (
                        <table className="w-full text-sm">
                          <thead><tr className="border-b text-left text-slate-500"><th className="py-1">Table</th><th className="text-right">Source</th><th className="text-right">Target</th><th className="text-right">Match</th></tr></thead>
                          <tbody>
                            {detail.tables.map((t) => (
                              <tr key={t.tableName} className="border-b">
                                <td className="py-1 font-mono text-xs">{t.tableName}</td>
                                <td className="text-right tabular-nums">{t.sourceRows.toLocaleString()}</td>
                                <td className="text-right tabular-nums">{t.targetRows.toLocaleString()}</td>
                                <td className={`text-right ${t.matched ? 'text-green-700' : 'text-red-700'}`}>{t.matched ? '✓' : '✗'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {detail.errors.length > 0 && (
                        <div className="mt-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                          <strong>Errors:</strong>
                          <ul className="list-disc pl-5">{detail.errors.map((e, i) => <li key={i}><strong>{e.scope}:</strong> {e.message}</li>)}</ul>
                        </div>
                      )}
                      {detail.tables.length === 0 && detail.errors.length === 0 && <p className="text-slate-500">No per-table detail recorded for this run (it may pre-date the history store).</p>}
                    </>
                  ) : <p className="text-slate-500">Could not load detail.</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
