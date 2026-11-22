'use client';

import type { DatabaseSchema } from '@/lib/sqlserver';

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
  const allSelected = schema.tables.length > 0 && schema.tables.every((t) => selection.tables.has(`${t.schema}.${t.name}`));
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <button onClick={() => onToggleAll(true)} className="rounded border px-3 py-1 text-sm">Select all</button>
        <button onClick={() => onToggleAll(false)} className="rounded border px-3 py-1 text-sm">Clear all</button>
        <span className="ml-auto text-sm text-slate-600">
          {selection.tables.size} tables, {selection.views.size} views selected
        </span>
      </div>
      <div className="max-h-96 overflow-auto rounded border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-100 text-left">
            <tr><th className="px-3 py-2">Object</th><th className="px-3 py-2">Type</th><th className="px-3 py-2 text-right">Rows</th><th className="px-3 py-2 text-right">Columns</th></tr>
          </thead>
          <tbody>
            {schema.tables.map((t) => {
              const key = `${t.schema}.${t.name}`;
              return (
                <tr key={key} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={selection.tables.has(key)} onChange={() => onToggleTable(key)} />
                      <span className="font-mono">{key}</span>
                      {t.primaryKey.length === 0 && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">no PK</span>}
                    </label>
                  </td>
                  <td className="px-3 py-2 text-slate-600">Table</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.rowCount.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{t.columns.length}</td>
                </tr>
              );
            })}
            {schema.views.map((v) => {
              const key = `${v.schema}.${v.name}`;
              return (
                <tr key={`view:${key}`} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={selection.views.has(key)} onChange={() => onToggleView(key)} />
                      <span className="font-mono">{key}</span>
                    </label>
                  </td>
                  <td className="px-3 py-2 text-slate-600">View</td>
                  <td className="px-3 py-2 text-right text-slate-400">—</td>
                  <td className="px-3 py-2 text-right text-slate-400">—</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {schema.tables.length === 0 && schema.views.length === 0 && (
          <p className="p-4 text-sm text-slate-500">No tables or views found in this database.</p>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Tables without a primary key are flagged — Hasura requires a PK (or a unique
        constraint) to track a table. Consider adding one in Postgres after migration.
      </p>
    </div>
  );
}
