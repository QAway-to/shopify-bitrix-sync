/**
 * GET /api/cron/cleanup-logs
 *
 * Cron endpoint — delete log rows older than 60 days.
 * Intended to be called daily (e.g. via Render Cron Jobs or Vercel Cron).
 *
 * Returns: { success: true, deleted: N }
 */

import { pool } from '../../../src/lib/logging/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!pool) {
    return res.status(503).json({
      success: false,
      error: 'Database pool is not available. Check DATABASE_URL.',
    });
  }

  try {
    const result = await pool.query(
      `DELETE FROM logs WHERE created_at < NOW() - INTERVAL '60 days'`
    );

    const deleted = result.rowCount ?? 0;

    console.log(`[cleanup-logs] Deleted ${deleted} log row(s) older than 60 days.`);

    return res.status(200).json({
      success: true,
      deleted,
      message: `Deleted ${deleted} log row(s) older than 60 days.`,
    });
  } catch (err) {
    console.error('[cleanup-logs] Failed to clean up logs:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
