'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BrandIcon } from '@/components/BrandIcons';
import { Badge, Button, inputCls } from '@/components/ui';
import type { ConnectorType } from '@/lib/connectors';

export type ConnectionMode = 'existing' | 'new';

/** What the connector list needs. /api/connectors already returns
 *  all of these (publicConnector strips only the password and the
 *  Hasura admin secret). */
export interface PickerConnector {
  id: string;
  name: string;
  type: ConnectorType;
  kind: string;
  host: string;
  database: string;
  projectRef: string;
  region: string;
  service?: string;
  filePath?: string;
  hasuraEndpoint?: string;
  hasHasuraSecret?: boolean;
  lastTestOk: boolean | null;
}

const SOURCE_LABELS: Record<string, string> = {
  sqlserver: 'SQL Server',
  mysql: 'MySQL',
  'postgres-source': 'PostgreSQL',
  oracle: 'Oracle',
  sqlite: 'SQLite',
};

const TARGET_LABELS: Record<string, string> = {
  nhost: 'NHost',
  supabase: 'Supabase',
  postgres: 'PostgreSQL',
};

/** One-line detail for a connector card: type plus where it points. */
export function connectorDetail(c: PickerConnector, kind: 'source' | 'target'): string {
  if (kind === 'source') {
    const label = SOURCE_LABELS[c.type] ?? c.type;
    if (c.type === 'sqlite') return `${label} · ${c.filePath || 'local file'}`;
    if (c.type === 'postgres-source') return `${label} · ${c.host ? `${c.host}/${c.database || 'postgres'}` : 'connection string'}`;
    if (c.type === 'oracle') return `${label} · ${c.host}${c.service ? `/${c.service}` : ''}`;
    return `${label} · ${c.host}${c.database ? `/${c.database}` : ''}`;
  }
  const label = TARGET_LABELS[c.type] ?? c.type;
  if (c.type === 'nhost') return `${label} · ${c.projectRef || c.host}`;
  if (c.type === 'supabase') return `${label} · ${c.projectRef || c.host}`;
  return `${label} · ${c.host}${c.database ? `/${c.database}` : ''}`;
}

export function ConnectionTabs({
  mode,
  onModeChange,
  existingLabel,
  newLabel,
}: {
  mode: ConnectionMode;
  onModeChange: (m: ConnectionMode) => void;
  existingLabel: string;
  newLabel: string;
}) {
  return (
    <div className="inline-flex rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Connection choice">
      {(
        [
          { value: 'existing' as const, label: existingLabel },
          { value: 'new' as const, label: newLabel },
        ] as const
      ).map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={mode === t.value}
          onClick={() => onModeChange(t.value)}
          className={`rounded-lg px-4 py-2 text-sm font-semibold transition-all ${
            mode === t.value
              ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Selectable list of saved connectors. When the list is empty it
 *  says so plainly and points at the New tab above and the
 *  Connectors page — the "no saved connector yet" case is the
 *  normal first-run state, not an error. */
export function ConnectorList({
  kind,
  connectors,
  selectedId,
  onSelect,
}: {
  kind: 'source' | 'target';
  connectors: PickerConnector[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (connectors.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm leading-relaxed text-slate-600">
        <p className="font-semibold text-slate-800">No saved {kind === 'source' ? 'sources' : 'destinations'} yet.</p>
        <p className="mt-1">
          <Link href="/connectors" className="font-medium text-brand-600 hover:text-brand-700">
            Add one in Connectors
          </Link>{' '}
          — its password stays in your Turso database and is never shown in the browser — or use the{' '}
          <strong>New {kind === 'source' ? 'source' : 'destination'}</strong> tab above to enter a connection
          manually.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2" role="radiogroup" aria-label={`Saved ${kind} connectors`}>
      {connectors.map((c) => {
        const selected = c.id === selectedId;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(c.id)}
            className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all duration-150 ${
              selected
                ? 'border-brand-500 bg-brand-50/60 shadow-sm'
                : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
            }`}
          >
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                selected ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'
              }`}
            >
              <BrandIcon type={c.type} className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-sm font-semibold ${selected ? 'text-brand-800' : 'text-slate-800'}`}>
                {c.name}
              </span>
              <span className="block truncate text-xs text-slate-500">{connectorDetail(c, kind)}</span>
            </span>
            {c.lastTestOk === true && (
              <Badge tone="green" className="shrink-0">
                Last test passed
              </Badge>
            )}
            {c.lastTestOk === false && (
              <Badge tone="red" className="shrink-0">
                Last test failed
              </Badge>
            )}
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                selected ? 'border-brand-600 bg-brand-600' : 'border-slate-300 bg-white'
              }`}
            >
              {selected && <span className="h-2 w-2 rounded-full bg-white" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** After a manual connection tests OK, offer to save it as a
 *  connector so it appears under Existing next time. The parent
 *  builds the connector payload from the tested form values and
 *  supplies it via onSave; an optional type picker covers the
 *  target case, where the manual form is only a connection string
 *  and the type (NHost / Supabase / PostgreSQL) is not known from
 *  the form itself. */
export function SaveConnectorBox({
  defaultName,
  onSave,
  typePicker,
}: {
  defaultName: string;
  onSave: (name: string, type?: string) => Promise<void>;
  typePicker?: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (v: string) => void;
  };
}) {
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (saved) {
    return (
      <p className="flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
        Saved as “{name}” — it now appears under Existing.
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-ink-50 px-4 py-3">
      <p className="text-sm font-semibold text-slate-800">Save this connection for next time?</p>
      <p className="text-xs leading-relaxed text-slate-500">
        It becomes a saved connector, so you can pick it from Existing instead of re-typing it. The password is
        stored in your Turso database, visible only to your account.
      </p>
      {typePicker && (
        <div className="flex flex-wrap gap-2">
          {typePicker.options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => typePicker.onChange(o.value)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                typePicker.value === o.value
                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Connector name"
          aria-label="Connector name"
          style={{ maxWidth: 320 }}
        />
        <Button
          disabled={saving || !name.trim()}
          loading={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await onSave(name.trim(), typePicker?.value);
              setSaved(true);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Saving…' : 'Save connector'}
        </Button>
      </div>
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
