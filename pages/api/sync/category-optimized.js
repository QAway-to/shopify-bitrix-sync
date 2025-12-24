// Optimized API endpoint for syncing products with progress tracking and parallel processing
import { getCategoryProducts } from '../../../src/lib/shopify/inventory.js';
import { syncProductVariantOptimized, refreshBitrixMappingsFromCatalog } from '../../../src/lib/bitrix/products.js';

// Server-only imports
const isServer = typeof window === 'undefined';
let writeFileSync, existsSync, mkdirSync, join;

if (isServer) {
  const fs = eval('require')('fs');
  const path = eval('require')('path');
  writeFileSync = fs.writeFileSync;
  existsSync = fs.existsSync;
  mkdirSync = fs.mkdirSync;
  join = path.join;
}

const VALID_CATEGORIES = ['category-a-f', 'category-g-m', 'category-n-s', 'category-t-z'];
const PARALLEL_WORKERS = 8; // Number of parallel workers

// Get progress directory (lazy initialization)
function getProgressDir() {
  if (!isServer) return null;
  const PROGRESS_DIR = join(process.cwd(), '.data', 'progress');
  if (!existsSync(PROGRESS_DIR)) {
    mkdirSync(PROGRESS_DIR, { recursive: true });
  }
  return PROGRESS_DIR;
}

function saveProgress(requestId, progress) {
  if (!isServer) return;
  try {
    const PROGRESS_DIR = getProgressDir();
    if (!PROGRESS_DIR) return;
    const progressFile = join(PROGRESS_DIR, `${requestId}.json`);
    writeFileSync(progressFile, JSON.stringify(progress, null, 2), 'utf-8');
  } catch (error) {
    console.error('[PROGRESS] Error saving progress:', error);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const action = req.query.action || 'sync';
  const isCreateAction = action === 'create';
  
  const category = req.body?.category || 'category-a-f';
  const sectionId = req.body?.sectionId ? parseInt(req.body.sectionId) : 32;

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid category',
      message: `Category must be one of: ${VALID_CATEGORIES.join(', ')}`
    });
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Initialize progress
  const progress = {
    requestId,
    category,
    status: 'starting',
    message: 'Загрузка товаров из Shopify...',
    total: 0,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString()
  };
  saveProgress(requestId, progress);

  console.log(JSON.stringify({
    event: 'SYNC_CATEGORY_OPTIMIZED_START',
    requestId,
    category,
    action,
    sectionId,
    timestamp: new Date().toISOString()
  }));

  // Start processing in background (don't wait for response)
  processCategoryAsync(requestId, category, sectionId, isCreateAction, progress)
    .catch(error => {
      console.error(`[SYNC ${category.toUpperCase()}] Background error:`, error);
      progress.status = 'error';
      progress.message = `Ошибка: ${error.message}`;
      progress.lastUpdate = new Date().toISOString();
      saveProgress(requestId, progress);
    });

  // Return immediately with requestId
  return res.status(202).json({
    success: true,
    requestId,
    message: 'Processing started',
    progressUrl: `/api/sync/progress?requestId=${requestId}`
  });
}

async function processCategoryAsync(requestId, category, sectionId, isCreateAction, progress) {
  try {
    // 1. Fetch products
    progress.status = 'fetching';
    progress.message = 'Загрузка товаров из Shopify...';
    progress.lastUpdate = new Date().toISOString();
    saveProgress(requestId, progress);

    const products = await getCategoryProducts(category);
    const productsToProcess = isCreateAction 
      ? products.filter(p => p.qty && p.qty > 0)
      : products;

    progress.total = productsToProcess.length;
    progress.status = 'processing';
    progress.message = `Обработка товаров: 0/${progress.total}`;
    progress.lastUpdate = new Date().toISOString();
    saveProgress(requestId, progress);

    // 2. Process in parallel batches
    const results = {
      products: [],
      summary: {
        total: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0
      }
    };

    // Split into batches for parallel processing
    const batches = [];
    for (let i = 0; i < productsToProcess.length; i += PARALLEL_WORKERS) {
      batches.push(productsToProcess.slice(i, i + PARALLEL_WORKERS));
    }

    let lastProgressUpdate = Date.now();

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      
      // Process batch in parallel
      const batchResults = await Promise.allSettled(
        batch.map(product => 
          syncProductVariantOptimized(
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
            sectionId
          )
        )
      );

      // Process results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.products.push(result.value);
          results.summary.total++;
          
          if (result.value.success) {
            if (isCreateAction && result.value.productId) {
              results.summary.created++;
              progress.created++;
            }
            if (result.value.documentId) {
              results.summary.updated++;
              progress.updated++;
            }
          } else {
            results.summary.errors++;
            progress.errors++;
          }
        } else {
          results.summary.errors++;
          progress.errors++;
          results.products.push({
            success: false,
            sku: 'N/A',
            error: result.reason?.message || 'Unknown error'
          });
        }
      }

      progress.processed = results.summary.total;
      progress.message = `Обработка товаров: ${progress.processed}/${progress.total}`;
      progress.lastUpdate = new Date().toISOString();

      // Update progress every 30 seconds or after each batch
      const now = Date.now();
      if (now - lastProgressUpdate >= 30000 || batchIndex === batches.length - 1) {
        saveProgress(requestId, progress);
        lastProgressUpdate = now;
      }

      // Small delay between batches to avoid overwhelming API
      if (batchIndex < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // 3. Group inventory documents (optimization: one document per batch of products)
    if (isCreateAction && results.summary.created > 0) {
      progress.status = 'syncing_inventory';
      progress.message = 'Синхронизация остатков...';
      progress.lastUpdate = new Date().toISOString();
      saveProgress(requestId, progress);

      // Inventory sync is already done in syncProductVariantOptimized
      // But we can optimize further by grouping documents
    }

    // 4. Refresh mappings
    if (isCreateAction) {
      progress.status = 'refreshing_mappings';
      progress.message = 'Обновление маппинга...';
      progress.lastUpdate = new Date().toISOString();
      saveProgress(requestId, progress);

      try {
        await refreshBitrixMappingsFromCatalog();
      } catch (mapErr) {
        console.error(`[SYNC ${category.toUpperCase()}] ⚠️ Failed to refresh mappings:`, mapErr);
      }
    }

    // 5. Finalize
    progress.status = 'completed';
    progress.message = `Завершено: создано ${results.summary.created}, обновлено ${results.summary.updated}`;
    progress.lastUpdate = new Date().toISOString();
    progress.endTime = new Date().toISOString();
    saveProgress(requestId, progress);

    console.log(JSON.stringify({
      event: 'SYNC_CATEGORY_OPTIMIZED_SUCCESS',
      requestId,
      category,
      summary: results.summary,
      timestamp: new Date().toISOString()
    }));

  } catch (error) {
    console.error(JSON.stringify({
      event: 'SYNC_CATEGORY_OPTIMIZED_ERROR',
      requestId,
      category,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }));

    progress.status = 'error';
    progress.message = `Ошибка: ${error.message}`;
    progress.lastUpdate = new Date().toISOString();
    saveProgress(requestId, progress);
  }
}

