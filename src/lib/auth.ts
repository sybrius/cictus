import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { withTurso, tursoUnavailableReason } from './turso';

/**
 * Simple email + password accounts, stored in Turso.
 *
 * This is deliberately small: it is a local tool's front door, not a
 * production identity system. Passwords are hashed with bcrypt
 * (never stored or logged in plain text). A login creates a random
 * session token; only the SHA-256 hash of the token is stored in the
 * `sessions` table, and the token itself lives in an httpOnly cookie
 * (`cictus_session`), so client-side JavaScript can never read it.
 * Sessions last 7 days.
 *
 * What this is NOT: there is no email verification, no password
 * reset, no rate limiting and no roles — anyone who can reach the
 * app can sign up. Run it on localhost (or behind your own auth)
 * and treat the first account as the owner. Accounts need Turso:
 * without `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` nobody can sign
 * in, and the login page says so.
 *
 * Session validation for pages and API routes happens in the (app)
 * layout (pages) and in `requireAuth()` (src/lib/api-auth.ts, API
 * routes), using this module's Node-runtime Turso lookup.
 * `getSessionUser()` here is what both of them call.
 */

export const SESSION_COOKIE = 'cictus_session';
export const SESSION_DAYS = 7;

export interface SessionUser {
  id: string;
  email: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sessionExpiry(): string {
  return new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Create a session for `userId` and set the cookie. Throws when
 *  Turso is unavailable — the caller turns that into a plain
 *  "auth database not configured" error. */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const ok = await withTurso(async (client) => {
    await client.execute({
      sql: `INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      args: [hashToken(token), userId, sessionExpiry(), new Date().toISOString()],
    });
    return true;
  });
  if (!ok) {
    throw new Error(tursoUnavailableReason() ?? 'The account database (Turso) is unavailable.');
  }
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

/** The signed-in user for this request, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await withTurso(async (client) => {
    const result = await client.execute({
      sql: `SELECT s.user_id AS user_id, u.email AS email
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
      args: [hashToken(token), new Date().toISOString()],
    });
    return (result.rows[0] as unknown as { user_id: string; email: string } | undefined) ?? null;
  });
  if (!row) return null;
  return { id: row.user_id, email: row.email };
}

/** Delete the current session (if any) and clear the cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await withTurso(async (client) => {
      await client.execute({
        sql: `DELETE FROM sessions WHERE token_hash = ?`,
        args: [hashToken(token)],
      });
    });
  }
  store.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

/** Register a new account. Throws `EMAIL_EXISTS` when the email is
 *  already registered, or a Turso-unavailable error. */
export async function createUser(email: string, password: string): Promise<SessionUser> {
  const clean = normaliseEmail(email);
  const passwordHash = await hashPassword(password);
  const user = await withTurso(async (client) => {
    const existing = await client.execute({
      sql: `SELECT id FROM users WHERE email = ?`,
      args: [clean],
    });
    if (existing.rows.length > 0) {
      const err = new Error('An account with this email already exists.');
      err.name = 'EMAIL_EXISTS';
      throw err;
    }
    const id = randomUUID();
    await client.execute({
      sql: `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
      args: [id, clean, passwordHash, new Date().toISOString()],
    });
    return { id, email: clean };
  });
  if (!user) {
    throw new Error(tursoUnavailableReason() ?? 'The account database (Turso) is unavailable.');
  }
  return user;
}

/** Check an email + password pair. Returns the user, or null when
 *  the email is unknown or the password is wrong (same result either
 *  way, so the response never reveals which one failed). */
export async function authenticateUser(email: string, password: string): Promise<SessionUser | null> {
  const clean = normaliseEmail(email);
  const row = await withTurso(async (client) => {
    const result = await client.execute({
      sql: `SELECT id, email, password_hash FROM users WHERE email = ?`,
      args: [clean],
    });
    return (result.rows[0] as unknown as { id: string; email: string; password_hash: string } | undefined) ?? null;
  });
  if (!row) return null;
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  return { id: row.id, email: row.email };
}
