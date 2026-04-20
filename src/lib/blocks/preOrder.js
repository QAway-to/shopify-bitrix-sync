/**
 * Pre-Order Block Handler
 * Extracted from bitrix.js handleDealUpdate (lines 1706-1822)
 * 
 * Purpose: Automatic Reservation for Category 4 deals
 * Trigger: When Brand, Model, Size are present and no shopifyOrderId exists
 * 
 * Flow:
 * 1. Find matching Shopify variant by Brand/Model/Size
 * 2. Create pending order in Shopify
 * 3. Sync product to Bitrix (On-Demand)
 * 4. Add product row to Deal
 * 5. Update Deal with Shopify Order ID (LAST to avoid race condition)
 */

import { logger } from '../logging/logger.js';
import { findShopifyVariantByAttributes, createShopifyOrderForPreorder } from '../shopify/adminClient.js';
import { syncProductVariantOptimized } from '../bitrix/products.js';
import { callBitrix } from '../bitrix/client.js';
import { resolveUserFieldListValue } from '../bitrix/userFields.js';

// Bitrix User Field IDs
const UF_BRAND = 'UF_CRM_1741642513658'; // New Select List Field (formerly UF_CRM_1768251890190)
const UF_MODEL = 'UF_CRM_1739793668182';
const UF_SIZE = 'UF_CRM_1739793720585';
const UF_SHOPIFY_ORDER_ID = 'UF_CRM_1742556489';

/**
 * Handle Pre-Order logic for Category 4 deals
 * @param {string} dealId - Bitrix deal ID
 * @param {Object} dealData - Full deal data from Bitrix
 * @param {string} requestId - Request correlation ID
 * @param {string} currentShopifyOrderId - Current Shopify order ID (may be empty)
 * @returns {Promise<{handled: boolean, newShopifyOrderId?: string}>}
 */
export async function handlePreOrder(dealId, dealData, requestId, currentShopifyOrderId) {
    const categoryId = dealData.CATEGORY_ID;

    // Only process Category 4
    if (String(categoryId) !== '4') {
        return { handled: false, reason: 'not_category_4' };
    }

    let brand = dealData[UF_BRAND] || dealData[UF_BRAND.toLowerCase()];

    // ✅ RESOLVE BRAND: If the value is a Select List ID (number or array), resolve to String
    if (brand && (Array.isArray(brand) || !isNaN(Number(brand)))) {
        const resolvedBrand = await resolveUserFieldListValue(UF_BRAND, brand);
        if (resolvedBrand) {
            logger.info('preorder_brand_resolved', 'Brand ID resolved', { brandId: JSON.stringify(brand), brandName: resolvedBrand });
            brand = resolvedBrand;
        }
    }

    let model = dealData[UF_MODEL] || dealData[UF_MODEL.toLowerCase()];
    const size = dealData[UF_SIZE] || dealData[UF_SIZE.toLowerCase()];

    // Sloppy Input Handling: Strip " - Size" suffix from model if present
    // Example: "Ground TTJ black Barefoot Kids Sneakers - 27" -> "Ground TTJ black Barefoot Kids Sneakers"
    if (model && typeof model === 'string' && model.includes(' - ')) {
        const parts = model.split(' - ');
        if (parts.length > 1) {
            parts.pop(); // Remove last part (size/variant suffix)
            model = parts.join(' - '); // Join back
            logger.info('preorder_model_normalized', 'Model name normalized', { original: dealData[UF_MODEL], normalized: model });
        }
    }

    logger.info('preorder_field_check', 'Pre-order field check', {
        requestId,
        dealId,
        fields: { brand, model, size },
        availableUFKeys: Object.keys(dealData).filter(k => k.startsWith('UF_')),
        hasAllFields: !!(brand && model && size),
        shopifyOrderId: currentShopifyOrderId
    });

    // Skip if already have linked order or missing required fields
    if (!brand || !model || !size) {
        return { handled: false, reason: 'missing_fields' };
    }

    if (currentShopifyOrderId && currentShopifyOrderId.trim() !== '') {
        return { handled: false, reason: 'order_already_exists' };
    }

    console.log(`[PRE-ORDER] checking availability for: ${brand} ${model} ${size}`);

    try {
        const result = await findShopifyVariantByAttributes({ brand, model, size });

        if (!result || !result.variant) {
            logger.warn('preorder_variant_not_found', 'No matching Shopify variant found', { brand, model, size });
            return { handled: true, success: false, reason: 'no_matching_variant' };
        }

        const { variant, productTitle, description, images } = result;
        console.log(`[PRE-ORDER] 🎯 Found matching variant: ${productTitle} - ${variant.title} (ID: ${variant.id})`);

        // Resolve Image URL
        let imageUrl = null;
        if (variant.imageId) {
            const img = (images || []).find(i => i.id === variant.imageId);
            if (img) imageUrl = img.src;
        }
        if (!imageUrl && images && images.length > 0) {
            imageUrl = images[0].src;
        }

        // 1. Create Pending Order in Shopify
        const order = await createShopifyOrderForPreorder(variant.id, {
            dealId: dealId,
        });

        if (!order || !order.id) {
            logger.error('preorder_order_creation_failed', 'Failed to create Shopify order', { error: 'order or order.id missing' });
            return { handled: true, success: false, reason: 'order_creation_failed' };
        }

        const newOrderId = String(order.id);
        const newOrderName = order.name;
        console.log(`[PRE-ORDER] ✅ Created pending order: ${newOrderId} (${newOrderName})`);
        logger.info('preorder_created', 'Pre-order Shopify order created', { dealId, orderId: newOrderId, variantId: variant.id.split('/').pop() });

        // 2. Ensure Product exists in Bitrix (On-Demand)
        const syncData = {
            variant_id: variant.id.split('/').pop(),
            sku: variant.sku,
            product_title: productTitle,
            variant_title: variant.title,
            price: variant.price || 0,
            qty: variant.inventoryQuantity,
            brand: brand,
            category: model,
            description: description,
            imageUrl: imageUrl
        };

        const syncResult = await syncProductVariantOptimized(syncData, true);

        if (!syncResult.productId) {
            logger.error('preorder_product_sync_failed', 'Failed to sync product to Bitrix', { error: 'syncResult.productId missing' });
            return { handled: true, success: false, reason: 'product_sync_failed', newShopifyOrderId: newOrderId };
        }

        // 3. Add Product Row to Deal
        const rowsResp = await callBitrix('crm.deal.productrows.get', { id: dealId });
        const rows = rowsResp.result || [];

        rows.push({
            PRODUCT_ID: syncResult.productId,
            QUANTITY: 1,
            PRICE: variant.price || 0,
            PRODUCT_NAME: syncResult.productName || `${productTitle} - ${variant.title}`
        });

        await callBitrix('crm.deal.productrows.set', { id: dealId, rows });
        console.log(`[PRE-ORDER] ✅ Added product ${syncResult.productId} to deal ${dealId}`);

        // 4. Update Bitrix Deal with Shopify Order ID and Title (LAST STEP)
        // We do this LAST so that if it triggers a webhook re-entry, 
        // the deal already has product rows, preventing "Sync Quantities" from wiping the order.
        await callBitrix('crm.deal.update', {
            id: dealId,
            fields: {
                [UF_SHOPIFY_ORDER_ID]: newOrderId,
                TITLE: newOrderName
            }
        });
        console.log(`[PRE-ORDER] ✅ Updated Deal Title and Order ID: ${newOrderName}`);

        return {
            handled: true,
            success: true,
            newShopifyOrderId: newOrderId,
            productId: syncResult.productId
        };

    } catch (err) {
        logger.error('preorder_failed', 'Pre-order creation failed', { dealId, error: err.message });
        return { handled: true, success: false, error: err.message };
    }
}

export default { handlePreOrder };
