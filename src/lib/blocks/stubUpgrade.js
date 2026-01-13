/**
 * Stub Upgrade Block Handler
 * Extracted from bitrix.js handleDealUpdate (lines 1824-1884)
 * 
 * Purpose: Kill & Recreate - Cancel stub orders when real products are added
 * Trigger: When shopifyOrderId exists and order has BITRIX_STUB tag
 * 
 * Flow:
 * 1. Check if existing order has BITRIX_STUB tag
 * 2. Check if deal now has real product rows
 * 3. If both true: Cancel the stub order
 * 4. Return shouldClearOrderId=true so main handler can trigger order creation
 */

import { getOrder, callShopifyGraphQL } from '../shopify/adminClient.js';
import { callBitrix } from '../bitrix/client.js';

/**
 * Handle Stub Order Upgrade logic
 * @param {string} shopifyOrderId - Current Shopify order ID
 * @param {string} dealId - Bitrix deal ID
 * @param {string} requestId - Request correlation ID
 * @returns {Promise<{shouldClearOrderId: boolean, cancelled: boolean}>}
 */
export async function handleStubUpgrade(shopifyOrderId, dealId, requestId) {
    if (!shopifyOrderId) {
        return { shouldClearOrderId: false, cancelled: false, reason: 'no_order_id' };
    }

    try {
        const existingOrder = await getOrder(shopifyOrderId);

        if (!existingOrder) {
            return { shouldClearOrderId: false, cancelled: false, reason: 'order_not_found' };
        }

        const tagsStr = existingOrder.tags || '';
        const tags = tagsStr.split(',').map(t => t.trim());

        if (!tags.includes('BITRIX_STUB')) {
            return { shouldClearOrderId: false, cancelled: false, reason: 'not_a_stub' };
        }

        // Check if we now have real products via Bitrix API
        const rowsResp = await callBitrix('crm.deal.productrows.get', { id: dealId });
        const rows = rowsResp?.result || [];

        // If we have real rows (and presumed valid products), kill the stub
        if (rows.length === 0) {
            return { shouldClearOrderId: false, cancelled: false, reason: 'no_real_products' };
        }

        console.log(JSON.stringify({
            event: 'STUB_ORDER_UPGRADE_TRIGGERED',
            requestId,
            dealId,
            shopifyOrderId,
            reason: 'Real products added to stub',
            timestamp: new Date().toISOString()
        }));

        // Cancel the stub via GraphQL to release inventory immediately
        const cancelMutation = `
      mutation orderCancel($orderId: ID!) {
        orderCancel(orderId: $orderId) {
          job {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

        try {
            await callShopifyGraphQL(cancelMutation, { orderId: `gid://shopify/Order/${shopifyOrderId}` });
            console.log(`[STUB UPGRADE] Cancelled stub order ${shopifyOrderId}`);

            return { shouldClearOrderId: true, cancelled: true };
        } catch (cancelErr) {
            console.error(`[STUB UPGRADE] Failed to cancel stub ${shopifyOrderId}:`, cancelErr);
            // Proceed anyway to ensure the new valid order exists
            return { shouldClearOrderId: true, cancelled: false, error: cancelErr.message };
        }

    } catch (stubError) {
        console.warn(`[STUB CHECK FAILED] Could not check/cancel stub order: ${stubError.message}`);
        return { shouldClearOrderId: false, cancelled: false, error: stubError.message };
    }
}

export default { handleStubUpgrade };
