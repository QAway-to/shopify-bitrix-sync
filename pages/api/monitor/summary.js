/**
 * Daily sync monitor — summary endpoint.
 *
 * GET /api/monitor/summary?date=YYYY-MM-DD
 *   Returns deal_sync_summary rows for the given date.
 *   Triggers yesterday's aggregation automatically at 10:00 MSK.
 *
 * GET /api/monitor/summary?dates=1
 *   Returns list of distinct dates that have data (for date picker).
 */

import { pool } from '../../../src/lib/logging/db.js';
import { requireAuth } from '../../../src/lib/auth/session.js';

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

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_sync_summary (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      date          DATE NOT NULL,
      deal_id       VARCHAR NOT NULL,
      order_id      VARCHAR,
      status        VARCHAR NOT NULL,
      syncs_count   INT DEFAULT 0,
      added         INT DEFAULT 0,
      incremented   INT DEFAULT 0,
      decremented   INT DEFAULT 0,
      orphans_count       INT DEFAULT 0,
      errors_count        INT DEFAULT 0,
      discrepancies_count INT DEFAULT 0,
      last_sync_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (date, deal_id)
    )
  `);
  await pool.query(`ALTER TABLE deal_sync_summary ADD COLUMN IF NOT EXISTS discrepancies_count INT DEFAULT 0`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitor_aggregation_runs (
      aggregated_date DATE PRIMARY KEY,
      status          VARCHAR NOT NULL DEFAULT 'running',
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at     TIMESTAMPTZ,
      deals_processed INT,
      error_message   TEXT
    )
  `);
}

/**
 * Atomically claims the aggregation slot for the given date.
 * Returns true if this caller won the race and should run aggregation.
 * Returns false if another process already succeeded or is actively running.
 * Re-claims stuck 'running' rows older than 30 minutes.
 */
async function tryClaimAggregation(date) {
  const claim = await pool.query(
    `INSERT INTO monitor_aggregation_runs (aggregated_date, status)
     VALUES ($1, 'running')
     ON CONFLICT (aggregated_date) DO UPDATE
       SET status = 'running', started_at = NOW(), finished_at = NULL, error_message = NULL
       WHERE monitor_aggregation_runs.status = 'failed'
          OR (monitor_aggregation_runs.status = 'running'
              AND monitor_aggregation_runs.started_at < NOW() - INTERVAL '30 minutes')
     RETURNING aggregated_date`,
    [date]
  );
  return claim.rows.length > 0;
}

async function markAggregationDone(date, dealsProcessed, errorMessage = null) {
  if (errorMessage) {
    await pool.query(
      `UPDATE monitor_aggregation_runs
       SET status = 'failed', finished_at = NOW(), error_message = $2
       WHERE aggregated_date = $1`,
      [date, errorMessage]
    );
  } else {
    await pool.query(
      `UPDATE monitor_aggregation_runs
       SET status = 'success', finished_at = NOW(), deals_processed = $2
       WHERE aggregated_date = $1`,
      [date, dealsProcessed]
    );
  }
}

async function aggregateYesterday() {
  const yesterday = getMskDateString(-1);

  const claimed = await tryClaimAggregation(yesterday);
  if (!claimed) return;

  try {
    // MSK day spans UTC: yesterday 21:00 → today 21:00
    const result = await pool.query(
      `SELECT
         metadata->>'dealId'              AS deal_id,
         metadata->>'shopifyOrderId'      AS order_id,
         (metadata->>'added')::int        AS added,
         (metadata->>'incremented')::int  AS incremented,
         (metadata->>'decremented')::int  AS decremented,
         (metadata->>'orphansCount')::int AS orphans_count,
         (metadata->>'errorsCount')::int  AS errors_count,
         created_at
       FROM logs
       WHERE event_type = 'quantity_sync_complete'
         AND created_at >= ($1::date - INTERVAL '3 hours')
         AND created_at <  ($1::date + INTERVAL '21 hours')
         AND metadata->>'dealId' IS NOT NULL`,
      [yesterday]
    );

    if (result.rows.length === 0) {
      await markAggregationDone(yesterday, 0);
      return;
    }

    const byDeal = new Map();
    for (const row of result.rows) {
      const key = row.deal_id;
      if (!byDeal.has(key)) {
        byDeal.set(key, {
          deal_id: key,
          order_id: row.order_id,
          syncs_count: 0,
          added: 0,
          incremented: 0,
          decremented: 0,
          orphans_count: 0,
          errors_count: 0,
          last_sync_at: row.created_at,
        });
      }
      const agg = byDeal.get(key);
      agg.syncs_count += 1;
      agg.added        += row.added        || 0;
      agg.incremented  += row.incremented  || 0;
      agg.decremented  += row.decremented  || 0;
      agg.orphans_count = Math.max(agg.orphans_count, row.orphans_count || 0);
      agg.errors_count += row.errors_count || 0;
      if (new Date(row.created_at) > new Date(agg.last_sync_at)) {
        agg.last_sync_at = row.created_at;
      }
    }

    for (const agg of byDeal.values()) {
      // errorRatio is 0 when syncs_count === 0 (no syncs recorded yet)
      const errorRatio = agg.syncs_count > 0 ? agg.errors_count / agg.syncs_count : 0;
      const allFailed = agg.errors_count > 0 && (agg.added + agg.incremented + agg.decremented) === 0;

      const status =
        (errorRatio >= 0.5 && agg.errors_count >= 3) || (allFailed && agg.errors_count >= 2)
          ? 'critical'
        : agg.errors_count > 0 || agg.orphans_count > 0
          ? 'warning'
        : agg.added + agg.incremented + agg.decremented > 0
          ? 'ok'
        : 'quiet';

      await pool.query(
        `INSERT INTO deal_sync_summary
           (date, deal_id, order_id, status, syncs_count, added, incremented, decremented,
            orphans_count, errors_count, last_sync_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (date, deal_id) DO UPDATE SET
           order_id      = EXCLUDED.order_id,
           status        = EXCLUDED.status,
           syncs_count   = EXCLUDED.syncs_count,
           added         = EXCLUDED.added,
           incremented   = EXCLUDED.incremented,
           decremented   = EXCLUDED.decremented,
           orphans_count = EXCLUDED.orphans_count,
           errors_count  = EXCLUDED.errors_count,
           last_sync_at  = EXCLUDED.last_sync_at`,
        [
          yesterday,
          agg.deal_id, agg.order_id, status,
          agg.syncs_count, agg.added, agg.incremented, agg.decremented,
          agg.orphans_count, agg.errors_count, agg.last_sync_at,
        ]
      );
    }

    await markAggregationDone(yesterday, byDeal.size);
  } catch (err) {
    try {
      await markAggregationDone(yesterday, 0, String(err?.message ?? err));
    } catch (markErr) {
      console.error('[monitor] Failed to record aggregation failure:', markErr.message);
    }
    throw err;
  }
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!pool)               return res.status(503).json({ error: 'Database not available' });

  try {
    await ensureTable();

    // Auto-aggregate at 10:00 MSK — fire-and-forget, claim is guarded in DB
    if (getMskHour() >= 10) {
      aggregateYesterday().catch(err =>
        console.error('[monitor] Aggregation failed:', err.message)
      );
    }

    // ?dates=1 — return available dates for date picker
    if (req.query.dates === '1') {
      const datesResult = await pool.query(
        `SELECT DISTINCT date::text
         FROM deal_sync_summary
         ORDER BY date DESC`
      );
      return res.status(200).json({
        dates: datesResult.rows.map(r => r.date),
      });
    }

    // Default: return summary for requested date
    const date = req.query.date || getMskDateString(-1);

    const result = await pool.query(
      `SELECT deal_id, order_id, status, syncs_count, added, incremented, decremented,
              orphans_count, errors_count, last_sync_at
       FROM deal_sync_summary
       WHERE date = $1
       ORDER BY
         CASE status WHEN 'critical' THEN 0 WHEN 'errors' THEN 0 WHEN 'warning' THEN 1 WHEN 'orphans' THEN 1 WHEN 'ok' THEN 2 ELSE 3 END,
         CASE WHEN deal_id ~ '^\d+$' THEN deal_id::bigint END DESC NULLS LAST`,
      [date]
    );

    const rows = result.rows;
    return res.status(200).json({
      date,
      summary: {
        total:    rows.length,
        ok:       rows.filter(r => r.status === 'ok').length,
        critical: rows.filter(r => r.status === 'critical').length,
        warning:  rows.filter(r => r.status === 'warning' || r.status === 'errors' || r.status === 'orphans').length,
        quiet:    rows.filter(r => r.status === 'quiet' || r.status === 'no_changes').length,
      },
      deals: rows,
    });
  } catch (err) {
    console.error('[monitor/summary] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
