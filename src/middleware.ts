import { NextResponse, type NextRequest } from 'next/server';

/**
 * The app's front door, part one: every page and API route requires
 * a session, except the auth pages and auth API routes themselves.
 *
 * This middleware only checks that a session cookie exists — it is
 * fast and needs no database. The real check happens where the
 * Node libsql client is available: the (app) layout verifies the
 * session for pages, and `requireAuth()` (src/lib/api-auth.ts)
 * verifies it for API routes. A forged or expired cookie passes
 * this middleware and is bounced there. (An earlier version did the
 * full check here with the edge-compatible libsql web client, but
 * that client cannot be verified against every database URL shape —
 * a lockout bug here would lock everyone out — so validation lives
 * in Node code only.)
 *
 * Unauthenticated page visits are redirected to /login;
 * unauthenticated API calls get a 401 JSON instead.
 */

export const config = {
  matcher: ['/((?!api/auth|login|signup|_next/static|_next/image|favicon.ico).*)'],
};

const SESSION_COOKIE = 'cictus_session';

export function middleware(req: NextRequest) {
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  return req.nextUrl.pathname.startsWith('/api/')
    ? NextResponse.json({ ok: false, error: 'Unauthorized — sign in first.' }, { status: 401 })
    : NextResponse.redirect(new URL('/login', req.url));
}
