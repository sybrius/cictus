import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createUser, createSession } from '@/lib/auth';

const SignupSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = SignupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid sign-up details.' },
        { status: 400 },
      );
    }
    const user = await createUser(parsed.data.email, parsed.data.password);
    await createSession(user.id);
    return NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (e) {
    if (e instanceof Error && e.name === 'EMAIL_EXISTS') {
      return NextResponse.json(
        { ok: false, error: 'An account with this email already exists — sign in instead.' },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Sign-up failed.' },
      { status: 500 },
    );
  }
}
