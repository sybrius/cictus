'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  DatabaseBackup,
  FileUp,
  Loader2,
  Play,
  XCircle,
} from 'lucide-react';
import { TargetConnectionForm, type TargetFormValues } from '@/components/ConnectionForm';
import { ConnectionTabs, ConnectorList, SaveConnectorBox, type ConnectionMode, type PickerConnector } from '@/components/ConnectionPicker';
import { MigrationLog, type LogLine } from '@/components/MigrationLog';
import { ProgressBar } from '@/components/ProgressBar';
import { Alert, Badge, Button, Card, CardHeader, PageHeader } from '@/components/ui';

const STEPS = ['Target', 'Upload dump', 'Review', 'Restore'];

interface ParseResult {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  total: number;
  tables: string[];
  views: string[];
  sequences: string[];
  copyTables: { table: string; rows: number }[];
  insertStatements: number;
  kinds: Record<string, number>;
  warnings: string[];
}

interface RestoreSummary {
  statements: number;
  succeeded: number;
  failed: number;
  rowsRestored: number;
  aborted: boolean;
  errors: string[];
}

export default function RestorePage() {
  const [step, setStep] = useState(0);
  const [connectors, setConnectors] = useState<PickerConnector[]>([]);
  const [targetConnectorId, setTargetConnectorId] = useState('');
  const [targetMode, setTargetMode] = useState<ConnectionMode>('existing');
  const [targetSaveType, setTargetSaveType] = useState('postgres');
  const [target, setTarget] = useState<TargetFormValues>({ connectionString: '' });
  const [targetOk, setTargetOk] = useState(false);
  const [targetResult, setTargetResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [stopOnError, setStopOnError] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
  const [log, setLog] = useState<LogLine[]>([]);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targetConnectors = connectors.filter((c) => c.kind === 'target');
  const selectedTargetConnector = connectors.find((c) => c.id === targetConnectorId);
  const targetTypeLabel = selectedTargetConnector
    ? selectedTargetConnector.type === 'nhost' ? 'NHost' : selectedTargetConnector.type === 'supabase' ? 'Supabase' : 'PostgreSQL'
    : 'Postgres';

  async function refreshConnectors() {
    try {
      const j = await (await fetch('/api/connectors')).json();
      setConnectors(j.connectors ?? []);
    } catch {
      /* keep the previous list */
    }
  }

  useEffect(() => {
    void refreshConnectors();
  }, []);

  const stamp = () => new Date().toLocaleTimeString();
  const addLog = (message: string, level: LogLine['level'] = 'info') =>
    setLog((l) => [...l, { time: stamp(), level, message }]);

  async function testTarget(v?: TargetFormValues) {
    setTesting(true);
    setTargetResult(null);
    try {
      const body = targetConnectorId ? { targetConnectorId } : (v ?? target);
      const r = await fetch('/api/target/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok) {
        setTargetOk(true);
        setTargetResult({ ok: true, message: `Connected — ${j.version ?? ''} (${j.database ?? ''})${j.postgis ? ' · PostGIS enabled' : ' · PostGIS not enabled'}` });
      } else {
        setTargetOk(false);
        setTargetResult({ ok: false, message: `Failed: ${j.error ?? 'unknown error'}` });
      }
    } catch (e) {
      setTargetResult({ ok: false, message: `Failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setTesting(false);
    }
  }

  async function saveTargetConnector(name: string, type?: string) {
    const r = await fetch('/api/connectors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: type ?? 'postgres', connectionString: target.connectionString }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error ?? 'Could not save the connector');
    await refreshConnectors();
    setTargetConnectorId(j.connector.id);
    setTargetMode('existing');
    setTargetResult({ ok: true, message: `Saved as “${name}” — selected under Existing destination.` });
  }

  async function parseDump() {
    if (!file) return;
    setParsing(true);
    setParseError(null);
    setParseResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await fetch('/api/restore/parse', { method: 'POST', body: form });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Could not parse the dump');
      setParseResult(j as ParseResult);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    } finally {
      setParsing(false);
    }
  }

  async function runRestore() {
    if (!parseResult) return;
    setRestoring(true);
    setProgress({ done: 0, total: parseResult.total, label: '' });
    setLog([]);
    setSummary(null);
    setError(null);
    setStep(3);
    addLog(`Restore started — ${parseResult.total.toLocaleString()} statements into ${selectedTargetConnector?.name ?? targetTypeLabel}.`);
    try {
      const r = await fetch('/api/restore/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: parseResult.fileId,
          fileName: parseResult.fileName,
          targetConnectorId: targetConnectorId || undefined,
          target: targetConnectorId ? undefined : target,
          stopOnError,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error ?? `Restore request failed (${r.status})`);
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
          if (e.type === 'progress') setProgress({ done: e.done, total: e.total, label: e.label });
          else if (e.type === 'error') addLog(`ERROR ${e.statement ? `(${e.statement}) ` : ''}${e.message}`, 'error');
          else if (e.type === 'done') {
            setSummary(e.summary as RestoreSummary);
            addLog(
              `Restore finished: ${e.summary.succeeded.toLocaleString()} statements ran, ${e.summary.failed} failed, ${e.summary.rowsRestored.toLocaleString()} rows restored.`,
              e.summary.failed ? 'error' : 'success',
            );
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (/failed to fetch|networkerror|network error|load failed/i.test(msg)) {
        addLog('Restore failed: the browser lost its connection to the server (network error). The run may still be finishing server-side — check History for the recorded result before re-running.', 'error');
      } else {
        addLog(`Restore failed: ${msg}`, 'error');
      }
    } finally {
      setRestoring(false);
    }
  }

  const canNext = (step === 0 && targetOk) || (step === 1 && parseResult !== null) || step === 2;
  const pct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Restore backup"
        subtitle={`Restore a pg_dump plain-text dump (.sql, or .sql.gz) into ${targetTypeLabel} Postgres. Nothing runs until Step 4 — upload first, review what the dump contains, then restore.`}
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
          <CardHeader title={`${step + 1} · ${STEPS[step]}`} subtitle={
            step === 0 ? 'Use an existing saved destination, or paste a new Postgres connection string.'
            : step === 1 ? 'Upload the dump file. It is parsed on the server — nothing is executed yet.'
            : step === 2 ? 'Check what the dump will do, then start the restore.'
            : 'Statements run one at a time. A failed statement is reported and the run moves on (unless Stop on first error is on).'
          } />
          <div className="p-5 sm:p-6">
            {step === 0 && (
              <div className="space-y-4">
                <ConnectionTabs
                  mode={targetMode}
                  onModeChange={(m) => {
                    setTargetMode(m);
                    if (m === 'new') { setTargetConnectorId(''); setTargetOk(false); setTargetResult(null); }
                  }}
                  existingLabel="Existing destination"
                  newLabel="New destination"
                />
                {targetMode === 'existing' ? (
                  <div className="space-y-3">
                    <ConnectorList
                      kind="target"
                      connectors={targetConnectors}
                      selectedId={targetConnectorId}
                      onSelect={(id) => { setTargetConnectorId(id); setTargetOk(false); setTargetResult(null); }}
                    />
                    {selectedTargetConnector && (
                      <div className="space-y-3">
                        <Button onClick={() => testTarget()} loading={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
                        {targetResult && <p className={`text-sm font-medium ${targetResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>{targetResult.message}</p>}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <TargetConnectionForm initial={target} onTest={(v) => { setTarget(v); testTarget(v); }} testing={testing} testResult={targetResult} />
                    {targetOk && (
                      <SaveConnectorBox
                        key={`tgt-${target.connectionString.match(/@([^:/]+)/)?.[1] ?? 'target'}`}
                        defaultName="Postgres target"
                        onSave={saveTargetConnector}
                        typePicker={{
                          options: [
                            { value: 'nhost', label: 'NHost' },
                            { value: 'supabase', label: 'Supabase' },
                            { value: 'postgres', label: 'PostgreSQL' },
                          ],
                          value: targetSaveType,
                          onChange: setTargetSaveType,
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".sql,.sql.gz"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) { setFile(f); setParseResult(null); setParseError(null); }
                    e.target.value = '';
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                    <FileUp className="h-4 w-4" />
                    {file ? 'Choose a different file' : 'Choose a .sql or .sql.gz file'}
                  </Button>
                  {file && (
                    <span className="text-sm text-slate-600">
                      <strong className="font-semibold text-slate-900">{file.name}</strong> · {(file.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-slate-500">
                  Plain-text dumps only — make one with <code className="rounded bg-slate-100 px-1 py-0.5 font-mono">pg_dump -F p dbname &gt; backup.sql</code>.
                  Custom-format dumps (.dump / .backup) need the pg_restore binary and are not supported here.
                  On the Vercel deployment, uploads are limited by the platform to about 4.5 MB — restore larger dumps from a local run of the app.
                </p>
                {file && (
                  <Button onClick={parseDump} loading={parsing}>
                    {parsing ? 'Parsing…' : 'Parse dump'}
                  </Button>
                )}
                {parseError && <p className="text-sm font-medium text-red-700">{parseError}</p>}
                {parseResult && (
                  <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                    <CheckCircle2 className="h-4 w-4" />
                    Parsed — {parseResult.total.toLocaleString()} statements, {parseResult.tables.length} tables,{' '}
                    {parseResult.copyTables.reduce((a, c) => a + c.rows, 0).toLocaleString()} COPY rows. Continue to Review.
                  </p>
                )}
              </div>
            )}

            {step === 2 && parseResult && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: 'Statements', value: parseResult.total.toLocaleString() },
                    { label: 'Tables to create', value: String(parseResult.tables.length) },
                    { label: 'COPY rows', value: parseResult.copyTables.reduce((a, c) => a + c.rows, 0).toLocaleString() },
                    { label: 'INSERT statements', value: parseResult.insertStatements.toLocaleString() },
                  ].map((s) => (
                    <div key={s.label} className="rounded-xl border border-slate-200 bg-ink-50 px-4 py-3.5">
                      <div className="text-xs font-medium text-slate-500">{s.label}</div>
                      <div className="tnum mt-1 text-2xl font-bold tracking-tight text-slate-900">{s.value}</div>
                    </div>
                  ))}
                </div>
                {parseResult.tables.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-semibold tracking-wide text-slate-600">Tables</p>
                    <div className="flex flex-wrap gap-1.5">
                      {parseResult.tables.map((t) => <Badge key={t} tone="blue">{t}</Badge>)}
                    </div>
                  </div>
                )}
                {parseResult.copyTables.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-semibold tracking-wide text-slate-600">Data (COPY)</p>
                    <div className="flex flex-wrap gap-1.5">
                      {parseResult.copyTables.map((c) => <Badge key={c.table} tone="green">{c.table} · {c.rows.toLocaleString()} rows</Badge>)}
                    </div>
                  </div>
                )}
                {parseResult.views.length > 0 && (
                  <p className="text-sm text-slate-600">Views: {parseResult.views.join(', ')}</p>
                )}
                {parseResult.warnings.length > 0 && (
                  <Alert tone="amber">
                    <strong>Check before restoring:</strong>
                    <ul className="mt-1 list-disc pl-5">{parseResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </Alert>
                )}
                <p className="rounded-xl bg-ink-50 px-4 py-3 text-xs leading-relaxed text-slate-500">
                  Restoring into <strong className="font-semibold text-slate-800">{selectedTargetConnector?.name ?? targetTypeLabel}</strong>
                  {' '}— the dump runs as-is against that database. Only restore dumps you trust: the file can drop or overwrite existing objects.
                </p>
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} className="h-4 w-4 accent-brand-600" />
                  Stop on first error (otherwise failed statements are reported and the run moves on)
                </label>
                <Button variant="success" size="lg" onClick={runRestore} loading={restoring}>
                  <Play className="h-4 w-4" />
                  {restoring ? 'Restoring…' : 'Start restore'}
                </Button>
              </div>
            )}

            {step === 3 && (
              <div>
                <ProgressBar
                  value={pct}
                  label={progress.total > 0 ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} statements${progress.label ? ` — ${progress.label}` : ''}` : 'Not started'}
                />
                <div className="mt-5"><MigrationLog lines={log} /></div>
                {summary && (
                  <div className="mt-5 space-y-4">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        { label: 'Statements', value: String(summary.statements) },
                        { label: 'Succeeded', value: summary.succeeded.toLocaleString() },
                        { label: 'Failed', value: String(summary.failed) },
                        { label: 'Rows restored', value: summary.rowsRestored.toLocaleString() },
                      ].map((s) => (
                        <div key={s.label} className="rounded-xl border border-slate-200 bg-ink-50 px-4 py-3.5">
                          <div className="text-xs font-medium text-slate-500">{s.label}</div>
                          <div className="tnum mt-1 text-2xl font-bold tracking-tight text-slate-900">{s.value}</div>
                        </div>
                      ))}
                    </div>
                    {summary.errors.length > 0 && (
                      <Alert tone="red">
                        <strong>Failed statements:</strong>
                        <ul className="mt-1 list-disc pl-5">
                          {summary.errors.slice(0, 20).map((e, i) => <li key={i} className="break-words">{e}</li>)}
                          {summary.errors.length > 20 && <li>…and {summary.errors.length - 20} more (see the log above).</li>}
                        </ul>
                      </Alert>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Link href="/history">
                        <Button variant="secondary">View in History <ArrowRight className="h-4 w-4" /></Button>
                      </Link>
                      <Button variant="secondary" onClick={() => { setStep(0); setSummary(null); setLog([]); setParseResult(null); setFile(null); }}>
                        Restore another dump
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || restoring}>
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        {step < 3 && (
          <Button
            onClick={() => { if (step === 2) void runRestore(); else setStep((s) => Math.min(3, s + 1)); }}
            disabled={!canNext || restoring}
          >
            {step === 2 ? 'Start restore' : 'Continue'}
            {step === 2 ? <Play className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
          </Button>
        )}
      </div>
      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-400">
        <DatabaseBackup className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        The dump is executed as SQL against the target database — only restore files you trust. The run is recorded in
        History as “Restore &lt;file&gt;”. The uploaded file is deleted from the server when the restore finishes.
      </p>
    </div>
  );
}
