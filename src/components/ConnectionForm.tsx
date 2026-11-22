'use client';

import { useState } from 'react';

export interface SourceFormValues {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  trustCert: boolean;
  encrypt: boolean;
  instance: string;
}

export interface TargetFormValues {
  connectionString: string;
}

export function SourceConnectionForm({
  initial,
  onTest,
  onDiagnose,
  testing,
  diagnosing,
  testResult,
  diagnoseResult,
}: {
  initial: SourceFormValues;
  onTest: (v: SourceFormValues) => void;
  onDiagnose: (v: SourceFormValues) => void;
  testing: boolean;
  diagnosing: boolean;
  testResult: { ok: boolean; message: string } | null;
  diagnoseResult: string | null;
}) {
  const [v, setV] = useState(initial);
  const set = (k: keyof SourceFormValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const input = 'w-full rounded border border-slate-300 px-3 py-2 text-sm';
  const label = 'block text-xs font-medium text-slate-600 mb-1';
  return (
    <form onSubmit={(e) => { e.preventDefault(); onTest(v); }} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>Host</label><input className={input} value={v.host} onChange={set('host')} required placeholder="localhost" /></div>
        <div><label className={label}>Port</label><input className={input} type="number" value={v.port} onChange={set('port')} required /></div>
        <div><label className={label}>User</label><input className={input} value={v.user} onChange={set('user')} required /></div>
        <div><label className={label}>Password</label><input className={input} type="password" value={v.password} onChange={set('password')} required /></div>
        <div><label className={label}>Database</label><input className={input} value={v.database} onChange={set('database')} required /></div>
        <div><label className={label}>Instance (optional)</label><input className={input} value={v.instance} onChange={set('instance')} placeholder="SQLEXPRESS" /></div>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={v.trustCert} onChange={set('trustCert')} /> Trust server certificate (self-signed)
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={v.encrypt} onChange={set('encrypt')} /> Use encryption (TLS) — turn off for a local SQL Server if the test fails with “Could not connect (sequence)”
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={testing} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" disabled={diagnosing || testing} onClick={() => onDiagnose(v)} className="rounded border px-4 py-2 text-sm disabled:opacity-50">
          {diagnosing ? 'Diagnosing…' : 'Diagnose (DNS + port)'}
        </button>
      </div>
      {diagnoseResult && (
        <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 whitespace-pre-wrap">{diagnoseResult}</p>
      )}
      {testResult && (
        <p className={`text-sm ${testResult.ok ? 'text-green-700' : 'text-red-700'}`}>{testResult.message}</p>
      )}
      <p className="text-xs text-slate-500">Credentials are sent to the server only for this request and are never stored. If the host is a PC name like QYLA and the app runs on that same PC, try “localhost” instead — and for a named instance (QYLA\SQLEXPRESS) put SQLEXPRESS in Instance and leave Port at 1433.</p>
    </form>
  );
}

export function TargetConnectionForm({
  initial,
  onTest,
  testing,
  testResult,
}: {
  initial: TargetFormValues;
  onTest: (v: TargetFormValues) => void;
  testing: boolean;
  testResult: { ok: boolean; message: string } | null;
}) {
  const [v, setV] = useState(initial);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onTest(v); }} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">NHost Postgres connection string</label>
        <input
          className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          type="password"
          value={v.connectionString}
          onChange={(e) => setV({ connectionString: e.target.value })}
          required
          placeholder="postgres://postgres:…@db.<subdomain>.nhost.run:5432/postgres"
        />
        <p className="mt-1 text-xs text-slate-500">NHost Dashboard → your project → Database → Connection string. Use the direct (non-pooled) string for DDL.</p>
      </div>
      <button type="submit" disabled={testing} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {testing ? 'Testing…' : 'Test connection'}
      </button>
      {testResult && (
        <p className={`text-sm ${testResult.ok ? 'text-green-700' : 'text-red-700'}`}>{testResult.message}</p>
      )}
    </form>
  );
}
