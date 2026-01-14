/**
 * Shopify Refund Operations
 * Handles calculating refund amounts and executing refunds via GraphQL
 */

import { callShopifyGraphQL } from './adminClient.js';

/**
 * Calculate refund amount from order details
 * Currently supports Full Refund strategy
 * @param {Object} order - Shopify Order object
 * @returns {Object} Refund payload components { currency, amount, shippingAmount }
 */
export function calculateRefundAmount(order) {
  if (!order) return null;

  const currency = order.currencyCode || order.totalPriceSet?.shopMoney?.currencyCode || 'EUR';

  // Total logic: Refund everything that was paid
  // Use totalPriceSet if available for accuracy
  const totalAmount = order.totalPriceSet?.shopMoney?.amount || order.totalPrice;

  // ⚠️ NOTE: For now, we assume FULL REFUND including shipping
  // If logical separation needed (e.g. shipping not refunded), modify here

  return {
    currency,
    amount: totalAmount,
    shippingAmount: '0.00' // If we want to refund shipping explicitly, we need line items. For now, we'll try to refund line items + shipping via "refund line items" logic or "restock" logic.
  };
}

/**
 * Connect to Shopify to creating a Refund
 * @param {string} orderId - Shopify Order ID (GID or legacy)
 * @param {Object} options - { restock: boolean, reason: string, note: string }
 * @returns {Promise<Object>} Refund result
 */
export async function createRefund(orderId, options = {}) {
  const {
    restock = true,
    note = '',
    notify = true
  } = options;

  console.log(`[SHOPIFY REFUND] Initiating refund for order ${orderId}. Options:`, options);

  try {
    const orderGid = orderId.toString().startsWith('gid://')
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    // 1. Fetch Order Line Items to calculate refund
    // We need line item GIDs to refund them
    const query = `
      query getOrderLines($id: ID!) {
        order(id: $id) {
          id
          email
          lineItems(first: 50) {
            edges {
              node {
                id
                quantity
                variant {
                  id
                }
              }
            }
          }
        }
      }
    `;

    const orderData = await callShopifyGraphQL(query, { id: orderGid });
    if (!orderData || !orderData.order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const lineItemsToRefund = orderData.order.lineItems.edges.map(edge => ({
      lineItemId: edge.node.id,
      quantity: edge.node.quantity,
      restockType: restock ? 'RETURN' : 'NO_RESTOCK', // RETURN = restock based on location, NO_RESTOCK = do nothing
      locationId: null // Optional: specify location if 'RETURN' needs specific location context (usually auto)
    }));

    if (lineItemsToRefund.length === 0) {
      console.warn(`[SHOPIFY REFUND] No line items to refund for order ${orderId}`);
      return { success: false, reason: 'no_line_items' };
    }

    // 2. Perform Refund Mutation
    // logic: refundOrder mutation (Calculator-based is newer, but 'refundCreate' handles manual calc)
    // We will use 'refundCreate' which is standard for creating refunds with line items
    const mutation = `
      mutation refundCreate($input: RefundInput!) {
        refundCreate(input: $input) {
          refund {
            id
            totalRefundedSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const input = {
      orderId: orderGid,
      note: note,
      notify: notify,
      refundLineItems: lineItemsToRefund,
      // For shipping refund:
      // shipping: { fullRefund: true } // Optional: refund shipping cost fully
    };

    console.log(`[SHOPIFY REFUND] Sending mutation:`, JSON.stringify(input, null, 2));

    const result = await callShopifyGraphQL(mutation, { input });

    if (result?.refundCreate?.userErrors?.length > 0) {
      const errors = result.refundCreate.userErrors.map(e => `${e.field}: ${e.message}`).join(', ');
      throw new Error(`Refund failed: ${errors}`);
    }

    const refundId = result?.refundCreate?.refund?.id;
    const amount = result?.refundCreate?.refund?.totalRefundedSet?.shopMoney?.amount;

    console.log(`[SHOPIFY REFUND] ✅ Refund created: ${refundId}, Amount: ${amount}`);

    return {
      success: true,
      refundId,
      amount
    };

  } catch (error) {
    console.error(`[SHOPIFY REFUND] ❌ Error creating refund:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}
