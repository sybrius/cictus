'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRightLeft, CheckCircle2, ChevronDown, History, XCircle } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';

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
  trigger?: string | null;
  run_name?: string | null;
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
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    fetch('/api/history').then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error ?? 'Could not load history');
      setRuns(j.runs ?? []);
      if (j.historyUnavailable) setHistoryNotice(j.historyReason ?? 'The Turso history database could not be reached.');
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
    <div className="space-y-6">
      <PageHeader
        title="Run history"
        subtitle="Every run is recorded in your Turso database — source, target, tables, row counts, per-table validation and errors. Click a run for its detail."
        actions={
          <Link href="/migrate">
            <Button>
              <ArrowRightLeft className="h-4 w-4" />
              New migration
            </Button>
          </Link>
        }
      />

      {error && <Alert>{error}</Alert>}

      {historyNotice && (
        <Alert>
          Run history is unavailable: {historyNotice} Migrations still work — runs just are not being recorded, and schedules live only in memory until the server restarts. See Troubleshooting in the README to restore it.
        </Alert>
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-[68px]" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<History className="h-7 w-7" />}
            title="No runs recorded yet"
            body="Run a migration and it will be stored here with per-table validation and any errors."
            action={
              <Link href="/migrate">
                <Button size="sm">
                  <ArrowRightLeft className="h-4 w-4" />
                  Run a migration
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {runs.map((r, idx) => {
            const open = openId === r.id;
            return (
              <Card key={r.id} hover className="animate-fade-up overflow-hidden">
                <div style={{ '--fade-delay': `${Math.min(idx, 8) * 40}ms` } as React.CSSProperties}>
                  <button onClick={() => toggle(r.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 text-left text-sm transition-colors">
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-slate-900">
                        {r.run_name ?? (r.startedAt ? new Date(r.startedAt).toLocaleString() : '—')}
                        {r.trigger === 'schedule' && <Badge tone="violet" className="ml-2 align-middle">Scheduled</Badge>}
                      </span>
                      <span className="mt-0.5 block font-mono text-xs text-slate-500">
                        {r.source_name} → {r.target_name} <span className="text-slate-400">({r.target_type})</span>
                        {r.run_name && r.startedAt ? ` · ${new Date(r.startedAt).toLocaleString()}` : ''}
                      </span>
                    </span>
                    <span className="tnum hidden text-slate-600 md:block">
                      <strong className="font-semibold text-slate-900">{r.tables_succeeded}/{r.tables_total}</strong> tables ·{' '}
                      <strong className="font-semibold text-slate-900">{r.rows_copied.toLocaleString()}</strong> rows ·{' '}
                      <strong className="font-semibold text-slate-900">{r.views_created}/{r.views_total}</strong> views
                    </span>
                    {r.errors_count > 0 ? (
                      <Badge tone="red"><XCircle className="h-3.5 w-3.5" /> {r.errors_count} error{r.errors_count === 1 ? '' : 's'}</Badge>
                    ) : (
                      <Badge tone="green"><CheckCircle2 className="h-3.5 w-3.5" /> Clean</Badge>
                    )}
                    <StatusBadge status={r.status} />
                    <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
                  </button>
                  <div className={`expand-grid ${open ? 'open' : ''}`}>
                    <div>
                      <div className="border-t border-slate-100 px-5 py-4 text-sm">
                        {detailLoading ? (
                          <div className="space-y-2 py-1">
                            <div className="skeleton h-8" />
                            <div className="skeleton h-8" />
                          </div>
                        ) : detail ? (
                          <>
                            {detail.tables.length > 0 && (
                              <div className="overflow-auto rounded-xl border border-slate-200">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                                      <th className="px-4 py-2.5 font-semibold">Table</th>
                                      <th className="px-4 py-2.5 text-right font-semibold">Source</th>
                                      <th className="px-4 py-2.5 text-right font-semibold">Target</th>
                                      <th className="px-4 py-2.5 text-right font-semibold">Match</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {detail.tables.map((t) => (
                                      <tr key={t.tableName} className="border-t border-slate-100 hover:bg-brand-50/30">
                                        <td className="px-4 py-2 font-mono text-xs">{t.tableName}</td>
                                        <td className="tnum px-4 py-2 text-right">{t.sourceRows.toLocaleString()}</td>
                                        <td className="tnum px-4 py-2 text-right">{t.targetRows.toLocaleString()}</td>
                                        <td className="px-4 py-2 text-right">
                                          {t.matched ? (
                                            <span className="inline-flex items-center gap-1 font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Match</span>
                                          ) : (
                                            <span className="inline-flex items-center gap-1 font-medium text-red-700"><XCircle className="h-4 w-4" /> Mismatch</span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            {detail.errors.length > 0 && (
                              <Alert tone="red">
                                <strong>Errors:</strong>
                                <ul className="mt-1 list-disc pl-5">
                                  {detail.errors.map((e, i) => <li key={i}><strong>{e.scope}:</strong> {e.message}</li>)}
                                </ul>
                              </Alert>
                            )}
                            {detail.tables.length === 0 && detail.errors.length === 0 && (
                              <p className="text-slate-500">No per-table detail recorded for this run (it may pre-date the history store).</p>
                            )}
                          </>
                        ) : (
                          <p className="text-slate-500">Could not load detail.</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
