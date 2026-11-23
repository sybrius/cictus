'use client';

import { useRef, useState } from 'react';
import { Database, FileUp, HardDrive, Loader2, Server, Stethoscope } from 'lucide-react';
import { Field, Toggle, inputCls } from '@/components/ui';
import type { SourceKind } from '@/lib/type-map';

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
  /** PostgreSQL source only: full connection string. */
  connectionString: string;
  /** Oracle only: service name (or SID). */
  service: string;
  /** SQLite only: path to the .sqlite / .db file on this machine. */
  filePath: string;
  /** Which source this form is for. */
  sourceType: SourceKind;
}

export interface TargetFormValues {
  connectionString: string;
}

const SOURCE_TYPES: { kind: SourceKind; icon: React.ReactNode; title: string; sub: string; port: number }[] = [
  { kind: 'sqlserver', icon: <HardDrive className="h-5 w-5" />, title: 'SQL Server', sub: 'T-SQL · port 1433', port: 1433 },
  { kind: 'mysql', icon: <Database className="h-5 w-5" />, title: 'MySQL', sub: 'MySQL 5.7 / 8 · port 3306', port: 3306 },
  { kind: 'postgres', icon: <Server className="h-5 w-5" />, title: 'PostgreSQL', sub: 'Same engine, other database', port: 5432 },
  { kind: 'oracle', icon: <Database className="h-5 w-5" />, title: 'Oracle', sub: 'Oracle 12c+ · port 1521', port: 1521 },
  { kind: 'sqlite', icon: <FileUp className="h-5 w-5" />, title: 'SQLite', sub: 'Local .sqlite / .db file', port: 0 },
];

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
      className={`flex min-w-[220px] flex-1 items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all duration-150 ${
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: keyof SourceFormValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const isMysql = v.sourceType === 'mysql';
  const isSqlServer = v.sourceType === 'sqlserver';
  const isPostgres = v.sourceType === 'postgres';
  const isOracle = v.sourceType === 'oracle';
  const isSqlite = v.sourceType === 'sqlite';

  async function uploadFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await fetch('/api/source/upload', { method: 'POST', body: form });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Upload failed');
      setV((cur) => ({ ...cur, filePath: j.filePath }));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); onTest(v); }} className="space-y-4">
      <Field label="Source database">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {SOURCE_TYPES.map((t) => (
            <SourceTypeCard
              key={t.kind}
              selected={v.sourceType === t.kind}
              onClick={() => setV({ ...v, sourceType: t.kind, port: t.port || v.port })}
              icon={t.icon}
              title={t.title}
              sub={t.sub}
            />
          ))}
        </div>
      </Field>
      {isSqlite ? (
        <div className="space-y-3">
          <Field
            label="SQLite file path"
            hint="The path is read on the machine the app runs on. Or upload a file — it is stored under data/uploads/ and opened read-only."
          >
            <input className={`${inputCls} font-mono`} value={v.filePath} onChange={set('filePath')} required placeholder="C:\Data\mydb.sqlite" />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".sqlite,.sqlite3,.db"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadFile(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
              {uploading ? 'Uploading…' : 'Upload a .sqlite file'}
            </button>
            {uploadError && <p className="text-sm font-medium text-red-700">{uploadError}</p>}
          </div>
        </div>
      ) : isPostgres ? (
        <Field
          label="Postgres connection string"
          hint="The source database's connection string — same format as a target. Tables are read from its schemas (excluding pg_catalog / information_schema)."
        >
          <input
            className={`${inputCls} font-mono`}
            type="password"
            value={v.connectionString}
            onChange={set('connectionString')}
            required
            placeholder="postgres://user:password@host:5432/database"
          />
        </Field>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Host"><input className={inputCls} value={v.host} onChange={set('host')} required placeholder="localhost" /></Field>
          <Field label="Port"><input className={inputCls} type="number" value={v.port} onChange={set('port')} required /></Field>
          <Field label="User"><input className={inputCls} value={v.user} onChange={set('user')} required /></Field>
          <Field label="Password"><input className={inputCls} type="password" value={v.password} onChange={set('password')} required /></Field>
          {isOracle ? (
            <Field label="Service name"><input className={inputCls} value={v.service} onChange={set('service')} required placeholder="ORCLPDB1" /></Field>
          ) : (
            <Field label="Database"><input className={inputCls} value={v.database} onChange={set('database')} required /></Field>
          )}
          {isSqlServer && <Field label="Instance (optional)"><input className={inputCls} value={v.instance} onChange={set('instance')} placeholder="SQLEXPRESS" /></Field>}
        </div>
      )}
      {isSqlServer && (
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
      )}
      {isMysql && (
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
          {diagnosing ? 'Diagnosing…' : 'Diagnose'}
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
        {isSqlServer
          ? ' If the host is a PC name like QYLA and the app runs on that same PC, try “localhost” instead — and for a named instance (QYLA\\SQLEXPRESS) put SQLEXPRESS in Instance and leave Port at 1433.'
          : isMysql
            ? ' If the app runs on the same machine as MySQL, use “localhost” — in Docker / WSL, use the host’s LAN IP or host.docker.internal. The MySQL user must be allowed to connect from this host (a user created as \'app\'@\'localhost\' cannot log in from another machine).'
            : isOracle
              ? ' Only tables owned by the connecting user are migrated — connect as the schema owner. Oracle 12c+ via the thin driver; no Oracle client is needed on this machine.'
              : isSqlite
                ? ' The file is opened read-only and never modified. Tables land in the target\'s public schema (SQLite has no schemas).'
                : ' The source is read from its schemas; system schemas (pg_catalog, information_schema) are skipped.'}
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
