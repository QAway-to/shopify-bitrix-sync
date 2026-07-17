/**
 * Quantity Sync Block Handler
 * Extracted from bitrix.js handleDealUpdate (lines 2396-2792)
 * 
 * Purpose: Sync product quantities from Bitrix deal to Shopify order
 * Trigger: shopifyOrderId exists AND order has BITRIX: tag
 * 
 * Flow:
 * 1. Get product rows from Bitrix deal
 * 2. Get line items from Shopify order
 * 3. Compare quantities by SKU
 * 4. Add/increment/decrement line items via orderEdit API
 * 5. Clean up stub products if real products added
 */

import { logger } from '../logging/logger.js';
import { getOrder, callShopifyAdmin } from '../shopify/adminClient.js';
import {
    incrementLineItemQuantity,
    decrementLineItemQuantity,
    addPositionToOrder,
    beginOrderEdit,
    setLineItemQuantity,
    commitOrderEdit
} from '../shopify/orderEdit.js';
import { addTagToOrder } from '../shopify/order.js';
import { callBitrix } from '../bitrix/client.js';
import { BITRIX_CONFIG } from '../bitrix/config.js';

// Default stub variant ID
const BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID = String(process.env.BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID || '53051786756360');

/**
 * Handle Quantity Sync from Bitrix to Shopify
 * @param {string} shopifyOrderId - Shopify order ID
 * @param {string} dealId - Bitrix deal ID
 * @param {string} requestId - Request correlation ID
 * @returns {Promise<{synced: boolean, changes?: number}>}
 */
export async function handleQuantitySync(shopifyOrderId, dealId, requestId, options = {}) {
    const {
        forceRemove = false,
        // Safety: when order already has refunds, never "re-add" items from Bitrix into Shopify.
        // This prevents accidental resurrection of refunded/removed line items.
        allowAddWhenRefunded = false
    } = options;
    if (!shopifyOrderId || shopifyOrderId.trim() === '') {
        logger.info('quantity_sync_skip', 'Quantity sync skipped', { dealId, shopifyOrderId, reason: 'no_shopify_order_id' });
        return { synced: false, reason: 'no_order_id' };
    }

    const _syncStartTime = Date.now();
    try {
        logger.info('quantity_sync_start', 'Quantity sync started', { dealId, shopifyOrderId });

        const shopifyOrder = await getOrder(shopifyOrderId);
        if (!shopifyOrder) {
            return { synced: false, reason: 'order_not_found' };
        }

        const financialStatus = shopifyOrder.financial_status ? String(shopifyOrder.financial_status) : null;
        const refundedStatuses = new Set(['refunded', 'partially_refunded', 'voided']);
        const isRefundedOrVoided = financialStatus ? refundedStatuses.has(financialStatus) : false;
        const blockAddsDueToRefund = isRefundedOrVoided && !allowAddWhenRefunded;

        // Check if order is created from Bitrix (has BITRIX:{dealId} tag)
        const orderTags = Array.isArray(shopifyOrder.tags)
            ? shopifyOrder.tags
            : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
        const isBitrixCreatedOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));
        // BitrixUpdated = order is managed by Bitrix (written to at least once); broader than created-by
        const isBitrixManagedOrder = isBitrixCreatedOrder
            || orderTags.some(tag => String(tag) === 'BitrixUpdated');

        if (!isBitrixManagedOrder && !forceRemove) {
            return { synced: false, reason: 'not_bitrix_order' };
        }

        // Get product rows from Bitrix
        const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', { id: dealId });
        const bitrixRows = Array.isArray(productRowsResp?.result) ? productRowsResp.result : [];

        logger.info('quantity_sync_bitrix_rows', 'Bitrix product rows fetched', { dealId, shopifyOrderId, rowsCount: bitrixRows.length });

        // ✅ GUARD: In forceRemove mode, if Bitrix has 0 rows, skip entirely.
        // This prevents race condition where Bitrix echo webhook arrives before
        // product rows are added to a newly created deal, causing all Shopify items to be deleted.
        // Uses isBitrixCreatedOrder (narrower) — race condition only applies to freshly created deals.
        if (forceRemove && !isBitrixCreatedOrder && bitrixRows.length === 0) {
            logger.info('quantity_sync_skip_force_remove', 'Sync skipped: forceRemove but no Bitrix rows', { dealId, shopifyOrderId });
            return { synced: false, reason: 'forceRemove_no_rows' };
        }

        // Get line items from Shopify
        const shopifyLineItems = shopifyOrder.line_items || [];

        // Build map: key = variant_id or sku, value = {quantity, variantId, sku}
        const bitrixQuantities = new Map();
        for (const row of bitrixRows) {
            const productId = row.PRODUCT_ID;
            if (productId) {
                // Shipping is a shipping_line in Shopify, not a line item — there is no variant
                // to add or match, so it can never reconcile here. Synced separately.
                if (String(productId) === String(BITRIX_CONFIG.SHIPPING_PRODUCT_ID)) {
                    logger.info('quantity_sync_shipping_row_skipped', 'Shipping product row skipped, not a Shopify line item', { dealId, shopifyOrderId, productId });
                    continue;
                }
                try {
                    const productResp = await callBitrix('/crm.product.get.json', { id: productId });
                    if (productResp.result) {
                        // ✅ Priority: XML_ID (variant_id) first, then CODE/SKU as fallback
                        const xmlId = productResp.result.XML_ID || productResp.result.xml_id || null;
                        const sku = productResp.result.CODE || productResp.result.code ||
                            productResp.result.SKU || productResp.result.sku || null;

                        // Determine variant_id: XML_ID if it looks like a number, otherwise null
                        const variantId = xmlId && /^\d+$/.test(String(xmlId).trim()) ? String(xmlId).trim() : null;

                        // Key for map: use variant_id if available, otherwise sku
                        const key = variantId || (sku && sku.trim() !== '' ? sku.trim() : null);

                        if (key) {
                            const quantity = parseFloat(row.QUANTITY || row.quantity || 0);
                            bitrixQuantities.set(key, {
                                quantity,
                                variantId: variantId,
                                sku: sku ? sku.trim() : null
                            });
                        } else {
                            logger.warn('quantity_sync_product_no_key', 'Product has no XML_ID or SKU — skipped', { dealId, productId });
                        }
                    }
                } catch (productError) {
                    logger.warn('quantity_sync_product_fetch_error', 'Failed to fetch product from Bitrix', { dealId, productId, error: productError.message });
                }
            }
        }

        // Compare with Shopify and find differences
        const quantityChanges = [];
        // Shopify may have duplicate line items for the same variant/SKU (from prior Order Edit re-adds).
        // Bitrix has a unique entry per match key — first Shopify match wins.
        const processedBitrixKeys = new Set();

        // Returns total quantity already fulfilled/shipped for a given line item id
        function getFulfilledQtyForLineItem(order, lineItemId) {
            if (!order.fulfillments || !Array.isArray(order.fulfillments)) return 0;
            let total = 0;
            for (const fulfillment of order.fulfillments) {
                if (!Array.isArray(fulfillment.line_items)) continue;
                for (const li of fulfillment.line_items) {
                    if (String(li.id) === String(lineItemId)) {
                        total += parseFloat(li.quantity ?? 0);
                    }
                }
            }
            return total;
        }

        // Check existing Shopify items - match by variant_id first, then sku
        for (const lineItem of shopifyLineItems) {
            const shopifyVariantId = lineItem.variant_id ? String(lineItem.variant_id) : null;
            const shopifySku = lineItem.sku ? String(lineItem.sku).trim() : null;

            if (!shopifyVariantId && !shopifySku) continue;

            // Find matching Bitrix item by variant_id first, then by sku
            let matchedEntry = null;
            let matchKey = null;

            // Try variant_id match first
            if (shopifyVariantId && bitrixQuantities.has(shopifyVariantId)) {
                matchedEntry = bitrixQuantities.get(shopifyVariantId);
                matchKey = shopifyVariantId;
            }
            // Fallback to sku match
            if (!matchedEntry && shopifySku) {
                for (const [key, entry] of bitrixQuantities.entries()) {
                    if (entry.sku && entry.sku === shopifySku) {
                        matchedEntry = entry;
                        matchKey = key;
                        break;
                    }
                }
            }

            if (matchedEntry && matchKey) {
                if (processedBitrixKeys.has(matchKey)) {
                    logger.info('quantity_sync_duplicate_skip', 'Duplicate Shopify line item skipped', {
                        dealId, shopifyOrderId, lineItemId: lineItem.id, matchKey, shopifyVariantId, shopifySku,
                    });
                    continue;
                }
                processedBitrixKeys.add(matchKey);
            }

            const bitrixQty = matchedEntry ? matchedEntry.quantity : 0;
            const fulfillable = lineItem.fulfillable_quantity != null
                ? parseFloat(lineItem.fulfillable_quantity)
                : parseFloat(lineItem.current_quantity ?? lineItem.quantity ?? 0);
            const fulfilledForLine = getFulfilledQtyForLineItem(shopifyOrder, lineItem.id);
            const shopifyQty = Math.min(fulfillable + fulfilledForLine, parseFloat(lineItem.quantity ?? 0));

            if (Math.abs(bitrixQty - shopifyQty) > 0.01) {
                // forceRemove mode: only process removals (qty→0), skip other changes
                if (forceRemove && !isBitrixManagedOrder && bitrixQty > 0) {
                    continue;
                }
                // If order is refunded/partially_refunded/voided, do not push increases from Bitrix to Shopify.
                // Allow only decreases/removals (e.g., cleanup) to avoid re-adding refunded items.
                if (blockAddsDueToRefund && bitrixQty > shopifyQty) {
                    continue;
                }
                quantityChanges.push({
                    key: matchKey || shopifyVariantId || shopifySku,
                    variantId: matchedEntry?.variantId || shopifyVariantId,
                    sku: matchedEntry?.sku || shopifySku,
                    bitrixQty,
                    shopifyQty,
                    newQty: bitrixQty
                });
            }
        }

        // Check for new items in Bitrix that don't exist in Shopify
        for (const [key, entry] of bitrixQuantities.entries()) {
            // Check if exists in Shopify by variant_id or sku
            const existsInShopify = shopifyLineItems.some(li => {
                const liVariantId = li.variant_id ? String(li.variant_id) : null;
                const liSku = li.sku ? String(li.sku).trim() : null;
                return (entry.variantId && liVariantId === entry.variantId) ||
                    (entry.sku && liSku === entry.sku);
            });

            if (!existsInShopify && entry.quantity > 0) {
                if (blockAddsDueToRefund) {
                    continue;
                }
                quantityChanges.push({
                    key,
                    variantId: entry.variantId,
                    sku: entry.sku,
                    bitrixQty: entry.quantity,
                    shopifyQty: 0,
                    newQty: entry.quantity,
                    isNew: true
                });
            }
        }

        if (quantityChanges.length === 0) {
            logger.info('quantity_sync_no_changes', 'No quantity changes detected', {
                dealId, shopifyOrderId, financialStatus, blockAddsDueToRefund,
                bitrixItemsCount: bitrixQuantities.size,
                shopifyItemsCount: shopifyLineItems.length,
            });
            return { synced: true, changes: 0 };
        }

        logger.info('quantity_sync_detected', 'Quantity changes detected', {
            dealId, shopifyOrderId, financialStatus, blockAddsDueToRefund,
            changesCount: quantityChanges.length,
            bitrixItemsCount: bitrixQuantities.size,
            shopifyItemsCount: shopifyLineItems.length,
            changes: quantityChanges,
        });

        // Apply changes
        let hasChanges = false;
        for (const change of quantityChanges) {
            try {
                if (change.isNew) {
                    // ✅ Use variantId first (direct lookup), fallback to sku (certificates)
                    const identifier = change.variantId || change.sku;
                    const addResult = await addPositionToOrder(shopifyOrderId, identifier, change.newQty);
                    if (addResult.success) {
                        hasChanges = true;
                        console.log(JSON.stringify({
                            event: 'QUANTITY_SYNC_ADD_SUCCESS',
                            requestId, dealId, shopifyOrderId,
                            variantId: change.variantId,
                            sku: change.sku,
                            quantity: change.newQty,
                            timestamp: new Date().toISOString()
                        }));
                    } else {
                        logger.warn('quantity_sync_add_error', 'Failed to add new item to Shopify order', {
                            dealId, shopifyOrderId,
                            variantId: change.variantId,
                            sku: change.sku,
                            error: addResult.error,
                            message: addResult.message,
                        });
                    }
                } else if (change.newQty > change.shopifyQty) {
                    const incrementQty = change.newQty - change.shopifyQty;
                    // Pass variantId so the line item is targeted by variant_id (unique), not by SKU
                    // (SKU can be empty on POS items or non-unique across products).
                    const incrementResult = await incrementLineItemQuantity(shopifyOrderId, change.sku, incrementQty, change.variantId);
                    if (incrementResult.success) {
                        hasChanges = true;
                        console.log(JSON.stringify({
                            event: 'QUANTITY_SYNC_INCREMENT_SUCCESS',
                            requestId, dealId, shopifyOrderId,
                            sku: change.sku, previousQty: change.shopifyQty, newQty: incrementResult.newQuantity,
                            timestamp: new Date().toISOString()
                        }));
                    } else {
                        logger.warn('quantity_sync_increment_error', 'Failed to increment line item quantity', {
                            dealId, shopifyOrderId,
                            sku: change.sku,
                            error: incrementResult.error,
                            message: incrementResult.message,
                            previousQty: change.shopifyQty,
                            newQty: change.newQty,
                        });
                    }
                } else if (change.newQty < change.shopifyQty) {
                    // Pass variantId so the line item is targeted by variant_id (unique), not by SKU.
                    const decrementResult = await decrementLineItemQuantity(shopifyOrderId, change.sku, change.newQty, change.variantId);
                    if (decrementResult.success) {
                        hasChanges = true;
                        if (change.newQty === 0) {
                            console.log(JSON.stringify({
                                event: 'QUANTITY_SYNC_REMOVE_SUCCESS',
                                requestId, dealId, shopifyOrderId,
                                sku: change.sku, previousQty: change.shopifyQty,
                                timestamp: new Date().toISOString()
                            }));
                        } else {
                            console.log(JSON.stringify({
                                event: 'QUANTITY_SYNC_DECREMENT_SUCCESS',
                                requestId, dealId, shopifyOrderId,
                                sku: change.sku, previousQty: change.shopifyQty, newQty: decrementResult.newQuantity,
                                timestamp: new Date().toISOString()
                            }));
                        }
                    } else {
                        logger.warn('quantity_sync_decrement_error', 'Failed to decrement line item quantity', {
                            dealId, shopifyOrderId,
                            sku: change.sku,
                            error: decrementResult.error,
                            message: decrementResult.message,
                            previousQty: change.shopifyQty,
                            newQty: change.newQty,
                        });
                    }
                }
            } catch (changeError) {
                logger.warn('quantity_sync_change_error', 'Unexpected error applying quantity change', {
                    dealId, shopifyOrderId,
                    sku: change.sku, error: changeError.message,
                });
            }
        }

        // Clean up stub order if real products were added
        const hasStubTag = orderTags.includes('BITRIX_STUB');
        const hasRealProducts = bitrixQuantities.size > 0;

        if (hasStubTag && hasRealProducts) {
            await cleanupStubOrder(shopifyOrderId, dealId, requestId);
        }

        // Add BitrixUpdated tag if any changes were made
        if (hasChanges) {
            try {
                await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
                console.log(JSON.stringify({
                    event: 'QUANTITY_SYNC_TAG_ADDED',
                    requestId, dealId, shopifyOrderId,
                    timestamp: new Date().toISOString()
                }));
            } catch (tagError) {
                logger.warn('quantity_sync_tag_error', 'Failed to add BitrixUpdated tag', { dealId, shopifyOrderId, error: tagError.message });
            }
        }

        logger.info('quantity_sync_completed', 'Quantity sync done', { dealId, changesCount: quantityChanges.length, duration_ms: Date.now() - _syncStartTime });
        return { synced: true, changes: quantityChanges.length };

    } catch (quantitySyncError) {
        logger.error('quantity_sync_error', 'Quantity sync failed', { dealId, shopifyOrderId, error: quantitySyncError.message });
        return { synced: false, error: quantitySyncError.message };
    }
}

/**
 * Clean up stub order by removing default variant and BITRIX_STUB tag
 */
async function cleanupStubOrder(shopifyOrderId, dealId, requestId) {
    logger.info('stub_order_cleanup_start', 'Stub order cleanup started', { dealId, shopifyOrderId });

    try {
        // Step 1: Remove default variant
        const beginResult = await beginOrderEdit(shopifyOrderId);
        if (beginResult.success) {
            const calculatedLineItems = beginResult.lineItems || [];
            const calculatedDefaultItem = calculatedLineItems.find(li => {
                if (!li.variant) return false;
                const liVariantId = li.variant.legacyResourceId
                    ? String(li.variant.legacyResourceId)
                    : (li.variant.id ? String(li.variant.id).split('/').pop() : null);
                return liVariantId === BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID;
            });

            if (calculatedDefaultItem && calculatedDefaultItem.quantity > 0) {
                const setResult = await setLineItemQuantity(
                    beginResult.calculatedOrderId,
                    calculatedDefaultItem.id,
                    0
                );

                if (setResult.success) {
                    const commitResult = await commitOrderEdit(beginResult.calculatedOrderId);
                    if (commitResult.success) {
                        logger.info('stub_order_variant_removed', 'Default stub variant removed from order', { dealId, shopifyOrderId, defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID });
                    }
                }
            }
        }

        // Step 2: Remove BITRIX_STUB tag
        const currentOrder = await getOrder(shopifyOrderId);
        if (currentOrder) {
            const currentTags = Array.isArray(currentOrder.tags)
                ? currentOrder.tags
                : (currentOrder.tags ? String(currentOrder.tags).split(',').map(t => t.trim()) : []);

            const updatedTags = currentTags.filter(tag => tag !== 'BITRIX_STUB');
            const currentNote = currentOrder.note || '';
            const shouldUpdateNote = currentNote.includes('STUB ORDER');
            const updatedNote = shouldUpdateNote ? `Ордер из Bitrix. Сделка: ${dealId}` : currentNote;

            if (updatedTags.length !== currentTags.length || shouldUpdateNote) {
                await callShopifyAdmin(`/orders/${shopifyOrderId}.json`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        order: {
                            id: shopifyOrderId,
                            tags: updatedTags.join(', '),
                            note: updatedNote
                        }
                    })
                });

                logger.info('stub_order_tag_removed', 'BITRIX_STUB tag removed from order', { dealId, shopifyOrderId, removedTag: 'BITRIX_STUB' });
            }
        }

        logger.info('stub_order_cleanup_success', 'Stub order cleanup completed', { dealId, shopifyOrderId });
    } catch (stubCleanupError) {
        logger.warn('stub_order_cleanup_error', 'Failed to clean up stub order', { dealId, shopifyOrderId, error: stubCleanupError.message });
    }
}

export default { handleQuantitySync, cleanupStubOrder };
