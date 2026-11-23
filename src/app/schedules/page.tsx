'use client';

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, Clock, Pencil, Play, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, PageHeader, Toggle, inputCls } from '@/components/ui';
import { SchemaTree } from '@/components/SchemaTree';
import type { DatabaseSchema } from '@/lib/sqlserver';
import { describeCron, nextRuns, validateCron } from '@/lib/cron';

interface ConnectorOpt {
  id: string;
  name: string;
  kind: 'source' | 'target';
  type: string;
  hasuraReady?: boolean;
}

interface ScheduleItem {
  id: string;
  name: string;
  sourceConnectorId: string;
  targetConnectorId: string;
  tables: string[];
  views: string[];
  includeData: boolean;
  dropExisting: boolean;
  useCopy: boolean;
  trackInHasura?: boolean;
  cron: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastRunId: string | null;
  nextRunAt: string | null;
  createdAt: string;
  sourceName: string | null;
  targetName: string | null;
}

const PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 02:00', cron: '0 2 * * *' },
  { label: 'Weekdays at 09:30', cron: '30 9 * * 1-5' },
  { label: 'Weekly · Mon 08:00', cron: '0 8 * * 1' },
  { label: 'Monthly · 1st at 03:00', cron: '0 3 1 * *' },
];

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [connectors, setConnectors] = useState<ConnectorOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form state (create + edit share one form).
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [sourceConnectorId, setSourceConnectorId] = useState('');
  const [targetConnectorId, setTargetConnectorId] = useState('');
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [selectedViews, setSelectedViews] = useState<Set<string>>(new Set());
  const [discovering, setDiscovering] = useState(false);
  const [includeData, setIncludeData] = useState(true);
  const [dropExisting, setDropExisting] = useState(false);
  const [useCopy, setUseCopy] = useState(true);
  const [trackInHasura, setTrackInHasura] = useState(false);
  const [cron, setCron] = useState('0 2 * * *');
  const [saving, setSaving] = useState(false);

  const sources = connectors.filter((c) => c.kind === 'source');
  const targets = connectors.filter((c) => c.kind === 'target');
  const selectedTarget = targets.find((c) => c.id === targetConnectorId);
  const hasuraAvailable = Boolean(selectedTarget?.hasuraReady);
  const cronError = useMemo(() => validateCron(cron), [cron]);
  const upcoming = useMemo(() => (cronError ? [] : nextRuns(cron, new Date(), 3)), [cron, cronError]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/schedules');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Could not load schedules');
      setSchedules(j.schedules);
      setConnectors(j.connectors);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function discover(sourceId: string, preselect?: { tables: string[]; views: string[] }) {
    if (!sourceId) return;
    setDiscovering(true);
    setError(null);
    try {
      const r = await fetch('/api/source/schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceConnectorId: sourceId }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Schema discovery failed');
      setSchema(j.schema);
      if (preselect) {
        setSelectedTables(new Set(preselect.tables));
        setSelectedViews(new Set(preselect.views));
      } else {
        setSelectedTables(new Set(j.schema.tables.map((t: { schema: string; name: string }) => `${t.schema}.${t.name}`)));
        setSelectedViews(new Set(j.schema.views.map((v: { schema: string; name: string }) => `${v.schema}.${v.name}`)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  }

  function resetForm() {
    setEditingId(null);
    setName('');
    setSourceConnectorId('');
    setTargetConnectorId('');
    setSchema(null);
    setSelectedTables(new Set());
    setSelectedViews(new Set());
    setIncludeData(true);
    setDropExisting(false);
    setUseCopy(true);
    setTrackInHasura(false);
    setCron('0 2 * * *');
  }

  function openCreate() {
    resetForm();
    setShowForm(true);
  }

  function openEdit(s: ScheduleItem) {
    setEditingId(s.id);
    setName(s.name);
    setSourceConnectorId(s.sourceConnectorId);
    setTargetConnectorId(s.targetConnectorId);
    setIncludeData(s.includeData);
    setDropExisting(s.dropExisting);
    setUseCopy(s.useCopy);
    setTrackInHasura(s.trackInHasura ?? false);
    setCron(s.cron);
    setSchema(null);
    setShowForm(true);
    void discover(s.sourceConnectorId, { tables: s.tables, views: s.views });
  }

  async function save() {
    if (cronError) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId ?? undefined,
          name,
          sourceConnectorId,
          targetConnectorId,
          tables: [...selectedTables],
          views: [...selectedViews],
          includeData,
          dropExisting,
          useCopy,
          trackInHasura,
          cron,
          enabled: true,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Could not save schedule');
      setNotice(`Schedule "${name}" saved — next run ${fmtDate(j.schedule.nextRunAt)}.`);
      setShowForm(false);
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(s: ScheduleItem) {
    try {
      const r = await fetch(`/api/schedules/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Could not update schedule');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runNow(s: ScheduleItem) {
    try {
      const r = await fetch(`/api/schedules/${s.id}/run`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Could not start the run');
      setNotice(`"${s.name}" started — watch History for the result.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(s: ScheduleItem) {
    if (!window.confirm(`Delete the schedule "${s.name}"? Past runs stay in History.`)) return;
    try {
      const r = await fetch(`/api/schedules/${s.id}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Could not delete schedule');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function checkNow() {
    try {
      const r = await fetch('/api/schedules/tick', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Tick failed');
      setNotice(
        j.started.length
          ? `Scheduler check: started ${j.started.length} due run(s).`
          : 'Scheduler check: nothing due right now.',
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const canSave =
    name.trim().length > 0 && sourceConnectorId && targetConnectorId && selectedTables.size > 0 && !cronError;

  return (
    <div>
      <PageHeader
        title="Schedules"
        subtitle="Recurring migrations — the same engine as a manual run, on a cron schedule. Runs happen while this app's server is running; a run that comes due while the server is off fires once when it starts again."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={checkNow}>
              <RefreshCw className="h-4 w-4" /> Check now
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> New schedule
            </Button>
          </div>
        }
      />

      {error && <div className="mb-4"><Alert tone="red">{error}</Alert></div>}
      {notice && (
        <div className="mb-4">
          <Alert tone="green">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> {notice}
              <button onClick={() => setNotice(null)} className="ml-auto text-emerald-800 underline">Dismiss</button>
            </span>
          </Alert>
        </div>
      )}

      {showForm && (
        <Card className="mb-6">
          <CardHeader
            title={editingId ? `Edit schedule — ${name || 'Untitled'}` : 'New schedule'}
            subtitle="Pick the saved connectors, the tables and views, and when it runs. Times are the server's local time."
          />
          <div className="space-y-5 px-5 pb-5">
            <Field label="Name">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly CallLog sync" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Source connector">
                <select
                  className={inputCls}
                  value={sourceConnectorId}
                  onChange={(e) => {
                    setSourceConnectorId(e.target.value);
                    setSchema(null);
                    setSelectedTables(new Set());
                    setSelectedViews(new Set());
                    if (e.target.value) void discover(e.target.value);
                  }}
                >
                  <option value="">Select a source…</option>
                  {sources.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                  ))}
                </select>
              </Field>
              <Field label="Target connector">
                <select className={inputCls} value={targetConnectorId} onChange={(e) => setTargetConnectorId(e.target.value)}>
                  <option value="">Select a target…</option>
                  {targets.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                  ))}
                </select>
              </Field>
            </div>

            {sourceConnectorId && !schema && (
              <Button variant="secondary" onClick={() => discover(sourceConnectorId)} loading={discovering}>
                Discover tables
              </Button>
            )}
            {schema && (
              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">
                  Tables &amp; views — <strong className="tnum">{selectedTables.size}</strong> tables · <strong className="tnum">{selectedViews.size}</strong> views selected
                </p>
                <SchemaTree
                  schema={schema}
                  selection={{ tables: selectedTables, views: selectedViews }}
                  onToggleTable={(key) => {
                    const next = new Set(selectedTables);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    setSelectedTables(next);
                  }}
                  onToggleView={(key) => {
                    const next = new Set(selectedViews);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    setSelectedViews(next);
                  }}
                  onToggleAll={(selectAll) => {
                    setSelectedTables(selectAll ? new Set(schema.tables.map((t) => `${t.schema}.${t.name}`)) : new Set());
                    setSelectedViews(selectAll ? new Set(schema.views.map((v) => `${v.schema}.${v.name}`)) : new Set());
                  }}
                />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
              <label className="flex cursor-pointer items-center gap-2 font-medium text-slate-700">
                <input type="checkbox" checked={includeData} onChange={(e) => setIncludeData(e.target.checked)} className="h-4 w-4 accent-brand-600" />
                Copy data
              </label>
              <label className="flex cursor-pointer items-center gap-2 font-medium text-slate-700">
                <input type="checkbox" checked={useCopy} onChange={(e) => setUseCopy(e.target.checked)} className="h-4 w-4 accent-brand-600" />
                Fast COPY bulk load for large tables
              </label>
              <label className="flex cursor-pointer items-center gap-2 font-medium text-slate-700" title="Drops the target tables before every run — only for full refreshes.">
                <input type="checkbox" checked={dropExisting} onChange={(e) => setDropExisting(e.target.checked)} className="h-4 w-4 accent-brand-600" />
                Drop existing target tables first
              </label>
              {hasuraAvailable && (
                <label className="flex cursor-pointer items-center gap-2 font-medium text-slate-700" title="After each run, track the created tables and views in Hasura so they appear in the GraphQL API.">
                  <input type="checkbox" checked={trackInHasura} onChange={(e) => setTrackInHasura(e.target.checked)} className="h-4 w-4 accent-brand-600" />
                  Track tables in Hasura after each run
                </label>
              )}
            </div>
            {dropExisting && (
              <Alert tone="amber">
                Drop existing runs on every scheduled run. Only use it for full-refresh schedules — a recurring drop + copy is not an incremental sync.
              </Alert>
            )}

            <div>
              <Field label="When it runs">
                <div className="mb-2 flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <button
                      key={p.cron}
                      type="button"
                      onClick={() => setCron(p.cron)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                        cron === p.cron
                          ? 'border-brand-600 bg-brand-50 text-brand-700'
                          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <input
                  className={`${inputCls} font-mono`}
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 2 * * *"
                  aria-label="Cron expression: minute hour day-of-month month day-of-week"
                />
                <p className="mt-1.5 text-xs text-slate-500">
                  Cron: minute hour day-of-month month day-of-week — e.g. <code className="font-mono">0 2 * * *</code> is daily at 02:00, <code className="font-mono">30 9 * * 1-5</code> is weekdays at 09:30.
                </p>
              </Field>
              {cronError ? (
                <div className="mt-2"><Alert tone="red">{cronError}</Alert></div>
              ) : (
                <p className="mt-2 flex items-center gap-1.5 text-sm text-slate-600">
                  <Clock className="h-4 w-4 text-brand-600" />
                  {describeCron(cron)}
                  {upcoming.length > 0 && (
                    <span className="text-slate-500">
                      — next: {upcoming.map((d) => d.toLocaleString()).join(' · ')}
                    </span>
                  )}
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button onClick={save} loading={saving} disabled={!canSave}>
                {editingId ? 'Save schedule' : 'Create schedule'}
              </Button>
              <Button variant="secondary" onClick={() => { setShowForm(false); resetForm(); }}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="space-y-3">
          <div className="skeleton h-24" />
          <div className="skeleton h-24" />
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-8 w-8" />}
          title="No schedules yet"
          body="Create one to run a migration on a cron schedule — nightly syncs, weekly refreshes, or hourly loads for large tables."
          action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New schedule</Button>}
        />
      ) : (
        <div className="space-y-3">
          {schedules.map((s, idx) => (
            <Card key={s.id} className="animate-fade-up">
              <div style={{ '--fade-delay': `${Math.min(idx, 8) * 40}ms` } as React.CSSProperties}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-slate-900">
                      {s.name}
                      {!s.enabled && <Badge tone="slate" className="ml-2 align-middle">Paused</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {s.sourceName ?? 'Unknown source'} → {s.targetName ?? 'Unknown target'}
                      {' · '}{s.tables.length} tables{s.views.length ? ` · ${s.views.length} views` : ''}
                      {' · '}{describeCron(s.cron)} <span className="font-mono text-slate-400">({s.cron})</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      Next run: <strong className="font-semibold text-slate-700">{fmtDate(s.nextRunAt)}</strong>
                      {' · '}Last run: <strong className="font-semibold text-slate-700">{fmtDate(s.lastRunAt)}</strong>
                      {s.lastStatus && (
                        <>
                          {' · '}
                          {s.lastStatus === 'completed' ? (
                            <Badge tone="green"><CheckCircle2 className="h-3.5 w-3.5" /> Completed</Badge>
                          ) : (
                            <Badge tone="red"><XCircle className="h-3.5 w-3.5" /> Failed</Badge>
                          )}
                        </>
                      )}
                    </span>
                  </span>
                  <div className="flex items-center gap-2">
                    <Toggle checked={s.enabled} onChange={() => toggleEnabled(s)} label={s.enabled ? 'On' : 'Off'} />
                    <Button variant="secondary" size="sm" onClick={() => runNow(s)}>
                      <Play className="h-4 w-4" /> Run now
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => openEdit(s)}>
                      <Pencil className="h-4 w-4" /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(s)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
