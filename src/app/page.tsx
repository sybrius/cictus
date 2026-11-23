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

interface Stats {
  totalRuns: number;
  completedRuns: number;
  totalRows: number;
  totalTables: number;
  totalErrors: number;
  lastRunAt: string | null;
}

interface ConnectorSummary { id: string; name: string; type: string; kind: string; lastTestOk: boolean | null }

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-sm text-slate-600">{label}</div>
      {sub && <div className="mt-1 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-600">
            Migrate SQL Server or MySQL to NHost, Supabase or any PostgreSQL — every run is recorded locally in DuckDB.
          </p>
        </div>
        <Link href="/migrate" className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white">
          New migration →
        </Link>
      </div>

      {error && <div className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Migration runs" value={loading ? '…' : String(stats?.totalRuns ?? 0)} sub={stats?.lastRunAt ? `Last run ${new Date(stats.lastRunAt).toLocaleString()}` : 'No runs yet'} />
        <StatCard label="Rows migrated" value={loading ? '…' : (stats?.totalRows ?? 0).toLocaleString()} sub="Across all recorded runs" />
        <StatCard label="Tables migrated" value={loading ? '…' : String(stats?.totalTables ?? 0)} sub="Tables created in targets" />
        <StatCard label="Success rate" value={loading ? '…' : successRate === null ? '—' : `${successRate}%`} sub={stats ? `${stats.completedRuns} of ${stats.totalRuns} runs clean · ${stats.totalErrors} errors total` : undefined} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Recent migrations</h2>
            <Link href="/history" className="text-sm text-blue-600">View all →</Link>
          </div>
          {loading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">
              No migrations recorded yet. Run one from <Link href="/migrate" className="text-blue-600">New migration</Link> and it will appear here with its tables, row counts and errors.
            </p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead><tr className="border-b text-left text-slate-500"><th className="py-2">Started</th><th>Source → Target</th><th className="text-right">Rows</th><th className="text-right">Errors</th><th className="text-right">Status</th></tr></thead>
              <tbody>
                {runs.slice(0, 8).map((r) => (
                  <tr key={r.id} className="border-b">
                    <td className="py-2">{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</td>
                    <td className="font-mono text-xs">{r.source_name} → {r.target_name} <span className="text-slate-400">({r.target_type})</span></td>
                    <td className="text-right tabular-nums">{r.rows_copied.toLocaleString()}</td>
                    <td className={`text-right tabular-nums ${r.errors_count ? 'font-medium text-red-700' : ''}`}>{r.errors_count}</td>
                    <td className={`text-right font-medium ${r.status === 'completed' ? 'text-green-700' : r.status === 'running' ? 'text-amber-700' : 'text-red-700'}`}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Connectors</h2>
            <Link href="/connectors" className="text-sm text-blue-600">Manage →</Link>
          </div>
          {connectors.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">
              No connectors saved yet. Add a SQL Server or MySQL source and an NHost, Supabase or PostgreSQL target, then pick them in the wizard instead of re-typing credentials.
            </p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {sources.map((c) => (
                <li key={c.id} className="flex justify-between rounded border px-3 py-2"><span>{c.name} <span className="text-slate-400">· {c.type} · source</span></span><span>{c.lastTestOk === true ? '✓' : c.lastTestOk === false ? '✗' : '—'}</span></li>
              ))}
              {targets.map((c) => (
                <li key={c.id} className="flex justify-between rounded border px-3 py-2"><span>{c.name} <span className="text-slate-400">· {c.type} · target</span></span><span>{c.lastTestOk === true ? '✓' : c.lastTestOk === false ? '✗' : '—'}</span></li>
              ))}
            </ul>
          )}
          <div className="mt-4 rounded bg-slate-50 p-3 text-xs text-slate-600">
            <strong>After a migration:</strong> NHost — track the tables in Hasura (Dashboard → Hasura → Data). Supabase — tables appear in the Table Editor; check RLS policies before exposing them via the API. Plain Postgres — nothing extra.
          </div>
        </section>
      </div>
    </div>
  );
}
