'use client';

import { AlertTriangle, KeyRound } from 'lucide-react';
import type { DatabaseSchema } from '@/lib/sqlserver';
import { mapSourceType } from '@/lib/type-map';

const PG_TYPES = [
  'smallint', 'integer', 'bigint', 'boolean', 'numeric(18,2)', 'numeric(19,4)',
  'double precision', 'real', 'date', 'time', 'timestamp', 'timestamptz',
  'char(1)', 'varchar(255)', 'text', 'bytea', 'uuid', 'xml', 'geography', 'geometry', 'jsonb',
];

export function TypeMappingTable({
  schema,
  selection,
  overrides,
  onOverride,
  sourceType = 'sqlserver',
}: {
  schema: DatabaseSchema;
  selection: { tables: Set<string> };
  overrides: Record<string, string>;
  onOverride: (key: string, pgType: string) => void;
  sourceType?: 'sqlserver' | 'mysql';
}) {
  const tables = schema.tables.filter((t) => selection.tables.has(`${t.schema}.${t.name}`));
  return (
    <div className="max-h-[28rem] overflow-auto rounded-xl border border-slate-200">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-semibold">Column</th>
            <th className="px-4 py-2.5 font-semibold">{sourceType === 'mysql' ? 'MySQL' : 'SQL Server'}</th>
            <th className="px-4 py-2.5 font-semibold">Postgres</th>
            <th className="px-4 py-2.5 font-semibold">Warning</th>
          </tr>
        </thead>
        <tbody>
          {tables.flatMap((t) =>
            t.columns.map((c) => {
              const key = `${c.schema}.${c.table}.${c.name}`;
              const mapped = mapSourceType(sourceType, {
                dataType: c.dataType,
                sourceExtra: c.sourceExtra,
                maxLength: c.maxLength,
                numericPrecision: c.numericPrecision,
                numericScale: c.numericScale,
                datetimePrecision: c.datetimePrecision,
              });
              const value = overrides[key] ?? mapped.pgType;
              const sqlLabel =
                `${c.dataType}` +
                (c.maxLength != null ? (c.maxLength === -1 ? '(max)' : `(${c.maxLength})`) : '') +
                (c.numericPrecision != null ? `(${c.numericPrecision},${c.numericScale ?? 0})` : '');
              return (
                <tr key={key} className="border-t border-slate-100 align-top transition-colors hover:bg-brand-50/40">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5 font-mono text-[13px]">
                      {c.schema}.{c.table}.{c.name}
                      {c.isIdentity && <KeyRound className="h-3.5 w-3.5 shrink-0 text-brand-500" />}
                      {!c.isNullable && <span className="text-red-500" title="NOT NULL">*</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[13px] text-slate-500">{sqlLabel}</td>
                  <td className="px-4 py-2.5">
                    <input
                      list="pg-types"
                      className="w-44 rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
                      value={value}
                      onChange={(e) => onOverride(key, e.target.value)}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-xs leading-relaxed text-amber-700">
                    {mapped.warning ? (
                      <span className="flex items-start gap-1.5">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                        {mapped.warning}
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
      <datalist id="pg-types">
        {PG_TYPES.map((t) => <option key={t} value={t} />)}
      </datalist>
      {tables.length === 0 && <p className="p-5 text-sm text-slate-500">No tables selected.</p>}
    </div>
  );
}
