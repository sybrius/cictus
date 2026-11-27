import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { getSessionUser } from '@/lib/auth';

/** The signed-in app shell: sidebar + topbar + page content.
 *  The session is verified here (Node runtime, Turso lookup) — the
 *  middleware only checks that a cookie exists, so this is the real
 *  gate for pages. Unauthenticated visits go to /login. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <Topbar />
        <main className="mx-auto w-full max-w-7xl px-6 py-7 lg:px-8">{children}</main>
        <footer className="mx-auto w-full max-w-7xl px-6 pb-6 lg:px-8">
          <p className="border-t border-slate-200/70 pt-4 text-xs text-slate-400">
            Cictus runs entirely on this machine. Connectors are stored in{' '}
            <span className="font-mono">data/connectors.json</span> and run history in your Turso database — neither
            is committed to git.
          </p>
        </footer>
      </div>
    </div>
  );
}
