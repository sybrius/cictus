'use client';

import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  Database,
  HardDrive,
  Pencil,
  PlugZap,
  Plus,
  Server,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, PageHeader, Toggle, inputCls } from '@/components/ui';

type ConnectorType = 'nhost' | 'supabase' | 'postgres' | 'sqlserver' | 'mysql';

interface Connector {
  id: string; name: string; type: ConnectorType; kind: string;
  projectRef: string; region: string; host: string; port: number;
  database: string; user: string; connectionString: string;
  instance: string; encrypt: boolean; trustCert: boolean;
  lastTestedAt: string | null; lastTestOk: boolean | null; lastTestMessage: string | null;
}

const TYPE_META: Record<ConnectorType, { label: string; hint: string; kind: 'source' | 'target' }> = {
  nhost: { label: 'NHost (Postgres)', hint: 'Enter the NHost subdomain and region, plus the postgres password — the connection string is built as postgres://postgres:…@<subdomain>.db.<region>.nhost.run:5432/postgres. Or paste the full connection string instead.', kind: 'target' },
  supabase: { label: 'Supabase (Postgres)', hint: 'Enter the project ref (from the Supabase dashboard URL / Project Settings) and the postgres password. Host defaults to db.<project-ref>.supabase.co:5432. Or paste the direct connection string instead (use the direct 5432 string, not the 6543 pooler, for DDL).', kind: 'target' },
  postgres: { label: 'PostgreSQL (generic)', hint: 'Any Postgres server: host, port (5432), database, user and password — or paste a full connection string.', kind: 'target' },
  sqlserver: { label: 'SQL Server', hint: 'Source database: host, port (1433), database, user and password. Named instance goes in Instance; leave Port at 1433 for a named instance.', kind: 'source' },
  mysql: { label: 'MySQL', hint: 'Source database: host, port (3306), database, user and password. Enable SSL only if the server requires it (most local / Docker setups do not).', kind: 'source' },
};

const TYPE_ICON: Record<ConnectorType, typeof Database> = {
  nhost: Cloud,
  supabase: Server,
  postgres: Database,
  sqlserver: HardDrive,
  mysql: Database,
};

const TYPE_TILE: Record<ConnectorType, string> = {
  nhost: 'bg-violet-50 text-violet-600',
  supabase: 'bg-emerald-50 text-emerald-600',
  postgres: 'bg-sky-50 text-sky-600',
  sqlserver: 'bg-blue-50 text-blue-600',
  mysql: 'bg-orange-50 text-orange-600',
};

const EMPTY: Record<string, string | number | boolean> = {
  name: '', type: 'nhost', projectRef: '', region: 'eu-central-1', host: '', port: 5432,
  database: 'postgres', user: 'postgres', password: '', connectionString: '',
  instance: '', encrypt: true, trustCert: true, ssl: false,
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
    setForm({ ...EMPTY, type, port: type === 'sqlserver' ? 1433 : type === 'mysql' ? 3306 : 5432, database: type === 'sqlserver' || type === 'mysql' ? '' : 'postgres', user: type === 'sqlserver' ? 'sa' : type === 'mysql' ? 'root' : 'postgres' });
    setEditingId(null);
    setShowForm(true);
    setMessage(null); setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function startEdit(c: Connector) {
    setForm({
      name: c.name, type: c.type, projectRef: c.projectRef, region: c.region || 'eu-central-1',
      host: c.host, port: c.port, database: c.database, user: c.user, password: '',
      connectionString: c.connectionString, instance: c.instance, encrypt: c.encrypt, trustCert: c.trustCert, ssl: (c as { ssl?: boolean }).ssl ?? false,
    });
    setEditingId(c.id);
    setShowForm(true);
    setMessage(null); setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
  const sources = list.filter((c) => c.kind === 'source');
  const targets = list.filter((c) => c.kind === 'target');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connectors"
        subtitle="Named, reusable connections. Add a SQL Server or MySQL source once, and NHost, Supabase or PostgreSQL targets — then pick them in the migration wizard instead of re-typing credentials."
        actions={
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TYPE_META) as ConnectorType[]).map((t) => (
              <Button key={t} size="sm" variant={t === 'nhost' || t === 'sqlserver' ? 'primary' : 'secondary'} onClick={() => startAdd(t)}>
                <Plus className="h-3.5 w-3.5" />
                {TYPE_META[t].label}
              </Button>
            ))}
          </div>
        }
      />

      {message && <Alert tone="green">{message}</Alert>}
      {error && <Alert>{error}</Alert>}

      {showForm && (
        <Card className="animate-scale-in">
          <CardHeader title={editingId ? 'Edit connector' : `Add ${TYPE_META[type].label}`} subtitle={TYPE_META[type].hint} />
          <div className="space-y-4 p-5 sm:p-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name"><input className={inputCls} value={String(form.name)} onChange={set('name')} placeholder="e.g. NHost production" required /></Field>
              <Field label="Type">
                <select className={inputCls} value={type} onChange={(e) => { const t = e.target.value as ConnectorType; setForm((f) => ({ ...f, type: t, port: t === 'sqlserver' ? 1433 : t === 'mysql' ? 3306 : 5432 })); }}>
                  {(Object.keys(TYPE_META) as ConnectorType[]).map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
                </select>
              </Field>
              {(type === 'nhost' || type === 'supabase') && (
                <>
                  <Field label={type === 'nhost' ? 'NHost subdomain' : 'Supabase project ref'}>
                    <input className={inputCls} value={String(form.projectRef)} onChange={set('projectRef')} placeholder={type === 'nhost' ? 'my-app' : 'abcdefghijklmnop'} />
                  </Field>
                  {type === 'nhost' && <Field label="Region"><input className={inputCls} value={String(form.region)} onChange={set('region')} placeholder="eu-central-1" /></Field>}
                </>
              )}
              <Field label={`Host${(type === 'sqlserver' || type === 'mysql') ? '' : ' (optional if project ref / connection string is given)'}`}>
                <input className={inputCls} value={String(form.host)} onChange={set('host')} placeholder={type === 'sqlserver' ? 'QYLA' : type === 'mysql' ? 'localhost' : type === 'supabase' ? 'db.<project-ref>.supabase.co' : 'localhost'} />
              </Field>
              <Field label="Port"><input className={inputCls} type="number" value={Number(form.port)} onChange={set('port')} /></Field>
              <Field label="Database"><input className={inputCls} value={String(form.database)} onChange={set('database')} /></Field>
              <Field label="User"><input className={inputCls} value={String(form.user)} onChange={set('user')} /></Field>
              <Field label={`Password${editingId ? ' (leave blank to keep the saved one)' : ''}`}>
                <input className={inputCls} type="password" value={String(form.password)} onChange={set('password')} autoComplete="new-password" />
              </Field>
              {type === 'sqlserver' && <Field label="Instance (optional)"><input className={inputCls} value={String(form.instance)} onChange={set('instance')} placeholder="SQLEXPRESS" /></Field>}
              {type !== 'sqlserver' && type !== 'mysql' && (
                <div className="sm:col-span-2">
                  <Field label="Connection string (optional — overrides host/port/user above)">
                    <input className={inputCls} type="password" value={String(form.connectionString)} onChange={set('connectionString')} placeholder="postgres://postgres:…@host:5432/postgres" autoComplete="new-password" />
                  </Field>
                </div>
              )}
            </div>
            {type === 'sqlserver' && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Toggle checked={Boolean(form.encrypt)} onChange={(checked) => setForm((f) => ({ ...f, encrypt: checked }))} label="Encryption (TLS)" />
                <Toggle checked={Boolean(form.trustCert)} onChange={(checked) => setForm((f) => ({ ...f, trustCert: checked }))} label="Trust server certificate" />
              </div>
            )}
            {type === 'mysql' && (
              <Toggle checked={Boolean(form.ssl)} onChange={(checked) => setForm((f) => ({ ...f, ssl: checked }))} label="Use SSL/TLS" hint="Only if the MySQL server requires it." />
            )}
            <div className="flex gap-2">
              <Button onClick={save} loading={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Save connector'}</Button>
              <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
            <p className="text-xs leading-relaxed text-slate-500">
              Stored only on this machine in <span className="font-mono">data/connectors.json</span> (git-ignored).
              Passwords are never shown back in the browser and are only used server-side when you test or run a migration with that connector.
            </p>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-[132px]" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PlugZap className="h-7 w-7" />}
            title="No connectors yet"
            body="Add one above — for example your NHost project (subdomain + region + postgres password) and your Supabase project (project ref + password). Supabase and NHost are both plain Postgres, so the same migration engine drives all three."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {[
            { label: 'Sources', items: sources, icon: Database },
            { label: 'Targets', items: targets, icon: Server },
          ].map(({ label, items, icon: SectionIcon }) => items.length > 0 && (
            <section key={label} className="animate-fade-up">
              <div className="mb-3 flex items-center gap-2">
                <SectionIcon className="h-4 w-4 text-slate-400" />
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{label} <span className="tnum text-slate-400">· {items.length}</span></h2>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {items.map((c) => {
                  const Icon = TYPE_ICON[c.type];
                  return (
                    <Card key={c.id} hover className="p-5">
                      <div className="flex items-start gap-3.5">
                        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${TYPE_TILE[c.type]}`}>
                          <Icon className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate font-semibold text-slate-900">{c.name}</div>
                              <div className="text-xs text-slate-500">{TYPE_META[c.type].label} · {c.kind === 'source' ? 'Source' : 'Target'}</div>
                            </div>
                            {c.lastTestOk === true ? (
                              <Badge tone="green"><CheckCircle2 className="h-3.5 w-3.5" /> Tested</Badge>
                            ) : c.lastTestOk === false ? (
                              <Badge tone="red"><XCircle className="h-3.5 w-3.5" /> Test failed</Badge>
                            ) : (
                              <Badge tone="slate">Not tested</Badge>
                            )}
                          </div>
                          <div className="mt-2 truncate font-mono text-xs text-slate-500">
                            {c.projectRef ? `${c.projectRef} · ` : ''}{c.host ? `${c.host}:${c.port}` : ''}{c.database ? ` / ${c.database}` : ''}
                          </div>
                          {c.lastTestMessage && <div className="mt-1 truncate text-xs text-slate-400">{c.lastTestMessage}</div>}
                          <div className="mt-3.5 flex gap-2">
                            <Button size="sm" onClick={() => test(c.id)} loading={testingId === c.id}>{testingId === c.id ? 'Testing…' : 'Test'}</Button>
                            <Button size="sm" variant="secondary" onClick={() => startEdit(c)}>
                              <Pencil className="h-3.5 w-3.5" /> Edit
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => remove(c.id, c.name)}>
                              <Trash2 className="h-3.5 w-3.5" /> Delete
                            </Button>
                          </div>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
