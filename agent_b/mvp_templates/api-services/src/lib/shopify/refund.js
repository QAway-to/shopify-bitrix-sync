/**
 * Shopify Refund Operations
 * Handles refund creation (partial and full) in Shopify
 */

import { callShopifyAdmin, getOrder } from './adminClient.js';

/**
 * Calculate refund amounts using Shopify API
 * @param {string|number} orderId - Shopify order ID
 * @param {Object} refundParams - Refund parameters
 * @param {Array} refundParams.refund_line_items - Array of line items to refund
 * @param {boolean} refundParams.notify - Whether to notify customer
 * @param {string} refundParams.note - Refund note
 * @param {boolean} refundParams.shipping - Whether to refund shipping
 * @returns {Promise<Object>} Calculated refund data
 */
export async function calculateRefund(orderId, refundParams) {
  try {
    const response = await callShopifyAdmin(`/orders/${orderId}/refunds/calculate.json`, {
      method: 'POST',
      body: JSON.stringify({
        refund: refundParams
      })
    });

    return {
      success: true,
      calculatedRefund: response.refund
    };
  } catch (error) {
    return {
      success: false,
      error: 'CALCULATE_REFUND_ERROR',
      message: error.message
    };
  }
}

/**
 * Normalize calculated refund from Shopify API
 * @param {Object} calculatedRefund - Refund object from calculate API
 * @returns {Object} Normalized refund data
 */
function normalizeCalculatedRefund(calculatedRefund) {
  if (!calculatedRefund) {
    return null;
  }

  const normalized = {
    refund_line_items: [],
    transactions: [],
    shipping: calculatedRefund.shipping || null,
    note: calculatedRefund.note || ''
  };

  // Normalize refund_line_items
  if (Array.isArray(calculatedRefund.refund_line_items)) {
    normalized.refund_line_items = calculatedRefund.refund_line_items.map(item => ({
      line_item_id: item.line_item_id,
      quantity: item.quantity,
      restock_type: item.restock_type || 'no_restock'
    }));
  }

  // Normalize transactions (for refund amounts)
  if (Array.isArray(calculatedRefund.transactions)) {
    normalized.transactions = calculatedRefund.transactions.map(txn => ({
      parent_id: txn.parent_id,
      amount: txn.amount,
      kind: txn.kind || 'refund',
      gateway: txn.gateway
    }));
  }

  return normalized;
}

/**
 * Create refund in Shopify
 * @param {string|number} orderId - Shopify order ID
 * @param {Object} refundPayload - Refund payload from normalized action
 * @param {string} correlationId - Correlation ID for tracking
 * @param {string} payloadHash - Payload hash for loop guard
 * @returns {Promise<Object>} Refund creation result
 */
export async function createRefund(orderId, refundPayload, correlationId, payloadHash) {
  if (!orderId) {
    return {
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'Shopify order ID is required for refund'
    };
  }

  try {
    // Step 1: Get order to verify it exists and get line items
    const order = await getOrder(orderId);
    if (!order) {
      return {
        success: false,
        error: 'ORDER_NOT_FOUND',
        message: `Order ${orderId} not found in Shopify`
      };
    }

    // Step 2: Build refund parameters
    const refundParams = {
      notify: false, // Don't notify customer automatically
      note: refundPayload.note || `Refund via middleware. Correlation: ${correlationId}, Hash: ${payloadHash}`
    };

    // Step 3: Handle refund_line_items
    if (refundPayload.items && Array.isArray(refundPayload.items) && refundPayload.items.length > 0) {
      // Partial refund: map items to refund_line_items
      refundParams.refund_line_items = refundPayload.items.map(item => {
        const refundItem = {
          line_item_id: item.line_item_id || null,
          quantity: item.quantity || 0,
          restock_type: item.restock_type || refundPayload.restock_type || 'no_restock'
        };

        // If line_item_id not provided, try to find by SKU
        if (!refundItem.line_item_id && item.sku) {
          const lineItem = order.line_items?.find(li => li.sku === item.sku);
          if (lineItem) {
            refundItem.line_item_id = lineItem.id;
          }
        }

        return refundItem;
      }).filter(item => item.line_item_id && item.quantity > 0);
    } else {
      // Full refund: refund all line items
      refundParams.refund_line_items = (order.line_items || []).map(lineItem => ({
        line_item_id: lineItem.id,
        quantity: lineItem.quantity,
        restock_type: refundPayload.restock_type || 'no_restock'
      }));
    }

    // Step 4: Handle shipping refund
    if (refundPayload.refund_shipping_full) {
      refundParams.shipping = {
        full_refund: true
      };
    }

    // Step 5: Calculate refund first (Shopify best practice)
    const calculateResult = await calculateRefund(orderId, refundParams);
    if (!calculateResult.success) {
      return {
        success: false,
        error: 'CALCULATE_REFUND_FAILED',
        message: calculateResult.message
      };
    }

    // Step 6: Normalize calculated refund
    const normalizedRefund = normalizeCalculatedRefund(calculateResult.calculatedRefund);
    if (!normalizedRefund) {
      return {
        success: false,
        error: 'NORMALIZE_REFUND_FAILED',
        message: 'Failed to normalize calculated refund'
      };
    }

    // Step 7: Create refund
    const refundResponse = await callShopifyAdmin(`/orders/${orderId}/refunds.json`, {
      method: 'POST',
      body: JSON.stringify({
        refund: normalizedRefund
      })
    });

    const refund = refundResponse.refund;

    return {
      success: true,
      refundId: refund.id,
      orderId: String(orderId),
      refundAmount: refund.transactions?.reduce((sum, txn) => sum + parseFloat(txn.amount || 0), 0) || 0,
      refundLineItemsCount: refund.refund_line_items?.length || 0
    };
  } catch (error) {
    return {
      success: false,
      error: 'REFUND_CREATE_ERROR',
      message: error.message,
      httpStatus: error.status || 500
    };
  }
}






