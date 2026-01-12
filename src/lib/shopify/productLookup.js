/**
 * Product Lookup utilities for Bitrix → Shopify integration
 * Handles searching products by Title-Size pattern
 */

import { callShopifyAdmin } from './adminClient.js';
import { callBitrix } from '../bitrix/client.js';
import { getSizeEnumId } from '../bitrix/utils.js';

/**
 * Parse "Title - Size" pattern from product name
 * @param {string} productName - e.g., "Amber 2.0 silver GR Barefoot Ballerinas - 31"
 * @returns {{ title: string, size: string } | null}
 */
export function parseTitleSizePattern(productName) {
    if (!productName || typeof productName !== 'string') return null;

    // Pattern: "Title - Size" where Size is 2-3 digits at the end
    const match = productName.trim().match(/^(.+?)\s*-\s*(\d{2,3})$/);
    if (match) {
        return {
            title: match[1].trim(),
            size: match[2]
        };
    }
    return null;
}

/**
 * Search Shopify for product variant by title and size
 * @param {string} title - Product title (e.g., "Amber 2.0 silver GR Barefoot Ballerinas")
 * @param {string} size - Size value (e.g., "31")
 * @returns {Promise<{ variantId: string, sku: string, product: object, variant: object } | null>}
 */
export async function searchVariantByTitleSize(title, size) {
    try {
        // Search products by title
        const searchUrl = `/products.json?title=${encodeURIComponent(title)}&limit=10`;
        const response = await callShopifyAdmin(searchUrl);
        const products = response.products || [];

        console.log(`[PRODUCT LOOKUP] Searching for "${title}" - found ${products.length} products`);

        if (products.length === 0) {
            console.warn(`[PRODUCT LOOKUP] No products found for title: "${title}"`);
            return null;
        }

        // Find exact or close match
        let matchedProduct = null;

        // First try exact match
        matchedProduct = products.find(p =>
            p.title.toLowerCase() === title.toLowerCase()
        );

        // If no exact match, try contains (for partial title input)
        if (!matchedProduct) {
            matchedProduct = products.find(p =>
                p.title.toLowerCase().includes(title.toLowerCase()) ||
                title.toLowerCase().includes(p.title.toLowerCase())
            );
        }

        // Fallback to first result
        if (!matchedProduct) {
            matchedProduct = products[0];
            console.log(`[PRODUCT LOOKUP] No exact match, using first result: "${matchedProduct.title}"`);
        }

        console.log(`[PRODUCT LOOKUP] Matched product: "${matchedProduct.title}" (ID: ${matchedProduct.id})`);

        // Find variant by size
        const variant = matchedProduct.variants?.find(v => {
            // Check all options and variant title
            return v.option1 === size ||
                v.option2 === size ||
                v.option3 === size ||
                v.title === size ||
                v.title?.includes(size);
        });

        if (!variant) {
            console.warn(`[PRODUCT LOOKUP] No variant found for size "${size}" in product "${matchedProduct.title}"`);
            console.log(`[PRODUCT LOOKUP] Available variants:`, matchedProduct.variants?.map(v => v.title).join(', '));
            return null;
        }

        console.log(`[PRODUCT LOOKUP] Found variant: ${variant.title} (ID: ${variant.id}, SKU: ${variant.sku})`);

        return {
            variantId: String(variant.id),
            sku: variant.sku || '',
            product: matchedProduct,
            variant
        };

    } catch (error) {
        console.error(`[PRODUCT LOOKUP] Error searching for "${title}" - "${size}":`, error);
        return null;
    }
}

/**
 * Update Bitrix product card with data from Shopify variant
 * @param {number} bitrixProductId - Bitrix product ID
 * @param {string} variantId - Shopify variant ID
 * @returns {Promise<boolean>} Success status
 */
export async function updateBitrixProductFromShopify(bitrixProductId, variantId) {
    try {
        // Get variant data from Shopify
        const variantResponse = await callShopifyAdmin(`/variants/${variantId}.json`);
        const variant = variantResponse.variant;
        if (!variant) {
            console.error(`[PRODUCT LOOKUP] Variant ${variantId} not found in Shopify`);
            return false;
        }

        // Get product data from Shopify
        const productResponse = await callShopifyAdmin(`/products/${variant.product_id}.json`);
        const product = productResponse.product;
        if (!product) {
            console.error(`[PRODUCT LOOKUP] Product ${variant.product_id} not found in Shopify`);
            return false;
        }

        // Extract size and color from variant options
        let sizeVal = '';
        let colorVal = '';
        const options = product.options || [];

        for (let i = 0; i < options.length; i++) {
            const optName = (options[i].name || '').toLowerCase();
            const optValue = variant[`option${i + 1}`];

            if (optName.includes('size') || optName.includes('размер') || optName.includes('eu size')) {
                sizeVal = optValue || '';
            } else if (optName.includes('color') || optName.includes('colour') || optName.includes('цвет')) {
                colorVal = optValue || '';
            }
        }

        // Fallback: use variant title as size if no explicit size option
        if (!sizeVal && variant.title && variant.title !== 'Default Title') {
            sizeVal = variant.title;
        }

        // Build update fields
        const sizeEnum = getSizeEnumId(sizeVal);
        const fullTitle = `${product.title} - ${variant.title || sizeVal}`;

        const updateFields = {
            NAME: fullTitle,
            CODE: variant.sku || '',
            XML_ID: String(variant.id), // variant_id for future lookups
            PRICE: parseFloat(variant.price || 0),
            DESCRIPTION: product.body_html || '',
            DESCRIPTION_TYPE: 'html',
            DETAIL_TEXT: product.body_html || '',
            DETAIL_TEXT_TYPE: 'html'
        };

        // Add properties if available
        if (product.vendor) updateFields.PROPERTY_102 = product.vendor; // Brand
        if (product.product_type) updateFields.PROPERTY_104 = product.product_type; // Category
        if (colorVal) updateFields.PROPERTY_106 = colorVal; // Color
        if (sizeEnum) updateFields.PROPERTY_98 = sizeEnum; // Size Enum

        console.log(`[PRODUCT LOOKUP] Updating Bitrix product ${bitrixProductId} with:`, {
            NAME: fullTitle,
            CODE: variant.sku,
            XML_ID: variant.id,
            PRICE: variant.price,
            brand: product.vendor,
            color: colorVal,
            size: sizeVal
        });

        // Update Bitrix product
        const updateResp = await callBitrix('/crm.product.update.json', {
            id: bitrixProductId,
            fields: updateFields
        });

        if (updateResp.result) {
            console.log(`[PRODUCT LOOKUP] ✅ Bitrix product ${bitrixProductId} updated successfully`);
            return true;
        } else {
            console.error(`[PRODUCT LOOKUP] ❌ Failed to update Bitrix product:`, updateResp.error);
            return false;
        }

    } catch (error) {
        console.error(`[PRODUCT LOOKUP] Error updating Bitrix product ${bitrixProductId}:`, error);
        return false;
    }
}

/**
 * Process product row with "Title - Size" pattern
 * 1. Search Shopify for variant
 * 2. Update Bitrix product card
 * 3. Return variant info for order creation
 * 
 * @param {object} row - Bitrix product row
 * @param {object} product - Bitrix product (partial data)
 * @returns {Promise<{ variantId: string, sku: string, qty: number } | null>}
 */
export async function processPreorderProductRow(row, product) {
    const productName = product.NAME || row.PRODUCT_NAME;
    const parsed = parseTitleSizePattern(productName);

    if (!parsed) {
        console.log(`[PRODUCT LOOKUP] Product name "${productName}" doesn't match Title-Size pattern`);
        return null;
    }

    console.log(`[PRODUCT LOOKUP] Parsed pre-order: title="${parsed.title}", size="${parsed.size}"`);

    // Search Shopify
    const result = await searchVariantByTitleSize(parsed.title, parsed.size);
    if (!result) {
        console.warn(`[PRODUCT LOOKUP] Could not find variant for "${productName}"`);
        return null;
    }

    // Update Bitrix product card with Shopify data
    const productId = row.PRODUCT_ID || product.ID;
    if (productId) {
        await updateBitrixProductFromShopify(productId, result.variantId);
    }

    return {
        variantId: result.variantId,
        sku: result.sku,
        qty: row.QUANTITY || 1
    };
}
