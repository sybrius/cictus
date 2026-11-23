'use client';

import { useState } from 'react';
import { Database, HardDrive, Loader2, Stethoscope } from 'lucide-react';
import { Field, Toggle, inputCls } from '@/components/ui';

export interface SourceFormValues {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  trustCert: boolean;
  encrypt: boolean;
  instance: string;
  /** MySQL only: use TLS. */
  ssl: boolean;
  /** Which source this form is for. */
  sourceType: 'sqlserver' | 'mysql';
}

export interface TargetFormValues {
  connectionString: string;
}

function SourceTypeCard({
  selected,
  onClick,
  icon,
  title,
  sub,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex flex-1 items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all duration-150 ${
        selected
          ? 'border-brand-500 bg-brand-50/60 shadow-sm'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
      }`}
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
        {icon}
      </span>
      <span>
        <span className={`block text-sm font-semibold ${selected ? 'text-brand-800' : 'text-slate-800'}`}>{title}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{sub}</span>
      </span>
      <span className={`ml-auto h-5 w-5 shrink-0 rounded-full border-2 ${selected ? 'border-brand-600 bg-brand-600' : 'border-slate-300 bg-white'} flex items-center justify-center`}>
        {selected && <span className="h-2 w-2 rounded-full bg-white" />}
      </span>
    </button>
  );
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
  const isMysql = v.sourceType === 'mysql';
  return (
    <form onSubmit={(e) => { e.preventDefault(); onTest(v); }} className="space-y-4">
      <Field label="Source database">
        <div className="flex flex-col gap-2 sm:flex-row">
          <SourceTypeCard
            selected={!isMysql}
            onClick={() => setV({ ...v, sourceType: 'sqlserver', port: 1433 })}
            icon={<HardDrive className="h-5 w-5" />}
            title="SQL Server"
            sub="T-SQL · port 1433"
          />
          <SourceTypeCard
            selected={isMysql}
            onClick={() => setV({ ...v, sourceType: 'mysql', port: 3306 })}
            icon={<Database className="h-5 w-5" />}
            title="MySQL"
            sub="MySQL 5.7 / 8 · port 3306"
          />
        </div>
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Host"><input className={inputCls} value={v.host} onChange={set('host')} required placeholder="localhost" /></Field>
        <Field label="Port"><input className={inputCls} type="number" value={v.port} onChange={set('port')} required /></Field>
        <Field label="User"><input className={inputCls} value={v.user} onChange={set('user')} required /></Field>
        <Field label="Password"><input className={inputCls} type="password" value={v.password} onChange={set('password')} required /></Field>
        <Field label="Database"><input className={inputCls} value={v.database} onChange={set('database')} required /></Field>
        {!isMysql && <Field label="Instance (optional)"><input className={inputCls} value={v.instance} onChange={set('instance')} placeholder="SQLEXPRESS" /></Field>}
      </div>
      {!isMysql ? (
        <div className="space-y-2">
          <Toggle
            checked={v.trustCert}
            onChange={(checked) => setV({ ...v, trustCert: checked })}
            label="Trust server certificate"
            hint="Needed for self-signed certificates on local SQL Server."
          />
          <Toggle
            checked={v.encrypt}
            onChange={(checked) => setV({ ...v, encrypt: checked })}
            label="Use encryption (TLS)"
            hint="Turn off for a local SQL Server if the test fails with “Could not connect (sequence)”."
          />
        </div>
      ) : (
        <Toggle
          checked={v.ssl}
          onChange={(checked) => setV({ ...v, ssl: checked })}
          label="Use SSL/TLS"
          hint="Only if the MySQL server requires it — most local / Docker setups do not."
        />
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={testing} className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-brand-700 active:scale-[0.98] disabled:opacity-50">
          {testing && <Loader2 className="h-4 w-4 animate-spin" />}
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" disabled={diagnosing || testing} onClick={() => onDiagnose(v)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-50">
          <Stethoscope className="h-4 w-4" />
          {diagnosing ? 'Diagnosing…' : 'Diagnose (DNS + port)'}
        </button>
      </div>
      {diagnoseResult && (
        <p className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-700">{diagnoseResult}</p>
      )}
      {testResult && (
        <p className={`text-sm font-medium ${testResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>{testResult.message}</p>
      )}
      <p className="text-xs leading-relaxed text-slate-500">
        Credentials are sent to the server only for this request and are never stored.
        {v.sourceType === 'sqlserver'
          ? ' If the host is a PC name like QYLA and the app runs on that same PC, try “localhost” instead — and for a named instance (QYLA\\SQLEXPRESS) put SQLEXPRESS in Instance and leave Port at 1433.'
          : ' If the app runs on the same machine as MySQL, use “localhost” — in Docker / WSL, use the host’s LAN IP or host.docker.internal. The MySQL user must be allowed to connect from this host (a user created as \'app\'@\'localhost\' cannot log in from another machine).'}
      </p>
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
    <form onSubmit={(e) => { e.preventDefault(); onTest(v); }} className="space-y-4">
      <Field
        label="Postgres connection string"
        hint="NHost Dashboard → your project → Database → Connection string. Use the direct (non-pooled) string for DDL."
      >
        <input
          className={`${inputCls} font-mono`}
          type="password"
          value={v.connectionString}
          onChange={(e) => setV({ connectionString: e.target.value })}
          required
          placeholder="postgres://postgres:…@db.<subdomain>.nhost.run:5432/postgres"
        />
      </Field>
      <button type="submit" disabled={testing} className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-brand-700 active:scale-[0.98] disabled:opacity-50">
        {testing && <Loader2 className="h-4 w-4 animate-spin" />}
        {testing ? 'Testing…' : 'Test connection'}
      </button>
      {testResult && (
        <p className={`text-sm font-medium ${testResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>{testResult.message}</p>
      )}
    </form>
  );
}
