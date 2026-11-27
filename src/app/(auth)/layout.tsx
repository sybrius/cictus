import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';

/** The sign-in shell: centred card, no sidebar or topbar.
 *  A signed-in visit goes straight to the dashboard instead. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (user) redirect('/');

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4 py-10">
      <div className="w-full max-w-md animate-fade-up">{children}</div>
    </div>
  );
}
