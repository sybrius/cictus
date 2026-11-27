'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DatabaseZap, UserPlus } from 'lucide-react';
import { Alert, Button, Card, Field, inputCls } from '@/components/ui';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        setError(j?.error ?? 'Sign-up failed. Try again.');
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError('Could not reach the server. Is it still running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="p-6 sm:p-8">
      <div className="flex flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-md shadow-brand-500/25">
          <DatabaseZap className="h-6 w-6" />
        </div>
        <h1 className="mt-4 text-[22px] font-bold tracking-tight text-slate-900">Create your Cictus account</h1>
        <p className="mt-1 text-sm text-slate-500">One account is all it takes — you are signed in right away.</p>
      </div>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {error && <Alert tone="red">{error}</Alert>}
        <Field label="Email">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Choose a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Confirm password">
          <input
            type="password"
            required
            autoComplete="new-password"
            placeholder="Repeat your password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Button type="submit" size="lg" loading={loading} className="w-full">
          <UserPlus className="h-4 w-4" />
          Create account
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
          Sign in
        </Link>
      </p>
      <p className="mt-4 border-t border-slate-100 pt-4 text-center text-xs leading-relaxed text-slate-400">
        Accounts are stored in your Turso database. Anyone who can reach this app can sign up — run it on localhost.
      </p>
    </Card>
  );
}
