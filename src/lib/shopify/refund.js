/**
 * Shopify Refund Operations
 * Handles calculating refund amounts and executing refunds via REST API (matching Python script logic)
 * 
 * Logic based on User's Python script:
 * 1. Calculate Refund (POST /refunds/calculate.json)
 * 2. Normalize Transactions (suggested_refund -> refund)
 * 3. Create Refund (POST /refunds.json)
 */

import { callShopifyAdmin, callShopifyGraphQL } from './adminClient.js';

/**
 * Calculate refund amount from order details (Legacy/Helper)
 * Currently unused in new logic which relies on Shopify's "calculate" endpoint
 */
export function calculateRefundAmount(order) {
  if (!order) return null;
  const currency = order.currencyCode || order.totalPriceSet?.shopMoney?.currencyCode || 'EUR';
  const totalAmount = order.totalPriceSet?.shopMoney?.amount || order.totalPrice;
  return { currency, amount: totalAmount, shippingAmount: '0.00' };
}

/**
 * Normalize transactions from 'calculate' response
 * Converts 'suggested_refund' kind to 'refund' for final creation
 * @param {Object} calcRefund - The 'refund' object from calculate response
 * @returns {Array} Normalized transactions
 */
function normalizeTransactions(calcRefund) {
  const txs = calcRefund.transactions || [];
  return txs.map(t => {
    // Clone to avoid mutating original if needed, though here we map
    const newT = { ...t };
    if (newT.kind === 'suggested_refund') {
      newT.kind = 'refund';
    }
    // Remove read-only/calculated fields that might cause issues if sent back
    delete newT.maximum_refundable;
    return newT;
  });
}

/**
 * Create a Refund (Advanced Logic)
 * @param {string} orderId - Shopify Order ID
 * @param {Object} options
 * @param {Array} options.refundLineItems - Array of { line_item_id, quantity, restock_type, location_id }
 * @param {boolean} options.refundShipping - Whether to refund shipping (default false)
 * @param {string} options.note - Note for the refund
 * @returns {Promise<Object>} Result
 */
export async function createRefund(orderId, options = {}) {
  const {
    refundLineItems = [],
    refundShipping = false,
    note = '',
    notify = true
  } = options;

  console.log(`[SHOPIFY REFUND] Initiating refund for order ${orderId}. Items: ${refundLineItems.length}`);

  try {
    // Ensure numeric ID for REST API
    const numericOrderId = String(orderId).replace('gid://shopify/Order/', '');

    // 1. Prepare Payload for Calculation
    const calcPayload = {
      refund: {
        refund_line_items: refundLineItems,
        shipping: { full_refund: refundShipping }
      }
    };

    console.log(`[SHOPIFY REFUND] Calculating refund...`);

    // 2. Call Calculate Endpoint
    // POST /admin/api/{version}/orders/{order_id}/refunds/calculate.json
    const calcResponse = await callShopifyAdmin(`/orders/${numericOrderId}/refunds/calculate.json`, {
      method: 'POST',
      body: JSON.stringify(calcPayload)
    });

    const calculatedRefund = calcResponse.refund;

    // 2.5 Override transactions if explicit amount provided (Reconciliation Mode)
    if (options.amount && parseFloat(options.amount) > 0) {
      console.log(`[SHOPIFY REFUND] Overriding calculated refund with explicit amount: ${options.amount}`);
      calculatedRefund.transactions = [{
        parent_id: calculatedRefund.transactions?.[0]?.parent_id || null, // Best effort to link to parent
        amount: options.amount,
        kind: 'refund',
        gateway: 'manual', // Default, will likely be overridden by parent_id if present
        currency: options.currency || 'EUR'
      }];
      // If parent_id exists (from previous calculation), use it
      if (calcResponse.refund.transactions?.[0]?.parent_id) {
        calculatedRefund.transactions[0].parent_id = calcResponse.refund.transactions[0].parent_id;
        delete calculatedRefund.transactions[0].gateway; // Let Shopify determine gateway from parent
      }
    }

    // 3. Normalize Transactions
    calculatedRefund.transactions = normalizeTransactions(calculatedRefund);
    calculatedRefund.note = note;
    if (notify !== undefined) calculatedRefund.notify = notify; // 'notify' might be a top-level field or inside? REST API usually takes 'notify' at root of POST, but here we embed in 'refund' object for creation? 
    // Wait, POST /refunds.json takes { refund: { ... } }. 'notify' is usually passed? 
    // Checking docs/script: Script doesn't explicitly send 'notify' in final POST, but maybe defaults?
    // We will inject 'notify' into the refund object if needed, or check API. 
    // Actually, 'notify' (boolean) is a property of the Refund resource in creation.
    calculatedRefund.notify = notify;

    console.log(`[SHOPIFY REFUND] Creating final refund...`);

    // 4. Create Final Refund
    // POST /admin/api/{version}/orders/{order_id}/refunds.json
    const ensureUniqueHeaders = {
      "X-Shopify-Api-Features": "include-presentment-prices" // Good practice
    };

    const createResponse = await callShopifyAdmin(`/orders/${numericOrderId}/refunds.json`, {
      method: 'POST',
      body: JSON.stringify({ refund: calculatedRefund }),
      headers: ensureUniqueHeaders
    });

    const finalRefund = createResponse.refund;
    console.log(`[SHOPIFY REFUND] ✅ Refund created: ${finalRefund.id}`);

    return {
      success: true,
      refundId: finalRefund.id,
      amount: finalRefund.transactions?.[0]?.amount || '0.00' // Approximation
    };

  } catch (error) {
    console.error(`[SHOPIFY REFUND] ❌ Error creating refund:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

