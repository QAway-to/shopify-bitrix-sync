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

    // 🆕 FETCH DEAL DATA SENSITIVELY
    let lossAction = { action: 'CANCEL', restock: true, reason: 'OTHER' };
    let lossReasonId = null;

    try {
        // Fetch Deal + Product Rows to calculate "Diff" for Refund
        const dealResp = await callBitrix('/crm.deal.get.json', { id: dealId });
        const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', { id: dealId });

        const dealData = dealResp?.result;
        const bitrixRows = productRowsResp?.result || []; // If empty, could mean all deleted or never added

        if (dealData) {
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

        const performRefund = lossAction.action === 'REFUND';
        const shouldRestock = lossAction.restock === true;

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
                    const isFulfilled = shopifyOrder.fulfillment_status === 'fulfilled';
                    const canCancel = !isFulfilled; // Prevent canceling fulfilled orders

                    if (isFulfilled) {
                        console.warn(`[CANCEL BLOCK] ⚠️ Order ${shopifyOrderId} is already FULFILLED. Skipping orderCancel part.`);
                    }

                    // STEP 0.5: RECONCILIATION REFUND (If items were removed previously)
                    try {
                        const totalReceived = parseFloat(shopifyOrder.total_received_set?.shop_money?.amount || shopifyOrder.total_price_set?.shop_money?.amount || shopifyOrder.total_price || '0');
                        // Note: total_received is often on root in REST, but safer to check structure or fallback.
                        // Actually REST API provided 'shopifyOrder' usually has 'total_received' at root?
                        // Let's use robust extraction.
                        const receivedAmount = parseFloat(shopifyOrder.total_received || '0');
                        const currentTotal = parseFloat(shopifyOrder.current_total_price || '0');
                        const overpayment = receivedAmount - currentTotal;
                        const currency = shopifyOrder.currency || 'EUR';

                        if (overpayment > 0.01) {
                            console.log(`[CANCEL BLOCK] 💰 Detected Overpayment of ${overpayment} ${currency}. Initiating Reconciliation Refund...`);
                            const reconciliationResult = await createRefund(shopifyOrderId, {
                                amount: String(overpayment),
                                currency: currency,
                                note: `Reconciliation Refund (Bitrix Loss/Removal)`,
                                notify: true
                            });
                            if (reconciliationResult.success) {
                                console.log(`[CANCEL BLOCK] ✅ Reconciliation Refund created.`);
                            } else {
                                console.warn(`[CANCEL BLOCK] ⚠️ Reconciliation Refund failed: ${reconciliationResult.error}`);
                            }
                        }
                    } catch (reconError) {
                        console.warn(`[CANCEL BLOCK] ⚠️ Error during reconciliation check: ${reconError.message}`);
                    }

                    // Determine Strategy
                    let doRefund = false;
                    let doCancel = false;

                    if (isFulfilled) {
                        // Must use Refund logic (Diff)
                        doRefund = true;
                        doCancel = false;
                        console.log(`[CANCEL BLOCK] ⚠️ Order is FULFILLED. Forcing REFUND strategy (Diff Only). Cancel disabled.`);
                    } else {
                        // Unfulfilled
                        // Unfulfilled
                        // ✅ FIX: If order is UNPAID (pending), we should CANCEL it even if action is REFUND
                        // (Because you cannot "refund" money that wasn't taken, and "Refund" action implies VOIDING the transaction for unpaid orders)
                        const isUnpaid = shopifyOrder.financial_status === 'pending' || shopifyOrder.financial_status === 'authorized';

                        if (lossAction.action === 'CANCEL' || (lossAction.action === 'REFUND' && isUnpaid)) {
                            doRefund = false; // Void/Cancel entire order (Refund not needed if unpaid)
                            doCancel = true;
                            if (isUnpaid && lossAction.action === 'REFUND') {
                                console.log(`[CANCEL BLOCK] ℹ️ Action is REFUND but order is UNPAID. Switching to CANCEL strategy.`);
                            }
                        } else {
                            // Action === 'REFUND' AND Order is PAID/PARTIALLY_PAID
                            doRefund = true; // Refund specific items (Diff)
                            doCancel = false; // Don't cancel the rest (keep as Refunded state)
                        }
                    }

                    // STEP 1: CALCULATE DIFF & REFUND
                    if (doRefund) {
                        console.log(`[CANCEL BLOCK] 🔄 Calculating Item Diff for Refund...`);

                        // 1. Map Shopify Items (ID -> Qty)
                        const shopifyItemsMap = {};
                        shopifyOrder.line_items.forEach(item => {
                            if (item.variant_id) {
                                shopifyItemsMap[item.variant_id] = item;
                            }
                        });

                        // 1.5 Calculate Already Refunded Quantities
                        const refundedQtyMap = {}; // LineItemID -> Qty
                        if (shopifyOrder.refunds && Array.isArray(shopifyOrder.refunds)) {
                            shopifyOrder.refunds.forEach(refund => {
                                if (refund.refund_line_items && Array.isArray(refund.refund_line_items)) {
                                    refund.refund_line_items.forEach(rli => {
                                        const liId = rli.line_item_id;
                                        refundedQtyMap[liId] = (refundedQtyMap[liId] || 0) + rli.quantity;
                                    });
                                }
                            });
                        }

                        // 2. Map Bitrix Rows (VariantID -> Qty)
                        const bitrixItemMap = {};
                        if (bitrixRows && bitrixRows.length > 0) {
                            for (const row of bitrixRows) {
                                try {
                                    const prod = await callBitrix('crm.product.get', { id: row.PRODUCT_ID });
                                    const xmlId = prod?.result?.XML_ID || prod?.result?.ORIGIN_ID;
                                    if (xmlId) {
                                        bitrixItemMap[Number(xmlId)] = (bitrixItemMap[Number(xmlId)] || 0) + row.QUANTITY;
                                    }
                                } catch (e) {
                                    console.warn(`[CANCEL BLOCK] Failed to resolve Bitrix Product ${row.PRODUCT_ID}`, e);
                                }
                            }
                        }

                        // 3. Calculate Diff
                        const itemsToRefund = [];
                        let fullRefundCalc = true;

                        for (const [variantIdStr, shopItem] of Object.entries(shopifyItemsMap)) {
                            const variantId = Number(variantIdStr);
                            const bitrixQty = bitrixItemMap[variantId] || 0;
                            const originalShopQty = shopItem.quantity;
                            const alreadyRefunded = refundedQtyMap[shopItem.id] || 0;
                            const activeShopQty = originalShopQty - alreadyRefunded; // The quantity currently "owned"

                            const refundQty = activeShopQty - bitrixQty;

                            if (bitrixQty > 0) fullRefundCalc = false; // If keeping any item, it's partial

                            // Only refund if we have positive active quantity to refund
                            if (refundQty > 0) {
                                itemsToRefund.push({
                                    line_item_id: shopItem.id,
                                    quantity: refundQty,
                                    restock_type: shouldRestock ? 'return' : 'no_restock',
                                    location_id: 98948808968
                                });
                            }
                        }

                        if (itemsToRefund.length > 0) {
                            console.log(`[CANCEL BLOCK] 📉 Refund Diff Calculated:`, itemsToRefund);
                            try {
                                const refundResult = await createRefund(shopifyOrderId, {
                                    refundLineItems: itemsToRefund,
                                    refundShipping: fullRefundCalc,
                                    note: `Refund triggered by Bitrix Loss Reason ID: ${lossReasonId}. Mode: ${fullRefundCalc ? 'FULL' : 'PARTIAL'}`,
                                    notify: true
                                });
                                if (refundResult.success) {
                                    console.log(`[CANCEL BLOCK] ✅ Refund successful (Mode: ${fullRefundCalc ? 'FULL' : 'PARTIAL'})`);
                                } else {
                                    console.error(`[CANCEL BLOCK] ❌ Refund failed: ${refundResult.error}`);
                                }
                            } catch (refundErr) {
                                console.error(`[CANCEL BLOCK] ❌ Refund Exception:`, refundErr);
                            }
                        } else {
                            console.log(`[CANCEL BLOCK] ℹ️ No refund required (Shopify & Bitrix items match).`);
                        }
                    }

                    // STEP 2: CANCEL ORDER
                    if (doCancel && canCancel) {
                        console.log(`[CANCEL BLOCK] 🚫 Executing Full Order Cancel (Reason: ${lossAction.reason})...`);
                        const orderGid = `gid://shopify/Order/${shopifyOrderId}`;
                        const mutation = `
                        mutation orderCancel($orderId: ID!, $restock: Boolean!) {
                          orderCancel(
                            orderId: $orderId,
                            reason: OTHER,
                            restock: $restock
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
                            restock: doRefund ? false : shouldRestock
                        });

                        if (cancelData?.orderCancel?.userErrors && cancelData.orderCancel.userErrors.length > 0) {
                            const errorMessages = cancelData.orderCancel.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');

                            // Check if order is already cancelled - treat as success
                            if (errorMessages.includes('already been canceled') || errorMessages.includes('already cancelled')) {
                                console.log(`[CANCEL BLOCK] ℹ️ Order ${shopifyOrderId} is already cancelled, ignoring error.`);
                            } else {
                                console.warn(`[CANCEL BLOCK] Cancel Warnings:`, cancelData.orderCancel.userErrors);
                            }
                        } else {
                            console.log(`[CANCEL BLOCK] 🚫 Order Cancelled Successfully`);
                        }
                    } else {
                        if (!canCancel) {
                            console.log(`[CANCEL BLOCK] ⏭️ Skipping Cancellation (Order Fulfilled or strategy)`);
                        }
                    }

                    if (!isBitrixOrder) await addTagToOrder(shopifyOrderId, 'BitrixUpdated');

                    return {
                        handled: true,
                        success: true,
                        action: doRefund ? 'order_refunded_logic_executed' : 'order_cancelled',
                        shopifyOrderId
                    };
                } // Close if (shopifyOrder)
            } catch (regularCancelError) {
                // If it's the "already cancelled" error from inside callShopifyGraphQL (unlikely but possible if it throws)
                if (regularCancelError.message && (regularCancelError.message.includes('already been canceled') || regularCancelError.message.includes('already cancelled'))) {
                    console.log(`[CANCEL BLOCK] ℹ️ Order ${shopifyOrderId} was already cancelled (caught exception).`);
                    return {
                        handled: true,
                        success: true,
                        action: 'order_already_cancelled',
                        shopifyOrderId
                    };
                }

                console.log(`[CANCEL BLOCK] Error during detail processing: ${regularCancelError.message}`);
                // Proceed to fallback?
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
