/**
 * Optimized batch operations for Bitrix products
 * Handles parallel processing and grouped documents
 */

import { callBitrix } from './client.js';
import { findProductBySku, createBitrixProduct, updateBitrixProductFields, getCurrentStock } from './products.js';
import { updateSkuMapping } from './mappingUtils.js';

/**
 * Batch check products existence by SKU
 * @param {string[]} skus - Array of SKUs to check
 * @returns {Promise<Map<string, number>>} Map of SKU -> Product ID (null if not exists)
 */
export async function batchFindProductsBySku(skus) {
  const skuMap = new Map();
  
  if (!skus || skus.length === 0) {
    return skuMap;
  }

  // Process in batches of 50 (Bitrix API limit)
  const batchSize = 50;
  for (let i = 0; i < skus.length; i += batchSize) {
    const batch = skus.slice(i, i + batchSize);
    
    try {
      // Bitrix API supports filtering by multiple XML_ID values using array
      // Format: filter: { XML_ID: ['SKU1', 'SKU2', ...] }
      const response = await callBitrix('crm.product.list', {
        filter: {
          XML_ID: batch
        },
        select: ['ID', 'XML_ID', 'CODE']
      });

      if (response.result) {
        for (const product of response.result) {
          const sku = product.XML_ID || product.CODE;
          if (sku) {
            skuMap.set(sku, parseInt(product.ID));
          }
        }
      }
    } catch (error) {
      console.error(`[BATCH PRODUCTS] Error checking batch:`, error);
      // If batch API fails, fall back to individual checks for this batch
      console.log(`[BATCH PRODUCTS] Falling back to individual checks for batch`);
      for (const sku of batch) {
        try {
          const { findProductBySku } = await import('./products.js');
          const productId = await findProductBySku(sku);
          skuMap.set(sku, productId);
        } catch (err) {
          console.error(`[BATCH PRODUCTS] Error checking individual SKU ${sku}:`, err);
          skuMap.set(sku, null);
        }
      }
    }
  }

  // Fill in nulls for SKUs not found
  for (const sku of skus) {
    if (!skuMap.has(sku)) {
      skuMap.set(sku, null);
    }
  }

  return skuMap;
}

/**
 * Batch get current stock for multiple products
 * @param {number[]} productIds - Array of product IDs
 * @param {number} storeId - Store ID (default: 2)
 * @returns {Promise<Map<number, number>>} Map of Product ID -> Stock quantity
 */
export async function batchGetCurrentStock(productIds, storeId = 2) {
  const stockMap = new Map();
  
  // Process in batches of 50
  const batchSize = 50;
  for (let i = 0; i < productIds.length; i += batchSize) {
    const batch = productIds.slice(i, i + batchSize);
    
    try {
      const response = await callBitrix('catalog.storeproduct.list', {
        filter: {
          productId: batch,
          storeId: storeId
        },
        select: ['PRODUCT_ID', 'AMOUNT']
      });

      if (response.result) {
        for (const item of response.result) {
          const productId = parseInt(item.PRODUCT_ID);
          const amount = parseFloat(item.AMOUNT) || 0;
          stockMap.set(productId, amount);
        }
      }
    } catch (error) {
      console.error(`[BATCH STOCK] Error getting stock batch:`, error);
      // Continue with next batch
    }
  }

  // Fill in 0 for products not found
  for (const productId of productIds) {
    if (!stockMap.has(productId)) {
      stockMap.set(productId, 0);
    }
  }

  return stockMap;
}

/**
 * Create a grouped incoming document for multiple products
 * @param {Array} products - Array of {productId, amount, sku}
 * @param {string} title - Document title
 * @param {number} storeId - Store ID (default: 2)
 * @returns {Promise<number>} Document ID
 */
export async function createGroupedIncomingDocument(products, title, storeId = 2) {
  if (!products || products.length === 0) {
    throw new Error('Products array is required');
  }

  const docNumber = `BATCH-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    // 1. Create document
    const docResponse = await callBitrix('catalog.document.add', {
      fields: {
        docType: 'S', // Store Adjustment
        title: title,
        docNumber: docNumber,
        currency: 'EUR',
        status: 'N', // Draft
        responsibleId: 52
      }
    });

    let docId;
    if (docResponse.result?.document?.id) {
      docId = docResponse.result.document.id;
    } else if (docResponse.result) {
      docId = docResponse.result;
    } else {
      throw new Error('Failed to create document: no ID returned');
    }

    console.log(`[BATCH DOCUMENT] ✅ Document created: ${docNumber} (ID: ${docId})`);

    // Wait a bit for document to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // 2. Add all products to document in parallel (but with rate limiting)
    const addPromises = products.map(async (product, index) => {
      // Stagger requests slightly to avoid overwhelming API
      await new Promise(resolve => setTimeout(resolve, index * 50));

      const elementPayload = {
        fields: {
          docId: docId,
          DOC_ID: docId,
          productId: product.productId,
          elementId: product.productId,
          ELEMENT_ID: product.productId,
          amount: product.amount,
          AMOUNT: product.amount,
          purchasingPrice: 0,
          PURCHASING_PRICE: 0,
          storeId: storeId,
          storeTo: storeId,
          STORE_TO: storeId
        }
      };

      try {
        const elementResponse = await callBitrix('catalog.document.element.add', elementPayload);
        if (elementResponse.result) {
          console.log(`[BATCH DOCUMENT] ✅ Added product ${product.sku} (ID: ${product.productId}, Qty: ${product.amount})`);
          return { success: true, productId: product.productId };
        } else {
          throw new Error(`Failed to add product: ${JSON.stringify(elementResponse)}`);
        }
      } catch (error) {
        console.error(`[BATCH DOCUMENT] ❌ Error adding product ${product.sku}:`, error);
        return { success: false, productId: product.productId, error: error.message };
      }
    });

    const addResults = await Promise.all(addPromises);
    const failed = addResults.filter(r => !r.success);

    if (failed.length > 0) {
      console.warn(`[BATCH DOCUMENT] ⚠️ ${failed.length} products failed to add to document`);
    }

    // Wait a bit before conducting
    await new Promise(resolve => setTimeout(resolve, 500));

    // 3. Conduct document
    const conductResponse = await callBitrix('catalog.document.conduct', { id: docId });

    if (conductResponse.result === true) {
      console.log(`[BATCH DOCUMENT] ✅ Document conducted: ${docNumber} (${products.length} products)`);
      return docId;
    } else {
      throw new Error(`Failed to conduct document: ${JSON.stringify(conductResponse)}`);
    }
  } catch (error) {
    console.error(`[BATCH DOCUMENT] ❌ Error creating grouped document:`, error);
    throw error;
  }
}

/**
 * Sync product variant with optimized batch operations
 * @param {Object} productData - Product data
 * @param {boolean} createNew - Whether to create if not exists
 * @param {number} sectionId - Section ID
 * @param {Map<string, number>} existingProductsMap - Pre-fetched map of existing products (SKU -> Product ID)
 * @param {Map<number, number>} stockMap - Pre-fetched map of stock (Product ID -> Stock)
 * @returns {Promise<Object>} Sync result
 */
export async function syncProductVariantOptimized(
  productData,
  createNew = true,
  sectionId = 32,
  existingProductsMap = null,
  stockMap = null
) {
  const { product_title, sku, price, qty } = productData;

  if (!sku || !sku.trim()) {
    return {
      success: false,
      sku: sku || 'N/A',
      error: 'SKU is required'
    };
  }

  const skuClean = sku.trim();
  const productName = product_title || 'Unknown Product';

  try {
    // 1. Check if product exists (use pre-fetched map if available)
    let productId = null;
    if (existingProductsMap && existingProductsMap.has(skuClean)) {
      productId = existingProductsMap.get(skuClean);
    } else {
      productId = await findProductBySku(skuClean);
    }

    // 2. Create product if not exists
    if (!productId) {
      if (createNew) {
        console.log(`[BATCH PRODUCTS] Creating product: ${productName} (SKU: ${skuClean})`);
        
        const productFields = {
          name: productName,
          price: parseFloat(price) || 0,
          sku: skuClean
        };

        productId = await createBitrixProduct(productFields, 14, sectionId);
        
        // Update product with additional properties if available
        if (productData.brand || productData.category) {
          const updateFields = {};
          if (productData.brand) {
            updateFields.PROPERTY_102 = productData.brand;
          }
          if (productData.category) {
            updateFields.PROPERTY_104 = productData.category;
          }
          
          if (Object.keys(updateFields).length > 0) {
            try {
              await updateBitrixProductFields(productId, updateFields);
            } catch (updateError) {
              console.warn(`[BATCH PRODUCTS] ⚠️ Failed to update product properties:`, updateError);
            }
          }
        }
        
        updateSkuMapping(skuClean, productId);
      } else {
        return {
          success: false,
          sku: skuClean,
          error: 'Product not found and createNew=false'
        };
      }
    } else {
      // Ensure mapping is in cache
      updateSkuMapping(skuClean, productId);
    }

    // 3. Check stock (use pre-fetched map if available)
    let currentStock = 0;
    if (stockMap && stockMap.has(productId)) {
      currentStock = stockMap.get(productId);
    } else {
      currentStock = await getCurrentStock(productId);
    }

    const shopifyQty = qty || 0;
    const difference = shopifyQty - currentStock;

    // Return data for grouped document creation (if qty > 0 and difference > 0)
    return {
      success: true,
      sku: skuClean,
      productId: productId,
      productName: productName,
      quantity: shopifyQty,
      currentStock: currentStock,
      difference: difference,
      needsIncomingDocument: shopifyQty > 0 && difference > 0,
      needsOutgoingDocument: difference < 0
    };
  } catch (error) {
    console.error(`[BATCH PRODUCTS] ❌ Error syncing product ${skuClean}:`, error);
    return {
      success: false,
      sku: skuClean,
      error: error.message
    };
  }
}

