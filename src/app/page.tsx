'use client';

import { useMemo, useState } from 'react';
import type { DatabaseSchema } from '@/lib/sqlserver';
import { SourceConnectionForm, TargetConnectionForm, type SourceFormValues, type TargetFormValues } from '@/components/ConnectionForm';
import { SchemaTree } from '@/components/SchemaTree';
import { TypeMappingTable } from '@/components/TypeMappingTable';
import { MigrationLog, type LogLine } from '@/components/MigrationLog';
import { ProgressBar } from '@/components/ProgressBar';

const STEPS = ['Connect SQL Server', 'Connect NHost', 'Discover & Select', 'Type Mapping', 'Migrate', 'Validate & Report'];

interface ValidationRow { table: string; source: number; target: number; match: boolean }

export default function Home() {
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<SourceFormValues>({
    host: 'localhost', port: 1433, user: 'sa', password: '', database: '', trustCert: true, instance: '',
  });
  const [target, setTarget] = useState<TargetFormValues>({ connectionString: '' });
  const [sourceOk, setSourceOk] = useState(false);
  const [targetOk, setTargetOk] = useState(false);
  const [testing, setTesting] = useState(false);
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

  async function testSource(v: SourceFormValues) {
    setSource(v); setTesting(true); setSourceResult(null);
    try {
      const r = await fetch('/api/source/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
      const j = await r.json();
      if (j.ok) { setSourceOk(true); setSourceResult({ ok: true, message: `Connected — ${j.version ?? ''} (${j.database ?? ''})` }); }
      else { setSourceOk(false); setSourceResult({ ok: false, message: `Failed: ${j.error ?? 'unknown error'}` }); }
    } catch (e) { setSourceResult({ ok: false, message: `Failed: ${e instanceof Error ? e.message : String(e)}` }); }
    finally { setTesting(false); }
  }

  async function testTarget(v: TargetFormValues) {
    setTarget(v); setTesting(true); setTargetResult(null);
    try {
      const r = await fetch('/api/target/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
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
      const r = await fetch('/api/source/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source) });
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
      body: JSON.stringify({ source, tables: [...selectedTables], views: [...selectedViews], overrides }),
    });
    const j = await r.json();
    if (!j.ok) { setError(j.error ?? 'Could not generate SQL'); return; }
    setScript(j.script);
    const blob = new Blob([j.script], { type: 'text/sql' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nhost-migration.sql';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function runMigration() {
    setMigrating(true); setPhase(''); setLog([]); setProgress({}); setValidation([]); setSummary(null); setError(null);
    addLog('Migration started.');
    try {
      const r = await fetch('/api/migrate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, target, tables: [...selectedTables], views: [...selectedViews], overrides, includeData, dropExisting }),
      });
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
      setError(e instanceof Error ? e.message : String(e));
      addLog(`Migration failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally { setMigrating(false); }
  }

  const canNext =
    (step === 0 && sourceOk) || (step === 1 && targetOk) ||
    (step === 2 && selectedTables.size > 0) || step === 3;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">SQL Server → NHost Migrator</h1>
      <p className="mt-1 text-sm text-slate-600">
        Migrate tables, schema, data and views from SQL Server to NHost Postgres (Hasura).
        Nothing is published or executed until you start Step 5 — and you can download the SQL first.
      </p>

      {/* Stepper */}
      <ol className="mt-6 flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className={`rounded-full px-3 py-1 text-xs font-medium ${i === step ? 'bg-blue-600 text-white' : i < step ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}`}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {error && <div className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}

      <section className="mt-6 rounded-lg border bg-white p-5 shadow-sm">
        {step === 0 && (
          <><h2 className="mb-3 text-lg font-semibold">1 · Connect SQL Server (source)</h2>
          <SourceConnectionForm initial={source} onTest={testSource} testing={testing} testResult={sourceResult} /></>
        )}
        {step === 1 && (
          <><h2 className="mb-3 text-lg font-semibold">2 · Connect NHost Postgres (target)</h2>
          <TargetConnectionForm initial={target} onTest={testTarget} testing={testing} testResult={targetResult} />
          <p className="mt-3 text-xs text-slate-500">After migration, track the new tables in the Hasura console (NHost Dashboard → Hasura → Data) so they appear in your GraphQL API. Tables without a primary key cannot be tracked until one is added.</p></>
        )}
        {step === 2 && (
          <><h2 className="mb-3 text-lg font-semibold">3 · Discover &amp; select tables / views</h2>
          {!schema ? (
            <button onClick={discover} disabled={loadingSchema} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {loadingSchema ? 'Discovering…' : 'Discover schema'}
            </button>
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
          )}</>
        )}
        {step === 3 && schema && (
          <><h2 className="mb-3 text-lg font-semibold">4 · Type mapping (editable)</h2>
          <p className="mb-3 text-sm text-slate-600">Defaults come from the SQL Server → Postgres map. Edit any Postgres type inline; warnings flag lossy conversions (geography needs PostGIS, sql_variant / hierarchyid / rowversion need review).</p>
          <TypeMappingTable schema={schema} selection={{ tables: selectedTables }} overrides={overrides} onOverride={(k, v) => setOverrides((o) => ({ ...o, [k]: v }))} />
          <button onClick={downloadScript} className="mt-4 rounded border px-4 py-2 text-sm">Download generated SQL (.sql)</button>
          {script && <p className="mt-2 text-xs text-green-700">SQL script generated ({script.length.toLocaleString()} chars) — download it again any time from Step 6.</p>}</>
        )}
        {step === 4 && (
          <><h2 className="mb-3 text-lg font-semibold">5 · Migrate</h2>
          <p className="mb-3 text-sm text-slate-600">Order: create tables → foreign keys → indexes → copy data in 1,000-row batches → create views → validate row counts.</p>
          <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={includeData} onChange={(e) => setIncludeData(e.target.checked)} /> Copy data</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={dropExisting} onChange={(e) => setDropExisting(e.target.checked)} /> Drop existing target tables first</label>
            <span className="text-slate-600">{selectedTables.size} tables · {totalRows.toLocaleString()} rows · {selectedViews.size} views</span>
          </div>
          <ProgressBar value={overallPct} label={phase ? `Phase: ${phase} — ${copiedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows` : 'Not started'} />
          <div className="mt-4"><MigrationLog lines={log} /></div>
          <button onClick={runMigration} disabled={migrating} className="mt-4 rounded bg-green-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
            {migrating ? 'Migrating…' : 'Start migration'}
          </button></>
        )}
        {step === 5 && (
          <><h2 className="mb-3 text-lg font-semibold">6 · Validate &amp; report</h2>
          {summary ? (
            <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div className="rounded border p-3"><div className="text-2xl font-bold">{summary.tables}</div><div className="text-slate-600">Tables</div></div>
              <div className="rounded border p-3"><div className="text-2xl font-bold">{summary.rowsCopied.toLocaleString()}</div><div className="text-slate-600">Rows copied</div></div>
              <div className="rounded border p-3"><div className="text-2xl font-bold">{summary.views}</div><div className="text-slate-600">Views</div></div>
              <div className="rounded border p-3"><div className="text-2xl font-bold">{summary.errors.length}</div><div className="text-slate-600">Errors</div></div>
            </div>
          ) : <p className="text-sm text-slate-600">No migration has run yet in this session. Run Step 5 first, or download the SQL script from Step 4.</p>}
          {validation.length > 0 && (
            <table className="mb-4 w-full text-sm">
              <thead><tr className="border-b text-left"><th className="py-2">Table</th><th className="text-right">Source rows</th><th className="text-right">Target rows</th><th className="text-right">Match</th></tr></thead>
              <tbody>
                {validation.map((v) => (
                  <tr key={v.table} className="border-b">
                    <td className="py-2 font-mono">{v.table}</td>
                    <td className="text-right tabular-nums">{v.source.toLocaleString()}</td>
                    <td className="text-right tabular-nums">{v.target.toLocaleString()}</td>
                    <td className={`text-right font-medium ${v.match ? 'text-green-700' : 'text-red-700'}`}>{v.match ? '✓' : '✗ MISMATCH'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {summary && summary.errors.length > 0 && (
            <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              <strong>Errors:</strong><ul className="list-disc pl-5">{summary.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button onClick={downloadScript} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white">Download SQL script (.sql)</button>
            <button onClick={() => { setStep(0); setSummary(null); setValidation([]); setLog([]); }} className="rounded border px-4 py-2 text-sm">Start a new migration</button>
          </div>
          <div className="mt-4"><MigrationLog lines={log} /></div></>
        )}
      </section>

      {/* Nav */}
      <div className="mt-4 flex justify-between">
        <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className="rounded border bg-white px-4 py-2 text-sm disabled:opacity-50">← Back</button>
        {step < 5 && (
          <button onClick={() => { if (step === 1) discover(); setStep((s) => Math.min(5, s + 1)); }} disabled={!canNext} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            Continue →
          </button>
        )}
      </div>
      <p className="mt-6 text-xs text-slate-400">Credentials are only sent with the request that needs them and are never stored. Review the generated SQL before running it against production; view conversion is best-effort T-SQL → Postgres.</p>
    </main>
  );
}
