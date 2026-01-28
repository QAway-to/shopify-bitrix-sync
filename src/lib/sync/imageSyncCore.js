/**
 * Image Sync Core Module
 * Syncs product images from Shopify to Bitrix for products missing PREVIEW_PICTURE
 */

import { callBitrix } from '../bitrix/client.js';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "83bfa8-c4.myshopify.com";
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || "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";

const BATCH_SIZE = 10; // Process 10 products at a time
const DELAY_BETWEEN_BATCHES_MS = 2000; // 2 sec delay to avoid rate limits

/**
 * Fetch Bitrix products without PREVIEW_PICTURE
 */
async function fetchProductsWithoutImages(progressCallback) {
    const products = [];
    let start = 0;
    const pageSize = 50;

    progressCallback?.({ type: 'info', message: 'Fetching Bitrix products without images...' });

    while (true) {
        const resp = await callBitrix('crm.product.list', {
            filter: {
                'PREVIEW_PICTURE': ''  // Empty = no image
            },
            select: ['ID', 'NAME', 'XML_ID', 'CODE', 'PREVIEW_PICTURE'],
            start
        });

        if (resp?.result) {
            products.push(...resp.result);
        }

        if (resp?.next !== undefined && resp.next !== null) {
            start = resp.next;
        } else {
            break;
        }
    }

    progressCallback?.({ type: 'info', message: `Found ${products.length} products without images` });
    return products;
}

/**
 * Get Shopify product image by variant_id (stored in XML_ID)
 */
async function getShopifyImageUrl(variantId) {
    if (!variantId) return null;

    try {
        // First get the variant to find product_id
        const variantUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/variants/${variantId}.json`;
        const variantResp = await fetch(variantUrl, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
        });

        if (!variantResp.ok) return null;
        const variantData = await variantResp.json();
        const productId = variantData.variant?.product_id;

        if (!productId) return null;

        // Then get the product to get images
        const productUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}.json`;
        const productResp = await fetch(productUrl, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
        });

        if (!productResp.ok) return null;
        const productData = await productResp.json();

        // Try variant-specific image first, then product image
        const variantImageId = variantData.variant?.image_id;
        if (variantImageId && productData.product?.images) {
            const variantImage = productData.product.images.find(img => img.id === variantImageId);
            if (variantImage?.src) return variantImage.src;
        }

        // Fallback to first product image
        return productData.product?.image?.src || productData.product?.images?.[0]?.src || null;

    } catch (error) {
        console.error(`[IMAGE SYNC] Error fetching Shopify image for variant ${variantId}:`, error.message);
        return null;
    }
}

/**
 * Upload image to Bitrix product
 */
async function uploadImageToBitrix(productId, imageUrl) {
    if (!imageUrl) return { success: false, error: 'No image URL' };

    try {
        // Force JPG format from Shopify CDN
        const fetchUrl = imageUrl.includes('?')
            ? `${imageUrl}&format=jpg`
            : `${imageUrl}?format=jpg`;

        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');

        // Generate filename
        let filename = imageUrl.split('/').pop().split('?')[0];
        filename = filename.replace(/\.(avif|webp|png|gif)$/i, '') + '.jpg';
        if (!filename || filename.length < 5) filename = 'image.jpg';

        // Update both Preview and Detail pictures
        await callBitrix('crm.product.update', {
            id: productId,
            fields: {
                PREVIEW_PICTURE: { fileData: [filename, base64] },
                DETAIL_PICTURE: { fileData: [filename, base64] }
            }
        });

        return { success: true };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Run image sync for products without images
 * @param {Object} options
 * @param {Function} options.progressCallback - Callback for progress updates
 * @returns {Object} Sync results
 */
export async function runImageSync(options = {}) {
    const { progressCallback } = options;
    const results = {
        success: true,
        totals: { total: 0, uploaded: 0, skipped: 0, errors: 0 },
        samples: []
    };

    try {
        // 1. Fetch products without images
        const products = await fetchProductsWithoutImages(progressCallback);
        results.totals.total = products.length;

        if (products.length === 0) {
            progressCallback?.({ type: 'complete', message: 'No products need image sync' });
            return results;
        }

        // 2. Process in batches
        for (let i = 0; i < products.length; i += BATCH_SIZE) {
            const batch = products.slice(i, i + BATCH_SIZE);

            for (const product of batch) {
                const productId = product.ID;
                const variantId = product.XML_ID; // Shopify variant_id stored in XML_ID
                const sku = product.CODE || product.NAME;

                // Get Shopify image URL
                const imageUrl = await getShopifyImageUrl(variantId);

                if (!imageUrl) {
                    // No image found in Shopify
                    results.totals.skipped++;
                    if (results.samples.length < 20) {
                        results.samples.push({ productId, sku, status: 'No Shopify image' });
                    }
                    continue;
                }

                // Upload to Bitrix
                const uploadResult = await uploadImageToBitrix(productId, imageUrl);

                if (uploadResult.success) {
                    results.totals.uploaded++;
                    if (results.samples.length < 20) {
                        results.samples.push({ productId, sku, status: 'Uploaded ✅' });
                    }
                    console.log(`[IMAGE SYNC] ✅ Uploaded image for ${sku} (ID: ${productId})`);
                } else {
                    results.totals.errors++;
                    if (results.samples.length < 20) {
                        results.samples.push({ productId, sku, status: `Error: ${uploadResult.error}` });
                    }
                    console.warn(`[IMAGE SYNC] ❌ Failed for ${sku}: ${uploadResult.error}`);
                }
            }

            // Progress update after batch
            progressCallback?.({
                type: 'batch_complete',
                processed: Math.min(i + BATCH_SIZE, products.length),
                total: products.length,
                uploaded: results.totals.uploaded,
                skipped: results.totals.skipped,
                errors: results.totals.errors
            });

            // Delay between batches
            if (i + BATCH_SIZE < products.length) {
                await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
            }
        }

        progressCallback?.({
            type: 'complete',
            message: `Image sync complete: ${results.totals.uploaded} uploaded, ${results.totals.skipped} skipped, ${results.totals.errors} errors`
        });

        return results;

    } catch (error) {
        console.error('[IMAGE SYNC] ❌ Sync failed:', error);
        results.success = false;
        results.error = error.message;
        progressCallback?.({ type: 'error', message: error.message });
        return results;
    }
}

export default { runImageSync };
