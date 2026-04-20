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

import { logger } from '../logging/logger.js';
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

    logger.info('order_cancel_check', 'Order cancel check', { requestId, dealId, stageId, shopifyOrderId: shopifyOrderId || 'not_set' });

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
                    logger.info('order_cancel_loss_reason_mapped', 'Mapped loss reason to action', { dealId, lossReasonId, lossAction });
                } else {
                    logger.warn('order_cancel_unknown_loss_reason', 'Unknown loss reason ID, using default CANCEL+RESTOCK', { dealId, lossReasonId });
                }
            } else {
                logger.info('order_cancel_no_loss_reason', 'No loss reason set', { dealId, field: BITRIX_LOSS_REASON_FIELD });
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
                        logger.warn('order_cancel_skip_fulfilled', 'Order is already fulfilled, skipping cancel', { shopifyOrderId, dealId });
                    }

                    // ✅ FIX: Check if order is ALREADY CANCELLED to prevent loop
                    // If Bitrix sends "LOSE" update -> we try to cancel -> if already cancelled, we MUST stop here
                    // otherwise we might update tags/notes which triggers Shopify webhook -> Bitrix update -> Loop
                    if (shopifyOrder.cancelled_at) {
                        logger.info('order_already_cancelled', 'Order already cancelled, skipping to prevent loop', { shopifyOrderId, dealId, cancelledAt: shopifyOrder.cancelled_at });
                        return {
                            handled: true,
                            success: true,
                            action: 'already_cancelled_loop_prevention',
                            shopifyOrderId
                        };
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
                            logger.info('order_cancel_overpayment_detected', 'Overpayment detected, initiating reconciliation refund', { shopifyOrderId, dealId, overpayment, currency });
                            const reconciliationResult = await createRefund(shopifyOrderId, {
                                amount: String(overpayment),
                                currency: currency,
                                note: `Reconciliation Refund (Bitrix Loss/Removal)`,
                                notify: true
                            });
                            if (reconciliationResult.success) {
                                logger.info('order_cancel_reconciliation_created', 'Reconciliation Refund created', { shopifyOrderId, dealId, overpayment, currency });
                            } else {
                                logger.warn('order_cancel_reconciliation_failed', 'Reconciliation refund failed', { shopifyOrderId, dealId, error: reconciliationResult.error });
                            }
                        }
                    } catch (reconError) {
                        logger.warn('order_cancel_reconciliation_error', 'Error during reconciliation check', { shopifyOrderId, dealId, error: reconError.message });
                    }

                    // Determine Strategy
                    let doRefund = false;
                    let doCancel = false;

                    if (isFulfilled) {
                        // Must use Refund logic (Diff)
                        doRefund = true;
                        doCancel = false;
                        logger.info('order_cancel_strategy_refund_forced', 'Order is fulfilled, forcing REFUND strategy, cancel disabled', { shopifyOrderId, dealId });
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
                                logger.info('order_cancel_strategy_override', 'Action is REFUND but order is UNPAID, switching to CANCEL strategy', { shopifyOrderId, dealId, financialStatus: shopifyOrder.financial_status });
                            }
                        } else {
                            // Action === 'REFUND' AND Order is PAID/PARTIALLY_PAID
                            doRefund = true; // Refund specific items (Diff)
                            doCancel = false; // Don't cancel the rest (keep as Refunded state)
                        }
                    }

                    // STEP 1: CALCULATE DIFF & REFUND
                    if (doRefund) {

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
                                    logger.warn('order_cancel_product_resolve_error', 'Failed to resolve Bitrix product', { dealId, productId: row.PRODUCT_ID, error: e.message });
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
                            logger.info('order_cancel_refund_diff', 'Refund diff calculated', { shopifyOrderId, dealId, itemsToRefund });
                            try {
                                const refundResult = await createRefund(shopifyOrderId, {
                                    refundLineItems: itemsToRefund,
                                    refundShipping: fullRefundCalc,
                                    note: `Refund triggered by Bitrix Loss Reason ID: ${lossReasonId}. Mode: ${fullRefundCalc ? 'FULL' : 'PARTIAL'}`,
                                    notify: true
                                });
                                if (refundResult.success) {
                                    logger.info('order_cancel_refund_success', 'Refund successful', { shopifyOrderId, dealId, mode: fullRefundCalc ? 'FULL' : 'PARTIAL' });
                                } else {
                                    logger.warn('order_cancel_refund_failed', 'Refund failed', { shopifyOrderId, dealId, error: refundResult.error, mode: fullRefundCalc ? 'FULL' : 'PARTIAL' });
                                }
                            } catch (refundErr) {
                                logger.error('order_cancel_refund_exception', 'Refund exception', { shopifyOrderId, dealId, error: refundErr.message });
                            }
                        } else {
                            logger.info('order_cancel_no_refund_needed', 'No refund required, Shopify and Bitrix items match', { shopifyOrderId, dealId });
                        }
                    }

                    // STEP 2: CANCEL ORDER
                    if (doCancel && canCancel) {
                        logger.info('order_cancel_executing', 'Executing full order cancel', { shopifyOrderId, dealId, reason: lossAction.reason });
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
                                logger.info('order_already_cancelled', 'Order already cancelled, ignoring error', { shopifyOrderId, dealId });
                            } else {
                                logger.warn('order_cancel_graphql_warnings', 'Cancel warnings from GraphQL', { shopifyOrderId, dealId, userErrors: cancelData.orderCancel.userErrors });
                            }
                        } else {
                            logger.info('order_cancel_success', 'Order cancelled successfully', { shopifyOrderId, dealId });
                        }
                    } else {
                        if (!canCancel) {
                            logger.info('order_cancel_skip', 'Skipping cancellation, order fulfilled or strategy override', { shopifyOrderId, dealId });
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
                    logger.info('order_already_cancelled', 'Order already cancelled (caught exception)', { shopifyOrderId, dealId });
                    return {
                        handled: true,
                        success: true,
                        action: 'order_already_cancelled',
                        shopifyOrderId
                    };
                }

                logger.warn('order_cancel_detail_error', 'Error during detail processing', { shopifyOrderId, dealId, error: regularCancelError.message });
                // Proceed to fallback?
            }
        }


        // STEP A2: Cancel technical order if exists (fallback)
        try {
            const cancelResult = await cancelOrderByDealId(dealId);

            if (cancelResult.success) {
                logger.info('order_cancelled', 'Order cancelled', { orderId: cancelResult.orderId, dealId });

                return {
                    handled: true,
                    success: true,
                    action: 'technical_order_cancelled',
                    shopifyOrderId: cancelResult.orderId
                };
            } else if (cancelResult.error === 'ORDER_NOT_FOUND') {
                logger.info('order_cancel_skip_no_order', 'No order found to cancel', { dealId, stageId });
                // No order to cancel - continue with normal flow
                return { handled: false, reason: 'no_order_found' };
            } else {
                logger.warn('order_cancel_error', 'Order cancel failed', { dealId, stageId, error: cancelResult.error, message: cancelResult.message });
                return { handled: false, reason: 'cancel_failed', error: cancelResult.error };
            }
        } catch (techCancelError) {
            logger.error('order_technical_cancel_error', 'Technical order cancel error', { dealId, stageId, error: techCancelError.message });
            return { handled: false, reason: 'technical_cancel_error', error: techCancelError.message };
        }

    } catch (cancelError) {
        logger.error('order_cancel_failed', 'Cancel failed', { orderId: shopifyOrderId, dealId, error: cancelError.message });
        return { handled: false, reason: 'exception', error: cancelError.message };
    }
}

export default { handleCancel, isLoseStage };
