// Shopify Webhook Adapter
// Events are persisted to PostgreSQL; an in-memory cache keeps the last 200
// events available for fast reads without hitting the DB on every render.
import { mapShopifyOrderToBitrixDeal } from '../../bitrix/orderMapper.js';
import { BITRIX_CONFIG, financialStatusToStageId } from '../../bitrix/config.js';
import { pool } from '../../logging/db.js';

// ---------------------------------------------------------------------------
// In-memory cache — last 200 events (newest at the end of the array)
// ---------------------------------------------------------------------------
const MAX_CACHE_SIZE = 200;

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

  const entityId = event.orderId != null ? String(event.orderId) : null;

  pool
    .query(
      `INSERT INTO logs
         (level, event_type, entity_type, entity_id, message, metadata, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'info',
        'shopify_webhook',
        'order',
        entityId,
        `Shopify webhook received: topic=${event.topic}, orderId=${entityId}`,
        JSON.stringify(event),
        'adapter/shopify',
      ]
    )
    .catch((err) => {
      console.error('[SHOPIFY ADAPTER] Failed to persist event to DB:', err.message);
    });
}

// ---------------------------------------------------------------------------
// ShopifyAdapter class
// ---------------------------------------------------------------------------

/**
 * Shopify Webhook Adapter
 * Handles Shopify webhook events storage and retrieval.
 */
export class ShopifyAdapter {
  constructor() {
    console.log('[SHOPIFY ADAPTER] Initialized (PostgreSQL-backed, in-memory cache)');
  }

  getName() {
    return 'shopify';
  }

  /**
   * Validate Shopify webhook payload against simplified schema.
   * @param {Object} payload
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateWebhookPayload(payload) {
    const errors = [];

    if (!payload || typeof payload !== 'object') {
      return { valid: false, errors: ['Payload must be an object'] };
    }

    if (payload.id !== undefined && typeof payload.id !== 'number') {
      errors.push('id must be a number');
    }
    if (payload.email !== undefined && typeof payload.email !== 'string') {
      errors.push('email must be a string');
    }
    if (payload.created_at !== undefined && typeof payload.created_at !== 'string') {
      errors.push('created_at must be a string');
    }
    if (payload.currency !== undefined && typeof payload.currency !== 'string') {
      errors.push('currency must be a string');
    }
    if (payload.total_price !== undefined && typeof payload.total_price !== 'string') {
      errors.push('total_price must be a string');
    }

    if (payload.line_items !== undefined) {
      if (!Array.isArray(payload.line_items)) {
        errors.push('line_items must be an array');
      } else {
        payload.line_items.forEach((item, index) => {
          if (item.id !== undefined && typeof item.id !== 'number') {
            errors.push(`line_items[${index}].id must be a number`);
          }
          if (item.quantity !== undefined && typeof item.quantity !== 'number') {
            errors.push(`line_items[${index}].quantity must be a number`);
          }
          if (item.title !== undefined && typeof item.title !== 'string') {
            errors.push(`line_items[${index}].title must be a string`);
          }
          if (item.price !== undefined && typeof item.price !== 'string') {
            errors.push(`line_items[${index}].price must be a string`);
          }
          if (item.sku !== undefined && typeof item.sku !== 'string') {
            errors.push(`line_items[${index}].sku must be a string`);
          }
        });
      }
    }

    if (payload.discount_codes !== undefined) {
      if (!Array.isArray(payload.discount_codes)) {
        errors.push('discount_codes must be an array');
      } else {
        payload.discount_codes.forEach((code, index) => {
          if (code.code !== undefined && typeof code.code !== 'string') {
            errors.push(`discount_codes[${index}].code must be a string`);
          }
          if (code.amount !== undefined && typeof code.amount !== 'string') {
            errors.push(`discount_codes[${index}].amount must be a string`);
          }
          if (code.type !== undefined && typeof code.type !== 'string') {
            errors.push(`discount_codes[${index}].type must be a string`);
          }
        });
      }
    }

    if (payload.customer !== undefined) {
      if (typeof payload.customer !== 'object') {
        errors.push('customer must be an object');
      } else {
        if (payload.customer.id !== undefined && typeof payload.customer.id !== 'number') {
          errors.push('customer.id must be a number');
        }
        if (payload.customer.first_name !== undefined && typeof payload.customer.first_name !== 'string') {
          errors.push('customer.first_name must be a string');
        }
        if (payload.customer.last_name !== undefined && typeof payload.customer.last_name !== 'string') {
          errors.push('customer.last_name must be a string');
        }
        if (payload.customer.email !== undefined && typeof payload.customer.email !== 'string') {
          errors.push('customer.email must be a string');
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Store a webhook event in the in-memory cache and asynchronously persist it
   * to PostgreSQL.
   *
   * @param {Object} payload - Validated webhook payload
   * @param {string|null} [topic] - Webhook topic (e.g. 'orders/create')
   * @returns {Object} The stored event object
   */
  storeEvent(payload, topic = null) {
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const event = {
      ...payload,
      received_at: new Date().toISOString(),
      id: uniqueId,
      eventId: uniqueId,
      orderId: payload.id ?? null,
      topic: topic ?? payload.topic ?? payload.x_shopify_topic ?? 'unknown',
    };

    console.log(
      `[SHOPIFY ADAPTER] Storing event: orderId=${event.orderId}, topic=${event.topic}, eventId=${event.id}`
    );

    addToCache(event);
    persistEventToDb(event); // fire-and-forget

    console.log(`[SHOPIFY ADAPTER] Event stored. Cache size: ${cache.length}`);

    return event;
  }

  /**
   * Get all events from the in-memory cache (newest first).
   * Optionally deduplicate by (orderId + topic) keeping only the latest per pair.
   *
   * @param {boolean} [includeAll=false] - When true, skip deduplication
   * @returns {Object[]}
   */
  getAllEvents(includeAll = false) {
    if (includeAll) {
      const all = [...cache].reverse();
      console.log(`[SHOPIFY ADAPTER] Returning all ${all.length} events (no deduplication)`);
      return all;
    }

    const seen = new Map();
    const unique = [];
    let skipped = 0;

    console.log(`[SHOPIFY ADAPTER] Starting deduplication: ${cache.length} total events`);

    for (let i = cache.length - 1; i >= 0; i--) {
      const event = cache[i];
      const orderId = event.orderId ?? event.id;
      const t = event.topic ?? event.x_shopify_topic ?? 'unknown';
      const key = `${orderId}:${t}`;

      if (!seen.has(key)) {
        seen.set(key, event);
        unique.unshift(event);
        console.log(
          `[SHOPIFY ADAPTER] Keeping event: orderId=${orderId}, topic=${t}, eventId=${event.id}`
        );
      } else {
        skipped++;
        const existing = seen.get(key);
        console.log(
          `[SHOPIFY ADAPTER] Skipping duplicate: orderId=${orderId}, topic=${t}, existingEventId=${existing.id}`
        );
      }
    }

    console.log(
      `[SHOPIFY ADAPTER] Deduplication result: ${cache.length} total -> ${unique.length} unique (skipped ${skipped})`
    );

    return unique;
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
   * Find a single event by its eventId / id field in the cache.
   * @param {string} eventId
   * @returns {Object|null}
   */
  getEventById(eventId) {
    return cache.find((e) => e.id === eventId || e.eventId === eventId) ?? null;
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
    console.log(`[SHOPIFY ADAPTER] Cleared ${count} events from cache`);
    return count;
  }

  /**
   * Transform a Shopify order (as stored by storeEvent) into Bitrix24 crm.deal.add format.
   * Uses the unified mapShopifyOrderToBitrixDeal mapper for consistency.
   *
   * @param {Object} shopifyOrder
   * @returns {Promise<{ fields: Object }>}
   */
  async transformToBitrix(shopifyOrder) {
    if (!shopifyOrder || typeof shopifyOrder !== 'object') {
      throw new Error('Invalid Shopify order data');
    }

    // orderId is the stable Shopify order.id; id may be the synthetic eventId
    const stableOrderId = shopifyOrder.orderId ?? shopifyOrder.id;

    const orderForMapper = {
      ...shopifyOrder,
      id: stableOrderId,
      eventId: shopifyOrder.eventId ?? shopifyOrder.id,
    };

    const { dealFields } = await mapShopifyOrderToBitrixDeal(orderForMapper);

    // Ensure UF_CRM_1742556489 uses the stable order ID
    dealFields.UF_CRM_1742556489 = String(stableOrderId);

    if (!dealFields.CATEGORY_ID) {
      const orderTags = Array.isArray(shopifyOrder.tags)
        ? shopifyOrder.tags
        : shopifyOrder.tags
        ? String(shopifyOrder.tags).split(',').map((t) => t.trim())
        : [];
      const preorderTags = ['pre-order', 'preorder-product-added'];
      const hasPreorderTag = orderTags.some((tag) =>
        preorderTags.some((pt) => tag.toLowerCase() === pt.toLowerCase())
      );
      dealFields.CATEGORY_ID = hasPreorderTag
        ? BITRIX_CONFIG.CATEGORY_PREORDER
        : BITRIX_CONFIG.CATEGORY_STOCK;
    }

    if (!dealFields.STAGE_ID) {
      dealFields.STAGE_ID = financialStatusToStageId(
        shopifyOrder.financial_status,
        dealFields.CATEGORY_ID ?? BITRIX_CONFIG.CATEGORY_STOCK,
        null
      );
    }

    return { fields: dealFields };
  }
}

// Export singleton instance
export const shopifyAdapter = new ShopifyAdapter();
