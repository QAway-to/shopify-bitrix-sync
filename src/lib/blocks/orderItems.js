/**
 * Order Items Resolver
 * 
 * Provides unified item resolution for Bitrix → Shopify order creation:
 * - Category 4: Catalog Order (Brand/Model/Size UF fields)
 * - All others: Regular Order (Product Rows)
 */

import { callBitrix } from '../bitrix/client.js';
import { findShopifyVariantByAttributes } from '../shopify/adminClient.js';
import { syncProductVariantOptimized } from '../bitrix/products.js';

// Bitrix UF Field IDs
const UF_BRAND = 'UF_CRM_1768251890190';
const UF_MODEL = 'UF_CRM_1739793668182';
const UF_SIZE = 'UF_CRM_1739793720585';

/**
 * Resolve items for Catalog Order (Category 4)
 * Uses Brand/Model/Size UF fields to find Shopify variant
 * 
 * @param {string} dealId - Bitrix deal ID
 * @param {Object} dealData - Full deal data from Bitrix
 * @param {string} requestId - Request correlation ID
 * @returns {Promise<Array<{variantId: string, qty: number}>>}
 */
export async function resolveCatalogOrderItems(dealId, dealData, requestId) {
    const brand = dealData[UF_BRAND] || dealData[UF_BRAND.toLowerCase()];
    let model = dealData[UF_MODEL] || dealData[UF_MODEL.toLowerCase()];
    const size = dealData[UF_SIZE] || dealData[UF_SIZE.toLowerCase()];

    // Strip " - Size" suffix from model if present (sloppy input handling)
    if (model && typeof model === 'string' && model.includes(' - ')) {
        const parts = model.split(' - ');
        if (parts.length > 1) {
            parts.pop();
            model = parts.join(' - ');
            console.log(`[CATALOG ORDER] Stripped suffix from model: "${dealData[UF_MODEL]}" -> "${model}"`);
        }
    }

    console.log(JSON.stringify({
        event: 'CATALOG_ORDER_FIELD_CHECK',
        requestId,
        dealId,
        fields: { brand, model, size },
        hasAllFields: !!(brand && model && size),
        timestamp: new Date().toISOString()
    }));

    if (!brand || !model || !size) {
        console.log(`[CATALOG ORDER] ⚠️ Missing required fields (Brand/Model/Size)`);
        return [];
    }

    try {
        const result = await findShopifyVariantByAttributes({ brand, model, size });

        if (!result || !result.variant) {
            console.log(`[CATALOG ORDER] ⚠️ No matching variant found for ${brand} ${model} ${size}`);
            return [];
        }

        const { variant, productTitle, description, images } = result;
        console.log(`[CATALOG ORDER] 🎯 Found variant: ${productTitle} - ${variant.title} (ID: ${variant.id})`);

        // Resolve image URL
        let imageUrl = null;
        if (variant.imageId) {
            const img = (images || []).find(i => i.id === variant.imageId);
            if (img) imageUrl = img.src;
        }
        if (!imageUrl && images && images.length > 0) {
            imageUrl = images[0].src;
        }

        // Sync product to Bitrix (on-demand)
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
            console.error(`[CATALOG ORDER] ❌ Failed to sync product to Bitrix`);
            return [];
        }

        // Add product row to deal
        const rowsResp = await callBitrix('crm.deal.productrows.get', { id: dealId });
        const rows = rowsResp.result || [];

        rows.push({
            PRODUCT_ID: syncResult.productId,
            QUANTITY: 1,
            PRICE: variant.price || 0,
            PRODUCT_NAME: syncResult.productName || `${productTitle} - ${variant.title}`
        });

        await callBitrix('crm.deal.productrows.set', { id: dealId, rows });
        console.log(`[CATALOG ORDER] ✅ Added product ${syncResult.productId} to deal ${dealId}`);

        // Return item for order creation
        return [{
            variantId: variant.id.split('/').pop(),
            qty: 1
        }];

    } catch (err) {
        console.error(`[CATALOG ORDER] ❌ Error: ${err.message}`);
        return [];
    }
}

/**
 * Resolve items for Regular Order (all categories except 4)
 * Uses existing Product Rows from deal
 * 
 * @param {string} dealId - Bitrix deal ID
 * @param {string} requestId - Request correlation ID
 * @returns {Promise<Array<{sku?: string, variantId?: string, qty: number}>>}
 */
export async function resolveRegularOrderItems(dealId, requestId) {
    const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', { id: dealId });

    console.log(JSON.stringify({
        event: 'REGULAR_ORDER_PRODUCT_ROWS',
        requestId,
        dealId,
        count: productRowsResp?.result?.length || 0,
        timestamp: new Date().toISOString()
    }));

    if (!productRowsResp.result || !Array.isArray(productRowsResp.result)) {
        return [];
    }

    const items = [];

    for (const row of productRowsResp.result) {
        const productId = row.PRODUCT_ID;
        if (!productId) continue;

        try {
            const productResp = await callBitrix('/crm.product.get.json', { id: productId });

            if (productResp.result) {
                const product = productResp.result;
                const code = product.CODE;
                const xmlId = product.XML_ID;

                if (code && code.trim() !== '') {
                    items.push({ sku: code.trim(), qty: row.QUANTITY || 1 });
                    console.log(`[REGULAR ORDER] Product ${productId}: SKU=${code.trim()}`);
                } else if (xmlId && xmlId.toString().trim() !== '') {
                    items.push({ variantId: xmlId.toString().trim(), qty: row.QUANTITY || 1 });
                    console.log(`[REGULAR ORDER] Product ${productId}: variantId=${xmlId}`);
                } else {
                    console.warn(`[REGULAR ORDER] Product ${productId} has no SKU/XML_ID, skipping`);
                }
            }
        } catch (productError) {
            console.error(`[REGULAR ORDER] Error getting product ${productId}:`, productError);
        }
    }

    console.log(JSON.stringify({
        event: 'REGULAR_ORDER_ITEMS_RESOLVED',
        requestId,
        dealId,
        itemsCount: items.length,
        timestamp: new Date().toISOString()
    }));

    return items;
}

export default { resolveCatalogOrderItems, resolveRegularOrderItems };
