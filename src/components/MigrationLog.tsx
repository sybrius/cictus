'use client';

import { useEffect, useRef } from 'react';

export interface LogLine {
  time: string;
  level: 'info' | 'success' | 'error';
  message: string;
}

export function MigrationLog({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);
  const color = (l: LogLine) =>
    l.level === 'error' ? 'text-red-400' : l.level === 'success' ? 'text-green-400' : 'text-slate-300';
  return (
    <div ref={ref} className="h-64 overflow-auto rounded bg-slate-900 p-3 font-mono text-xs leading-5">
      {lines.length === 0 && <p className="text-slate-500">Migration log will appear here…</p>}
      {lines.map((l, i) => (
        <p key={i} className={color(l)}>
          <span className="text-slate-500">{l.time} </span>{l.message}
        </p>
      ))}
    </div>
  );
}
