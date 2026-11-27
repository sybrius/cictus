import { NextResponse } from 'next/server';
import { getSessionUser } from './auth';

/** Guard for API routes: returns a 401 response when the request
 *  has no valid session, or null when it may proceed. Every API
 *  route except /api/auth/* calls this first — the middleware only
 *  checks that a session cookie exists, so the real check lives
 *  here (and in the (app) layout for pages), using the Node libsql
 *  client, which works against both Turso and local file URLs. */
export async function requireAuth(): Promise<NextResponse | null> {
  const user = await getSessionUser();
  if (user) return null;
  return NextResponse.json({ ok: false, error: 'Unauthorized — sign in first.' }, { status: 401 });
}
