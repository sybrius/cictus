'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Database,
  Download,
  Eye,
  FileDown,
  HardDrive,
  Layers,
  Play,
  Rows3,
  Table2,
  XCircle,
} from 'lucide-react';
import type { DatabaseSchema } from '@/lib/sqlserver';
import { SourceConnectionForm, TargetConnectionForm, type SourceFormValues, type TargetFormValues } from '@/components/ConnectionForm';
import { SchemaTree } from '@/components/SchemaTree';
import { TypeMappingTable } from '@/components/TypeMappingTable';
import { MigrationLog, type LogLine } from '@/components/MigrationLog';
import { ProgressBar } from '@/components/ProgressBar';
import { Alert, Badge, Button, Card, CardHeader, PageHeader, inputCls } from '@/components/ui';

const STEPS = ['Connect source', 'Connect target', 'Discover & Select', 'Type Mapping', 'Migrate', 'Validate & Report'];

interface ValidationRow { table: string; source: number; target: number; match: boolean }
interface ConnectorSummary { id: string; name: string; type: string; kind: string; host: string; database: string; projectRef: string; region: string; lastTestOk: boolean | null }

const TARGET_HINTS: Record<string, string> = {
  nhost: 'After migration, track the new tables in the Hasura console (NHost Dashboard → Hasura → Data) so they appear in your GraphQL API. Tables without a primary key cannot be tracked until one is added.',
  supabase: 'After migration, tables appear in the Supabase Table Editor. Check Row Level Security policies before exposing them via the Supabase API — new tables have RLS disabled by default.',
  postgres: 'After migration, the tables are plain Postgres tables in the target database — no extra step.',
};

const STEP_DESCRIPTIONS = [
  'Pick a saved source connector, or connect to SQL Server / MySQL manually.',
  'Pick a saved target connector, or paste a Postgres connection string.',
  'Discover the source schema and choose the tables and views to migrate.',
  'Review the source → Postgres type map and edit any type inline.',
  'Create tables, copy data, add foreign keys, create views.',
  'Compare row counts and review any errors.',
];

export default function MigratePage() {
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<SourceFormValues>({
    host: 'localhost', port: 1433, user: 'sa', password: '', database: '', trustCert: true, encrypt: true, instance: '', ssl: false, sourceType: 'sqlserver',
  });
  const [target, setTarget] = useState<TargetFormValues>({ connectionString: '' });
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [sourceConnectorId, setSourceConnectorId] = useState('');
  const [targetConnectorId, setTargetConnectorId] = useState('');
  const [sourceOk, setSourceOk] = useState(false);
  const [targetOk, setTargetOk] = useState(false);
  const [testing, setTesting] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<string | null>(null);
  const [sourceResult, setSourceResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [targetResult, setTargetResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [selectedViews, setSelectedViews] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const [includeData, setIncludeData] = useState(true);
  const [dropExisting, setDropExisting] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [phase, setPhase] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<Record<string, { copied: number; total: number }>>({});
  const [validation, setValidation] = useState<ValidationRow[]>([]);
  const [summary, setSummary] = useState<{ tables: number; rowsCopied: number; views: number; errors: string[] } | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/connectors').then((r) => r.json()).then((j) => setConnectors(j.connectors ?? [])).catch(() => undefined);
  }, []);

  const sourceConnectors = connectors.filter((c) => c.kind === 'source');
  const targetConnectors = connectors.filter((c) => c.kind === 'target');
  const selectedSourceConnector = connectors.find((c) => c.id === sourceConnectorId);
  const selectedTargetConnector = connectors.find((c) => c.id === targetConnectorId);
  /** The source dialect for this run: from the picked connector, or
   *  from the manual form's source-type selector. */
  const effectiveSourceType: 'sqlserver' | 'mysql' = selectedSourceConnector
    ? (selectedSourceConnector.type === 'mysql' ? 'mysql' : 'sqlserver')
    : source.sourceType;
  const sourceTypeLabel = effectiveSourceType === 'mysql' ? 'MySQL' : 'SQL Server';
  const targetTypeLabel = selectedTargetConnector
    ? selectedTargetConnector.type === 'nhost' ? 'NHost' : selectedTargetConnector.type === 'supabase' ? 'Supabase' : 'PostgreSQL'
    : 'Postgres';

  const totalRows = useMemo(
    () => (schema?.tables ?? []).filter((t) => selectedTables.has(`${t.schema}.${t.name}`)).reduce((a, t) => a + t.rowCount, 0),
    [schema, selectedTables],
  );
  const copiedRows = useMemo(
    () => Object.values(progress).reduce((a, p) => a + p.copied, 0),
    [progress],
  );
  const overallPct = totalRows > 0 ? (copiedRows / totalRows) * 100 : 0;

  const stamp = () => new Date().toLocaleTimeString();
  const addLog = (message: string, level: LogLine['level'] = 'info') =>
    setLog((l) => [...l, { time: stamp(), level, message }]);

  async function testSource(v?: SourceFormValues) {
    setTesting(true); setSourceResult(null);
    try {
      const body = sourceConnectorId ? { sourceConnectorId } : (v ?? source);
      const r = await fetch('/api/source/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok) { setSourceOk(true); setSourceResult({ ok: true, message: `Connected — ${j.version ?? ''} (${j.database ?? ''})${j.encryption ? ` · encryption ${j.encryption}` : ''}` }); }
      else { setSourceOk(false); setSourceResult({ ok: false, message: `Failed: ${j.error ?? 'unknown error'}` }); }
    } catch (e) { setSourceResult({ ok: false, message: `Failed: ${e instanceof Error ? e.message : String(e)}` }); }
    finally { setTesting(false); }
  }

  async function diagnoseSource(v: SourceFormValues) {
    setSource(v); setDiagnosing(true); setDiagnoseResult(null);
    try {
      const body = sourceConnectorId ? { sourceConnectorId } : v;
      const r = await fetch('/api/source/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      const host = sourceConnectorId ? (selectedSourceConnector?.host ?? '') : v.host;
      setDiagnoseResult(
        `DNS: ${j.dns?.ok ? `OK (${j.dns.address})` : `FAILED — ${j.dns?.error ?? ''}`}\n` +
        `TCP ${host}: ${j.tcp?.ok ? 'OK — port is open' : `FAILED — ${j.tcp?.error ?? ''}`}\n` +
        `${j.hint ?? ''}`,
      );
    } catch (e) { setDiagnoseResult(`Diagnose failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setDiagnosing(false); }
  }

  async function testTarget(v?: TargetFormValues) {
    setTesting(true); setTargetResult(null);
    try {
      const body = targetConnectorId ? { targetConnectorId } : (v ?? target);
      const r = await fetch('/api/target/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok) {
        setTargetOk(true);
        setTargetResult({ ok: true, message: `Connected — ${j.version ?? ''} (${j.database ?? ''})${j.postgis ? ' · PostGIS enabled' : ' · PostGIS not enabled'}` });
      } else { setTargetOk(false); setTargetResult({ ok: false, message: `Failed: ${j.error ?? 'unknown error'}` }); }
    } catch (e) { setTargetResult({ ok: false, message: `Failed: ${e instanceof Error ? e.message : String(e)}` }); }
    finally { setTesting(false); }
  }

  async function discover() {
    setLoadingSchema(true); setError(null);
    try {
      const body = sourceConnectorId ? { sourceConnectorId } : source;
      const r = await fetch('/api/source/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Schema discovery failed');
      setSchema(j.schema);
      setSelectedTables(new Set(j.schema.tables.map((t: { schema: string; name: string }) => `${t.schema}.${t.name}`)));
      setSelectedViews(new Set(j.schema.views.map((v: { schema: string; name: string }) => `${v.schema}.${v.name}`)));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoadingSchema(false); }
  }

  async function downloadScript() {
    const r = await fetch('/api/migrate/ddl', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, sourceConnectorId: sourceConnectorId || undefined, tables: [...selectedTables], views: [...selectedViews], overrides }),
    });
    const j = await r.json();
    if (!j.ok) { setError(j.error ?? 'Could not generate SQL'); return; }
    setScript(j.script);
    const blob = new Blob([j.script], { type: 'text/sql' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'migration.sql';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function runMigration() {
    setMigrating(true); setPhase(''); setLog([]); setProgress({}); setValidation([]); setSummary(null); setError(null);
    addLog('Migration started.');
    try {
      const r = await fetch('/api/migrate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source, target,
          sourceConnectorId: sourceConnectorId || undefined,
          targetConnectorId: targetConnectorId || undefined,
          sourceName: selectedSourceConnector?.name ?? `${source.host}/${source.database}`,
          targetName: selectedTargetConnector?.name ?? 'Postgres target',
          targetType: selectedTargetConnector?.type ?? 'postgres',
          tables: [...selectedTables], views: [...selectedViews], overrides, includeData, dropExisting,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error ?? `Migration request failed (${r.status})`);
      }
      if (!r.body) throw new Error('No response stream from server');
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const e = JSON.parse(line.slice(6));
          if (e.type === 'log') addLog(e.message);
          else if (e.type === 'phase') { setPhase(e.phase); addLog(`Phase: ${e.phase}`); }
          else if (e.type === 'table-start') addLog(`Copying ${e.table} (${e.total.toLocaleString()} rows)…`);
          else if (e.type === 'table-progress') setProgress((p) => ({ ...p, [e.table]: { copied: e.copied, total: e.total } }));
          else if (e.type === 'table-done') addLog(`Done ${e.table}: ${e.copied.toLocaleString()} rows`, 'success');
          else if (e.type === 'view-done') addLog(`View created: ${e.view}${e.notes?.length ? ` — review notes: ${e.notes.join('; ')}` : ''}`, 'success');
          else if (e.type === 'validation') setValidation((v) => [...v, e]);
          else if (e.type === 'error') addLog(`ERROR ${e.table ? `(${e.table}) ` : ''}${e.message}`, 'error');
          else if (e.type === 'done') { setSummary(e.summary); addLog(`Migration finished: ${e.summary.tables} tables, ${e.summary.rowsCopied.toLocaleString()} rows, ${e.summary.views} views, ${e.summary.errors.length} error(s).`, e.summary.errors.length ? 'error' : 'success'); }
        }
      }
      setStep(5);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // A dropped browser connection ("Failed to fetch" / network
      // error) does not necessarily mean the server stopped: the run
      // keeps going server-side and is recorded in History, and a
      // re-run is safe (CREATE TABLE IF NOT EXISTS + ON CONFLICT DO
      // NOTHING). Say so instead of leaving "Migration failed" bare.
      if (/failed to fetch|networkerror|network error|load failed/i.test(msg)) {
        addLog('Migration failed: the browser lost its connection to the dev server (network error). The run may still be finishing server-side — check History / Dashboard for the recorded result before re-running. Re-running is safe.', 'error');
      } else {
        addLog(`Migration failed: ${msg}`, 'error');
      }
    } finally { setMigrating(false); }
  }

  const canNext =
    (step === 0 && sourceOk) || (step === 1 && targetOk) ||
    (step === 2 && selectedTables.size > 0) || step === 3;

  return (
    <div className="space-y-6">
      <PageHeader
        title="New migration"
        subtitle={`Migrate tables, schema, data and views from SQL Server or MySQL to ${targetTypeLabel} Postgres. Pick saved connectors or connect manually. Nothing is executed until you start Step 5 — and you can download the SQL first.`}
      />

      {/* Stepper */}
      <Card className="animate-fade-up px-5 py-4 sm:px-6">
        <ol className="flex flex-col gap-1 sm:flex-row sm:items-center">
          {STEPS.map((s, i) => {
            const done = i < step;
            const current = i === step;
            return (
              <li key={s} className="flex flex-1 items-center gap-2.5 sm:gap-0">
                <button
                  onClick={() => { if (done) setStep(i); }}
                  disabled={!done}
                  className={`flex items-center gap-2.5 rounded-lg px-1 py-1 text-left ${done ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ring-2 transition-all ${
                      done
                        ? 'bg-emerald-500 text-white ring-emerald-500/30'
                        : current
                          ? 'bg-brand-600 text-white ring-brand-500/30 shadow-md shadow-brand-500/25'
                          : 'bg-slate-100 text-slate-500 ring-slate-200'
                    }`}
                  >
                    {done ? <Check className="h-4 w-4" /> : i + 1}
                  </span>
                  <span className={`text-[13px] font-medium leading-tight ${current ? 'text-slate-900' : done ? 'text-slate-600' : 'text-slate-400'}`}>
                    {s}
                  </span>
                </button>
                {i < STEPS.length - 1 && (
                  <span className={`mx-2 hidden h-px flex-1 sm:block ${done ? 'bg-emerald-400' : 'bg-slate-200'}`} />
                )}
              </li>
            );
          })}
        </ol>
      </Card>

      {error && <Alert>{error}</Alert>}

      <Card className="animate-fade-up">
        <div style={{ '--fade-delay': '80ms' } as React.CSSProperties}>
          <CardHeader title={`${step + 1} · ${STEPS[step]}`} subtitle={STEP_DESCRIPTIONS[step]} />
          <div className="p-5 sm:p-6">
            {step === 0 && (
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold tracking-wide text-slate-600">Saved source connector</label>
                  <select className={inputCls} value={sourceConnectorId} onChange={(e) => { setSourceConnectorId(e.target.value); setSourceOk(false); setSourceResult(null); }}>
                    <option value="">Manual connection (enter below)</option>
                    {sourceConnectors.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.type === 'mysql' ? 'MySQL' : 'SQL Server'} · {c.host}/{c.database}</option>)}
                  </select>
                  <p className="mt-1.5 text-xs text-slate-500">No source connector yet? <Link href="/connectors" className="font-medium text-brand-600 hover:text-brand-700">Add one in Connectors</Link> — its password stays on this machine and is never shown in the browser.</p>
                </div>
                {sourceConnectorId && selectedSourceConnector ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-ink-50 px-4 py-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600">
                        {selectedSourceConnector.type === 'mysql' ? <Database className="h-5 w-5" /> : <HardDrive className="h-5 w-5" />}
                      </span>
                      <div className="min-w-0 text-sm">
                        <span className="block truncate font-semibold text-slate-900">{selectedSourceConnector.name}</span>
                        <span className="text-slate-500">{selectedSourceConnector.type === 'mysql' ? 'MySQL' : 'SQL Server'} · {selectedSourceConnector.host}/{selectedSourceConnector.database}</span>
                      </div>
                      {selectedSourceConnector.lastTestOk === true && <Badge tone="green" className="ml-auto shrink-0">Last test passed</Badge>}
                    </div>
                    <Button onClick={() => testSource()} loading={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
                    {sourceResult && <p className={`text-sm font-medium ${sourceResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>{sourceResult.message}</p>}
                  </div>
                ) : (
                  <SourceConnectionForm initial={source} onTest={(v) => { setSource(v); testSource(v); }} onDiagnose={diagnoseSource} testing={testing} diagnosing={diagnosing} testResult={sourceResult} diagnoseResult={diagnoseResult} />
                )}
              </div>
            )}
            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold tracking-wide text-slate-600">Saved target connector</label>
                  <select className={inputCls} value={targetConnectorId} onChange={(e) => { setTargetConnectorId(e.target.value); setTargetOk(false); setTargetResult(null); }}>
                    <option value="">Manual connection (paste connection string below)</option>
                    {targetConnectors.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.type}{c.projectRef ? ` · ${c.projectRef}` : ''}{c.host ? ` · ${c.host}` : ''}</option>)}
                  </select>
                  <p className="mt-1.5 text-xs text-slate-500">No target connector yet? <Link href="/connectors" className="font-medium text-brand-600 hover:text-brand-700">Add an NHost, Supabase or PostgreSQL connector</Link>.</p>
                </div>
                {targetConnectorId && selectedTargetConnector ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-ink-50 px-4 py-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
                        <Database className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 text-sm">
                        <span className="block truncate font-semibold text-slate-900">{selectedTargetConnector.name}</span>
                        <span className="text-slate-500">
                          {selectedTargetConnector.type}
                          {selectedTargetConnector.projectRef ? ` · ${selectedTargetConnector.projectRef}` : ''}
                          {selectedTargetConnector.host ? ` · ${selectedTargetConnector.host}` : ''}
                        </span>
                      </div>
                    </div>
                    <Button onClick={() => testTarget()} loading={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
                    {targetResult && <p className={`text-sm font-medium ${targetResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>{targetResult.message}</p>}
                  </div>
                ) : (
                  <TargetConnectionForm initial={target} onTest={(v) => { setTarget(v); testTarget(v); }} testing={testing} testResult={targetResult} />
                )}
                <p className="rounded-xl bg-ink-50 px-4 py-3 text-xs leading-relaxed text-slate-500">{TARGET_HINTS[selectedTargetConnector?.type ?? 'postgres']}</p>
              </div>
            )}
            {step === 2 && (
              <div>
                {!schema ? (
                  <Button onClick={discover} loading={loadingSchema}>
                    <Eye className="h-4 w-4" />
                    {loadingSchema ? 'Discovering…' : 'Discover schema'}
                  </Button>
                ) : (
                  <SchemaTree
                    schema={schema}
                    selection={{ tables: selectedTables, views: selectedViews }}
                    onToggleTable={(k) => setSelectedTables((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })}
                    onToggleView={(k) => setSelectedViews((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })}
                    onToggleAll={(all) => {
                      setSelectedTables(all ? new Set(schema.tables.map((t) => `${t.schema}.${t.name}`)) : new Set());
                      setSelectedViews(all ? new Set(schema.views.map((v) => `${v.schema}.${v.name}`)) : new Set());
                    }}
                  />
                )}
              </div>
            )}
            {step === 3 && schema && (
              <div>
                <p className="mb-4 text-sm leading-relaxed text-slate-600">
                  Defaults come from the {sourceTypeLabel} → Postgres map. Edit any Postgres type inline; warnings flag
                  lossy conversions (geography needs PostGIS, sql_variant / hierarchyid / rowversion need review
                  {effectiveSourceType === 'mysql' ? '; tinyint(1) is treated as boolean' : ''}).
                </p>
                <TypeMappingTable schema={schema} selection={{ tables: selectedTables }} overrides={overrides} onOverride={(k, v) => setOverrides((o) => ({ ...o, [k]: v }))} sourceType={effectiveSourceType} />
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button variant="secondary" onClick={downloadScript}>
                    <FileDown className="h-4 w-4" />
                    Download generated SQL (.sql)
                  </Button>
                  {script && <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" /> SQL script generated ({script.length.toLocaleString()} chars) — download it again any time from Step 6.</p>}
                </div>
              </div>
            )}
            {step === 4 && (
              <div>
                <p className="mb-4 text-sm leading-relaxed text-slate-600">
                  Order: create tables → indexes → copy data in 1,000-row batches → add foreign keys → create views → validate row counts.
                  The run is recorded in the local DuckDB history.
                </p>
                <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
                  <label className="flex cursor-pointer items-center gap-2 font-medium text-slate-700">
                    <input type="checkbox" checked={includeData} onChange={(e) => setIncludeData(e.target.checked)} className="h-4 w-4 accent-brand-600" />
                    Copy data
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 font-medium text-slate-700">
                    <input type="checkbox" checked={dropExisting} onChange={(e) => setDropExisting(e.target.checked)} className="h-4 w-4 accent-brand-600" />
                    Drop existing target tables first
                  </label>
                  <span className="text-slate-500">
                    <strong className="tnum font-semibold text-slate-900">{selectedTables.size}</strong> tables ·{' '}
                    <strong className="tnum font-semibold text-slate-900">{totalRows.toLocaleString()}</strong> rows ·{' '}
                    <strong className="tnum font-semibold text-slate-900">{selectedViews.size}</strong> views · target:{' '}
                    {selectedTargetConnector?.name ?? targetTypeLabel}
                  </span>
                </div>
                <ProgressBar value={overallPct} label={phase ? `Phase: ${phase} — ${copiedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows` : 'Not started'} />
                <div className="mt-5"><MigrationLog lines={log} /></div>
                <Button variant="success" size="lg" onClick={runMigration} loading={migrating} className="mt-5">
                  <Play className="h-4 w-4" />
                  {migrating ? 'Migrating…' : 'Start migration'}
                </Button>
              </div>
            )}
            {step === 5 && (
              <div>
                {summary ? (
                  <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { icon: <Table2 className="h-4 w-4" />, label: 'Tables', value: String(summary.tables) },
                      { icon: <Rows3 className="h-4 w-4" />, label: 'Rows copied', value: summary.rowsCopied.toLocaleString() },
                      { icon: <Eye className="h-4 w-4" />, label: 'Views', value: String(summary.views) },
                      { icon: <XCircle className="h-4 w-4" />, label: 'Errors', value: String(summary.errors.length) },
                    ].map((s) => (
                      <div key={s.label} className="rounded-xl border border-slate-200 bg-ink-50 px-4 py-3.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">{s.icon}{s.label}</div>
                        <div className="tnum mt-1 text-2xl font-bold tracking-tight text-slate-900">{s.value}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mb-4 text-sm text-slate-600">No migration has run yet in this session. Run Step 5 first, or download the SQL script from Step 4.</p>
                )}
                {validation.length > 0 && (
                  <div className="mb-5 overflow-auto rounded-xl border border-slate-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="px-4 py-2.5 font-semibold">Table</th>
                          <th className="px-4 py-2.5 text-right font-semibold">Source rows</th>
                          <th className="px-4 py-2.5 text-right font-semibold">Target rows</th>
                          <th className="px-4 py-2.5 text-right font-semibold">Match</th>
                        </tr>
                      </thead>
                      <tbody>
                        {validation.map((v) => (
                          <tr key={v.table} className="border-t border-slate-100 hover:bg-brand-50/30">
                            <td className="px-4 py-2.5 font-mono text-[13px]">{v.table}</td>
                            <td className="tnum px-4 py-2.5 text-right">{v.source.toLocaleString()}</td>
                            <td className="tnum px-4 py-2.5 text-right">{v.target.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right">
                              {v.match ? <Badge tone="green"><CheckCircle2 className="h-3.5 w-3.5" /> Match</Badge> : <Badge tone="red">Mismatch</Badge>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {summary && summary.errors.length > 0 && (
                  <Alert tone="red">
                    <strong>Errors:</strong>
                    <ul className="mt-1 list-disc pl-5">{summary.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </Alert>
                )}
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button onClick={downloadScript}>
                    <Download className="h-4 w-4" />
                    Download SQL script (.sql)
                  </Button>
                  <Button variant="secondary" onClick={() => { setStep(0); setSummary(null); setValidation([]); setLog([]); }}>
                    Start a new migration
                  </Button>
                  <Link href="/history">
                    <Button variant="secondary">
                      View in History <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                </div>
                <div className="mt-5"><MigrationLog lines={log} /></div>
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        {step < 5 && (
          <Button onClick={() => { if (step === 1) discover(); setStep((s) => Math.min(5, s + 1)); }} disabled={!canNext}>
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-400">
        <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Credentials are only sent with the request that needs them. Saved connectors keep their password on this machine only
        (data/connectors.json, never committed). Review the generated SQL before running it against production; view
        conversion is best-effort {effectiveSourceType === 'mysql' ? 'MySQL' : 'T-SQL'} → Postgres.
      </p>
    </div>
  );
}
