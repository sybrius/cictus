'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Dashboard', icon: '▦' },
  { href: '/migrate', label: 'New migration', icon: '→' },
  { href: '/connectors', label: 'Connectors', icon: '🔌' },
  { href: '/history', label: 'History', icon: '◷' },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-900 text-slate-200">
      <div className="px-5 pb-4 pt-6">
        <div className="text-lg font-bold text-white">Cictus</div>
        <div className="mt-0.5 text-xs text-slate-400">SQL Server &amp; MySQL → Postgres Migrator</div>
        <div className="mt-3 inline-block rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-emerald-300">● Local · Enterprise</div>
      </div>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((item) => {
          const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${active ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'}`}
            >
              <span className="w-5 text-center">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-4 text-[11px] leading-relaxed text-slate-500">
        Targets: NHost · Supabase · PostgreSQL
        <br />
        History is stored locally in DuckDB (<span className="font-mono">data/migrations.duckdb</span>). Connectors are stored locally in <span className="font-mono">data/connectors.json</span> — never committed.
      </div>
    </aside>
  );
}
