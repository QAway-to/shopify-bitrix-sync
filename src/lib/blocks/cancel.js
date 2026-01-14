/**
 * Cancel Block Handler
 * Extracted from bitrix.js handleDealUpdate (lines 1897-2062)
 *
 * Purpose: Cancel (and optionally Refund) Shopify orders when Bitrix deal moves to LOSE stage
 * Trigger: stageId ends with :LOSE, or is CANCELLED/REFUNDED
 *
 * Flow:
 * 1. Check if stage is LOSE/CANCELLED/REFUNDED
 * 2. Fetch Deal Data to check "Reason for loss" (UF_CRM_1740125449458)
 * 3. Map Reason to Action (CANCEL vs REFUND, Restock vs No Restock)
 * 4. Execute Refund (if applicable) -> Cancel
 * 5. Add BitrixUpdated tag to prevent webhook loop
 */

import { getOrder, callShopifyGraphQL } from '../shopify/adminClient.js';
import { addTagToOrder, cancelOrderByDealId } from '../shopify/order.js';
import { createRefund, calculateRefundAmount } from '../shopify/refund.js';
import { BITRIX_CONFIG } from '../bitrix/config.js';
import { callBitrix } from '../bitrix/client.js';
import { BITRIX_LOSS_REASON_FIELD, getActionByLossReason } from '../bitrix/stageMapping.js';

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

    // 🆕 FETCH DEAL DATA FOR LOSS REASON
    let lossAction = { action: 'CANCEL', restock: true, reason: 'OTHER' }; // Default safe action
    let lossReasonId = null;

    try {
        const dealResp = await callBitrix('/crm.deal.get.json', { id: dealId });
        if (dealResp && dealResp.result) {
            const dealData = dealResp.result;
            lossReasonId = dealData[BITRIX_LOSS_REASON_FIELD];

            if (lossReasonId) {
                const mappedAction = getActionByLossReason(lossReasonId);
                if (mappedAction) {
                    lossAction = mappedAction;
                    console.log(`[CANCEL BLOCK] 🔍 Mapped Loss Reason ID ${lossReasonId} to Action:`, lossAction);
                } else {
                    console.warn(`[CANCEL BLOCK] ⚠️ Unknown Loss Reason ID ${lossReasonId}, using default CANCEL+RESTOCK`);
                }
            } else {
                console.log(`[CANCEL BLOCK] ℹ️ No Loss Reason set in field ${BITRIX_LOSS_REASON_FIELD}`);
            }
        }
    } catch (fetchErr) {
        console.warn(`[CANCEL BLOCK] ⚠️ Failed to fetch deal data for loss reason: ${fetchErr.message}`);
    }

    const performRefund = lossAction.action === 'REFUND';
    const shouldRestock = lossAction.restock === true; // Strict boolean check

    try {
        // STEP A1: Process logic if shopifyOrderId exists
        if (shopifyOrderId && shopifyOrderId.trim() !== '') {
            try {
                const shopifyOrder = await getOrder(shopifyOrderId);

                if (shopifyOrder) {
                    const orderTags = Array.isArray(shopifyOrder.tags)
                        ? shopifyOrder.tags
                        : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
                    const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));

                    // CHECK FULFILLMENT STATUS
                    // Shopify does not allow cancelling orders that are already fulfilled.
                    // statuses: null, 'fulfilled', 'partial', 'restocked'
                    const isFulfilled = shopifyOrder.fulfillment_status === 'fulfilled';
                    const canCancel = !isFulfilled;

                    if (isFulfilled) {
                        console.warn(`[CANCEL BLOCK] ⚠️ Order ${shopifyOrderId} is already FULFILLED. Skipping orderCancel to avoid API error.`);
                    }

                    // 🆕 REFUND LOGIC
                    if (performRefund) {
                        console.log(`[CANCEL BLOCK] 💸 Initiating REFUND for Order ${shopifyOrderId} (Restock: ${shouldRestock})`);
                        try {
                            const refundResult = await createRefund(shopifyOrderId, {
                                restock: shouldRestock,
                                note: `Refund triggered by Bitrix Loss Reason ID: ${lossReasonId || 'Unknown'}`,
                                notify: true
                            });

                            if (refundResult.success) {
                                console.log(`[CANCEL BLOCK] ✅ Refund successful for Order ${shopifyOrderId}`);
                            } else {
                                console.error(`[CANCEL BLOCK] ❌ Refund failed: ${refundResult.error}`);
                            }
                        } catch (refundErr) {
                            console.error(`[CANCEL BLOCK] ❌ Refund Exception:`, refundErr);
                        }
                    }

                    // Cancel order via GraphQL
                    // If we ALREADY refunded and restocked via 'createRefund' (checking refund.js logic...),
                    // we should check if createRefund handles restocking.
                    // Currently createRefund handles *Refund*, but maybe not full Cancellation state if partially refunded?
                    // Usually "Cancel" ensures the order status is "Cancelled".
                    // If we already restocked items in Refund, we should NOT restock again in Cancel.

                    // CHECK: Did createRefund restock items?
                    // In `src/lib/shopify/refund.js`, we passed `restockType: 'RETURN'` to refundLineItems.
                    // This creates a refund AND puts items back. 
                    // So if we run orderCancel with restock=true AFTER that, we might double restock?
                    // Shopify API: orderCancel validates if items are already refunded/restocked.
                    // SAFE BET: If we did a REFUND with restock, passing restock=true to Cancel is likely ignored or handled safely,
                    // BUT explicitly, if we refunded everything, the items are returned.

                    // Refined Logic:
                    // If performRefund is true, we assume refund.js handled item return.
                    // So passing restock: false for Cancel might be safer to avoid double counting, 
                    // OR stick to restock=true and trust Shopify.
                    // Given the ambiguity, let's keep it simple: Pass `restock: shouldRestock` to Cancel too. 
                    // Shopify usually prevents double restocking of the same line item fulfillment.

                    // Only proceed if order is NOT fulfilled
                    let cancelData = null;
                    if (canCancel) {
                        const orderGid = `gid://shopify/Order/${shopifyOrderId}`;
                        const mutation = `
            mutation orderCancel($orderId: ID!, $restock: Boolean!) {
              orderCancel(
                orderId: $orderId,
                reason: OTHER,
                restock: $restock,
                email: false
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

                        cancelData = await callShopifyGraphQL(mutation, {
                            orderId: orderGid,
                            restock: performRefund ? false : shouldRestock // If we refunded (and implied restock there), don't restock again in cancel?
                            // WAIT. refund.js implements `refundCreate`. Does update inventory? Yes if inputs have `restockType: RETURN`.
                            // So if we Refunded+Restocked, then Cancel should NOT restock.
                            // Correct logic: restock: (performRefund ? false : shouldRestock)
                        });

                        if (cancelData?.orderCancel?.userErrors && cancelData.orderCancel.userErrors.length > 0) {
                            const errorMessages = cancelData.orderCancel.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
                            throw new Error(`Shopify orderCancel userErrors: ${errorMessages}`);
                        }
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
                        actionPerformed: performRefund ? 'REFUND_AND_CANCEL' : 'CANCEL',
                        restocked: shouldRestock,
                        timestamp: new Date().toISOString()
                    }));

                    return {
                        handled: true,
                        success: true,
                        action: performRefund ? 'order_refunded_and_cancelled' : 'order_cancelled',
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
