'use client';

import { useEffect, useRef } from 'react';
import { AlertCircle, CheckCircle2, Info, TerminalSquare } from 'lucide-react';

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
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-card">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
        <span className="ml-2 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <TerminalSquare className="h-3.5 w-3.5" />
          Migration log
        </span>
        <span className="ml-auto text-[11px] text-slate-500">{lines.length} lines</span>
      </div>
      <div ref={ref} className="h-64 overflow-auto p-3 font-mono text-xs leading-5">
        {lines.length === 0 && <p className="text-slate-500">Migration log will appear here…</p>}
        {lines.map((l, i) => (
          <p key={i} className="flex items-start gap-2">
            {l.level === 'error' ? (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
            ) : l.level === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            ) : (
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
            )}
            <span>
              <span className="text-slate-500">{l.time} </span>
              <span className={l.level === 'error' ? 'text-red-300' : l.level === 'success' ? 'text-emerald-300' : 'text-slate-300'}>
                {l.message}
              </span>
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}
