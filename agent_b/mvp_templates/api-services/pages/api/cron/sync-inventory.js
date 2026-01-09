// Server-side cron endpoint for automatic inventory synchronization
// Runs hourly via external cron service (e.g., Render cron, cron-job.org)
// Syncs only products with qty > 0 from Shopify (source of truth) to Bitrix
// Section ID is auto-determined from SKU first letter: A-F→36, G-M→38, N-S→40, T-Z→42

import { getAllProductsFromShopify } from '../../../src/lib/shopify/inventory.js';
import { syncProductVariantOptimized, getCurrentStock, createOutgoingDocument } from '../../../src/lib/bitrix/products.js';
import { findProductIdBySku } from '../../../src/lib/bitrix/mappingUtils.js';

// Rate limiting settings
const BATCH_SIZE = 50;
const DELAY_BETWEEN_BATCHES_MS = 2000;
const DELAY_BETWEEN_ITEMS_MS = 300;

export default async function handler(req, res) {
    // Verify cron secret (optional but recommended)
    const cronSecret = req.headers['x-cron-secret'] || req.query.secret;
    const expectedSecret = process.env.CRON_SECRET;

    if (expectedSecret && cronSecret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    console.log(JSON.stringify({
        event: 'CRON_SYNC_INVENTORY_START',
        requestId,
        timestamp: new Date().toISOString(),
        source: 'cron'
    }));

    try {
        // 1. Fetch all products from Shopify
        console.log(`[CRON SYNC INVENTORY] Fetching all products from Shopify...`);
        const allVariants = await getAllProductsFromShopify();

        // 2. Filter to only products with qty > 0
        const variantsWithStock = allVariants.filter(v => v.qty > 0);

        console.log(`[CRON SYNC INVENTORY] Found ${allVariants.length} total variants, ${variantsWithStock.length} with qty > 0`);

        const results = {
            success: true,
            requestId,
            summary: {
                totalShopifyVariants: allVariants.length,
                variantsWithStock: variantsWithStock.length,
                synced: 0,
                created: 0,
                updated: 0,
                skipped: 0,
                errors: 0
            },
            errors: [],
            duration: 0
        };

        // 3. Process variants in batches
        for (let i = 0; i < variantsWithStock.length; i += BATCH_SIZE) {
            const batch = variantsWithStock.slice(i, Math.min(i + BATCH_SIZE, variantsWithStock.length));
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(variantsWithStock.length / BATCH_SIZE);

            console.log(`[CRON SYNC INVENTORY] Processing batch ${batchNum}/${totalBatches} (${batch.length} items)`);

            for (const variant of batch) {
                try {
                    // Sync variant to Bitrix (create if not exists, update stock)
                    // Section ID is auto-determined from SKU first letter
                    const syncResult = await syncProductVariantOptimized(
                        variant,
                        true // createNew = true (create products that don't exist)
                        // sectionId not passed - auto-determined from SKU
                    );

                    results.summary.synced++;

                    if (syncResult.success) {
                        if (syncResult.created) {
                            results.summary.created++;
                        } else if (syncResult.documentId) {
                            results.summary.updated++;
                        } else {
                            results.summary.skipped++; // No change needed
                        }
                    } else {
                        results.summary.errors++;
                        results.errors.push({
                            sku: variant.sku,
                            variant_id: variant.variant_id,
                            error: syncResult.error
                        });
                    }

                    // Rate limiting between items
                    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ITEMS_MS));
                } catch (error) {
                    results.summary.errors++;
                    results.errors.push({
                        sku: variant.sku,
                        variant_id: variant.variant_id,
                        error: error.message
                    });
                }
            }

            // Rate limiting between batches
            if (i + BATCH_SIZE < variantsWithStock.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
            }
        }

        results.duration = Date.now() - startTime;

        console.log(JSON.stringify({
            event: 'CRON_SYNC_INVENTORY_SUCCESS',
            requestId,
            summary: results.summary,
            duration: `${results.duration}ms`,
            timestamp: new Date().toISOString()
        }));

        // Limit errors in response
        if (results.errors.length > 20) {
            results.errors = results.errors.slice(0, 20);
            results.errorsNote = 'Showing first 20 errors only';
        }

        return res.status(200).json(results);
    } catch (error) {
        const duration = Date.now() - startTime;

        console.error(JSON.stringify({
            event: 'CRON_SYNC_INVENTORY_ERROR',
            requestId,
            error: error.message,
            stack: error.stack,
            duration: `${duration}ms`,
            timestamp: new Date().toISOString()
        }));

        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message,
            requestId,
            duration
        });
    }
}
