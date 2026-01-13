/**
 * Bitrix24 Deal Product Rows Management
 * Handles product rows for deals
 * 
 * ✅ Updated: Now uses syncProductVariantOptimized for dynamic product creation
 *    with description and preview image (same as Pre-Order flow)
 */

import { callBitrixAPI } from './client.js';
import { BITRIX_CONFIG } from './config.js';
import { syncProductVariantOptimized } from './products.js';
import { callShopifyAdmin } from '../shopify/adminClient.js';

/**
 * Fetch product details from Shopify to get description and images
 * @param {string} productId - Shopify product ID
 * @returns {Promise<{description: string|null, imageUrl: string|null}>}
 */
async function fetchShopifyProductDetails(productId) {
  try {
    const response = await callShopifyAdmin(`/products/${productId}.json`);
    const product = response?.product;

    if (!product) {
      return { description: null, imageUrl: null };
    }

    const description = product.body_html || null;
    const imageUrl = product.image?.src || product.images?.[0]?.src || null;

    return { description, imageUrl };
  } catch (error) {
    console.warn(`[PRODUCT ROWS] Failed to fetch product ${productId} details:`, error.message);
    return { description: null, imageUrl: null };
  }
}

/**
 * Map Shopify line item to Bitrix product row (async, creates product if needed)
 * @param {Object} lineItem - Shopify line item
 * @param {Object} order - Shopify order
 * @returns {Promise<Object|null>} Bitrix product row or null if failed
 */
async function mapLineItemToProductRowAsync(lineItem, order) {
  const sku = lineItem.sku;
  const variantId = lineItem.variant_id;

  if (!sku && !variantId) {
    console.warn(`[BITRIX PRODUCT ROWS] Line item ${lineItem.id} has no SKU or variant_id, skipping`);
    return null;
  }

  // Parse price
  const price = typeof lineItem.price === 'string'
    ? parseFloat(lineItem.price)
    : (lineItem.price || 0);

  // Get tax rate from line item or order
  let taxRate = 0;
  if (lineItem.tax_lines && lineItem.tax_lines.length > 0) {
    taxRate = (lineItem.tax_lines[0].rate || 0) * 100;
  } else if (order.tax_lines && order.tax_lines.length > 0) {
    taxRate = (order.tax_lines[0].rate || 0) * 100;
  }

  // ✅ Dynamic product sync with description and image
  // Fetch product details from Shopify
  const productId = lineItem.product_id;
  let description = null;
  let imageUrl = null;

  if (productId) {
    const details = await fetchShopifyProductDetails(productId);
    description = details.description;
    imageUrl = details.imageUrl;
  }

  // Sync product to Bitrix (create if not exists, update if exists)
  const syncData = {
    variant_id: variantId ? String(variantId) : null,
    sku: sku || null,
    product_title: lineItem.title || lineItem.name || 'Unknown Product',
    variant_title: lineItem.variant_title || '',
    price: price,
    qty: lineItem.quantity || 1,
    description: description,
    imageUrl: imageUrl
  };

  try {
    const syncResult = await syncProductVariantOptimized(syncData, true);

    if (syncResult.productId) {
      console.log(`[BITRIX PRODUCT ROWS] ✅ Synced product ${syncResult.productId} for SKU ${sku}`);
      return {
        PRODUCT_ID: syncResult.productId,
        PRICE: price,
        QUANTITY: lineItem.quantity || 1,
        TAX_INCLUDED: order.taxes_included ? 'Y' : 'N',
        TAX_RATE: taxRate
      };
    }
  } catch (syncError) {
    console.error(`[BITRIX PRODUCT ROWS] Failed to sync product for SKU ${sku}:`, syncError.message);
  }

  // Fallback to static mapping if sync failed
  const staticProductId = BITRIX_CONFIG.SKU_TO_PRODUCT_ID?.[sku];
  if (staticProductId) {
    console.log(`[BITRIX PRODUCT ROWS] Using static mapping for SKU ${sku}: ${staticProductId}`);
    return {
      PRODUCT_ID: staticProductId,
      PRICE: price,
      QUANTITY: lineItem.quantity || 1,
      TAX_INCLUDED: order.taxes_included ? 'Y' : 'N',
      TAX_RATE: taxRate
    };
  }

  console.warn(`[BITRIX PRODUCT ROWS] Could not resolve product for SKU ${sku}`);
  return null;
}

/**
 * Create product rows array from Shopify order (async version)
 * ✅ Now syncs products with description and images
 * @param {Object} order - Shopify order
 * @returns {Promise<Array<Object>>} Array of product rows
 */
export async function createProductRowsFromOrder(order) {
  const rows = [];

  // Process line items
  if (order.line_items && Array.isArray(order.line_items)) {
    for (const lineItem of order.line_items) {
      const row = await mapLineItemToProductRowAsync(lineItem, order);
      if (row) {
        rows.push(row);
      }
    }
  }

  // Add shipping as separate product row if configured
  if (BITRIX_CONFIG.SHIPPING_PRODUCT_ID > 0 && order.shipping_lines && order.shipping_lines.length > 0) {
    const shippingLine = order.shipping_lines[0];
    const shippingPrice = typeof shippingLine.price === 'string'
      ? parseFloat(shippingLine.price)
      : (shippingLine.price || 0);

    if (shippingPrice > 0) {
      rows.push({
        PRODUCT_ID: BITRIX_CONFIG.SHIPPING_PRODUCT_ID,
        PRICE: shippingPrice,
        QUANTITY: 1,
        TAX_INCLUDED: order.taxes_included ? 'Y' : 'N',
        TAX_RATE: 0 // Shipping usually doesn't have tax
      });
    }
  }

  return rows;
}

/**
 * Set product rows for a deal
 * @param {string} webhookUrl - Bitrix webhook URL
 * @param {number} dealId - Deal ID
 * @param {Array<Object>} rows - Product rows array
 * @returns {Promise<boolean>} Success status
 */
export async function setBitrixDealProductRows(webhookUrl, dealId, rows) {
  if (!rows || rows.length === 0) {
    console.log('[BITRIX PRODUCT ROWS] No product rows to set');
    return true; // Not an error, just nothing to do
  }

  try {
    const result = await callBitrixAPI(webhookUrl, 'crm.deal.productrows.set', {
      id: dealId,
      rows: rows
    });

    if (result.result) {
      console.log(`[BITRIX PRODUCT ROWS] Successfully set ${rows.length} product rows for deal ${dealId}`);
      return true;
    }

    console.error('[BITRIX PRODUCT ROWS] Failed to set product rows:', result);
    return false;
  } catch (error) {
    console.error('[BITRIX PRODUCT ROWS] Error setting product rows:', error);
    return false;
  }
}
