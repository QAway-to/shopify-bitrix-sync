// Universal API endpoint for syncing products from any category (A-F, G-M, N-S, T-Z)
import { getCategoryProducts } from '../../../src/lib/shopify/inventory.js';
import { syncProductVariant, refreshBitrixMappingsFromCatalog } from '../../../src/lib/bitrix/products.js';

const VALID_CATEGORIES = ['category-a-f', 'category-g-m', 'category-n-s', 'category-t-z'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Check action: 'create' for creating new products, default is 'sync' (update quantities)
  const action = req.query.action || 'sync';
  const isCreateAction = action === 'create';
  
  // Get category and sectionId from request body
  const category = req.body?.category || 'category-a-f';
  const sectionId = req.body?.sectionId ? parseInt(req.body.sectionId) : 32;

  // Validate category
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid category',
      message: `Category must be one of: ${VALID_CATEGORIES.join(', ')}`
    });
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log(JSON.stringify({
    event: 'SYNC_CATEGORY_START',
    requestId,
    category,
    action,
    sectionId,
    timestamp: new Date().toISOString()
  }));

  try {
    // 1. Get products data from Shopify for the specified category
    console.log(`[SYNC ${category.toUpperCase()}] Fetching products data from Shopify...`);
    console.log(`[SYNC ${category.toUpperCase()}] Section ID (folder): ${sectionId}`);
    const products = await getCategoryProducts(category);

    const results = {
      success: true,
      requestId,
      category: category,
      sectionId: sectionId,
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
          console.log(`[SYNC ${category.toUpperCase()}] ⏭️ Skipping ${product.sku} (qty = 0)`);
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
          isCreateAction, // createNew: true for "create", false for "sync"
          sectionId // Section ID (folder) where to create products
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
        console.error(`[SYNC ${category.toUpperCase()}] Error syncing product:`, error);
        results.summary.errors++;
        results.products.push({
          success: false,
          sku: product.sku || 'N/A',
          error: error.message
        });
      }
    }

    console.log(JSON.stringify({
      event: 'SYNC_CATEGORY_SUCCESS',
      requestId,
      category,
      summary: results.summary,
      timestamp: new Date().toISOString()
    }));

    // If this was a create action, refresh mappings from Bitrix catalog after creation
    if (isCreateAction) {
      try {
        const mappingRefresh = await refreshBitrixMappingsFromCatalog();
        results.mappingRefresh = mappingRefresh;
        console.log(`[SYNC ${category.toUpperCase()}] ✅ Mapping refreshed after create:`, mappingRefresh);
      } catch (mapErr) {
        console.error(`[SYNC ${category.toUpperCase()}] ⚠️ Failed to refresh mappings after create:`, mapErr);
        results.mappingRefresh = { success: false, error: mapErr.message };
      }
    }

    return res.status(200).json(results);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'SYNC_CATEGORY_ERROR',
      requestId,
      category,
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

