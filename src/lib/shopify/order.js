/**
 * Shopify Order Operations
 * Handles creation and cancellation of orders from Bitrix deals
 */

import { callShopifyGraphQL } from './adminClient.js';
import { getVariantIdsBySkus } from './hold.js';

// In-memory lock to prevent concurrent order creation for the same deal
const dealIdLocks = new Map();

/**
 * Acquire lock for dealId (returns true if acquired, false if already locked)
 */
function acquireLock(dealId) {
  if (dealIdLocks.has(dealId)) {
    return false; // Already locked
  }
  dealIdLocks.set(dealId, Date.now());
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

  const tag = `BITRIX:${dealId}`;
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
    // Shopify tag search: use quotes for tags with special characters like ':'
    const data = await callShopifyGraphQL(query, {
      query: `tag:'${tag}'`
    });

    if (data?.orders?.edges && data.orders.edges.length > 0) {
      const order = data.orders.edges[0].node;
      const orderId = order.legacyResourceId || order.id.split('/').pop();
      console.log(`[FIND EXISTING ORDER] Found existing order ${orderId} for deal ${dealId} by tag ${tag}`);
      return String(orderId);
    }

    return null;
  } catch (error) {
    console.warn(`[FIND EXISTING ORDER] Error searching for order by tag ${tag}:`, error.message);
    return null; // Don't block order creation if search fails
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
 * @returns {Promise<Object>} Created order data
 */
export async function createOrderFromBitrix(items, dealId, correlationId = null) {
  if (!items || items.length === 0) {
    throw new Error('Items array is required and cannot be empty');
  }

  if (!dealId) {
    throw new Error('Deal ID is required');
  }

  // ✅ CRITICAL STEP 1: Acquire lock IMMEDIATELY to prevent concurrent order creation
  const lockAcquired = acquireLock(dealId);
  if (!lockAcquired) {
    // Another request is creating order - wait and check for existing order multiple times
    console.log(`[CREATE ORDER FROM BITRIX] ⚠️ Lock already held for deal ${dealId}, waiting and checking for existing order...`);
    
    // Wait with multiple checks for existing order
    for (let checkAttempt = 1; checkAttempt <= 10; checkAttempt++) {
      await new Promise(resolve => setTimeout(resolve, 300)); // Wait 300ms between checks
      
      // Check if order already exists
      const existingOrderId = await findExistingOrderByDealId(dealId);
      if (existingOrderId) {
        console.log(`[CREATE ORDER FROM BITRIX] ✅ Found existing order ${existingOrderId} for deal ${dealId} on check attempt ${checkAttempt}`);
        return {
          success: true,
          orderId: existingOrderId,
          orderName: `Existing order ${existingOrderId}`,
          wasDuplicate: true,
          lineItems: [],
          tags: ['TECH', 'BITRIX', `BITRIX:${dealId}`],
          note: `Технический ордер из Bitrix. Сделка: ${dealId}`
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
      return {
        success: true,
        orderId: finalExistingOrderId,
        orderName: `Existing order ${finalExistingOrderId}`,
        wasDuplicate: true,
        lineItems: [],
        tags: ['TECH', 'BITRIX', `BITRIX:${dealId}`],
        note: `Технический ордер из Bitrix. Сделка: ${dealId}`
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
        releaseLock(dealId);
        return {
          success: true,
          orderId: existingOrderId,
          orderName: `Existing order ${existingOrderId}`,
          wasDuplicate: true,
          lineItems: [],
          tags: ['TECH', 'BITRIX', `BITRIX:${dealId}`],
          note: `Технический ордер из Bitrix. Сделка: ${dealId}`
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

  // Build line items with variant IDs
  const lineItems = [];
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
        throw new Error(`Variant ID not found for SKU: ${item.sku}`);
      }
      console.log(`[CREATE ORDER FROM BITRIX] Found variantId by SKU: ${item.sku} -> ${variantId}`);
    } else {
      throw new Error(`Item must have either sku or variantId: ${JSON.stringify(item)}`);
    }

    // GraphQL requires variant ID in format "gid://shopify/ProductVariant/{id}"
    lineItems.push({
      variantId: `gid://shopify/ProductVariant/${variantId}`,
      quantity: item.qty
    });
  }

  // Build tags: ["TECH", "BITRIX", dealId]
  // TECH tag indicates this is a technical order
  const tags = ['TECH', 'BITRIX'];
  if (dealId) {
    tags.push(`BITRIX:${dealId}`);
  }
  if (correlationId) {
    tags.push(`CORR:${correlationId}`);
  }

  // Build note with technical order information
  const note = `Технический ордер из Bitrix. Сделка: ${dealId}${correlationId ? `. CorrelationId: ${correlationId}` : ''}`;

  const mutation = `
    mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        userErrors {
          field
          message
        }
        order {
          id
          name
          legacyResourceId
          confirmed
          tags
          note
          createdAt
          lineItems(first: 250) {
            edges {
              node {
                id
                title
                variant {
                  id
                  sku
                }
                quantity
              }
            }
          }
        }
      }
    }
  `;

  const order_input = {
    lineItems: lineItems,
    tags: tags,
    note: note,
    email: 'hold@bfcshoes.local'
  };

  const options_input = {
    inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', // Reserve inventory (British spelling as per Shopify API)
    sendReceipt: false,
    sendFulfillmentReceipt: false
  };

  const variables = {
    order: order_input,
    options: options_input
  };

  // ✅ CRITICAL STEP 3: Final duplicate checks with delays before creation
  console.log(`[CREATE ORDER FROM BITRIX] Performing final duplicate checks before creating order for deal ${dealId}...`);
  
  // Wait 1.5 seconds to allow any concurrent requests to finish creating their orders
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  // Check 3 more times with delays
  for (let finalCheck = 1; finalCheck <= 3; finalCheck++) {
    const existingOrderId = await findExistingOrderByDealId(dealId);
    if (existingOrderId) {
      console.log(`[CREATE ORDER FROM BITRIX] ⚠️⚠️⚠️ CRITICAL: Existing order ${existingOrderId} found for deal ${dealId} on final check ${finalCheck}. Aborting creation!`);
      releaseLock(dealId);
      return {
        success: true,
        orderId: existingOrderId,
        orderName: `Existing order ${existingOrderId}`,
        wasDuplicate: true,
        lineItems: [],
        tags: tags,
        note: note
      };
    }
    if (finalCheck < 3) {
      await new Promise(resolve => setTimeout(resolve, 400)); // Wait 400ms between final checks
    }
  }
  
  console.log(`[CREATE ORDER FROM BITRIX] ✅ All duplicate checks passed. Proceeding with order creation for deal ${dealId}`);

  try {
    const data = await callShopifyGraphQL(mutation, variables);

    if (!data?.orderCreate) {
      throw new Error('Invalid GraphQL response: orderCreate is missing');
    }

    const { order, userErrors } = data.orderCreate;

    // Check for user errors (business logic errors from Shopify)
    if (userErrors && userErrors.length > 0) {
      const errorMessages = userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify orderCreate userErrors: ${errorMessages}`);
    }

    if (!order) {
      throw new Error('Order creation failed: order is null');
    }

    // Extract numeric order ID from GraphQL ID
    const orderId = order.legacyResourceId || order.id.split('/').pop();

    return {
      success: true,
      order: order,
      orderId: orderId,
      orderName: order.name,
      lineItems: order.lineItems?.edges?.map(e => e.node) || [],
      tags: order.tags || [],
      note: order.note || ''
    };
  } catch (error) {
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

