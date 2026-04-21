/**
 * PostgreSQL connection pool for logging infrastructure.
 * Uses a singleton pattern — safe to import from multiple modules.
 *
 * Render requires SSL with rejectUnauthorized: false for both
 * the external (dev) and internal (production) DATABASE_URL.
 */

import pg from 'pg';

const { Pool } = pg;

let pool = null;

function createPool() {
  if (!process.env.DATABASE_URL) {
    console.error('[logging/db] DATABASE_URL is not set — DB logging will be disabled.');
    return null;
  }

  const instance = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false, // Required for Render PostgreSQL
    },
    // Keep the pool small; logging traffic is low-priority background work.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  instance.on('error', (err) => {
    // Log the error but never crash the process — logging is non-critical.
    console.error('[logging/db] Unexpected pool error:', err.message);
  });

  return instance;
}

// Singleton: reuse across hot-reloads in Next.js dev mode via globalThis.
const GLOBAL_KEY = '__loggingDbPool';

if (!globalThis[GLOBAL_KEY]) {
  globalThis[GLOBAL_KEY] = createPool();
}

pool = globalThis[GLOBAL_KEY];

// Auto-cleanup: delete log rows older than RETENTION_DAYS every 24h.
// globalThis guard prevents duplicate timers on Next.js HMR reloads.
const CLEANUP_KEY = '__loggingCleanupTimer';
const RETENTION_DAYS = 60;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runCleanup() {
  if (!pool) return;
  try {
    const result = await pool.query(
      `DELETE FROM logs WHERE created_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );
    console.log(`[logging/db] Cleanup: deleted ${result.rowCount ?? 0} rows older than ${RETENTION_DAYS} days.`);
  } catch (err) {
    console.error('[logging/db] Cleanup failed:', err.message);
  }
}

if (!globalThis[CLEANUP_KEY] && process.env.NODE_ENV !== 'test' && !process.env.DISABLE_LOG_CLEANUP) {
  // Delay first run 60s to let the app stabilize after startup.
  const initialTimer = setTimeout(async () => {
    await runCleanup();
    const interval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
    interval.unref();
    globalThis[CLEANUP_KEY] = interval;
  }, 60_000);
  initialTimer.unref();
  globalThis[CLEANUP_KEY] = initialTimer;
}

export { pool };
export default pool;
