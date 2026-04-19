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

export { pool };
export default pool;
