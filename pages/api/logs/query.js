/**
 * GET /api/logs/query
 *
 * Query the logs table with optional filters.
 *
 * Query parameters:
 *   level       — 'info' | 'warn' | 'error'
 *   event_type  — exact match
 *   entity_id   — exact match
 *   from        — ISO date string (inclusive lower bound on created_at)
 *   to          — ISO date string (inclusive upper bound on created_at)
 *   limit       — number of rows (default 100, max 500)
 *   offset      — pagination offset (default 0)
 *
 * Response: { logs: [...], total: N }
 */

import { getLogs } from '../../../src/lib/logging/logger.js';
import { requireAuth } from '../../../src/lib/auth/session.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { level, event_type, entity_id, from, to, limit, offset } = req.query;

  // Basic validation on limit/offset so callers get a helpful error early.
  if (limit !== undefined && (isNaN(Number(limit)) || Number(limit) < 1)) {
    return res.status(400).json({ error: '`limit` must be a positive integer.' });
  }
  if (offset !== undefined && (isNaN(Number(offset)) || Number(offset) < 0)) {
    return res.status(400).json({ error: '`offset` must be a non-negative integer.' });
  }

  try {
    const result = await getLogs({ level, event_type, entity_id, from, to, limit, offset });

    return res.status(200).json(result);
  } catch (err) {
    console.error('[logs/query] Query failed:', err.message);
    return res.status(500).json({ error: 'Failed to query logs.' });
  }
}
