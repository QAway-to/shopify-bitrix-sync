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

// Simple progress store (in-memory)
const progressStore = new Map();

// Cleanup old progress (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of progressStore.entries()) {
    if (value.timestamp && now - value.timestamp > 3600000) {
      progressStore.delete(key);
    }
  }
}, 60000);

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

    return res.status(200).json(progress);
  }
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

    // Filter products with qty > 0 if create action
    const productsToProcess = isCreateAction
      ? products.filter(p => p.qty && p.qty > 0)
      : products;

    console.log(`[SYNC ${category.toUpperCase()}] Processing ${productsToProcess.length} products (out of ${products.length} total) using optimized batch processing`);

    // Initialize progress
    progressStore.set(requestId, {
      processed: 0,
      total: productsToProcess.length,
      currentBatch: 0,
      totalBatches: Math.ceil(productsToProcess.length / BATCH_SIZE),
      complete: false,
      timestamp: Date.now()
    });

    // 2. Process in batches with optimization
    for (let batchStart = 0; batchStart < productsToProcess.length; batchStart += BATCH_SIZE) {
      const batch = productsToProcess.slice(batchStart, batchStart + BATCH_SIZE);
      const currentBatch = Math.floor(batchStart / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(productsToProcess.length / BATCH_SIZE);
      
      console.log(`[SYNC ${category.toUpperCase()}] Processing batch ${currentBatch}/${totalBatches} (${batch.length} products)`);
      
      // Update progress
      let progress = progressStore.get(requestId);
      if (progress) {
        progress.currentBatch = currentBatch;
        progress.totalBatches = totalBatches;
        progress.timestamp = Date.now();
        progressStore.set(requestId, progress);
      }

      // 2.1. Pre-fetch existing products for this batch
      const skus = batch.map(p => p.sku?.trim()).filter(Boolean);
      const existingProductsMap = await batchFindProductsBySku(skus);
      console.log(`[SYNC ${category.toUpperCase()}] Found ${Array.from(existingProductsMap.values()).filter(v => v !== null).length} existing products in batch`);

      // 2.2. Process products in parallel (with limit)
      const syncPromises = batch.map(async (product, index) => {
        // Stagger parallel requests slightly
        await new Promise(resolve => setTimeout(resolve, (index % PARALLEL_LIMIT) * 100));

        return syncProductVariantOptimized(
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
      });

      const syncResults = await Promise.all(syncPromises);
      
      // Update progress after batch
      progress = progressStore.get(requestId);
      if (progress) {
        progress.processed += syncResults.length;
        progress.timestamp = Date.now();
        progressStore.set(requestId, progress);
      }
      
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

      // Small delay between batches
      if (batchStart + BATCH_SIZE < productsToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Update skipped count
    results.summary.skipped = products.length - productsToProcess.length;

    // Mark progress as complete and store result
    const finalProgress = progressStore.get(requestId);
    if (finalProgress) {
      finalProgress.complete = true;
      finalProgress.processed = productsToProcess.length;
      finalProgress.result = results;
      finalProgress.timestamp = Date.now();
      progressStore.set(requestId, finalProgress);
    }

    // Log detailed results
    console.log(JSON.stringify({
      event: 'SYNC_CATEGORY_SUCCESS',
      requestId,
      category,
      sectionId,
      action,
      summary: results.summary,
      totalProducts: products.length,
      processedProducts: productsToProcess.length,
      timestamp: new Date().toISOString()
    }));

    // Log detailed report
    console.log(`[SYNC ${category.toUpperCase()}] === ОТЧЁТ ПО ОБРАБОТКЕ ===`);
    console.log(`[SYNC ${category.toUpperCase()}] Всего товаров в категории: ${products.length}`);
    console.log(`[SYNC ${category.toUpperCase()}] Обработано товаров: ${productsToProcess.length}`);
    console.log(`[SYNC ${category.toUpperCase()}] Пропущено (qty=0): ${results.summary.skipped}`);
    console.log(`[SYNC ${category.toUpperCase()}] Создано новых: ${results.summary.created}`);
    console.log(`[SYNC ${category.toUpperCase()}] Обновлено (документы): ${results.summary.updated}`);
    console.log(`[SYNC ${category.toUpperCase()}] Ошибок: ${results.summary.errors}`);
    console.log(`[SYNC ${category.toUpperCase()}] Раздел (SECTION_ID): ${sectionId}`);
    console.log(`[SYNC ${category.toUpperCase()}] ===========================`);

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
    // Mark progress as error
    const errorProgress = progressStore.get(requestId);
    if (errorProgress) {
      errorProgress.complete = true;
      errorProgress.error = error.message;
      errorProgress.timestamp = Date.now();
      progressStore.set(requestId, errorProgress);
    }

    console.error(JSON.stringify({
      event: 'SYNC_CATEGORY_ERROR',
      requestId,
      category,
      sectionId,
      action,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }));

    console.error(`[SYNC ${category.toUpperCase()}] === ОШИБКА ОБРАБОТКИ ===`);
    console.error(`[SYNC ${category.toUpperCase()}] Категория: ${category}`);
    console.error(`[SYNC ${category.toUpperCase()}] Раздел: ${sectionId}`);
    console.error(`[SYNC ${category.toUpperCase()}] Ошибка: ${error.message}`);
    console.error(`[SYNC ${category.toUpperCase()}] ======================`);

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      requestId
    });
  }
}

