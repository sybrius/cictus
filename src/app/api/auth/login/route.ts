import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateUser, createSession } from '@/lib/auth';

const LoginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid login details.' },
        { status: 400 },
      );
    }
    const user = await authenticateUser(parsed.data.email, parsed.data.password);
    if (!user) {
      // Same message either way — the response never reveals whether
      // the email or the password was the wrong half.
      return NextResponse.json({ ok: false, error: 'Incorrect email or password.' }, { status: 401 });
    }
    await createSession(user.id);
    return NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Login failed.' },
      { status: 500 },
    );
  }
}
