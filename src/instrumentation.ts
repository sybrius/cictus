/**
 * Runs once when the Next.js server starts (Node runtime only).
 * Starts the background scheduler for recurring migrations
 * (src/lib/scheduler.ts). Not run during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    try {
      const { ensureSchedulerStarted } = await import('./lib/scheduler');
      ensureSchedulerStarted();
    } catch (e) {
      // A scheduler failure must never stop the server from starting.
      console.warn('[cictus] Background scheduler could not start:', e instanceof Error ? e.message : String(e));
    }
  }
}
