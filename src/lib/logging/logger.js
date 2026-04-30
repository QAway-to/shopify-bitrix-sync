/**
 * Structured logger that writes to PostgreSQL asynchronously.
 *
 * All DB writes are fire-and-forget: they never block the caller and never throw.
 * The console fallback always runs first so logs appear even if the DB is down.
 *
 * Exports:
 *   logger               — { info, warn, error } bound to no specific request
 *   createRequestLogger  — factory that returns a logger pre-bound to a requestId+source
 *   getLogs              — query helper for the logs table
 */

import { pool } from './db.js';

// ---------------------------------------------------------------------------
// Internal: fire-and-forget DB write
// ---------------------------------------------------------------------------

/**
 * @param {object} entry
 * @param {string} entry.level
 * @param {string} [entry.event_type]
 * @param {string} [entry.entity_type]
 * @param {string} [entry.entity_id]
 * @param {string} entry.message
 * @param {object} [entry.metadata]
 * @param {string} [entry.request_id]
 * @param {string} [entry.source]
 * @param {number} [entry.duration_ms]
 */
function writeToDb(entry) {
  if (!pool) return; // DB not available — already warned at startup

  // Intentionally not awaited — this is a background write.
  pool
    .query(
      `INSERT INTO logs
         (level, event_type, entity_type, entity_id, message, metadata, request_id, source, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.level,
        entry.event_type ?? null,
        entry.entity_type ?? null,
        entry.entity_id ?? null,
        entry.message,
        entry.metadata != null ? JSON.stringify(entry.metadata) : null,
        entry.request_id ?? null,
        entry.source ?? null,
        entry.duration_ms ?? null,
      ]
    )
    .catch((err) => {
      // Swallow — never propagate DB errors back to callers.
      console.error('[logger] Failed to write log to DB:', err.message);
    });
}

// ---------------------------------------------------------------------------
// Internal: build a log entry and emit it
// ---------------------------------------------------------------------------

/**
 * @param {string} level        - 'info' | 'warn' | 'error'
 * @param {string} eventType    - machine-readable event identifier
 * @param {string} message      - human-readable description
 * @param {object} [metadata]   - arbitrary structured context
 * @param {string} [requestId]  - optional request correlation ID
 * @param {string} [source]     - optional source label (e.g. 'webhook/shopify')
 * @param {string} [entityType] - e.g. 'deal' | 'order' | 'product'
 * @param {string} [entityId]   - primary key of the entity
 */
function log(level, eventType, message, metadata, requestId, source, entityType, entityId) {
  // 1. Console fallback — always runs synchronously before the DB write.
  const consoleFn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  const prefix = [
    `[${level.toUpperCase()}]`,
    source ? `[${source}]` : null,
    requestId ? `(${requestId})` : null,
    eventType ? `<${eventType}>` : null,
  ]
    .filter(Boolean)
    .join(' ');

  try {
    consoleFn(prefix, message, metadata ?? '');
  } catch {
    // Extremely unlikely, but guard against broken console overrides.
  }

  // 2. Async DB write — fire-and-forget, never throws.
  writeToDb({
    level,
    event_type: eventType,
    entity_type: entityType ?? null,
    entity_id: entityId != null ? String(entityId) : null,
    message,
    metadata,
    request_id: requestId,
    source,
  });
}

// ---------------------------------------------------------------------------
// Public: base logger (no request binding)
// ---------------------------------------------------------------------------

export const logger = {
  /**
   * @param {string} eventType
   * @param {string} message
   * @param {object} [metadata]
   * @param {{ entityType?: string, entityId?: string|number }} [entity]
   */
  info(eventType, message, metadata, { entityType, entityId } = {}) {
    log('info', eventType, message, metadata, undefined, undefined, entityType, entityId);
  },

  /**
   * @param {string} eventType
   * @param {string} message
   * @param {object} [metadata]
   * @param {{ entityType?: string, entityId?: string|number }} [entity]
   */
  warn(eventType, message, metadata, { entityType, entityId } = {}) {
    log('warn', eventType, message, metadata, undefined, undefined, entityType, entityId);
  },

  /**
   * @param {string} eventType
   * @param {string} message
   * @param {object} [metadata]
   * @param {{ entityType?: string, entityId?: string|number }} [entity]
   */
  error(eventType, message, metadata, { entityType, entityId } = {}) {
    log('error', eventType, message, metadata, undefined, undefined, entityType, entityId);
  },
};

// ---------------------------------------------------------------------------
// Public: per-request logger factory
// ---------------------------------------------------------------------------

/**
 * Returns a logger object pre-bound to a specific requestId and source.
 * Useful for tracing a single webhook / API call end-to-end.
 *
 * @param {string} requestId
 * @param {string} source  - e.g. 'webhook/shopify', 'cron/cleanup'
 * @returns {{ info, warn, error }}
 */
export function createRequestLogger(requestId, source) {
  return {
    info(eventType, message, metadata, { entityType, entityId } = {}) {
      log('info', eventType, message, metadata, requestId, source, entityType, entityId);
    },
    warn(eventType, message, metadata, { entityType, entityId } = {}) {
      log('warn', eventType, message, metadata, requestId, source, entityType, entityId);
    },
    error(eventType, message, metadata, { entityType, entityId } = {}) {
      log('error', eventType, message, metadata, requestId, source, entityType, entityId);
    },
  };
}

// ---------------------------------------------------------------------------
// Public: query helper
// ---------------------------------------------------------------------------

/**
 * Fetch logs from the DB with optional filters.
 *
 * @param {object} [filters]
 * @param {string} [filters.level]        - 'info' | 'warn' | 'error'
 * @param {string} [filters.event_type]
 * @param {string} [filters.entity_id]
 * @param {string} [filters.from]         - ISO date string (inclusive)
 * @param {string} [filters.to]           - ISO date string (inclusive)
 * @param {number} [filters.limit=100]    - max rows (capped at 500)
 * @param {number} [filters.offset=0]
 * @returns {Promise<{ logs: object[], total: number }>}
 */
export async function getLogs(filters = {}) {
  if (!pool) {
    return { logs: [], total: 0 };
  }

  const { level, event_type, entity_id, from, to } = filters;
  const limit = Math.min(Number(filters.limit) || 100, 500);
  const offset = Number(filters.offset) || 0;

  const conditions = [];
  const params = [];

  if (level) {
    params.push(level);
    conditions.push(`level = $${params.length}`);
  }
  if (event_type) {
    params.push(event_type);
    conditions.push(`event_type = $${params.length}`);
  }
  if (entity_id) {
    params.push(entity_id);
    conditions.push(`entity_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`created_at <= $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countParams = [...params];
  const dataParams = [...params, limit, offset];

  const [countResult, dataResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM logs ${where}`, countParams),
    pool.query(
      `SELECT * FROM logs ${where} ORDER BY created_at DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    ),
  ]);

  return {
    logs: dataResult.rows,
    total: countResult.rows[0].total,
  };
}
