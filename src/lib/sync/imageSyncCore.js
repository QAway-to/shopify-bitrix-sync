/**
 * Image Sync Core Module (Optimized)
 * Syncs product images from Shopify to Bitrix for products missing PREVIEW_PICTURE
 * Uses Bulk Fetching from Shopify to minimize API calls.
 */

import { callBitrix } from '../bitrix/client.js';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "83bfa8-c4.myshopify.com";
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || "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";

const BATCH_SIZE = 50; // Increased batch size for efficiency
const DELAY_BETWEEN_BATCHES_MS = 1000; // Reduced delay

/**
 * Fetch Bitrix products without PREVIEW_PICTURE
 */
async function fetchProductsWithoutImages(progressCallback) {
    const products = [];
    let start = 0;

    progressCallback?.({ type: 'info', message: 'Fetching Bitrix products without images...' });

    // Fetch in chunks to avoid memory issues if too many
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
            // Safety break for very large datasets to process in chunks? 
            // For now, fetch all.
        } else {
            break;
        }
    }

    progressCallback?.({ type: 'info', message: `Found ${products.length} products without images` });
    return products;
}

/**
 * Bulk fetch Shopify image URLs for a list of variant IDs
 * Reduces N*2 requests to 2 requests.
 */
async function getShopifyImagesBulk(variantIds) {
    if (!variantIds || variantIds.length === 0) return {};

    const mapping = {}; // variantId -> imageUrl
    const validVariantIds = variantIds.filter(id => id && id !== 'null' && id !== 'undefined');

    if (validVariantIds.length === 0) return {};

    try {
        // 1. Fetch Variants in Bulk
        // Shopify limits ids parameter to ~100 usually. We process in batch of 50 so it fits.
        const variantsUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/variants.json?ids=${validVariantIds.join(',')}&fields=id,product_id,image_id`;
        const variantsResp = await fetch(variantsUrl, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
        });

        if (!variantsResp.ok) {
            console.error(`[IMAGE SYNC] Failed to fetch variants bulk: ${variantsResp.statusText}`);
            return {};
        }

        const variantsData = await variantsResp.json();
        const variants = variantsData.variants || [];

        // Collect Product IDs to fetch images
        const productIds = [...new Set(variants.map(v => v.product_id).filter(Boolean))];

        if (productIds.length === 0) return {};

        // 2. Fetch Products in Bulk (to get images)
        // Split productIds if > 50 (unlikely for 50 variants but possible)
        const productsUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?ids=${productIds.join(',')}&fields=id,images,image`;
        const productsResp = await fetch(productsUrl, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
        });

        if (!productsResp.ok) {
            console.error(`[IMAGE SYNC] Failed to fetch products bulk: ${productsResp.statusText}`);
            return {};
        }

        const productsData = await productsResp.json();
        const products = productsData.products || [];

        // create product lookup
        const productMap = {}; // productId -> product object
        products.forEach(p => { productMap[p.id] = p; });

        // 3. Map Variant -> Image URL
        for (const variant of variants) {
            const product = productMap[variant.product_id];
            if (!product) continue;

            let imgSrc = null;

            // Try variant-specific image
            if (variant.image_id && product.images) {
                const specificImg = product.images.find(img => img.id === variant.image_id);
                if (specificImg) imgSrc = specificImg.src;
            }

            // Fallback to main product image
            if (!imgSrc) {
                imgSrc = product.image?.src || product.images?.[0]?.src;
            }

            if (imgSrc) {
                mapping[String(variant.id)] = imgSrc;
            }
        }

    } catch (error) {
        console.error(`[IMAGE SYNC] Bulk fetch error: ${error.message}`);
    }

    return mapping;
}

/**
 * Upload image to Bitrix product
 */
async function uploadImageToBitrix(productId, imageUrl) {
    if (!imageUrl) return { success: false, error: 'No image URL' };

    try {
        // Fetch image
        const fetchUrl = imageUrl.includes('?') ? `${imageUrl}&format=jpg` : `${imageUrl}?format=jpg`;
        const response = await fetch(fetchUrl);

        if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');

        // Filename
        let filename = imageUrl.split('/').pop().split('?')[0];
        filename = filename.replace(/\.(avif|webp|png|gif)$/i, '') + '.jpg';
        if (!filename || filename.length < 5) filename = 'image.jpg';

        // Update Bitrix (single call for both fields)
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
 * Run image sync
 */
export async function runImageSync(options = {}) {
    const { progressCallback } = options;
    const results = {
        success: true,
        totals: { total: 0, uploaded: 0, skipped: 0, errors: 0 },
        samples: []
    };

    try {
        const products = await fetchProductsWithoutImages(progressCallback);
        results.totals.total = products.length;

        if (products.length === 0) {
            progressCallback?.({ type: 'complete', message: 'No products need image sync' });
            return results;
        }

        // Process in batches
        for (let i = 0; i < products.length; i += BATCH_SIZE) {
            const batch = products.slice(i, i + BATCH_SIZE);

            // 1. Bulk Fetching from Shopify
            const variantIds = batch.map(p => p.XML_ID).filter(Boolean);
            const imageMap = await getShopifyImagesBulk(variantIds);

            // 2. Upload in parallel (with concurrency limit managed by batch size)
            // Bitrix API can handle the batch parallel requests if not too aggressive.
            // For 50 items, we might want to throttle uploads slightly or use Promise.all for chunks.
            // Let's do Promise.all for the whole batch (50 concurrent uploads might be okay for standard plans, 
            // but safer to do sub-batches of 5 for uploads to avoid 503s).

            const UPLOAD_CONCURRENCY = 5;
            for (let j = 0; j < batch.length; j += UPLOAD_CONCURRENCY) {
                const subBatch = batch.slice(j, j + UPLOAD_CONCURRENCY);

                await Promise.all(subBatch.map(async (product) => {
                    const productId = product.ID;
                    const variantId = String(product.XML_ID);
                    const sku = product.CODE || product.NAME;

                    const imageUrl = imageMap[variantId];

                    if (!imageUrl) {
                        results.totals.skipped++;
                        return; // Skip if no image found
                    }

                    // Upload
                    const uploadResult = await uploadImageToBitrix(productId, imageUrl);

                    if (uploadResult.success) {
                        results.totals.uploaded++;
                        // Log only first few or periodically to avoid spam
                        if (results.totals.uploaded % 10 === 0) {
                            console.log(`[IMAGE SYNC] ✅ Uploaded ${sku}`);
                        }
                    } else {
                        results.totals.errors++;
                        console.warn(`[IMAGE SYNC] ❌ Failed ${sku}: ${uploadResult.error}`);
                    }
                }));
            }

            // Progress update per batch
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
            message: `Image sync complete: ${results.totals.uploaded} uploaded`
        });

        return results;

    } catch (error) {
        console.error('[IMAGE SYNC] Fatal error:', error);
        results.success = false;
        results.error = error.message;
        progressCallback?.({ type: 'error', message: error.message });
        return results;
    }
}

export default { runImageSync };
