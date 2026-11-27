'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRightLeft, ChevronRight, Plus } from 'lucide-react';

const TITLES: Record<string, { title: string; crumb: string }> = {
  '/': { title: 'Dashboard', crumb: 'Overview' },
  '/migrate': { title: 'New migration', crumb: 'Migrate' },
  '/history': { title: 'Run history', crumb: 'Migrate' },
  '/connectors': { title: 'Connectors', crumb: 'Connections' },
  '/schedules': { title: 'Schedules', crumb: 'Migrate' },
};

export function Topbar() {
  const pathname = usePathname();
  const current = TITLES[pathname] ?? { title: 'Cictus', crumb: 'Workspace' };
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md">
      <div className="flex h-16 items-center justify-between gap-4 px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="hidden font-medium text-slate-400 sm:inline">Cictus</span>
          <ChevronRight className="hidden h-4 w-4 text-slate-300 sm:inline" />
          <span className="hidden text-slate-500 md:inline">{current.crumb}</span>
          <ChevronRight className="hidden h-4 w-4 text-slate-300 md:inline" />
          <span className="truncate font-semibold text-slate-900">{current.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 sm:inline-flex">
            <span className="h-1.5 w-1.5 animate-pulse_soft rounded-full bg-emerald-500" />
            Turso history
          </span>
          {pathname !== '/migrate' && (
            <Link
              href="/migrate"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-brand-700 active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" />
              New migration
            </Link>
          )}
          {pathname === '/migrate' && (
            <span className="hidden items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 md:inline-flex">
              <ArrowRightLeft className="h-4 w-4" />
              SQL Server / MySQL → Postgres
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
