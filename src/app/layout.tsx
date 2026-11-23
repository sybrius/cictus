import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';

export const metadata: Metadata = {
  title: 'Cictus — SQL Server → Postgres Migrator',
  description:
    'Migrate SQL Server tables, schema, data and views to NHost, Supabase or any PostgreSQL database, with connectors and a local DuckDB migration history.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="min-w-0 flex-1">
            <header className="border-b border-slate-200 bg-white px-6 py-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-700">Migration workspace</div>
                <div className="text-xs text-slate-500">
                  Source: SQL Server · Targets: NHost / Supabase / PostgreSQL
                </div>
              </div>
            </header>
            <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
