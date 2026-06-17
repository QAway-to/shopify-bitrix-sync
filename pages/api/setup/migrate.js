/**
 * GET /api/setup/migrate
 *
 * One-time migration endpoint: creates the `logs` table and its indexes
 * if they don't already exist.
 *
 * Safe to call multiple times — all statements use IF NOT EXISTS.
 */

import { pool } from '../../../src/lib/logging/db.js';
import { requireAuth } from '../../../src/lib/auth/session.js';

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
    level       TEXT        NOT NULL,
    event_type  TEXT,
    entity_type TEXT,
    entity_id   TEXT,
    message     TEXT        NOT NULL,
    metadata    JSONB,
    request_id  TEXT,
    source      TEXT,
    duration_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS logs_created_at_idx  ON logs (created_at DESC);
  CREATE INDEX IF NOT EXISTS logs_event_type_idx  ON logs (event_type);
  CREATE INDEX IF NOT EXISTS logs_entity_id_idx   ON logs (entity_id);
  CREATE INDEX IF NOT EXISTS logs_level_idx       ON logs (level);
  CREATE INDEX IF NOT EXISTS logs_request_id_idx  ON logs (request_id);
`;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAuth(req, res)) return;

  if (!pool) {
    return res.status(503).json({
      success: false,
      error: 'Database pool is not available. Check DATABASE_URL.',
    });
  }

  try {
    await pool.query(MIGRATION_SQL);

    // Verify the table now exists and grab a quick row count.
    const infoResult = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM logs) AS row_count,
        pg_size_pretty(pg_total_relation_size('logs')) AS table_size
    `);

    const { row_count, table_size } = infoResult.rows[0];

    return res.status(200).json({
      success: true,
      message: 'Migration complete — logs table and indexes are ready.',
      table: {
        name: 'logs',
        row_count,
        table_size,
      },
    });
  } catch (err) {
    console.error('[migrate] Migration failed:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
