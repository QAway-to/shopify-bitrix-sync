// Bitrix24 Webhook Adapter
// Events are persisted to PostgreSQL; an in-memory cache keeps the last 50
// events available for fast reads without hitting the DB on every render.
import { pool } from '../../logging/db.js';

// ---------------------------------------------------------------------------
// In-memory cache — last 50 events (newest at the end of the array)
// ---------------------------------------------------------------------------
const MAX_CACHE_SIZE = 50;

/** @type {Object[]} */
let cache = [];

function addToCache(event) {
  cache.push(event);
  if (cache.length > MAX_CACHE_SIZE) {
    cache = cache.slice(cache.length - MAX_CACHE_SIZE);
  }
}

// ---------------------------------------------------------------------------
// Async DB write — fire-and-forget, never throws, never blocks
// ---------------------------------------------------------------------------

/**
 * @param {Object} event - The fully-formed event object stored in the cache
 */
function persistEventToDb(event) {
  if (!pool) return;

  const entityId = event.dealId != null ? String(event.dealId) : null;

  pool
    .query(
      `INSERT INTO logs
         (level, event_type, entity_type, entity_id, message, metadata, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'info',
        'bitrix_webhook',
        'deal',
        entityId,
        `Bitrix webhook received: dealId=${entityId}`,
        JSON.stringify(event),
        'adapter/bitrix',
      ]
    )
    .catch((err) => {
      console.error('[BITRIX ADAPTER] Failed to persist event to DB:', err.message);
    });
}

// ---------------------------------------------------------------------------
// BitrixAdapter class
// ---------------------------------------------------------------------------

/**
 * Bitrix Webhook Adapter
 * Handles Bitrix webhook events storage and retrieval.
 */
export class BitrixAdapter {
  constructor() {
    console.log('[BITRIX ADAPTER] Initialized (PostgreSQL-backed, in-memory cache)');
  }

  getName() {
    return 'bitrix';
  }

  /**
   * Store a webhook event in the in-memory cache and asynchronously persist it
   * to PostgreSQL.
   * Includes deduplication: events with the same dealId arriving within 5 seconds
   * of each other are treated as duplicates and the existing event is returned.
   *
   * @param {Object} payload - Bitrix webhook event payload
   * @returns {Object} The stored (or existing duplicate) event object
   */
  storeEvent(payload) {
    const dealId = payload.dealId;
    const receivedAt = payload.received_at ?? new Date().toISOString();
    const receivedTimestamp = new Date(receivedAt).getTime();

    // Deduplication: same dealId within 5-second window
    const DEDUP_WINDOW_MS = 5000;
    const recentDuplicate = cache.find((event) => {
      if (event.dealId !== dealId) return false;
      const eventTimestamp = new Date(event.received_at ?? event.receivedAt ?? 0).getTime();
      return Math.abs(receivedTimestamp - eventTimestamp) < DEDUP_WINDOW_MS;
    });

    if (recentDuplicate) {
      console.log(
        `[BITRIX ADAPTER] Duplicate event detected (dealId=${dealId}, within ${DEDUP_WINDOW_MS}ms), skipping. Existing eventId: ${recentDuplicate.id}`
      );
      return recentDuplicate;
    }

    const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const event = {
      ...payload,
      received_at: receivedAt,
      id: uniqueId,
      eventId: uniqueId,
    };

    console.log(
      `[BITRIX ADAPTER] Storing event: dealId=${event.dealId}, eventId=${event.id}, received_at=${event.received_at}`
    );

    addToCache(event);
    persistEventToDb(event); // fire-and-forget

    console.log(`[BITRIX ADAPTER] Event stored. Cache size: ${cache.length}`);

    return event;
  }

  /**
   * Get all events from the in-memory cache, newest first.
   * @returns {Object[]}
   */
  getAllEvents() {
    const events = [...cache].reverse();
    console.log(`[BITRIX ADAPTER] Returning ${events.length} events (newest first)`);
    return events;
  }

  /**
   * Get the most recently stored event.
   * @returns {Object|null}
   */
  getLatestEvent() {
    if (cache.length === 0) return null;
    return cache[cache.length - 1];
  }

  /**
   * Number of events currently in the cache.
   * @returns {number}
   */
  getEventsCount() {
    return cache.length;
  }

  /**
   * Clear all events from the in-memory cache.
   * @returns {number} Number of events that were cleared
   */
  clearEvents() {
    const count = cache.length;
    cache = [];
    console.log(`[BITRIX ADAPTER] Cleared ${count} events from cache`);
    return count;
  }
}

// Export singleton instance
export const bitrixAdapter = new BitrixAdapter();
