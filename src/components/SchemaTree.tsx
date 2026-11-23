'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Eye, Search, Table2 } from 'lucide-react';
import type { DatabaseSchema } from '@/lib/sqlserver';
import { Badge } from '@/components/ui';

export interface Selection {
  tables: Set<string>; // "schema.table"
  views: Set<string>;
}

export function SchemaTree({
  schema,
  selection,
  onToggleTable,
  onToggleView,
  onToggleAll,
}: {
  schema: DatabaseSchema;
  selection: Selection;
  onToggleTable: (key: string) => void;
  onToggleView: (key: string) => void;
  onToggleAll: (selectAll: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const tables = useMemo(
    () => (q ? schema.tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(q)) : schema.tables),
    [schema.tables, q],
  );
  const views = useMemo(
    () => (q ? schema.views.filter((v) => `${v.schema}.${v.name}`.toLowerCase().includes(q)) : schema.views),
    [schema.views, q],
  );
  const allSelected = schema.tables.length > 0 && schema.tables.every((t) => selection.tables.has(`${t.schema}.${t.name}`));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tables & views…"
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm shadow-sm transition-colors placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
          />
        </div>
        <button
          onClick={() => onToggleAll(true)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          Select all
        </button>
        <button
          onClick={() => onToggleAll(false)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          Clear all
        </button>
        <span className="ml-auto text-sm text-slate-500">
          <strong className="tnum font-semibold text-slate-900">{selection.tables.size}</strong> tables,{' '}
          <strong className="tnum font-semibold text-slate-900">{selection.views.size}</strong> views selected
        </span>
      </div>
      <div className="max-h-96 overflow-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Object</th>
              <th className="px-4 py-2.5 font-semibold">Type</th>
              <th className="px-4 py-2.5 text-right font-semibold">Rows</th>
              <th className="px-4 py-2.5 text-right font-semibold">Columns</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => {
              const key = `${t.schema}.${t.name}`;
              return (
                <tr key={key} className="border-t border-slate-100 transition-colors hover:bg-brand-50/40">
                  <td className="px-4 py-2.5">
                    <label className="flex cursor-pointer items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={selection.tables.has(key)}
                        onChange={() => onToggleTable(key)}
                        className="h-4 w-4 shrink-0 accent-brand-600"
                      />
                      <Table2 className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="font-mono text-[13px]">{key}</span>
                      {t.primaryKey.length === 0 && (
                        <Badge tone="amber">
                          <AlertTriangle className="h-3 w-3" /> no PK
                        </Badge>
                      )}
                    </label>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">Table</td>
                  <td className="tnum px-4 py-2.5 text-right">{t.rowCount.toLocaleString()}</td>
                  <td className="tnum px-4 py-2.5 text-right">{t.columns.length}</td>
                </tr>
              );
            })}
            {views.map((v) => {
              const key = `${v.schema}.${v.name}`;
              return (
                <tr key={`view:${key}`} className="border-t border-slate-100 transition-colors hover:bg-brand-50/40">
                  <td className="px-4 py-2.5">
                    <label className="flex cursor-pointer items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={selection.views.has(key)}
                        onChange={() => onToggleView(key)}
                        className="h-4 w-4 shrink-0 accent-brand-600"
                      />
                      <Eye className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="font-mono text-[13px]">{key}</span>
                    </label>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">View</td>
                  <td className="px-4 py-2.5 text-right text-slate-400">—</td>
                  <td className="px-4 py-2.5 text-right text-slate-400">—</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {tables.length === 0 && views.length === 0 && (
          <p className="p-5 text-sm text-slate-500">
            {q ? `No tables or views match “${query}”.` : 'No tables or views found in this database.'}
          </p>
        )}
      </div>
      <p className="mt-2.5 flex items-start gap-1.5 text-xs leading-relaxed text-slate-500">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        Tables without a primary key are flagged — Hasura requires a PK (or a unique constraint) to track a table.
        Consider adding one in Postgres after migration.
      </p>
      <span className="hidden">{allSelected}</span>
    </div>
  );
}
