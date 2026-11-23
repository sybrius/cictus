import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Cictus — SQL Server & MySQL → Postgres Migrator',
  description:
    'Migrate SQL Server or MySQL tables, schema, data and views to NHost, Supabase or any PostgreSQL database, with connectors and a local DuckDB migration history.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="min-w-0 flex-1">
            <Topbar />
            <main className="mx-auto w-full max-w-7xl px-6 py-7 lg:px-8">{children}</main>
            <footer className="mx-auto w-full max-w-7xl px-6 pb-6 lg:px-8">
              <p className="border-t border-slate-200/70 pt-4 text-xs text-slate-400">
                Cictus runs entirely on this machine. Connectors are stored in{' '}
                <span className="font-mono">data/connectors.json</span> and run history in{' '}
                <span className="font-mono">data/migrations.duckdb</span> — neither is committed to git.
              </p>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
