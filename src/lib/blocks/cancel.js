/**
 * Cancel Block Handler
 * Extracted from bitrix.js handleDealUpdate (lines 1897-2062)
 * 
 * Purpose: Cancel Shopify orders when Bitrix deal moves to LOSE stage
 * Trigger: stageId ends with :LOSE, or is CANCELLED/REFUNDED
 * 
 * Flow:
 * 1. Check if stage is LOSE/CANCELLED/REFUNDED
 * 2. If shopifyOrderId exists: Cancel via GraphQL
 * 3. If no shopifyOrderId: Try to find and cancel by BITRIX:{dealId} tag
 * 4. Add BitrixUpdated tag to prevent webhook loop
 */

import { getOrder, callShopifyGraphQL } from '../shopify/adminClient.js';
import { addTagToOrder, cancelOrderByDealId } from '../shopify/order.js';
import { BITRIX_CONFIG } from '../bitrix/config.js';

/**
 * Check if stage is a LOSE stage
 * @param {string} stageId - Bitrix stage ID
 * @returns {boolean}
 */
export function isLoseStage(stageId) {
    return stageId === 'LOSE' ||
        stageId === BITRIX_CONFIG.STAGES.CANCELLED ||
        stageId === BITRIX_CONFIG.STAGES.REFUNDED ||
        (typeof stageId === 'string' && stageId.endsWith(':LOSE'));
}

/**
 * Handle Order Cancellation when deal is in LOSE stage
 * @param {string} shopifyOrderId - Current Shopify order ID (may be empty)
 * @param {string} dealId - Bitrix deal ID
 * @param {string} stageId - Current stage ID
 * @param {string} requestId - Request correlation ID
 * @returns {Promise<{handled: boolean, success?: boolean, action?: string}>}
 */
export async function handleCancel(shopifyOrderId, dealId, stageId, requestId) {
    if (!isLoseStage(stageId)) {
        return { handled: false, reason: 'not_lose_stage' };
    }

    console.log(JSON.stringify({
        event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_CHECK',
        requestId,
        dealId,
        stageId,
        shopifyOrderId: shopifyOrderId || 'not_set',
        timestamp: new Date().toISOString()
    }));

    try {
        // STEP A1: Cancel regular order if shopifyOrderId exists
        if (shopifyOrderId && shopifyOrderId.trim() !== '') {
            try {
                const shopifyOrder = await getOrder(shopifyOrderId);

                if (shopifyOrder) {
                    const orderTags = Array.isArray(shopifyOrder.tags)
                        ? shopifyOrder.tags
                        : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
                    const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));

                    // Cancel order via GraphQL
                    const orderGid = `gid://shopify/Order/${shopifyOrderId}`;
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

                    const cancelData = await callShopifyGraphQL(mutation, { orderId: orderGid });

                    if (cancelData?.orderCancel?.userErrors && cancelData.orderCancel.userErrors.length > 0) {
                        const errorMessages = cancelData.orderCancel.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
                        throw new Error(`Shopify orderCancel userErrors: ${errorMessages}`);
                    }

                    // Add BitrixUpdated tag to prevent webhook loop
                    if (!isBitrixOrder) {
                        await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
                    }

                    console.log(JSON.stringify({
                        event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_SUCCESS',
                        requestId,
                        dealId,
                        stageId,
                        shopifyOrderId,
                        orderName: shopifyOrder.name,
                        isBitrixOrder,
                        jobId: cancelData?.orderCancel?.job?.id,
                        timestamp: new Date().toISOString()
                    }));

                    return {
                        handled: true,
                        success: true,
                        action: 'order_cancelled',
                        shopifyOrderId
                    };
                }
            } catch (regularCancelError) {
                console.log(JSON.stringify({
                    event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_ERROR',
                    requestId,
                    dealId,
                    stageId,
                    shopifyOrderId,
                    error: regularCancelError.message,
                    timestamp: new Date().toISOString()
                }));
                // Continue to try technical order cancellation as fallback
            }
        }

        // STEP A2: Cancel technical order if exists (fallback)
        try {
            const cancelResult = await cancelOrderByDealId(dealId);

            if (cancelResult.success) {
                console.log(JSON.stringify({
                    event: 'BITRIX_TO_SHOPIFY_TECHNICAL_ORDER_CANCEL_SUCCESS',
                    requestId,
                    dealId,
                    stageId,
                    shopifyOrderId: cancelResult.orderId,
                    orderName: cancelResult.orderName,
                    timestamp: new Date().toISOString()
                }));

                return {
                    handled: true,
                    success: true,
                    action: 'technical_order_cancelled',
                    shopifyOrderId: cancelResult.orderId
                };
            } else if (cancelResult.error === 'ORDER_NOT_FOUND') {
                console.log(JSON.stringify({
                    event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_SKIP',
                    requestId,
                    dealId,
                    stageId,
                    skip_reason: 'no_order_found',
                    timestamp: new Date().toISOString()
                }));
                // No order to cancel - continue with normal flow
                return { handled: false, reason: 'no_order_found' };
            } else {
                console.log(JSON.stringify({
                    event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_ERROR',
                    requestId,
                    dealId,
                    stageId,
                    error: cancelResult.error,
                    message: cancelResult.message,
                    timestamp: new Date().toISOString()
                }));
                return { handled: false, reason: 'cancel_failed', error: cancelResult.error };
            }
        } catch (techCancelError) {
            console.log(JSON.stringify({
                event: 'BITRIX_TO_SHOPIFY_TECHNICAL_ORDER_CANCEL_ERROR',
                requestId,
                dealId,
                stageId,
                error: techCancelError.message,
                timestamp: new Date().toISOString()
            }));
            return { handled: false, reason: 'technical_cancel_error', error: techCancelError.message };
        }

    } catch (cancelError) {
        console.error(`[BITRIX TO SHOPIFY] Error cancelling order for deal ${dealId}:`, cancelError);
        console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_EXCEPTION',
            requestId,
            dealId,
            stageId,
            error: cancelError.message,
            timestamp: new Date().toISOString()
        }));
        return { handled: false, reason: 'exception', error: cancelError.message };
    }
}

export default { handleCancel, isLoseStage };
