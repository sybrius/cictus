'use client';

import type { DatabaseSchema } from '@/lib/sqlserver';
import { mapSqlServerType } from '@/lib/type-map';

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
}: {
  schema: DatabaseSchema;
  selection: { tables: Set<string> };
  overrides: Record<string, string>;
  onOverride: (key: string, pgType: string) => void;
}) {
  const tables = schema.tables.filter((t) => selection.tables.has(`${t.schema}.${t.name}`));
  return (
    <div className="max-h-[28rem] overflow-auto rounded border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-slate-100 text-left">
          <tr>
            <th className="px-3 py-2">Column</th><th className="px-3 py-2">SQL Server</th>
            <th className="px-3 py-2">Postgres</th><th className="px-3 py-2">Warning</th>
          </tr>
        </thead>
        <tbody>
          {tables.flatMap((t) =>
            t.columns.map((c) => {
              const key = `${c.schema}.${c.table}.${c.name}`;
              const mapped = mapSqlServerType({
                dataType: c.dataType,
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
                <tr key={key} className="border-t align-top hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono">{c.schema}.{c.table}.{c.name}{c.isIdentity ? ' 🔑' : ''}{!c.isNullable ? ' *' : ''}</td>
                  <td className="px-3 py-2 font-mono text-slate-600">{sqlLabel}</td>
                  <td className="px-3 py-2">
                    <input
                      list="pg-types"
                      className="w-44 rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                      value={value}
                      onChange={(e) => onOverride(key, e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-amber-700">{mapped.warning ?? ''}</td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
      <datalist id="pg-types">
        {PG_TYPES.map((t) => <option key={t} value={t} />)}
      </datalist>
      {tables.length === 0 && <p className="p-4 text-sm text-slate-500">No tables selected.</p>}
    </div>
  );
}
