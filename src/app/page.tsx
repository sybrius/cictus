'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  Database,
  Gauge,
  History,
  Layers,
  PlugZap,
  Rows3,
  Workflow,
} from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader, StatCard, StatusBadge } from '@/components/ui';

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

interface Stats {
  totalRuns: number;
  completedRuns: number;
  totalRows: number;
  totalTables: number;
  totalErrors: number;
  lastRunAt: string | null;
}

interface ConnectorSummary { id: string; name: string; type: string; kind: string; lastTestOk: boolean | null }

const TARGET_ICON: Record<string, string> = { nhost: 'NHost', supabase: 'Supabase', postgres: 'PostgreSQL' };

export default function Dashboard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [h, c] = await Promise.all([
          fetch('/api/history').then((r) => r.json()),
          fetch('/api/connectors').then((r) => r.json()),
        ]);
        if (!h.ok) throw new Error(h.error ?? 'Could not load history');
        setRuns(h.runs ?? []);
        setStats(h.stats ?? null);
        if (h.historyUnavailable) setHistoryNotice(h.historyReason ?? 'The DuckDB history file could not be loaded on this machine.');
        setConnectors(c.connectors ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const successRate = stats && stats.totalRuns > 0 ? Math.round((stats.completedRuns / stats.totalRuns) * 100) : null;
  const targets = connectors.filter((c) => c.kind === 'target');
  const sources = connectors.filter((c) => c.kind === 'source');
  const maxRows = Math.max(1, ...runs.slice(0, 8).map((r) => r.rows_copied));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Migrate SQL Server or MySQL to NHost, Supabase or any PostgreSQL — every run is recorded locally in DuckDB."
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
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-[104px]" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={<Workflow className="h-5 w-5" />} label="Migration runs" value={String(stats?.totalRuns ?? 0)} sub={stats?.lastRunAt ? `Last run ${new Date(stats.lastRunAt).toLocaleString()}` : 'No runs yet'} tone="brand" delay={0} />
          <StatCard icon={<Rows3 className="h-5 w-5" />} label="Rows migrated" value={(stats?.totalRows ?? 0).toLocaleString()} sub="Across all recorded runs" tone="emerald" delay={60} />
          <StatCard icon={<Layers className="h-5 w-5" />} label="Tables migrated" value={String(stats?.totalTables ?? 0)} sub="Tables created in targets" tone="violet" delay={120} />
          <StatCard icon={<Gauge className="h-5 w-5" />} label="Success rate" value={successRate === null ? '—' : `${successRate}%`} sub={stats ? `${stats.completedRuns} of ${stats.totalRuns} runs clean · ${stats.totalErrors} errors total` : undefined} tone="amber" delay={180} />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Recent migrations */}
        <Card className="animate-fade-up lg:col-span-2" >
          <div style={{ '--fade-delay': '120ms' } as React.CSSProperties}>
            <CardHeader
              title="Recent migrations"
              subtitle="Latest runs, newest first"
              action={
                <Link href="/history" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700">
                  View all <ArrowRight className="h-4 w-4" />
                </Link>
              }
            />
            {loading ? (
              <div className="space-y-3 p-5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-11" />
                ))}
              </div>
            ) : runs.length === 0 ? (
              <EmptyState
                icon={<History className="h-7 w-7" />}
                title="No migrations yet"
                body="Run your first migration and it will appear here with its tables, row counts and errors."
                action={
                  <Link href="/migrate">
                    <Button size="sm">
                      <ArrowRightLeft className="h-4 w-4" />
                      Start a migration
                    </Button>
                  </Link>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="px-5 py-3 font-semibold">Started</th>
                      <th className="px-5 py-3 font-semibold">Source → Target</th>
                      <th className="px-5 py-3 text-right font-semibold">Rows</th>
                      <th className="px-5 py-3 text-right font-semibold">Errors</th>
                      <th className="px-5 py-3 text-right font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 8).map((r) => (
                      <tr key={r.id} className="border-b border-slate-50 transition-colors last:border-0 hover:bg-brand-50/30">
                        <td className="whitespace-nowrap px-5 py-3 text-slate-600">{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</td>
                        <td className="px-5 py-3">
                          <span className="font-mono text-xs text-slate-700">{r.source_name} → {r.target_name}</span>
                          <span className="ml-1.5 text-xs text-slate-400">({TARGET_ICON[r.target_type] ?? r.target_type})</span>
                        </td>
                        <td className="tnum px-5 py-3 text-right font-medium">{r.rows_copied.toLocaleString()}</td>
                        <td className="tnum px-5 py-3 text-right">
                          {r.errors_count === 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" /> 0</span>
                          ) : (
                            <Badge tone="red">{r.errors_count}</Badge>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right"><StatusBadge status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Rows-per-run mini chart */}
                <div className="border-t border-slate-100 px-5 py-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Rows copied per run</p>
                  <div className="flex h-16 items-end gap-1.5">
                    {runs.slice(0, 8).map((r) => (
                      <div key={r.id} className="group relative flex-1" title={`${r.rows_copied.toLocaleString()} rows · ${r.startedAt ? new Date(r.startedAt).toLocaleDateString() : ''}`}>
                        <div
                          className="w-full rounded-t-md bg-gradient-to-t from-brand-600 to-violet-400 transition-all duration-300 group-hover:from-brand-500 group-hover:to-violet-300"
                          style={{ height: `${Math.max(6, (r.rows_copied / maxRows) * 100)}%` }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Connectors */}
        <Card className="animate-fade-up">
          <div style={{ '--fade-delay': '180ms' } as React.CSSProperties}>
            <CardHeader
              title="Connectors"
              subtitle="Saved sources & targets"
              action={
                <Link href="/connectors" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700">
                  Manage <ArrowRight className="h-4 w-4" />
                </Link>
              }
            />
            <div className="space-y-2 p-5">
              {connectors.length === 0 ? (
                <p className="text-sm leading-relaxed text-slate-500">
                  No connectors saved yet. Add a SQL Server or MySQL source and an NHost, Supabase or PostgreSQL target, then pick them in the wizard instead of re-typing credentials.
                </p>
              ) : (
                <>
                  {sources.length > 0 && <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sources</p>}
                  {sources.map((c) => (
                    <ConnectorRow key={c.id} c={c} />
                  ))}
                  {targets.length > 0 && <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Targets</p>}
                  {targets.map((c) => (
                    <ConnectorRow key={c.id} c={c} />
                  ))}
                </>
              )}
              <div className="mt-4 rounded-xl bg-ink-50 p-3.5 text-xs leading-relaxed text-slate-600">
                <strong className="text-slate-800">After a migration:</strong> NHost — track the tables in Hasura
                (Dashboard → Hasura → Data). Supabase — tables appear in the Table Editor; check RLS policies before
                exposing them via the API. Plain Postgres — nothing extra.
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ConnectorRow({ c }: { c: ConnectorSummary }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200/80 px-3.5 py-2.5 transition-colors hover:border-brand-200 hover:bg-brand-50/30">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${c.kind === 'source' ? 'bg-sky-50 text-sky-600' : 'bg-emerald-50 text-emerald-600'}`}>
        {c.kind === 'source' ? <Database className="h-4 w-4" /> : <PlugZap className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-800">{c.name}</span>
        <span className="block text-xs text-slate-400">{c.type} · {c.kind}</span>
      </span>
      {c.lastTestOk === true ? (
        <Badge tone="green">Tested</Badge>
      ) : c.lastTestOk === false ? (
        <Badge tone="red">Failed</Badge>
      ) : (
        <Badge tone="slate">Untested</Badge>
      )}
    </div>
  );
}
