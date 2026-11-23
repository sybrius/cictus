'use client';

import { useEffect, useState } from 'react';

type ConnectorType = 'nhost' | 'supabase' | 'postgres' | 'sqlserver';

interface Connector {
  id: string; name: string; type: ConnectorType; kind: string;
  projectRef: string; region: string; host: string; port: number;
  database: string; user: string; connectionString: string;
  instance: string; encrypt: boolean; trustCert: boolean;
  lastTestedAt: string | null; lastTestOk: boolean | null; lastTestMessage: string | null;
}

const TYPE_META: Record<ConnectorType, { label: string; hint: string }> = {
  nhost: { label: 'NHost (Postgres)', hint: 'Enter the NHost subdomain and region, plus the postgres password — the connection string is built as postgres://postgres:…@<subdomain>.db.<region>.nhost.run:5432/postgres. Or paste the full connection string instead.' },
  supabase: { label: 'Supabase (Postgres)', hint: 'Enter the project ref (from the Supabase dashboard URL / Project Settings) and the postgres password. Host defaults to db.<project-ref>.supabase.co:5432. Or paste the direct connection string instead (use the direct 5432 string, not the 6543 pooler, for DDL).' },
  postgres: { label: 'PostgreSQL (generic)', hint: 'Any Postgres server: host, port (5432), database, user and password — or paste a full connection string.' },
  sqlserver: { label: 'SQL Server', hint: 'Source database: host, port (1433), database, user and password. Named instance goes in Instance; leave Port at 1433 for a named instance.' },
};

const EMPTY: Record<string, string | number | boolean> = {
  name: '', type: 'nhost', projectRef: '', region: 'eu-central-1', host: '', port: 5432,
  database: 'postgres', user: 'postgres', password: '', connectionString: '',
  instance: '', encrypt: true, trustCert: true,
};

export default function ConnectorsPage() {
  const [list, setList] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Record<string, string | number | boolean>>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const j = await fetch('/api/connectors').then((r) => r.json());
    setList(j.connectors ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value }));

  function startAdd(type: ConnectorType) {
    setForm({ ...EMPTY, type, port: type === 'sqlserver' ? 1433 : 5432, database: type === 'sqlserver' ? '' : 'postgres', user: type === 'sqlserver' ? 'sa' : 'postgres' });
    setEditingId(null);
    setShowForm(true);
    setMessage(null); setError(null);
  }

  function startEdit(c: Connector) {
    setForm({
      name: c.name, type: c.type, projectRef: c.projectRef, region: c.region || 'eu-central-1',
      host: c.host, port: c.port, database: c.database, user: c.user, password: '',
      connectionString: c.connectionString, instance: c.instance, encrypt: c.encrypt, trustCert: c.trustCert,
    });
    setEditingId(c.id);
    setShowForm(true);
    setMessage(null); setError(null);
  }

  async function save() {
    setSaving(true); setError(null); setMessage(null);
    const body = { ...form, id: editingId ?? undefined };
    const r = await fetch('/api/connectors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    setSaving(false);
    if (!j.ok) { setError(j.error ?? 'Could not save connector'); return; }
    setMessage(`Saved “${j.connector.name}”.`);
    setShowForm(false);
    await load();
  }

  async function test(id: string) {
    setTestingId(id); setMessage(null);
    const r = await fetch('/api/connectors/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const j = await r.json();
    setTestingId(null);
    setMessage(j.ok ? `Test passed — ${j.version ?? ''} (${j.database ?? ''})` : `Test failed: ${j.error ?? 'unknown error'}`);
    await load();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete connector “${name}”?`)) return;
    await fetch(`/api/connectors?id=${id}`, { method: 'DELETE' });
    await load();
  }

  const type = form.type as ConnectorType;
  const input = 'w-full rounded border border-slate-300 px-3 py-2 text-sm';
  const label = 'block text-xs font-medium text-slate-600 mb-1';

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Connectors</h1>
          <p className="mt-1 text-sm text-slate-600">
            Named, reusable connections. Add a SQL Server source once, and NHost, Supabase or PostgreSQL targets — then pick them in the migration wizard instead of re-typing credentials.
          </p>
        </div>
        <div className="flex gap-2">
          {(Object.keys(TYPE_META) as ConnectorType[]).map((t) => (
            <button key={t} onClick={() => startAdd(t)} className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white">+ {TYPE_META[t].label}</button>
          ))}
        </div>
      </div>

      {message && <div className="mt-4 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">{message}</div>}
      {error && <div className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}

      {showForm && (
        <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">{editingId ? 'Edit connector' : `Add ${TYPE_META[type].label}`}</h2>
          <p className="mt-1 text-xs text-slate-500">{TYPE_META[type].hint}</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div><label className={label}>Name</label><input className={input} value={String(form.name)} onChange={set('name')} placeholder="e.g. NHost production" required /></div>
            <div><label className={label}>Type</label>
              <select className={input} value={type} onChange={(e) => { const t = e.target.value as ConnectorType; setForm((f) => ({ ...f, type: t, port: t === 'sqlserver' ? 1433 : 5432 })); }}>
                {(Object.keys(TYPE_META) as ConnectorType[]).map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
              </select>
            </div>
            {(type === 'nhost' || type === 'supabase') && (
              <>
                <div><label className={label}>{type === 'nhost' ? 'NHost subdomain' : 'Supabase project ref'}</label><input className={input} value={String(form.projectRef)} onChange={set('projectRef')} placeholder={type === 'nhost' ? 'my-app' : 'abcdefghijklmnop'} /></div>
                {type === 'nhost' && <div><label className={label}>Region</label><input className={input} value={String(form.region)} onChange={set('region')} placeholder="eu-central-1" /></div>}
              </>
            )}
            <div><label className={label}>Host {type !== 'sqlserver' && '(optional if project ref / connection string is given)'}</label><input className={input} value={String(form.host)} onChange={set('host')} placeholder={type === 'sqlserver' ? 'QYLA' : type === 'supabase' ? 'db.<project-ref>.supabase.co' : 'localhost'} /></div>
            <div><label className={label}>Port</label><input className={input} type="number" value={Number(form.port)} onChange={set('port')} /></div>
            <div><label className={label}>Database</label><input className={input} value={String(form.database)} onChange={set('database')} /></div>
            <div><label className={label}>User</label><input className={input} value={String(form.user)} onChange={set('user')} /></div>
            <div><label className={label}>Password {editingId ? '(leave blank to keep the saved one)' : ''}</label><input className={input} type="password" value={String(form.password)} onChange={set('password')} autoComplete="new-password" /></div>
            {type === 'sqlserver' && <div><label className={label}>Instance (optional)</label><input className={input} value={String(form.instance)} onChange={set('instance')} placeholder="SQLEXPRESS" /></div>}
            {type !== 'sqlserver' && <div className="col-span-2"><label className={label}>Connection string (optional — overrides host/port/user above)</label><input className={input} type="password" value={String(form.connectionString)} onChange={set('connectionString')} placeholder="postgres://postgres:…@host:5432/postgres" autoComplete="new-password" /></div>}
          </div>
          {type === 'sqlserver' && (
            <div className="mt-3 flex gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(form.encrypt)} onChange={set('encrypt')} /> Encryption (TLS)</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(form.trustCert)} onChange={set('trustCert')} /> Trust server certificate</label>
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <button onClick={save} disabled={saving} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? 'Saving…' : editingId ? 'Save changes' : 'Save connector'}</button>
            <button onClick={() => setShowForm(false)} className="rounded border px-4 py-2 text-sm">Cancel</button>
          </div>
          <p className="mt-3 text-xs text-slate-500">Stored only on this machine in <span className="font-mono">data/connectors.json</span> (git-ignored). Passwords are never shown back in the browser and are only used server-side when you test or run a migration with that connector.</p>
        </section>
      )}

      <section className="mt-6">
        {loading ? <p className="text-sm text-slate-500">Loading…</p> : list.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm">
            No connectors yet. Add one above — for example your NHost project (subdomain + region + postgres password) and your Supabase project (project ref + password). Supabase and NHost are both plain Postgres, so the same migration engine drives all three.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((c) => (
              <div key={c.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">{c.name}</div>
                    <div className="text-xs text-slate-500">{TYPE_META[c.type].label} · {c.kind === 'source' ? 'Source' : 'Target'}</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.lastTestOk === true ? 'bg-green-100 text-green-800' : c.lastTestOk === false ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-600'}`}>
                    {c.lastTestOk === true ? '✓ Tested' : c.lastTestOk === false ? '✗ Test failed' : 'Not tested'}
                  </span>
                </div>
                <div className="mt-2 font-mono text-xs text-slate-600">
                  {c.projectRef ? `${c.projectRef} · ` : ''}{c.host ? `${c.host}:${c.port}` : ''}{c.database ? ` / ${c.database}` : ''}
                </div>
                {c.lastTestMessage && <div className="mt-1 text-xs text-slate-500">{c.lastTestMessage}</div>}
                <div className="mt-3 flex gap-2">
                  <button onClick={() => test(c.id)} disabled={testingId === c.id} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{testingId === c.id ? 'Testing…' : 'Test'}</button>
                  <button onClick={() => startEdit(c)} className="rounded border px-3 py-1.5 text-xs">Edit</button>
                  <button onClick={() => remove(c.id, c.name)} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
