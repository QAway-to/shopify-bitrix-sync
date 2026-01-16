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

// Default stub variant ID
const BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID = String(process.env.BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID || '53051786756360');

/**
 * Handle Quantity Sync from Bitrix to Shopify
 * @param {string} shopifyOrderId - Shopify order ID
 * @param {string} dealId - Bitrix deal ID
 * @param {string} requestId - Request correlation ID
 * @returns {Promise<{synced: boolean, changes?: number}>}
 */
export async function handleQuantitySync(shopifyOrderId, dealId, requestId) {
    if (!shopifyOrderId || shopifyOrderId.trim() === '') {
        console.log(JSON.stringify({
            event: 'QUANTITY_SYNC_SKIP',
            requestId,
            dealId,
            shopifyOrderId: shopifyOrderId || 'empty',
            reason: 'no_shopify_order_id',
            timestamp: new Date().toISOString()
        }));
        return { synced: false, reason: 'no_order_id' };
    }

    try {
        console.log(JSON.stringify({
            event: 'QUANTITY_SYNC_START',
            requestId,
            dealId,
            shopifyOrderId,
            timestamp: new Date().toISOString()
        }));

        const shopifyOrder = await getOrder(shopifyOrderId);
        if (!shopifyOrder) {
            return { synced: false, reason: 'order_not_found' };
        }

        // Check if order is created from Bitrix (has BITRIX:{dealId} tag)
        const orderTags = Array.isArray(shopifyOrder.tags)
            ? shopifyOrder.tags
            : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
        const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));

        if (!isBitrixOrder) {
            return { synced: false, reason: 'not_bitrix_order' };
        }

        // Get product rows from Bitrix
        const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', { id: dealId });
        const bitrixRows = Array.isArray(productRowsResp?.result) ? productRowsResp.result : [];

        console.log(JSON.stringify({
            event: 'QUANTITY_SYNC_BITRIX_ROWS',
            requestId,
            dealId,
            shopifyOrderId,
            rowsCount: bitrixRows.length,
            timestamp: new Date().toISOString()
        }));

        // Get line items from Shopify
        const shopifyLineItems = shopifyOrder.line_items || [];

        // Build map of SKU -> quantity from Bitrix
        const bitrixQuantities = new Map();
        for (const row of bitrixRows) {
            const productId = row.PRODUCT_ID;
            if (productId) {
                try {
                    const productResp = await callBitrix('/crm.product.get.json', { id: productId });
                    if (productResp.result) {
                        const sku = productResp.result.CODE || productResp.result.code ||
                            productResp.result.SKU || productResp.result.sku;
                        if (sku && sku.trim() !== '') {
                            const quantity = parseFloat(row.QUANTITY || row.quantity || 0);
                            bitrixQuantities.set(sku.trim(), quantity);
                        }
                    }
                } catch (productError) {
                    console.warn(`[SYNC QUANTITIES] Failed to get product ${productId}: ${productError.message}`);
                }
            }
        }

        // Compare with Shopify and find differences
        const quantityChanges = [];

        // Check existing Shopify items
        for (const lineItem of shopifyLineItems) {
            const rawSku = lineItem.sku;
            if (!rawSku || String(rawSku).trim() === '') continue;

            const sku = String(rawSku).trim();
            const bitrixQty = bitrixQuantities.has(sku) ? bitrixQuantities.get(sku) : 0;
            const shopifyQty = parseFloat(lineItem.quantity || 0);

            if (Math.abs(bitrixQty - shopifyQty) > 0.01) {
                quantityChanges.push({
                    sku,
                    bitrixQty,
                    shopifyQty,
                    newQty: bitrixQty
                });
            }
        }

        // Check for new items in Bitrix that don't exist in Shopify
        for (const [sku, bitrixQty] of bitrixQuantities.entries()) {
            const existsInShopify = shopifyLineItems.some(li => String(li?.sku || '').trim() === sku);
            if (!existsInShopify && bitrixQty > 0) {
                quantityChanges.push({
                    sku,
                    bitrixQty,
                    shopifyQty: 0,
                    newQty: bitrixQty,
                    isNew: true
                });
            }
        }

        if (quantityChanges.length === 0) {
            console.log(JSON.stringify({
                event: 'QUANTITY_SYNC_NO_CHANGES',
                requestId,
                dealId,
                shopifyOrderId,
                bitrixItemsCount: bitrixQuantities.size,
                shopifyItemsCount: shopifyLineItems.length,
                timestamp: new Date().toISOString()
            }));
            return { synced: true, changes: 0 };
        }

        console.log(JSON.stringify({
            event: 'QUANTITY_SYNC_DETECTED',
            requestId,
            dealId,
            shopifyOrderId,
            changesCount: quantityChanges.length,
            changes: quantityChanges,
            timestamp: new Date().toISOString()
        }));

        // Apply changes
        let hasChanges = false;
        for (const change of quantityChanges) {
            try {
                if (change.isNew) {
                    const addResult = await addPositionToOrder(shopifyOrderId, change.sku, change.newQty);
                    if (addResult.success) {
                        hasChanges = true;
                        console.log(JSON.stringify({
                            event: 'QUANTITY_SYNC_ADD_SUCCESS',
                            requestId, dealId, shopifyOrderId,
                            sku: change.sku, quantity: change.newQty,
                            timestamp: new Date().toISOString()
                        }));
                    } else {
                        console.log(JSON.stringify({
                            event: 'QUANTITY_SYNC_ADD_ERROR',
                            requestId, dealId, shopifyOrderId,
                            sku: change.sku, error: addResult.error,
                            timestamp: new Date().toISOString()
                        }));
                    }
                } else if (change.newQty > change.shopifyQty) {
                    const incrementQty = change.newQty - change.shopifyQty;
                    const incrementResult = await incrementLineItemQuantity(shopifyOrderId, change.sku, incrementQty);
                    if (incrementResult.success) {
                        hasChanges = true;
                        console.log(JSON.stringify({
                            event: 'QUANTITY_SYNC_INCREMENT_SUCCESS',
                            requestId, dealId, shopifyOrderId,
                            sku: change.sku, previousQty: change.shopifyQty, newQty: incrementResult.newQuantity,
                            timestamp: new Date().toISOString()
                        }));
                    } else {
                        console.log(JSON.stringify({
                            event: 'QUANTITY_SYNC_INCREMENT_ERROR',
                            requestId, dealId, shopifyOrderId,
                            sku: change.sku, error: incrementResult.error,
                            timestamp: new Date().toISOString()
                        }));
                    }
                } else if (change.newQty < change.shopifyQty) {
                    const decrementResult = await decrementLineItemQuantity(shopifyOrderId, change.sku, change.newQty);
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
                        console.log(JSON.stringify({
                            event: 'QUANTITY_SYNC_DECREMENT_ERROR',
                            requestId, dealId, shopifyOrderId,
                            sku: change.sku, error: decrementResult.error,
                            timestamp: new Date().toISOString()
                        }));
                    }
                }
            } catch (changeError) {
                console.log(JSON.stringify({
                    event: 'QUANTITY_SYNC_CHANGE_ERROR',
                    requestId, dealId, shopifyOrderId,
                    sku: change.sku, error: changeError.message,
                    timestamp: new Date().toISOString()
                }));
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
                console.warn(`[QUANTITY SYNC] Failed to add BitrixUpdated tag: ${tagError.message}`);
            }
        }

        return { synced: true, changes: quantityChanges.length };

    } catch (quantitySyncError) {
        console.warn(`[QUANTITY SYNC] Could not sync quantities: ${quantitySyncError.message}`);
        console.log(JSON.stringify({
            event: 'QUANTITY_SYNC_ERROR',
            requestId, dealId, shopifyOrderId,
            error: quantitySyncError.message,
            timestamp: new Date().toISOString()
        }));
        return { synced: false, error: quantitySyncError.message };
    }
}

/**
 * Clean up stub order by removing default variant and BITRIX_STUB tag
 */
async function cleanupStubOrder(shopifyOrderId, dealId, requestId) {
    console.log(JSON.stringify({
        event: 'STUB_ORDER_CLEANUP_START',
        requestId, dealId, shopifyOrderId,
        timestamp: new Date().toISOString()
    }));

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
                        console.log(JSON.stringify({
                            event: 'STUB_ORDER_DEFAULT_VARIANT_REMOVED',
                            requestId, dealId, shopifyOrderId,
                            defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
                            timestamp: new Date().toISOString()
                        }));
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

                console.log(JSON.stringify({
                    event: 'STUB_ORDER_TAG_REMOVED',
                    requestId, dealId, shopifyOrderId,
                    removedTag: 'BITRIX_STUB',
                    timestamp: new Date().toISOString()
                }));
            }
        }

        console.log(JSON.stringify({
            event: 'STUB_ORDER_CLEANUP_SUCCESS',
            requestId, dealId, shopifyOrderId,
            timestamp: new Date().toISOString()
        }));
    } catch (stubCleanupError) {
        console.warn(`[STUB CLEANUP] Failed to clean up stub order: ${stubCleanupError.message}`);
        console.log(JSON.stringify({
            event: 'STUB_ORDER_CLEANUP_ERROR',
            requestId, dealId, shopifyOrderId,
            error: stubCleanupError.message,
            timestamp: new Date().toISOString()
        }));
    }
}

export default { handleQuantitySync, cleanupStubOrder };
