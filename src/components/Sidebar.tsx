'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowRightLeft,
  ChevronsLeft,
  ChevronsRight,
  DatabaseZap,
  History,
  LayoutDashboard,
  PlugZap,
  Workflow,
} from 'lucide-react';

const SECTIONS = [
  {
    label: 'Overview',
    items: [{ href: '/', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Migrate',
    items: [
      { href: '/migrate', label: 'New migration', icon: ArrowRightLeft },
      { href: '/history', label: 'Run history', icon: History },
    ],
  },
  {
    label: 'Connections',
    items: [{ href: '/connectors', label: 'Connectors', icon: PlugZap }],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem('cictus-sidebar-collapsed') === '1');
    } catch {
      /* storage unavailable — keep expanded */
    }
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem('cictus-sidebar-collapsed', c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  return (
    <aside
      className={`sidebar-shell sticky top-0 flex h-screen shrink-0 flex-col border-r border-slate-200/80 bg-white ${collapsed ? 'w-[76px]' : 'w-64'}`}
    >
      {/* Brand */}
      <div className={`flex items-center gap-3 px-4 pb-5 pt-5 ${collapsed ? 'justify-center px-0' : ''}`}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-md shadow-brand-500/25">
          <DatabaseZap className="h-5 w-5" />
        </div>
        {!collapsed && (
          <div className="sidebar-label min-w-0">
            <div className="truncate text-[17px] font-bold leading-tight tracking-tight text-slate-900">Cictus</div>
            <div className="truncate text-[11px] font-medium text-slate-400">SQL Server &amp; MySQL → Postgres</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {SECTIONS.map((section) => (
          <div key={section.label}>
            {!collapsed && (
              <p className="sidebar-label mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                {section.label}
              </p>
            )}
            <ul className="space-y-1">
              {section.items.map((item) => {
                const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={collapsed ? item.label : undefined}
                      className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                        active
                          ? 'bg-brand-50 text-brand-700 shadow-sm ring-1 ring-inset ring-brand-600/10'
                          : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                      } ${collapsed ? 'justify-center px-0' : ''}`}
                    >
                      {active && !collapsed && (
                        <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-brand-600" />
                      )}
                      <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-brand-600' : 'text-slate-400 group-hover:text-slate-600'}`} />
                      {!collapsed && <span className="sidebar-label">{item.label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Pipeline hint */}
      {!collapsed && (
        <div className="sidebar-label mx-3 mb-3 rounded-xl border border-slate-200/80 bg-ink-50 p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
            <Workflow className="h-4 w-4 text-brand-600" />
            How a run flows
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            Tables → indexes → data in 1,000-row batches → foreign keys → views → validation.
          </p>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-slate-100 px-3 py-3">
        <button
          onClick={toggle}
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 ${collapsed ? 'justify-center px-0' : ''}`}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? <ChevronsRight className="h-[18px] w-[18px]" /> : <ChevronsLeft className="h-[18px] w-[18px]" />}
          {!collapsed && <span className="sidebar-label">Collapse panel</span>}
        </button>
        {!collapsed && (
          <p className="sidebar-label mt-2 px-3 text-[11px] leading-relaxed text-slate-400">
            Local-first · history in DuckDB · connectors never leave this machine
          </p>
        )}
      </div>
    </aside>
  );
}
