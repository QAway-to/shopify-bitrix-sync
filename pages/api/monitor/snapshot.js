/**
 * Deal snapshot monitor endpoint.
 *
 * GET /api/monitor/snapshot?dates=1
 *   Returns list of dates that have snapshot data.
 *
 * GET /api/monitor/snapshot?date=YYYY-MM-DD
 *   Returns snapshot diffs for that date.
 *
 * POST /api/monitor/snapshot
 *   Manually triggers today's snapshot job.
 *
 * Auto-triggers yesterday's snapshot at 09:00 MSK on first GET after that hour.
 */

import { pool } from '../../../src/lib/logging/db.js';
import { ensureSnapshotTables, runDealSnapshot } from '../../../src/lib/sync/dealSnapshotCore.js';

const MSK_OFFSET_HOURS = 3;

function getMskHour() {
  const now = new Date();
  return new Date(now.getTime() + MSK_OFFSET_HOURS * 3600_000).getUTCHours();
}

function getMskDateString(offsetDays = 0) {
  const now = new Date();
  const msk = new Date(now.getTime() + MSK_OFFSET_HOURS * 3600_000);
  msk.setUTCDate(msk.getUTCDate() + offsetDays);
  return msk.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!pool) return res.status(503).json({ error: 'Database not available' });

  try {
    await ensureSnapshotTables();

    // Manual trigger
    if (req.method === 'POST') {
      const date = getMskDateString(0);
      const existing = await pool.query(
        `SELECT status FROM deal_snapshot_runs WHERE snapshot_date = $1`, [date]
      );
      if (existing.rows.length > 0 && existing.rows[0].status === 'success') {
        return res.status(200).json({ message: 'Already completed for today', date, skipped: true });
      }
      runDealSnapshot(date).catch(err =>
        console.error('[snapshot] Manual run failed:', err.message)
      );
      return res.status(202).json({ message: 'Snapshot job started', date });
    }

    // Auto-trigger at 09:00 MSK — only if yesterday's snapshot hasn't succeeded yet
    if (getMskHour() >= 9) {
      const yesterday = getMskDateString(-1);
      const ran = await pool.query(
        `SELECT status FROM deal_snapshot_runs WHERE snapshot_date = $1`, [yesterday]
      );
      if (!ran.rows.length || ran.rows[0].status !== 'success') {
        runDealSnapshot(yesterday).catch(err =>
          console.error('[snapshot] Auto-run failed:', err.message)
        );
      }
    }

    // ?dates=1
    if (req.query.dates === '1') {
      const result = await pool.query(
        `SELECT DISTINCT snapshot_date::text AS date
         FROM deal_snapshot_diff
         ORDER BY snapshot_date DESC`
      );
      return res.status(200).json({ dates: result.rows.map(r => r.date) });
    }

    // Last run status
    if (req.query.status === '1') {
      const result = await pool.query(
        `SELECT snapshot_date::text AS date, status, started_at, finished_at, deals_checked, error_message
         FROM deal_snapshot_runs
         ORDER BY snapshot_date DESC
         LIMIT 1`
      );
      return res.status(200).json({ run: result.rows[0] || null });
    }

    // Snapshot data for a date
    const dateParam = req.query.date;
    if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
    }
    const date = dateParam || getMskDateString(-1);

    const result = await pool.query(
      `SELECT deal_id, order_id, bitrix_stage, expected_stage, stage_match,
              total_bitrix, total_shopify, total_match,
              positions_total, positions_matched, positions_diff, has_discrepancy
       FROM deal_snapshot_diff
       WHERE snapshot_date = $1
       ORDER BY has_discrepancy DESC, deal_id::bigint DESC NULLS LAST`,
      [date]
    );

    const rows = result.rows;
    return res.status(200).json({
      date,
      summary: {
        total:           rows.length,
        withDiscrepancy: rows.filter(r => r.has_discrepancy).length,
        stageMismatch:   rows.filter(r => !r.stage_match).length,
        totalMismatch:   rows.filter(r => !r.total_match).length,
        positionMismatch: rows.filter(r => r.positions_diff?.length > 0).length,
      },
      deals: rows,
    });
  } catch (err) {
    console.error('[monitor/snapshot] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
