/**
 * Shopify Order Operations
 * Handles creation and cancellation of orders from Bitrix deals
 */

import { callShopifyAdmin, callShopifyGraphQL } from './adminClient.js';
import { getVariantIdsBySkus } from './hold.js';

// In-memory lock to prevent concurrent order creation for the same deal
const dealIdLocks = new Map();

// In-memory cache of recently created / detected orders per dealId.
// This specifically mitigates Shopify search/tag indexing lag + concurrent Bitrix webhooks.
const RECENT_ORDER_TTL_MS = 5 * 60 * 1000; // 5 minutes
const dealIdRecentOrders = new Map(); // dealId -> { orderId: string, ts: number }

function getRecentOrderId(dealId) {
  const key = String(dealId || '').trim();
  if (!key) return null;
  const entry = dealIdRecentOrders.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age > RECENT_ORDER_TTL_MS) {
    dealIdRecentOrders.delete(key);
    return null;
  }
  return entry.orderId ? String(entry.orderId) : null;
}

function setRecentOrderId(dealId, orderId) {
  const key = String(dealId || '').trim();
  const val = String(orderId || '').trim();
  if (!key || !val) return;
  dealIdRecentOrders.set(key, { orderId: val, ts: Date.now() });
}

async function findOrdersByDealId(dealId, first = 10) {
  if (!dealId) return [];
  const tag = `BITRIX:${String(dealId).trim()}`;

  const query = `
    query findOrdersByTag($first: Int!, $query: String!) {
      orders(first: $first, query: $query) {
        edges {
          node {
            id
            legacyResourceId
            name
            createdAt
            tags
          }
        }
      }
    }
  `;

  // Shopify search can be finicky with ":" inside tags. Try variants and merge results.
  const queryVariants = [
    `tag:'${tag}'`,
    `tag:"${tag}"`,
    `tag:${tag}`,
    `tag:${tag.replace(':', '\\:')}`,
  ];

  const byId = new Map(); // orderId -> orderInfo

  for (const q of queryVariants) {
    try {
      const data = await callShopifyGraphQL(query, { first, query: q });
      const edges = data?.orders?.edges || [];
      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const tags = Array.isArray(node.tags) ? node.tags : [];
        if (!tags.includes(tag)) continue;
        const orderId = String(node.legacyResourceId || node.id?.split('/').pop() || '').trim();
        if (!orderId) continue;
        byId.set(orderId, {
          orderId,
          name: node.name || null,
          createdAt: node.createdAt || null,
          tags,
        });
      }
    } catch {
      // ignore and try next variant
    }
  }

  return Array.from(byId.values());
}

function pickCanonicalOrderId(orders) {
  if (!orders || orders.length === 0) return null;
  // Prefer lowest numeric orderId (stable + correlates with earliest creation).
  const sorted = [...orders].sort((a, b) => {
    const ai = Number(a.orderId);
    const bi = Number(b.orderId);
    const aNum = Number.isFinite(ai) ? ai : Number.MAX_SAFE_INTEGER;
    const bNum = Number.isFinite(bi) ? bi : Number.MAX_SAFE_INTEGER;
    if (aNum !== bNum) return aNum - bNum;
    const ac = a.createdAt || '';
    const bc = b.createdAt || '';
    return ac.localeCompare(bc);
  });
  return sorted[0].orderId;
}

async function reconcileDuplicateOrdersForDeal(dealId, createdOrderId, correlationId) {
  // Best-effort: if multiple orders exist for same deal tag, cancel extras and return canonical orderId.
  try {
    // Small delay to allow Shopify indexing to catch up.
    await new Promise(resolve => setTimeout(resolve, 1200));

    for (let attempt = 1; attempt <= 3; attempt++) {
      const orders = await findOrdersByDealId(dealId, 10);
      if (orders.length <= 1) {
        return String(createdOrderId);
      }

      const canonicalId = pickCanonicalOrderId(orders);
      const extras = orders
        .map(o => o.orderId)
        .filter(id => id && id !== canonicalId);

      console.warn(JSON.stringify({
        event: 'CREATE_ORDER_FROM_BITRIX_DUPLICATE_RECONCILE_DETECTED',
        dealId,
        correlationId,
        attempt,
        orders: orders.map(o => ({ orderId: o.orderId, name: o.name, createdAt: o.createdAt })),
        canonicalId,
        extras,
        timestamp: new Date().toISOString()
      }));

      for (const extraId of extras) {
        try {
          const cancelRes = await cancelOrderById(extraId, false);
          console.log(JSON.stringify({
            event: 'CREATE_ORDER_FROM_BITRIX_DUPLICATE_RECONCILE_CANCELLED',
            dealId,
            correlationId,
            canonicalId,
            cancelledOrderId: extraId,
            cancelSuccess: !!cancelRes?.success,
            cancelError: cancelRes?.error || null,
            timestamp: new Date().toISOString()
          }));
        } catch (cancelErr) {
          console.error(JSON.stringify({
            event: 'CREATE_ORDER_FROM_BITRIX_DUPLICATE_RECONCILE_CANCEL_ERROR',
            dealId,
            correlationId,
            canonicalId,
            cancelledOrderId: extraId,
            error: cancelErr.message,
            timestamp: new Date().toISOString()
          }));
        }
      }

      if (canonicalId) {
        setRecentOrderId(dealId, canonicalId);
        return String(canonicalId);
      }

      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 800));
    }

    return String(createdOrderId);
  } catch (e) {
    console.warn(JSON.stringify({
      event: 'CREATE_ORDER_FROM_BITRIX_DUPLICATE_RECONCILE_ERROR',
      dealId,
      correlationId,
      createdOrderId,
      error: e.message,
      timestamp: new Date().toISOString()
    }));
    return String(createdOrderId);
  }
}

/**
 * Acquire lock for dealId (returns true if acquired, false if already locked)
 */
const LOCK_TTL_MS = 30 * 1000; // 30 seconds

function acquireLock(dealId) {
  const now = Date.now();
  if (dealIdLocks.has(dealId)) {
    const lockedAt = dealIdLocks.get(dealId);
    if (now - lockedAt < LOCK_TTL_MS) {
      return false; // Already locked and within TTL
    }
    // Lock expired, overwrite it
    console.warn(`[LOCK] Overwriting expired lock for deal ${dealId} (age: ${now - lockedAt}ms)`);
  }
  dealIdLocks.set(dealId, now);
  return true;
}

/**
 * Release lock for dealId
 */
function releaseLock(dealId) {
  dealIdLocks.delete(dealId);
}

/**
 * Wait for lock to be released (with timeout)
 */
async function waitForLock(dealId, maxWaitMs = 2000) {
  const startTime = Date.now();
  while (dealIdLocks.has(dealId) && (Date.now() - startTime) < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, 50)); // Check every 50ms
  }
  return !dealIdLocks.has(dealId); // Returns true if lock is now available
}

/**
 * Check if order already exists in Shopify by BITRIX:{dealId} tag
 * @param {string} dealId - Bitrix deal ID
 * @returns {Promise<string|null>} Existing order ID or null if not found
 */
export async function findExistingOrderByDealId(dealId) {
  if (!dealId) {
    return null;
  }

  // Fast path: in-memory cache (avoids Shopify search indexing lag)
  const cached = getRecentOrderId(dealId);
  if (cached) {
    return cached;
  }

  const tag = `BITRIX:${String(dealId).trim()}`;
  const query = `
    query findOrderByTag($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            legacyResourceId
            name
            tags
          }
        }
      }
    }
  `;

  try {
    // Shopify search can be finicky with ":" inside tags. Try a few query variants.
    const queryVariants = [
      `tag:'${tag}'`,
      `tag:"${tag}"`,
      `tag:${tag}`,
      `tag:${tag.replace(':', '\\:')}`,
    ];

    for (const q of queryVariants) {
      try {
        const data = await callShopifyGraphQL(query, { query: q });
        if (data?.orders?.edges?.length) {
          const order = data.orders.edges[0].node;
          const tags = Array.isArray(order.tags) ? order.tags : [];
          if (tags.includes(tag)) {
            const orderId = order.legacyResourceId || order.id.split('/').pop();
            console.log(`[FIND EXISTING ORDER] Found existing order ${orderId} for deal ${dealId} by tag ${tag} (query: ${q})`);
            setRecentOrderId(dealId, orderId);
            return String(orderId);
          }
        }
      } catch (variantError) {
        // Try next variant
      }
    }

    // Fallback: fetch a small batch by generic BITRIX tag and filter client-side.
    // This is slower, but helps when exact tag search doesn't match due to indexing quirks.
    const fallbackQuery = `
      query findOrderByGenericTag($query: String!) {
        orders(first: 25, query: $query) {
          edges {
            node {
              id
              legacyResourceId
              name
              tags
            }
          }
        }
      }
    `;
    const fallbackData = await callShopifyGraphQL(fallbackQuery, { query: `tag:BITRIX` });
    const edges = fallbackData?.orders?.edges || [];
    for (const edge of edges) {
      const order = edge?.node;
      const tags = Array.isArray(order?.tags) ? order.tags : [];
      if (tags.includes(tag)) {
        const orderId = order.legacyResourceId || order.id.split('/').pop();
        console.log(`[FIND EXISTING ORDER] Found existing order ${orderId} for deal ${dealId} by scanning BITRIX-tagged orders`);
        setRecentOrderId(dealId, orderId);
        return String(orderId);
      }
    }

    return null;
  } catch (error) {
    console.warn(`[FIND EXISTING ORDER] Error searching for order by tag ${tag}:`, error.message);
    return null; // Don't block order creation if search fails
  }
}

/**
 * Cancel order in Shopify by orderId with optional refund
 * @param {string|number} orderId - Shopify order ID
 * @param {boolean} refund - Whether to refund (default: false)
 * @returns {Promise<Object>} Cancellation result
 */
export async function cancelOrderById(orderId, refund = false) {
  if (!orderId) {
    throw new Error('Order ID is required');
  }

  const orderGid = `gid://shopify/Order/${orderId}`;

  const mutation = `
    mutation orderCancel($orderId: ID!) {
      orderCancel(
        orderId: $orderId,
        reason: OTHER,
        restock: true,
        refund: ${refund ? 'true' : 'false'}
      ) {
        userErrors {
          field
          message
          job
        }
        job {
          id
        }
      }
    }
  `;

  try {
    const data = await callShopifyGraphQL(mutation, {
      orderId: orderGid
    });

    if (!data?.orderCancel) {
      throw new Error('Invalid GraphQL response: orderCancel is missing');
    }

    const { userErrors, job } = data.orderCancel;

    if (userErrors && userErrors.length > 0) {
      const errorMessages = userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify orderCancel userErrors: ${errorMessages}`);
    }

    console.log(`[CANCEL ORDER] ✅ Successfully cancelled order ${orderId}. Restock: YES, Refund: ${refund ? 'YES' : 'NO'}`);
    if (job?.id) {
      console.log(`[CANCEL ORDER] Job ID: ${job.id}`);
    }

    return {
      success: true,
      orderId: String(orderId),
      orderName: `Order ${orderId}`,
      jobId: job?.id,
      restocked: true,
      refunded: refund
    };
  } catch (error) {
    console.error(`[CANCEL ORDER] Error cancelling order ${orderId}:`, error);
    return {
      success: false,
      error: 'ORDER_CANCEL_ERROR',
      message: error.message,
      orderId: String(orderId)
    };
  }
}

/**
 * Cancel technical order in Shopify by dealId
 * @param {string} dealId - Bitrix deal ID
 * @returns {Promise<Object>} Cancellation result
 */
export async function cancelOrderByDealId(dealId) {
  if (!dealId) {
    throw new Error('Deal ID is required');
  }

  // Find existing technical order by dealId
  const existingOrderId = await findExistingOrderByDealId(dealId);
  if (!existingOrderId) {
    console.log(`[CANCEL ORDER] No technical order found for deal ${dealId}`);
    return {
      success: false,
      error: 'ORDER_NOT_FOUND',
      message: `No technical order found for deal ${dealId}`
    };
  }

  // Get order GraphQL ID
  const orderGid = `gid://shopify/Order/${existingOrderId}`;

  // Use exact mutation format from working script
  const mutation = `
    mutation orderCancel($orderId: ID!) {
      orderCancel(
        orderId: $orderId,
        reason: OTHER,
        restock: true,
        refund: false
      ) {
        userErrors {
          field
          message
        }
        job {
          id
        }
      }
    }
  `;

  try {
    const data = await callShopifyGraphQL(mutation, {
      orderId: orderGid
    });

    if (!data?.orderCancel) {
      throw new Error('Invalid GraphQL response: orderCancel is missing');
    }

    const { userErrors, job } = data.orderCancel;

    // Check for user errors
    if (userErrors && userErrors.length > 0) {
      const errorMessages = userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify orderCancel userErrors: ${errorMessages}`);
    }

    console.log(`[CANCEL ORDER] ✅ Successfully cancelled order ${existingOrderId} for deal ${dealId}. Restock: YES (+1 to Inventory)`);
    if (job?.id) {
      console.log(`[CANCEL ORDER] Job ID: ${job.id}`);
    }

    return {
      success: true,
      orderId: existingOrderId,
      orderName: `Order ${existingOrderId}`,
      jobId: job?.id,
      restocked: true
    };
  } catch (error) {
    console.error(`[CANCEL ORDER] Error cancelling order ${existingOrderId} for deal ${dealId}:`, error);
    return {
      success: false,
      error: 'ORDER_CANCEL_ERROR',
      message: error.message,
      orderId: existingOrderId
    };
  }
}

/**
 * Create order in Shopify from Bitrix deal
 * @param {Array<{sku?: string, variantId?: string|number, qty: number}>} items - Array of items with SKU or variantId and quantity
 * @param {string} dealId - Bitrix deal ID
 * @param {string} correlationId - Correlation ID for tracking (optional)
 * @param {Object} options - Additional options (optional)
 * @param {Object} options.shippingAddress - Shipping address object (optional)
 * @param {Array<Object>} options.shippingLines - Shipping lines array (optional)
 * @returns {Promise<Object>} Created order data
 */
export async function createOrderFromBitrix(items, dealId, correlationId = null, options = {}) {
  if (!items || items.length === 0) {
    throw new Error('Items array is required and cannot be empty');
  }

  if (!dealId) {
    throw new Error('Deal ID is required');
  }

  const isStubOrder = !!options?.isStubOrder;
  const stubReason = options?.stubReason ? String(options.stubReason) : null;
  const stubDefaultVariantId = options?.stubDefaultVariantId ? String(options.stubDefaultVariantId) : null;
  const customerEmailRaw = options?.customerEmail ? String(options.customerEmail) : '';
  const customerEmail = customerEmailRaw && customerEmailRaw.trim() !== '' ? customerEmailRaw.trim() : null;

  // ✅ CRITICAL STEP 0: Fast cache check (prevents duplicates when Shopify search lags)
  const cachedOrderId = getRecentOrderId(dealId);
  if (cachedOrderId) {
    console.log(JSON.stringify({
      event: 'CREATE_ORDER_FROM_BITRIX_RECENT_CACHE_HIT',
      dealId,
      correlationId,
      cachedOrderId,
      timestamp: new Date().toISOString()
    }));
    return {
      success: true,
      orderId: cachedOrderId,
      orderName: `Existing order ${cachedOrderId}`,
      wasDuplicate: true,
      lineItems: [],
      tags: [`BITRIX:${dealId}`, ...(isStubOrder ? ['BITRIX_STUB'] : [])],
      note: isStubOrder
        ? `STUB ORDER (Bitrix): deal=${dealId}${stubReason ? `; reason=${stubReason}` : ''}${stubDefaultVariantId ? `; default_variant=${stubDefaultVariantId}` : ''}`
        : `Ордер из Bitrix. Сделка: ${dealId}`
    };
  }

  // ✅ CRITICAL STEP 1: Acquire lock IMMEDIATELY to prevent concurrent order creation
  const lockAcquired = acquireLock(dealId);
  if (!lockAcquired) {
    // Another request is creating order - wait and check for existing order multiple times
    console.log(`[CREATE ORDER FROM BITRIX] ⚠️ Lock already held for deal ${dealId}, waiting and checking for existing order...`);

    // Wait with multiple checks for existing order
    for (let checkAttempt = 1; checkAttempt <= 10; checkAttempt++) {
      await new Promise(resolve => setTimeout(resolve, 300)); // Wait 300ms between checks

      // Fast path: in-memory cache (avoid Shopify search lag)
      const cached = getRecentOrderId(dealId);
      if (cached) {
        console.log(JSON.stringify({
          event: 'CREATE_ORDER_FROM_BITRIX_LOCK_WAIT_CACHE_HIT',
          dealId,
          correlationId,
          cachedOrderId: cached,
          checkAttempt,
          timestamp: new Date().toISOString()
        }));
        return {
          success: true,
          orderId: cached,
          orderName: `Existing order ${cached}`,
          wasDuplicate: true,
          lineItems: [],
          tags: [`BITRIX:${dealId}`, ...(isStubOrder ? ['BITRIX_STUB'] : [])],
          note: isStubOrder
            ? `STUB ORDER (Bitrix): deal=${dealId}${stubReason ? `; reason=${stubReason}` : ''}${stubDefaultVariantId ? `; default_variant=${stubDefaultVariantId}` : ''}`
            : `Ордер из Bitrix. Сделка: ${dealId}`
        };
      }

      // Check if order already exists
      const existingOrderId = await findExistingOrderByDealId(dealId);
      if (existingOrderId) {
        console.log(`[CREATE ORDER FROM BITRIX] ✅ Found existing order ${existingOrderId} for deal ${dealId} on check attempt ${checkAttempt}`);
        setRecentOrderId(dealId, existingOrderId);
        return {
          success: true,
          orderId: existingOrderId,
          orderName: `Existing order ${existingOrderId}`,
          wasDuplicate: true,
          lineItems: [],
          tags: [`BITRIX:${dealId}`, ...(isStubOrder ? ['BITRIX_STUB'] : [])],
          note: isStubOrder
            ? `STUB ORDER (Bitrix): deal=${dealId}${stubReason ? `; reason=${stubReason}` : ''}${stubDefaultVariantId ? `; default_variant=${stubDefaultVariantId}` : ''}`
            : `Ордер из Bitrix. Сделка: ${dealId}`
        };
      }

      // Check if lock is released
      if (!dealIdLocks.has(dealId)) {
        console.log(`[CREATE ORDER FROM BITRIX] Lock released for deal ${dealId} on attempt ${checkAttempt}`);
        // Try to acquire lock
        if (acquireLock(dealId)) {
          break; // Lock acquired, continue with creation
        }
        // Another request got the lock, continue waiting
      }
    }

    // Final check after waiting
    const finalExistingOrderId = await findExistingOrderByDealId(dealId);
    if (finalExistingOrderId) {
      console.log(`[CREATE ORDER FROM BITRIX] ✅ Found existing order ${finalExistingOrderId} for deal ${dealId} after all checks`);
      setRecentOrderId(dealId, finalExistingOrderId);
      return {
        success: true,
        orderId: finalExistingOrderId,
        orderName: `Existing order ${finalExistingOrderId}`,
        wasDuplicate: true,
        lineItems: [],
        tags: [`BITRIX:${dealId}`, ...(isStubOrder ? ['BITRIX_STUB'] : [])],
        note: isStubOrder
          ? `STUB ORDER (Bitrix): deal=${dealId}${stubReason ? `; reason=${stubReason}` : ''}${stubDefaultVariantId ? `; default_variant=${stubDefaultVariantId}` : ''}`
          : `Ордер из Bitrix. Сделка: ${dealId}`
      };
    }

    // If still locked after all checks, throw error
    if (dealIdLocks.has(dealId)) {
      throw new Error(`Timeout waiting for lock on deal ${dealId} - order creation already in progress for too long`);
    }

    // Try one more time to acquire lock
    if (!acquireLock(dealId)) {
      throw new Error(`Could not acquire lock for deal ${dealId} after waiting`);
    }
  }

  try {
    // ✅ CRITICAL STEP 2: Multiple duplicate checks BEFORE preparing data
    for (let preCheck = 1; preCheck <= 3; preCheck++) {
      const existingOrderId = await findExistingOrderByDealId(dealId);
      if (existingOrderId) {
        console.log(`[CREATE ORDER FROM BITRIX] ⚠️ Existing order ${existingOrderId} found for deal ${dealId} on pre-check ${preCheck}`);
        setRecentOrderId(dealId, existingOrderId);
        releaseLock(dealId);
        return {
          success: true,
          orderId: existingOrderId,
          orderName: `Existing order ${existingOrderId}`,
          wasDuplicate: true,
          lineItems: [],
          tags: [`BITRIX:${dealId}`, ...(isStubOrder ? ['BITRIX_STUB'] : [])],
          note: isStubOrder
            ? `STUB ORDER (Bitrix): deal=${dealId}${stubReason ? `; reason=${stubReason}` : ''}${stubDefaultVariantId ? `; default_variant=${stubDefaultVariantId}` : ''}`
            : `Ордер из Bitrix. Сделка: ${dealId}`
        };
      }
      if (preCheck < 3) {
        await new Promise(resolve => setTimeout(resolve, 200)); // Wait 200ms between checks
      }
    }
  } catch (preCheckError) {
    releaseLock(dealId);
    throw preCheckError;
  }

  // Separate items with SKU from items with variantId
  const itemsWithSku = items.filter(item => item.sku && !item.variantId);
  const itemsWithVariantId = items.filter(item => item.variantId);

  // Step 1: Get variant IDs for all SKUs (single batch query)
  let variantIdMap = new Map();
  if (itemsWithSku.length > 0) {
    const skus = itemsWithSku.map(item => item.sku);
    variantIdMap = await getVariantIdsBySkus(skus);
  }

  // Build line items with variant IDs (for GraphQL) and numeric variant_ids (for REST)
  const lineItems = [];
  const lineItemsRest = [];
  const missingSkus = [];
  let hasStubItems = false;

  for (const item of items) {
    let variantId = null;

    // If variantId is provided directly, use it (XML_ID from Bitrix)
    if (item.variantId) {
      variantId = String(item.variantId);
      console.log(`[CREATE ORDER FROM BITRIX] Using variantId directly: ${variantId}`);
    }
    // Otherwise, if SKU is provided, look up variantId by SKU from batch result
    else if (item.sku) {
      variantId = variantIdMap.get(item.sku);

      if (!variantId) {
        if (stubDefaultVariantId) {
          console.warn(`[CREATE ORDER FROM BITRIX] Variant ID not found for SKU: ${item.sku}. Using stub variant ${stubDefaultVariantId}.`);
          variantId = stubDefaultVariantId;
          missingSkus.push(item.sku);
          hasStubItems = true;
        } else {
          throw new Error(`Variant ID not found for SKU: ${item.sku}`);
        }
      } else {
        console.log(`[CREATE ORDER FROM BITRIX] Found variantId by SKU: ${item.sku} -> ${variantId}`);
      }
    } else {
      throw new Error(`Item must have either sku or variantId: ${JSON.stringify(item)}`);
    }

    // GraphQL requires variant ID in format "gid://shopify/ProductVariant/{id}"
    lineItems.push({
      variantId: `gid://shopify/ProductVariant/${variantId}`,
      quantity: item.qty
    });

    // REST requires numeric variant_id
    lineItemsRest.push({
      variant_id: Number(variantId),
      quantity: item.qty
    });
  }

  // Force isStubOrder to true if we had to use stub items (to ensure pending payment status etc)
  const effectivelyStubOrder = isStubOrder || hasStubItems;

  // Build tags: ["BITRIX:{dealId}"]
  // BITRIX:{dealId} tag is used for duplicate detection, linking to Bitrix deal, and identifying orders created from Bitrix
  const tags = [];
  if (dealId) {
    tags.push(`BITRIX:${dealId}`);
  }
  if (effectivelyStubOrder) {
    // Separate tag (no colon) to be easily visible and searchable in Shopify UI
    tags.push('BITRIX_STUB');
    if (missingSkus.length > 0) {
      tags.push('MISSING_SKU');
    }
  }

  // Build note with order information
  let noteBase = `Ордер из Bitrix. Сделка: ${dealId}`;
  if (effectivelyStubOrder) {
    noteBase = `STUB ORDER (Bitrix): deal=${dealId}`;
    if (stubReason) noteBase += `; reason=${stubReason}`;
    if (missingSkus.length > 0) noteBase += `; missing_skus=${missingSkus.join(',')}`;
    if (stubDefaultVariantId) noteBase += `; default_variant=${stubDefaultVariantId}`;
  }
  const note = noteBase;

  // ✅ UNIFIED REST ORDER CREATION
  // We use REST API because it reliably supports 'financial_status: pending'
  // and 'shipping_address', which caused issues in the GraphQL implementation.

  console.log(JSON.stringify({
    event: 'CREATE_ORDER_FROM_BITRIX_REST_ATTEMPT',
    dealId,
    correlationId,
    lineItemsCount: lineItemsRest.length,
    isStubOrder: effectivelyStubOrder,
    timestamp: new Date().toISOString()
  }));

  const shippingAddressRaw = options?.shippingAddress && typeof options.shippingAddress === 'object'
    ? options.shippingAddress
    : null;

  const shipping_address = shippingAddressRaw ? {
    first_name: shippingAddressRaw.first_name || shippingAddressRaw.firstName || undefined,
    last_name: shippingAddressRaw.last_name || shippingAddressRaw.lastName || undefined,
    address1: shippingAddressRaw.address1 || undefined,
    address2: shippingAddressRaw.address2 || undefined,
    city: shippingAddressRaw.city || undefined,
    zip: shippingAddressRaw.zip || undefined,
    province: shippingAddressRaw.province || shippingAddressRaw.provinceCode || undefined,
    country: shippingAddressRaw.country || undefined,
    country_code: shippingAddressRaw.country_code || shippingAddressRaw.countryCode || undefined,
    phone: shippingAddressRaw.phone || undefined,
  } : undefined;

  const restResp = await callShopifyAdmin('/orders.json', {
    method: 'POST',
    body: JSON.stringify({
      order: {
        line_items: lineItemsRest,
        tags: tags.join(', '),
        note,
        email: customerEmail || 'hold@bfcshoes.local',
        taxes_included: true,
        financial_status: 'pending', // Always pending initially
        inventory_behaviour: 'decrement_obeying_policy',
        send_receipt: false,
        send_fulfillment_receipt: false,
        ...(shipping_address ? { shipping_address } : {})
      }
    })
  });

  const restOrder = restResp?.order;
  if (!restOrder?.id) {
    const errorMsg = 'REST order creation failed: missing order.id';
    console.error(JSON.stringify({
      event: 'CREATE_ORDER_FROM_BITRIX_REST_ERROR',
      dealId,
      correlationId,
      error: 'INVALID_RESPONSE',
      message: errorMsg,
      responseData: JSON.stringify(restResp).substring(0, 500),
      timestamp: new Date().toISOString()
    }));
    throw new Error(errorMsg);
  }

  const createdOrderId = String(restOrder.id);
  setRecentOrderId(dealId, createdOrderId);

  // ✅ Best-effort reconciliation: if duplicates exist (multi-instance race), cancel extras and return canonical orderId
  const canonicalOrderId = await reconcileDuplicateOrdersForDeal(dealId, createdOrderId, correlationId);
  const wasDuplicate = String(canonicalOrderId) !== String(createdOrderId);
  if (wasDuplicate) {
    setRecentOrderId(dealId, canonicalOrderId);
  }

  console.log(JSON.stringify({
    event: 'CREATE_ORDER_FROM_BITRIX_REST_SUCCESS',
    dealId,
    correlationId,
    orderId: canonicalOrderId,
    orderName: restOrder.name || null,
    financialStatus: restOrder.financial_status || null,
    wasDuplicate,
    timestamp: new Date().toISOString()
  }));

  // Construct response matching expected format
  return {
    success: true,
    order: restOrder,
    orderId: canonicalOrderId,
    orderName: wasDuplicate ? `Existing order ${canonicalOrderId}` : (restOrder.name || `#${canonicalOrderId}`),
    wasDuplicate,
    lineItems: restOrder.line_items || [],
    tags: Array.isArray(restOrder.tags) ? restOrder.tags : (restOrder.tags ? String(restOrder.tags).split(',').map(t => t.trim()) : []),
    note: restOrder.note || ''
  };

} catch (error) {
  console.error(JSON.stringify({
    event: 'CREATE_ORDER_FROM_BITRIX_EXCEPTION',
    dealId,
    correlationId,
    error: 'ORDER_CREATE_EXCEPTION',
    message: error?.message || String(error),
    stack: error?.stack,
    timestamp: new Date().toISOString()
  }));

  return {
    success: true,
    order: restOrder,
    orderId: canonicalOrderId,
    orderName: wasDuplicate ? `Existing order ${canonicalOrderId}` : (restOrder.name || `#${canonicalOrderId}`),
    wasDuplicate,
    lineItems: restOrder.line_items || [],
    tags: Array.isArray(restOrder.tags) ? restOrder.tags : (restOrder.tags ? String(restOrder.tags).split(',').map(t => t.trim()) : []),
    note: restOrder.note || ''
  };

} catch (error) {
  console.error(`[CREATE ORDER FROM BITRIX] Fatal error creating order for deal ${dealId}:`, error);
  return {
    success: false,
    error: 'ORDER_CREATE_ERROR',
    message: error.message
  };
} finally {
  // Always release lock when done
  releaseLock(dealId);
}
}

/**
 * Add tag to Shopify order
 * @param {string|number} orderId - Shopify order ID
 * @param {string} tag - Tag to add
 * @returns {Promise<Object>} Result with success status
 */
export async function addTagToOrder(orderId, tag) {
  if (!orderId) {
    return {
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'Shopify order ID is required'
    };
  }

  if (!tag) {
    return {
      success: false,
      error: 'MISSING_TAG',
      message: 'Tag is required'
    };
  }

  try {
    // Get current order to get existing tags
    const { callShopifyAdmin, getOrder } = await import('./adminClient.js');
    const order = await getOrder(orderId);

    if (!order) {
      return {
        success: false,
        error: 'ORDER_NOT_FOUND',
        message: `Order ${orderId} not found in Shopify`
      };
    }

    // Get existing tags (handle both array and comma-separated string)
    const existingTags = Array.isArray(order.tags)
      ? order.tags
      : (order.tags ? String(order.tags).split(',').map(t => t.trim()) : []);

    // Check if tag already exists
    if (existingTags.includes(tag)) {
      return {
        success: true,
        orderId: String(orderId),
        orderName: order.name,
        tag,
        message: 'Tag already exists',
        tags: existingTags
      };
    }

    // Add new tag
    const updatedTags = [...existingTags, tag];

    // Update order with new tags
    const updateResponse = await callShopifyAdmin(`/orders/${orderId}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        order: {
          id: orderId,
          tags: updatedTags.join(', ') // Shopify REST API expects comma-separated string
        }
      })
    });

    return {
      success: true,
      orderId: String(orderId),
      orderName: updateResponse.order.name,
      tag,
      tags: updatedTags
    };
  } catch (error) {
    return {
      success: false,
      error: 'TAG_ADD_ERROR',
      message: error.message,
      httpStatus: error.status || 500
    };
  }
}
