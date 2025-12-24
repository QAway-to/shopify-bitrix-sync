// Universal API endpoint for syncing products from any category (A-F, G-M, N-S, T-Z)
// Uses optimized batch processing for better performance
import { getCategoryProducts } from '../../../src/lib/shopify/inventory.js';
import { refreshBitrixMappingsFromCatalog } from '../../../src/lib/bitrix/products.js';
import { 
  syncProductVariantOptimized,
  batchFindProductsBySku,
  batchGetCurrentStock,
  createGroupedIncomingDocument
} from '../../../src/lib/bitrix/productsBatch.js';

const VALID_CATEGORIES = ['category-a-f', 'category-g-m', 'category-n-s', 'category-t-z'];

// Optimization configuration
const BATCH_SIZE = 50; // Process products in batches
const PARALLEL_LIMIT = 5; // Number of products to process in parallel
const DOCUMENT_GROUP_SIZE = 20; // Group products into documents

// Store progress in memory (simple approach)
const progressStore = new Map();

// Store category sync results for logging (keep last 100 operations)
const categorySyncResults = [];
const MAX_SYNC_RESULTS = 100;

// Cleanup old progress entries (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of progressStore.entries()) {
    if (value.timestamp && now - value.timestamp > 3600000) {
      progressStore.delete(key);
    }
  }
}, 60000); // Check every minute

// Export function to get sync results for logs
export function getCategorySyncResults() {
  return [...categorySyncResults].reverse(); // Most recent first
}

export default async function handler(req, res) {
  // Support GET for progress updates
  if (req.method === 'GET') {
    const requestId = req.query.requestId;
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required' });
    }

    const progress = progressStore.get(requestId);
    if (!progress) {
      return res.status(404).json({ error: 'Progress not found' });
    }

    // Return current progress
    if (progress.complete) {
      return res.status(200).json({ type: 'complete', ...progress.result });
    } else {
      return res.status(200).json({ type: 'progress', ...progress });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST', 'GET']);
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

  const requestId = requestIdFromBody || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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

    // Filter products with qty > 0 if create action
    const productsToProcess = isCreateAction
      ? products.filter(p => p.qty && p.qty > 0)
      : products;

    console.log(`[SYNC ${category.toUpperCase()}] Processing ${productsToProcess.length} products (out of ${products.length} total) using optimized batch processing`);

    // Initialize progress
    progressStore.set(requestId, {
      processed: 0,
      total: productsToProcess.length,
      complete: false,
      result: null,
      currentProduct: null,
      currentAction: 'Инициализация...',
      details: [],
      timestamp: Date.now()
    });

    // 2. Process in batches with optimization
    for (let batchStart = 0; batchStart < productsToProcess.length; batchStart += BATCH_SIZE) {
      const batch = productsToProcess.slice(batchStart, batchStart + BATCH_SIZE);
      console.log(`[SYNC ${category.toUpperCase()}] Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(productsToProcess.length / BATCH_SIZE)} (${batch.length} products)`);

      // 2.1. Pre-fetch existing products for this batch
      const skus = batch.map(p => p.sku?.trim()).filter(Boolean);
      const existingProductsMap = await batchFindProductsBySku(skus);
      console.log(`[SYNC ${category.toUpperCase()}] Found ${Array.from(existingProductsMap.values()).filter(v => v !== null).length} existing products in batch`);

      // 2.2. Process products in parallel (with limit)
      const syncPromises = batch.map(async (product, index) => {
        // Stagger parallel requests slightly
        await new Promise(resolve => setTimeout(resolve, (index % PARALLEL_LIMIT) * 100));

        // Update progress - current product
        const currentProgress = progressStore.get(requestId);
        if (currentProgress) {
          currentProgress.currentProduct = `${product.sku || 'N/A'} - ${product.product_title || 'Unknown'}`;
          currentProgress.currentAction = isCreateAction ? 'Создание товара...' : 'Проверка товара...';
          currentProgress.timestamp = Date.now();
          progressStore.set(requestId, currentProgress);
        }

        const syncResult = await syncProductVariantOptimized(
          {
            product_title: product.product_title,
            sku: product.sku,
            price: product.price,
            qty: product.qty,
            variant_id: product.variant_id,
            brand: product.brand || null,
            category: product.category || null
          },
          isCreateAction,
          sectionId,
          existingProductsMap,
          null // Stock will be fetched later in groups
        );

        // Update progress - add detail
        const updatedProgress = progressStore.get(requestId);
        if (updatedProgress) {
          const detail = {
            sku: product.sku || 'N/A',
            title: product.product_title || 'Unknown',
            status: syncResult.success ? 'success' : 'error',
            action: syncResult.success 
              ? (syncResult.productId && !existingProductsMap.get(product.sku) ? 'created' : 'exists')
              : 'error',
            message: syncResult.success 
              ? (syncResult.productId && !existingProductsMap.get(product.sku) 
                  ? `Создан (ID: ${syncResult.productId})` 
                  : `Существует (ID: ${syncResult.productId})`)
              : syncResult.error || 'Ошибка'
          };
          updatedProgress.details.push(detail);
          updatedProgress.processed++;
          updatedProgress.currentProduct = null;
          updatedProgress.currentAction = `Обработано: ${updatedProgress.processed}/${updatedProgress.total}`;
          updatedProgress.timestamp = Date.now();
          progressStore.set(requestId, updatedProgress);
        }

        return syncResult;
      });

      const syncResults = await Promise.all(syncPromises);
      
      // 2.3. Collect results and group products needing documents
      const productsNeedingIncoming = [];
      const productsNeedingOutgoing = [];
      const productIdsForStock = [];

      for (const syncResult of syncResults) {
        results.products.push(syncResult);
        results.summary.total++;

        if (syncResult.success) {
          if (isCreateAction && syncResult.productId && !existingProductsMap.get(syncResult.sku)) {
            results.summary.created++;
          }

          if (syncResult.productId) {
            productIdsForStock.push(syncResult.productId);
          }

          if (syncResult.needsIncomingDocument) {
            productsNeedingIncoming.push({
              productId: syncResult.productId,
              amount: syncResult.difference,
              sku: syncResult.sku
            });
          } else if (syncResult.needsOutgoingDocument) {
            productsNeedingOutgoing.push({
              productId: syncResult.productId,
              amount: Math.abs(syncResult.difference),
              sku: syncResult.sku
            });
          }
        } else {
          results.summary.errors++;
        }
      }

      // 2.4. Batch fetch stock for all products
      if (productIdsForStock.length > 0) {
        const stockMap = await batchGetCurrentStock(productIdsForStock);
        
        // Re-calculate differences with actual stock
        for (let i = 0; i < syncResults.length; i++) {
          const syncResult = syncResults[i];
          if (syncResult.success && syncResult.productId && stockMap.has(syncResult.productId)) {
            const actualStock = stockMap.get(syncResult.productId);
            const actualDifference = syncResult.quantity - actualStock;
            
            // Update needsIncomingDocument/needsOutgoingDocument based on actual stock
            if (syncResult.quantity > 0 && actualDifference > 0) {
              const existingIndex = productsNeedingIncoming.findIndex(p => p.productId === syncResult.productId);
              if (existingIndex >= 0) {
                productsNeedingIncoming[existingIndex].amount = actualDifference;
              } else {
                productsNeedingIncoming.push({
                  productId: syncResult.productId,
                  amount: actualDifference,
                  sku: syncResult.sku
                });
              }
            } else if (actualDifference < 0) {
              const existingIndex = productsNeedingOutgoing.findIndex(p => p.productId === syncResult.productId);
              if (existingIndex >= 0) {
                productsNeedingOutgoing[existingIndex].amount = Math.abs(actualDifference);
              } else {
                productsNeedingOutgoing.push({
                  productId: syncResult.productId,
                  amount: Math.abs(actualDifference),
                  sku: syncResult.sku
                });
              }
            }
          }
        }
      }

      // 2.5. Create grouped incoming documents
      for (let i = 0; i < productsNeedingIncoming.length; i += DOCUMENT_GROUP_SIZE) {
        const documentGroup = productsNeedingIncoming.slice(i, i + DOCUMENT_GROUP_SIZE);
        try {
          const docId = await createGroupedIncomingDocument(
            documentGroup,
            `Синхронизация товаров ${category} из Shopify (батч ${Math.floor(i / DOCUMENT_GROUP_SIZE) + 1})`,
            2
          );
          results.summary.updated += documentGroup.length;
          console.log(`[SYNC ${category.toUpperCase()}] ✅ Created incoming document ${docId} for ${documentGroup.length} products`);
        } catch (error) {
          console.error(`[SYNC ${category.toUpperCase()}] ❌ Error creating grouped document:`, error);
          results.summary.errors += documentGroup.length;
        }
      }

      // 2.6. Create outgoing documents (one per product for now)
      if (productsNeedingOutgoing.length > 0) {
        const { createOutgoingDocument } = await import('../../../src/lib/bitrix/products.js');
        
        for (const product of productsNeedingOutgoing) {
          try {
            const docId = await createOutgoingDocument({
              title: `Синхронизация товара ${product.sku} из Shopify (списание)`,
              productId: product.productId,
              amount: product.amount
            });
            results.summary.updated++;
            console.log(`[SYNC ${category.toUpperCase()}] ✅ Created outgoing document for ${product.sku}`);
          } catch (error) {
            console.error(`[SYNC ${category.toUpperCase()}] ❌ Error creating outgoing document:`, error);
            results.summary.errors++;
          }
        }
      }

      // Update progress after batch completion
      const currentProgress = progressStore.get(requestId);
      if (currentProgress) {
        currentProgress.currentAction = `Батч ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(productsToProcess.length / BATCH_SIZE)} завершен. Создание документов...`;
        currentProgress.timestamp = Date.now();
        progressStore.set(requestId, currentProgress);
      }

      // Small delay between batches
      if (batchStart + BATCH_SIZE < productsToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Update skipped count
    results.summary.skipped = products.length - productsToProcess.length;

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

    // Mark as complete
    const finalProgress = progressStore.get(requestId);
    if (finalProgress) {
      finalProgress.complete = true;
      finalProgress.currentProduct = null;
      finalProgress.currentAction = 'Завершено';
      finalProgress.result = results;
      finalProgress.timestamp = Date.now();
      progressStore.set(requestId, finalProgress);
    }

    // Store result for logging
    // Determine created vs existing products based on details
    const createdProducts = [];
    const existingProducts = [];
    const errorProducts = [];
    
    if (finalProgress && finalProgress.details) {
      for (const detail of finalProgress.details) {
        const product = results.products.find(p => p.sku === detail.sku);
        if (product && product.success && product.productId) {
          if (detail.action === 'created') {
            createdProducts.push(product);
          } else if (detail.action === 'exists') {
            existingProducts.push(product);
          }
        } else if (detail.status === 'error') {
          errorProducts.push({
            sku: detail.sku,
            error: detail.message || 'Unknown error'
          });
        }
      }
    }
    
    const syncLogEntry = {
      requestId: requestId,
      category: category,
      sectionId: sectionId,
      action: action,
      timestamp: new Date().toISOString(),
      summary: results.summary,
      totalProducts: productsToProcess.length,
      details: finalProgress?.details || [],
      success: results.success,
      errors: errorProducts.length > 0 ? errorProducts : results.products.filter(p => !p.success || p.error),
      createdProducts: createdProducts,
      existingProducts: existingProducts
    };
    
    categorySyncResults.push(syncLogEntry);
    // Keep only last MAX_SYNC_RESULTS entries
    if (categorySyncResults.length > MAX_SYNC_RESULTS) {
      categorySyncResults.shift();
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

    // Store error result for logging
    const errorLogEntry = {
      requestId: requestId,
      category: category,
      sectionId: sectionId,
      action: action,
      timestamp: new Date().toISOString(),
      success: false,
      error: error.message,
      stack: error.stack
    };
    
    categorySyncResults.push(errorLogEntry);
    if (categorySyncResults.length > MAX_SYNC_RESULTS) {
      categorySyncResults.shift();
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      requestId
    });
  }
}

