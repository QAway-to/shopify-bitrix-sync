/**
 * Deal Snapshot Core
 *
 * Daily job that fetches Bitrix deals with linked Shopify orders,
 * compares key fields (positions, totals, stage), and stores diffs in DB.
 *
 * Stage comparison only fires for terminal Shopify states (paid+fulfilled,
 * refunded, cancelled) — in-flight deals are excluded to avoid false positives.
 */

import { pool } from '../logging/db.js';
import { callBitrix } from '../bitrix/client.js';
import { getOrder } from '../shopify/adminClient.js';
import { financialStatusToStageId } from '../bitrix/config.js';
import { isWonStage, isLoseStage } from '../bitrix/stageMapping.js';

const UF_SHOPIFY_ORDER_ID = 'UF_CRM_1742556489';
const API_DELAY_MS = 500;
// Tolerance for total price comparison (handles rounding from discounts/tax)
const TOTAL_TOLERANCE = 1;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── DB helpers ──────────────────────────────────────────────────────────────

export async function ensureSnapshotTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_snapshot_diff (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshot_date     DATE NOT NULL,
      deal_id           VARCHAR NOT NULL,
      order_id          VARCHAR,
      bitrix_stage      VARCHAR,
      expected_stage    VARCHAR,
      stage_match       BOOLEAN NOT NULL DEFAULT true,
      stage_checked     BOOLEAN NOT NULL DEFAULT false,
      total_bitrix      NUMERIC(12,2),
      total_shopify     NUMERIC(12,2),
      total_match       BOOLEAN NOT NULL DEFAULT true,
      positions_total   INT NOT NULL DEFAULT 0,
      positions_matched INT NOT NULL DEFAULT 0,
      positions_diff    JSONB NOT NULL DEFAULT '[]',
      has_discrepancy   BOOLEAN NOT NULL DEFAULT false,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (snapshot_date, deal_id)
    )
  `);
  await pool.query(`ALTER TABLE deal_snapshot_diff ADD COLUMN IF NOT EXISTS stage_checked BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_snapshot_runs (
      snapshot_date  DATE PRIMARY KEY,
      status         VARCHAR NOT NULL DEFAULT 'running',
      started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at    TIMESTAMPTZ,
      deals_checked  INT,
      error_message  TEXT
    )
  `);
}

async function tryClaimSnapshot(date) {
  const claim = await pool.query(
    `INSERT INTO deal_snapshot_runs (snapshot_date, status)
     VALUES ($1, 'running')
     ON CONFLICT (snapshot_date) DO UPDATE
       SET status = 'running', started_at = NOW(), finished_at = NULL, error_message = NULL
       WHERE deal_snapshot_runs.status = 'failed'
          OR (deal_snapshot_runs.status = 'running'
              AND deal_snapshot_runs.started_at < NOW() - INTERVAL '30 minutes')
     RETURNING snapshot_date`,
    [date]
  );
  return claim.rows.length > 0;
}

async function markSnapshotDone(date, dealsChecked, errorMessage = null) {
  if (errorMessage) {
    await pool.query(
      `UPDATE deal_snapshot_runs
       SET status = 'failed', finished_at = NOW(), error_message = $2
       WHERE snapshot_date = $1`,
      [date, errorMessage]
    );
  } else {
    await pool.query(
      `UPDATE deal_snapshot_runs
       SET status = 'success', finished_at = NOW(), deals_checked = $2
       WHERE snapshot_date = $1`,
      [date, dealsChecked]
    );
  }
}

// ─── Stage derivation ────────────────────────────────────────────────────────

/**
 * Returns { expectedStage, shouldCheck }.
 * shouldCheck = false for in-flight deals (pending, partial pay, not fulfilled)
 * to avoid false positives — we only flag when Shopify is in a terminal state.
 */
function deriveExpectedStage(shopifyOrder, categoryId) {
  const financial   = (shopifyOrder.financial_status || '').toLowerCase();
  const fulfillment = (shopifyOrder.fulfillment_status || '').toLowerCase();
  const isFulfilled = fulfillment === 'fulfilled';
  const cat         = parseInt(categoryId, 10) || 0;

  // Terminal: fully cancelled / refunded → must be LOSE in Bitrix
  if (financial === 'refunded' || financial === 'cancelled' || financial === 'voided') {
    return { expectedStage: cat > 0 ? `C${cat}:LOSE` : 'LOSE', shouldCheck: true };
  }

  // Terminal: paid + fulfilled → must be WON in Bitrix
  if (financial === 'paid' && isFulfilled) {
    return { expectedStage: cat > 0 ? `C${cat}:WON` : 'WON', shouldCheck: true };
  }

  // Terminal: partially refunded + fulfilled → WON (partial refund after delivery)
  if (financial === 'partially_refunded' && isFulfilled) {
    return { expectedStage: cat > 0 ? `C${cat}:WON` : 'WON', shouldCheck: true };
  }

  // Pre-order paid but not yet fulfilled → WON expected (pre-orders go WON on payment)
  if (financial === 'paid' && (cat === 4 || cat === 8)) {
    return { expectedStage: `C${cat}:WON`, shouldCheck: true };
  }

  // In-flight (pending, partially_paid, paid-not-fulfilled for non-preorder) — skip stage check
  return { expectedStage: financialStatusToStageId(financial, cat) || 'unknown', shouldCheck: false };
}

function stagesMatch(bitrixStage, expectedStage) {
  if (isWonStage(bitrixStage) && isWonStage(expectedStage)) return true;
  if (isLoseStage(bitrixStage) && isLoseStage(expectedStage)) return true;
  return bitrixStage === expectedStage;
}

// ─── Positions comparison ────────────────────────────────────────────────────

function comparePositions(bitrixRows, shopifyLineItems) {
  // Build Bitrix map: CODE (SKU) → qty
  const bitrixMap = new Map();
  for (const row of bitrixRows) {
    const sku = (row.CODE || '').trim();
    if (sku) bitrixMap.set(sku, parseFloat(row.QUANTITY) || 0);
  }

  // Build Shopify map: sku → qty (prefer SKU; fall back to variant_id string)
  const shopifyMap = new Map();
  for (const li of shopifyLineItems) {
    const key = (li.sku || '').trim() || String(li.variant_id || '').trim();
    if (key) shopifyMap.set(key, parseFloat(li.quantity) || 0);
  }

  const diffs = [];
  const allKeys = new Set([...bitrixMap.keys(), ...shopifyMap.keys()]);

  for (const key of allKeys) {
    const bQty = bitrixMap.get(key) ?? null;
    const sQty = shopifyMap.get(key) ?? null;

    if (bQty === null) {
      diffs.push({ sku: key, bitrixQty: null, shopifyQty: sQty, type: 'missing_in_bitrix' });
    } else if (sQty === null) {
      diffs.push({ sku: key, bitrixQty: bQty, shopifyQty: null, type: 'missing_in_shopify' });
    } else if (Math.abs(bQty - sQty) > 0.01) {
      diffs.push({ sku: key, bitrixQty: bQty, shopifyQty: sQty, type: 'qty_mismatch' });
    }
  }

  return { total: allKeys.size, matched: allKeys.size - diffs.length, diffs };
}

// ─── Main snapshot runner ────────────────────────────────────────────────────

export async function runDealSnapshot(date) {
  const claimed = await tryClaimSnapshot(date);
  if (!claimed) return { skipped: true };

  try {
    // 1. Fetch all deals with a linked Shopify order ID
    const allDeals = [];
    let start = 0;

    while (true) {
      const resp = await callBitrix('crm.deal.list', {
        select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'CATEGORY_ID', UF_SHOPIFY_ORDER_ID],
        filter: { [`!${UF_SHOPIFY_ORDER_ID}`]: '' },
        start,
      });
      await sleep(API_DELAY_MS);

      const rows = resp.result || [];
      allDeals.push(...rows.filter(d => d[UF_SHOPIFY_ORDER_ID]));

      if (resp.next) { start = resp.next; } else { break; }
    }

    let checked = 0;

    for (const deal of allDeals) {
      const dealId      = deal.ID;
      const shopifyId   = deal[UF_SHOPIFY_ORDER_ID];
      const categoryId  = parseInt(deal.CATEGORY_ID, 10) || 0;
      const bitrixStage = deal.STAGE_ID;
      const bitrixTotal = parseFloat(deal.OPPORTUNITY) || null;

      try {
        // 2. Fetch Shopify order
        const shopifyOrder = await getOrder(shopifyId);
        await sleep(300);

        if (!shopifyOrder) {
          console.error(`[snapshot] Deal ${dealId}: Shopify order ${shopifyId} not found — skipping`);
          continue;
        }

        // 3. Fetch Bitrix product rows
        const rowsResp = await callBitrix('crm.deal.productrows.get', { id: dealId });
        await sleep(API_DELAY_MS);
        const bitrixRows = rowsResp.result || [];

        // 4. Compare stage — only for terminal Shopify states
        const { expectedStage, shouldCheck } = deriveExpectedStage(shopifyOrder, categoryId);
        const stageOk = shouldCheck ? stagesMatch(bitrixStage, expectedStage) : true;

        // 5. Compare totals
        const shopifyTotal = parseFloat(shopifyOrder.total_price) || null;
        const totalOk = bitrixTotal !== null && shopifyTotal !== null
          ? Math.abs(bitrixTotal - shopifyTotal) < TOTAL_TOLERANCE
          : true;

        // 6. Compare positions
        const { total, matched, diffs } = comparePositions(bitrixRows, shopifyOrder.line_items || []);

        const hasDiscrepancy = !stageOk || !totalOk || diffs.length > 0;

        // 7. Upsert into DB
        await pool.query(
          `INSERT INTO deal_snapshot_diff
             (snapshot_date, deal_id, order_id, bitrix_stage, expected_stage,
              stage_match, stage_checked, total_bitrix, total_shopify, total_match,
              positions_total, positions_matched, positions_diff, has_discrepancy)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (snapshot_date, deal_id) DO UPDATE SET
             order_id          = EXCLUDED.order_id,
             bitrix_stage      = EXCLUDED.bitrix_stage,
             expected_stage    = EXCLUDED.expected_stage,
             stage_match       = EXCLUDED.stage_match,
             stage_checked     = EXCLUDED.stage_checked,
             total_bitrix      = EXCLUDED.total_bitrix,
             total_shopify     = EXCLUDED.total_shopify,
             total_match       = EXCLUDED.total_match,
             positions_total   = EXCLUDED.positions_total,
             positions_matched = EXCLUDED.positions_matched,
             positions_diff    = EXCLUDED.positions_diff,
             has_discrepancy   = EXCLUDED.has_discrepancy`,
          [
            date, dealId, shopifyId, bitrixStage, expectedStage,
            stageOk, shouldCheck, bitrixTotal, shopifyTotal, totalOk,
            total, matched, JSON.stringify(diffs), hasDiscrepancy,
          ]
        );

        checked++;
      } catch (dealErr) {
        console.error(`[snapshot] Deal ${dealId} error:`, dealErr.message);
      }
    }

    await markSnapshotDone(date, checked);
    return { checked };
  } catch (err) {
    try { await markSnapshotDone(date, 0, String(err?.message ?? err)); } catch {}
    throw err;
  }
}
