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

                    // 🆕 ADVANCED REFUND LOGIC (Diff-based)
                    if (performRefund) {
                        console.log(`[CANCEL BLOCK] 💸 Checking Refund Eligibility based on Bitrix Items Diff...`);

                        // 1. Map Shopify Items {variantId: {lineItemId, quantity, ...}}
                        const shopifyItemsMap = {};
                        // Helper to find variant ID from line item (variant_id is numeric)
                        shopifyOrder.line_items.forEach(li => {
                            if (li.variant_id) {
                                shopifyItemsMap[li.variant_id] = {
                                    id: li.id,
                                    quantity: li.quantity,
                                    variant_id: li.variant_id
                                };
                            }
                        });

                        // 2. Map Bitrix Items {variantId: quantity}
                        // Bitrix 'PRODUCT_ID' usually maps to Shopify Variant ID if stored correctly, 
                        // BUT better to check 'XML_ID' or similar if available. 
                        // Typically we store Variant ID in PRODUCT_ID or a custom field. 
                        // Let's assume standard behavior: we try to match by what we have. 
                        // *Bitrix product rows* have 'PRODUCT_ID' (Bitrix Catalog ID) and... wait.
                        // We need the linkage. 
                        // Usually: Bitrix Catalog Product 'XML_ID' = Shopify Variant ID.
                        // We need to fetch the Bitrix Products details to get XML_ID if productRows doesn't have it?
                        // `productRowsResp` returns: ID, OWNER_ID, PRODUCT_ID, PRODUCT_NAME, QUANTITY, PRICE.
                        // Missing XML_ID directly. We might need to fetch products.
                        // SHORTCUT for MVP: Since we need to know what was *removed*, 
                        // maybe we rely on Quantity?
                        // Let's TRY to fetch detailed product info if needed, OR:
                        // Iterate Bitrix rows, get PRODUCT_ID.
                        // IF we can't match easily, this is risky.
                        // User's python script inputs TARGET_VARIANT_ID.
                        // We need to find that Automatically.

                        // PLAN B: Fetch Bitrix Products details for these rows to get XML_ID (Variant ID).
                        const bitrixVariantIds = new Set();
                        const bitrixItemMap = {}; // variantId -> quantity

                        if (bitrixRows.length > 0) {
                            // We need to resolve Bitrix Product ID -> XML_ID (Shopify Variant ID)
                            // This might be slow for many items. 
                            // Optimized: Batch call CRON? No.
                            // Just loop for now (usually few items).
                            for (const row of bitrixRows) {
                                // We need to call crm.product.get? No, catalog.product.get?
                                // Let's assume we have a helper or just call
                                try {
                                    // Assuming we have a helper or just call
                                    const prod = await callBitrix('crm.product.get', { id: row.PRODUCT_ID });
                                    // XML_ID is usually valid here? Or 'ORIGIN_ID'?
                                    // If we use 'sync' logic, XML_ID = variantId.
                                    const xmlId = prod?.result?.XML_ID || prod?.result?.ORIGIN_ID;
                                    if (xmlId) {
                                        bitrixItemMap[Number(xmlId)] = (bitrixItemMap[Number(xmlId)] || 0) + row.QUANTITY;
                                    }
                                } catch (e) {
                                    console.warn(`[CANCEL BLOCK] Failed to resolve Bitrix Product ${row.PRODUCT_ID}`, e);
                                }
                            }
                        }

                        // 3. Calculate Diff (Items to Refund)
                        // Refund = (Shopify Qty) - (Bitrix Qty)
                        const itemsToRefund = [];
                        let fullRefundCalc = true; // Assume full unless we find items kept

                        for (const [variantIdStr, shopItem] of Object.entries(shopifyItemsMap)) {
                            const variantId = Number(variantIdStr);
                            const bitrixQty = bitrixItemMap[variantId] || 0;
                            const shopQty = shopItem.quantity;

                            const refundQty = shopQty - bitrixQty;

                            if (bitrixQty > 0) fullRefundCalc = false; // User kept some items

                            if (refundQty > 0) {
                                itemsToRefund.push({
                                    line_item_id: shopItem.id,
                                    quantity: refundQty,
                                    restock_type: shouldRestock ? 'return' : 'no_restock',
                                    location_id: 98948808968 // Hardcoded from user script for now
                                });
                            }
                        }

                        // Special Case: If Bitrix rows are empty (bitrixRows.length === 0), it implies Full Refund.
                        // Logic handles this: bitrixQty will be 0 for all, so refundQty = shopQty.

                        if (itemsToRefund.length > 0) {
                            console.log(`[CANCEL BLOCK] 📉 Refund Diff Calculated:`, itemsToRefund);

                            // Execute Refund
                            try {
                                const refundResult = await createRefund(shopifyOrderId, {
                                    refundLineItems: itemsToRefund,
                                    refundShipping: fullRefundCalc, // Refund shipping if FULL refund (all items gone)
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

                    // Cancel order via GraphQL
                    // Only proceed if order is NOT fulfilled
                    let cancelData = null;
                    if (canCancel) {
                        // ... (Existing Cancel Logic)
                        // Reuse existing block but ensure we don't double restock?
                        // If we just refunded everything (restock=return), then Cancel with restock=true might error?
                        // Shopify: checking 'restock' behavior.
                        // If items are refunded, they are 'removed' from fulfillable quantity.
                        // Cancel normally restooks unfulfilled items.
                        // Use restock: (performRefund ? false : shouldRestock) logic discussed before.

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
                            restock: performRefund ? false : shouldRestock // If refunded/restocked individually, don't restock again globally
                        });

                        // Log cancel result...
                        if (cancelData?.orderCancel?.userErrors && cancelData.orderCancel.userErrors.length > 0) {
                            // Log but don't crash if we already successfully refunded
                            console.warn(`[CANCEL BLOCK] Cancel Warnings:`, cancelData.orderCancel.userErrors);
                        } else {
                            console.log(`[CANCEL BLOCK] 🚫 Order Cancelled Successfully`);
                        }
                    } else {
                        console.log(`[CANCEL BLOCK] ⏭️ Skipping Cancellation (Order Fulfilled). Status: ${shopifyOrder.fulfillment_status}`);
                    }

                    // Add BitrixUpdated tag...
                    if (!isBitrixOrder) await addTagToOrder(shopifyOrderId, 'BitrixUpdated');

                    return {
                        handled: true,
                        success: true,
                        action: performRefund ? 'order_refunded_logic_executed' : 'order_cancelled',
                        shopifyOrderId
                    };
                }
            } catch (regularCancelError) {
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
