// API endpoint for syncing category A-F products from Shopify to Bitrix
import { getCategoryProducts } from '../../../src/lib/shopify/inventory.js';
import { syncProductVariant, refreshBitrixMappingsFromCatalog } from '../../../src/lib/bitrix/products.js';

const CATEGORY = 'category-a-f';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Check action: 'create' for creating new products, default is 'sync' (update quantities)
  const action = req.query.action || 'sync';
  const isCreateAction = action === 'create';

  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log(JSON.stringify({
    event: 'SYNC_CATEGORY_A_F_START',
    requestId,
    action,
    timestamp: new Date().toISOString()
  }));

  try {
    // 1. Get products data from Shopify for category A-F
    console.log(`[SYNC CATEGORY A-F] Fetching products data from Shopify...`);
    const products = await getCategoryProducts(CATEGORY);

    const results = {
      success: true,
      requestId,
      category: CATEGORY,
      products: [],
      summary: {
        total: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0
      }
    };

    // 2. Sync each product
    for (const product of products) {
      try {
        // Skip products with qty = 0 if this is create action (only create products with stock)
        if (isCreateAction && (!product.qty || product.qty === 0)) {
          console.log(`[SYNC CATEGORY A-F] ⏭️ Skipping ${product.sku} (qty = 0)`);
          results.summary.skipped++;
          continue;
        }

        const syncResult = await syncProductVariant(
          {
            product_title: product.product_title,
            sku: product.sku,
            price: product.price,
            qty: product.qty,
            variant_id: product.variant_id,
            brand: product.brand || null,
            category: product.category || null
          },
          isCreateAction // createNew: true for "create", false for "sync"
        );

        results.products.push(syncResult);
        results.summary.total++;

        if (syncResult.success) {
          if (isCreateAction && syncResult.productId) {
            results.summary.created++;
          }
          // Only count as "updated" if quantity was actually synced (documentId means quantity changed)
          if (syncResult.documentId) {
            results.summary.updated++;
          }
        } else {
          results.summary.errors++;
        }

        // Rate limiting between products
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`[SYNC CATEGORY A-F] Error syncing product:`, error);
        results.summary.errors++;
        results.products.push({
          success: false,
          sku: product.sku || 'N/A',
          error: error.message
        });
      }
    }

    console.log(JSON.stringify({
      event: 'SYNC_CATEGORY_A_F_SUCCESS',
      requestId,
      summary: results.summary,
      timestamp: new Date().toISOString()
    }));

    // If this was a create action, refresh mappings from Bitrix catalog after creation
    if (isCreateAction) {
      try {
        const mappingRefresh = await refreshBitrixMappingsFromCatalog();
        results.mappingRefresh = mappingRefresh;
        console.log(`[SYNC CATEGORY A-F] ✅ Mapping refreshed after create:`, mappingRefresh);
      } catch (mapErr) {
        console.error(`[SYNC CATEGORY A-F] ⚠️ Failed to refresh mappings after create:`, mapErr);
        results.mappingRefresh = { success: false, error: mapErr.message };
      }
    }

    return res.status(200).json(results);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'SYNC_CATEGORY_A_F_ERROR',
      requestId,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }));

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      requestId
    });
  }
}

