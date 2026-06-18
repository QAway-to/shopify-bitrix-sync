/**
 * Map Shopify Order to Bitrix24 Deal
 * Returns both deal fields and product rows
 */

import { logger } from '../logging/logger.js';
import { BITRIX_CONFIG, financialStatusToStageId, financialStatusToPaymentStatus, sourceNameToSourceId } from './config.js';
import skuMapping from './skuMapping.json' assert { type: 'json' };
import handleMapping from './handleMapping.json' assert { type: 'json' };
import brandMapping from './brandMapping.json' assert { type: 'json' };
// ENHANCED MAPPING (закомментировано - используется семантический маппинг)
// import skuMappingEnhanced from './skuMappingEnhanced.json' assert { type: 'json' };
// ✅ SEMANTIC MAPPING: Используем семантический маппинг с 100% совпадениями
import skuMappingSemantic from './skuMappingSemantic.json' assert { type: 'json' };
// ✅ NEW: Category-based mapping with hybrid search (cache + Bitrix API)
import { findProductIdBySku, findProductIdByVariantId, loadAllMappings } from './mappingUtils.js';
import { resolveResponsibleId } from './responsible.js';
import { callShopifyAdmin } from '../shopify/adminClient.js';

// Known certificate variant_id -> Bitrix PRODUCT_ID mapping (fallback when SKU is missing)
// Based on provided Shopify variants for E-Certificate
const CERT_VARIANT_TO_PRODUCT_ID = {
  50398439440648: 4268,  // €30
  50420389413128: 4270,  // €50
  50420389445896: 4272,  // €70
  50420389478664: 4274,  // €100
  50420389511432: 4276,  // €120
  50420389544200: 4278,  // €150
  50420389576968: 4280,  // €200
  50420389609736: 4282,  // €300
  50420389642504: 4284,  // €500
  50420389675272: 4286   // €1000
};

/**
 * Parse model name from product title
 * Example: "Wellie Paint KL tractor blue Barefoot Kids Rubber Boots" → "Wellie Paint KL"
 * @param {string} title - Product title from Shopify
 * @returns {string|null} Model name or null
 */
function parseModelFromTitle(title) {
  if (!title || typeof title !== 'string') return null;

  // Common patterns: "Brand Model Color Type" or "Model Color Type"
  // Try to extract model (usually first 2-3 words before color)
  const words = title.split(/\s+/);

  // Look for color keywords to split model from color
  const colorKeywords = ['blue', 'red', 'green', 'yellow', 'black', 'white', 'pink', 'fuchsia', 'violet', 'cyan', 'tractor', 'flowers'];
  let modelEndIndex = words.length;

  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase();
    if (colorKeywords.some(keyword => word.includes(keyword))) {
      modelEndIndex = i;
      break;
    }
  }

  // Extract model (first part before color)
  if (modelEndIndex > 0) {
    return words.slice(0, modelEndIndex).join(' ').trim() || null;
  }

  // Fallback: return first 2-3 words
  return words.slice(0, Math.min(3, words.length)).join(' ').trim() || null;
}

/**
 * Parse color from product title or properties
 * @param {string} title - Product title
 * @param {Array} properties - Product properties array
 * @returns {string|null} Color name or null
 */
function parseColorFromTitle(title, properties = []) {
  // First try properties
  const colorProperty = properties.find(p =>
    p.name && (
      p.name.toLowerCase().includes('color') ||
      p.name.toLowerCase().includes('цвет')
    )
  );
  if (colorProperty?.value) {
    return colorProperty.value.trim();
  }

  // Then try to extract from title
  if (!title || typeof title !== 'string') return null;

  const colorKeywords = {
    'blue': 'blue',
    'red': 'red',
    'green': 'green',
    'yellow': 'yellow',
    'black': 'black',
    'white': 'white',
    'pink': 'pink',
    'fuchsia': 'fuchsia',
    'violet': 'violet',
    'cyan': 'cyan',
    'tractor blue': 'tractor blue',
    'flowers': 'flowers'
  };

  const titleLower = title.toLowerCase();
  for (const [keyword, color] of Object.entries(colorKeywords)) {
    if (titleLower.includes(keyword)) {
      return color;
    }
  }

  return null;
}

// Enum Map for Size (PROPERTY_98)
const SIZE_ENUM_MAP = {
  "20": 154, "21": 156, "22": 158, "23": 160, "24": 162,
  "25": 164, "26": 166, "27": 168, "28": 170, "29": 172,
  "30": 174, "31": 176, "32": 178, "33": 320, "34": 322,
  "35": 324, "36": 326, "37": 328, "38": 330, "39": 332,
  "40": 334, "41": 336, "42": 338, "43": 340, "44": 342,
  "45": 344, "46": 346, "47": 348, "48": 350, "49": 352,
  "50": 354, "51": 356, "52": 358, "53": 360, "54": 362
};

function getSizeEnumId(sizeText) {
  if (!sizeText) return null;
  const sizeClean = String(sizeText).trim();
  return SIZE_ENUM_MAP[sizeClean] || null;
}

function getCategoryBySku(sku) {
  if (!sku) return 'category-g-m';
  const firstChar = sku[0].toLowerCase();
  if (firstChar >= 'a' && firstChar <= 'f') return 'category-a-f';
  if (firstChar >= 'g' && firstChar <= 'm') return 'category-g-m';
  if (firstChar >= 'n' && firstChar <= 's') return 'category-n-s';
  if (firstChar >= 't' && firstChar <= 'z') return 'category-t-z';
  return 'category-g-m';
}

function getSectionIdBySku(sku) {
  const cat = getCategoryBySku(sku);
  const map = {
    'category-a-f': 36,
    'category-g-m': 38,
    'category-n-s': 40,
    'category-t-z': 42
  };
  return map[cat] || 38;
}

// ============ SHOPIFY IMAGE HELPERS ============

async function getShopifyImageBase64(variantId) {
  try {
    // 1. Get Variant to find image_id and product_id
    const vData = await callShopifyAdmin(`/variants/${variantId}.json`);
    const variant = vData.variant;

    if (!variant || !variant.image_id) return null;

    // 2. Get Product Image URL
    const pData = await callShopifyAdmin(`/products/${variant.product_id}/images/${variant.image_id}.json`);
    const imageUrl = pData.image ? pData.image.src : null;

    if (!imageUrl) return null;

    // 3. Download and Convert to Base64
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) return null;

    const arrayBuffer = await imgResp.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');

  } catch (e) {
    logger.error('shopify_image_fetch_failed', 'Error fetching Shopify image', { variantId, error: e.message });
    return null;
  }
}

async function getShopifyProductDescription(variantId) {
  try {
    // 1. Get Variant to find product_id
    const vData = await callShopifyAdmin(`/variants/${variantId}.json`);
    const productId = vData.variant?.product_id;
    if (!productId) return null;

    // 2. Get Product Description (body_html)
    const pData = await callShopifyAdmin(`/products/${productId}.json`);
    return pData.product?.body_html || "";

  } catch (e) {
    logger.error('shopify_description_fetch_failed', 'Error fetching Shopify description', { variantId, error: e.message });
    return null;
  }
}

/**
 * Fetch Shopify product metadata for on-demand property mapping
 * Returns: { vendor, product_type, options } - same as sync_inventory_batch.py uses
 */
async function getShopifyProductMetadata(variantId) {
  try {
    // 1. Get Variant to find product_id
    const vData = await callShopifyAdmin(`/variants/${variantId}.json`);
    const variant = vData.variant;
    if (!variant?.product_id) return null;

    // 2. Get Product
    const pData = await callShopifyAdmin(`/products/${variant.product_id}.json`);
    const product = pData.product;

    // 3. Parse Size/Color from Options (like sync_inventory_batch.py)
    let sizeIndex = -1;
    let colorIndex = -1;
    const options = product.options || [];

    for (let i = 0; i < options.length; i++) {
      const name = (options[i].name || '').toLowerCase();
      if (name.includes('size') || name.includes('размер') || name.includes('eu size')) {
        sizeIndex = i;
      } else if (name.includes('color') || name.includes('colour') || name.includes('цвет')) {
        colorIndex = i;
      }
    }

    // Find the target variant in product.variants
    const targetVariant = product.variants?.find(v => String(v.id) === String(variantId));

    let sizeVal = '';
    let colorVal = '';

    if (targetVariant) {
      if (sizeIndex >= 0) sizeVal = targetVariant[`option${sizeIndex + 1}`] || '';
      if (colorIndex >= 0) colorVal = targetVariant[`option${colorIndex + 1}`] || '';

      // Fallback: if no size found and title is not "Default Title", use title as size
      if (!sizeVal && targetVariant.title && targetVariant.title !== 'Default Title') {
        sizeVal = targetVariant.title;
      }
    }

    return {
      vendor: product.vendor || '',
      product_type: product.product_type || '',
      size: sizeVal,
      color: colorVal,
      inventory_quantity: targetVariant.inventory_quantity,
      inventory_policy: targetVariant.inventory_policy
    };

  } catch (e) {
    logger.error('shopify_metadata_fetch_failed', 'Error fetching Shopify metadata', { variantId, error: e.message });
    return null;
  }
}

/**
 * Map Shopify order to Bitrix24 deal fields and product rows
 * @param {Object} order - Shopify order object
 * @returns {Object} { dealFields, productRows }
 */
export async function mapShopifyOrderToBitrixDeal(order) {
  // ✅ Calculate total from active line_items (current_quantity > 0) to get sum of active items
  // This matches Shopify UI "Total" (sum of unfulfilled/active items), not "Paid" amount
  let totalPrice = 0;
  if (order.line_items && Array.isArray(order.line_items)) {
    for (const item of order.line_items) {
      // Calculate manual refund quantity just in case current_quantity is unreliable
      let manualRefundQty = 0;
      if (order.refunds && Array.isArray(order.refunds)) {
        for (const refund of order.refunds) {
          if (refund.refund_line_items && Array.isArray(refund.refund_line_items)) {
            for (const rLi of refund.refund_line_items) {
              if (String(rLi.line_item_id) === String(item.id)) {
                manualRefundQty += Number(rLi.quantity || 0);
              }
            }
          }
        }
      }

      let currentQuantity = Number(item.current_quantity ?? item.quantity ?? 0);

      // Fallback: If financial status is refunded or partially refunded
      // and current_quantity doesn't seem to reflect the manual refunds, apply it.
      if (manualRefundQty > 0 && currentQuantity === Number(item.quantity)) {
        currentQuantity = Math.max(0, currentQuantity - manualRefundQty);
      }

      // Store the corrected quantity directly on the item so the product rows mapper can use it later
      item.__resolved_current_quantity = currentQuantity;

      if (currentQuantity > 0) {
        const itemPrice = Number(item.price || 0);
        const itemTotal = itemPrice * currentQuantity;
        // Subtract discounts if present
        const itemDiscount = Number(
          item.discount_allocations?.[0]?.amount ||
          item.discount_allocations?.[0]?.amount_set?.shop_money?.amount ||
          item.total_discount ||
          0
        );
        totalPrice += itemTotal - itemDiscount;
      }
    }
    // Add shipping if present
    const shippingPrice = Number(
      order.current_total_shipping_price_set?.shop_money?.amount ||
      order.total_shipping_price_set?.shop_money?.amount ||
      order.shipping_price ||
      order.shipping_lines?.[0]?.price ||
      0
    );
    totalPrice += shippingPrice;

    logger.info('price_calculation', 'Calculated totalPrice from active line_items', { totalPrice, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  }

  // Fallback to current_total_price or total_price if line_items calculation failed
  if (totalPrice === 0) {
    totalPrice = Number(order.current_total_price || order.total_price || 0);
    logger.warn('price_calculation', 'Using fallback totalPrice from order totals', { totalPrice, currentTotalPrice: order.current_total_price, totalPriceRaw: order.total_price, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  }

  const totalDiscount = Number(order.current_total_discounts || order.total_discounts || 0);
  const totalTax = Number(order.current_total_tax || 0);

  const shippingPrice = Number(
    order.current_total_shipping_price_set?.shop_money?.amount ||
    order.total_shipping_price_set?.shop_money?.amount ||
    order.shipping_price ||
    order.shipping_lines?.[0]?.price ||
    0
  );

  // Determine category based on order source (POS vs Site) and tags (pre-order vs stock)
  // Source detection: source_name === 'pos' or 'shopify_draft_order' → POS (shop)
  // Otherwise → site
  const sourceName = order.source_name?.toLowerCase() || '';
  const isPOS = sourceName === 'pos' || sourceName === 'point_of_sale';

  const orderTags = Array.isArray(order.tags)
    ? order.tags
    : (order.tags ? String(order.tags).split(',').map(t => t.trim()) : []);

  const preorderTags = ['pre-order', 'preorder-product-added'];
  const hasPreorderTag = orderTags.some(tag =>
    preorderTags.some(preorderTag => tag.toLowerCase() === preorderTag.toLowerCase())
  );

  // Category logic:
  // POS + Stock → 0 (Stock in the shop)
  // POS + Pre-order → 4 (Pre-order in the shop)
  // Site + Stock → 2 (Stock site)
  // Site + Pre-order → 8 (Pre-order site)
  let categoryId;
  if (isPOS) {
    categoryId = hasPreorderTag ? BITRIX_CONFIG.CATEGORY_SHOP_PREORDER : BITRIX_CONFIG.CATEGORY_SHOP_STOCK;
  } else {
    categoryId = hasPreorderTag ? BITRIX_CONFIG.CATEGORY_PREORDER : BITRIX_CONFIG.CATEGORY_STOCK;

    // ✅ Fulfillable quantity check: if any line item cannot be fulfilled → pre-order
    // fulfillable_quantity = 0 means no stock available (genuine pre-order / oversell)
    // fulfillable_quantity > 0 means item is reserved and can be shipped (stock order)
    if (!hasPreorderTag && order.line_items && Array.isArray(order.line_items)) {
      for (const item of order.line_items) {
        const fulfillableQty = Number(item.fulfillable_quantity ?? item.quantity ?? 1);
        logger.info('category_fulfillable_check', 'Fulfillable quantity check for pre-order detection', { sku: item.sku, variantId: item.variant_id, fulfillableQuantity: fulfillableQty, orderId: order.id });
        if (fulfillableQty === 0) {
          logger.info('category_fulfillable_preorder', 'Item has zero fulfillable quantity — marking as pre-order', { sku: item.sku, variantId: item.variant_id, orderId: order.id });
          categoryId = BITRIX_CONFIG.CATEGORY_PREORDER;
          break;
        }
      }
    }
  }

  logger.info('category_determined', 'Deal category set', { categoryId, source: isPOS ? 'POS' : 'Site', hasPreorderTag, sourceName, tags: orderTags, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });

  // Customer name
  const customerName = order.customer
    ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || null
    : null;

  // ✅ Simplified logic (matching backup repository): Check cancellation and refunds
  const financialStatus = (order.financial_status || '').toLowerCase();
  const cancelledAt = order.cancelled_at;
  const cancelReason = order.cancel_reason;

  // ✅ Check if order has active items (current_quantity > 0) - only for partial refund detection
  const hasActiveItems = order.line_items && order.line_items.some(item => {
    const currentQty = Number(item.__resolved_current_quantity ?? item.current_quantity ?? item.quantity ?? 0);
    return currentQty > 0;
  });

  // ✅ Calculate total price to check if order is empty (cancelled)
  // totalPrice is calculated above from active line_items
  const isOrderEmpty = totalPrice === 0 && !hasActiveItems;

  // ✅ CRITICAL: Cancellation detection - check multiple indicators
  // Priority: cancelled_at (HIGHEST) > financial_status > cancel_reason > empty order
  // 1. cancelled_at field is set (Shopify sets this when order is cancelled) - HIGHEST PRIORITY
  // 2. financial_status === 'cancelled' || 'voided' (primary check)
  // 3. cancel_reason field is set (Shopify sets this when order is cancelled)
  // 4. If order is empty (totalPrice = 0, no active items) → cancelled (regardless of financial_status)
  //    (Empty order = all items removed/refunded = cancellation)
  const isCancelledByField = cancelledAt !== null && cancelledAt !== undefined && cancelledAt !== '';
  const isCancelledByStatus = financialStatus === 'cancelled' || financialStatus === 'voided';
  const isCancelledByReason = cancelReason !== null && cancelReason !== undefined && cancelReason !== '';
  // ✅ CRITICAL: If order is empty (0 amount, no active items), it's ALWAYS cancelled
  // This covers cases where cancelled_at/cancel_reason might not be in webhook, but order is clearly cancelled
  const isCancelledByEmpty = isOrderEmpty;

  // ✅ CRITICAL: cancelled_at has HIGHEST PRIORITY - if it's set, order is cancelled regardless of financial_status
  const isCancelled = isCancelledByField || isCancelledByStatus || isCancelledByReason || isCancelledByEmpty;

  // ✅ Full refund: financial_status=refunded AND no active items → LOSE
  // If there are active items (exchange/size change), it's NOT a full refund
  // BUT: if cancelled, it takes priority (cancelled > refunded)
  const isFullRefund = !isCancelled && financialStatus === 'refunded' && !hasActiveItems;

  // ✅ PARTIAL REFUND / EXCHANGE: partially_refunded OR refunded with active items → PREPARATION
  // Covers: partial refund, size exchange, adding new item after refund
  // BUT: if cancelled, it takes priority (cancelled > partial refund)
  const isPartialRefund = !isCancelled && !isFullRefund && hasActiveItems &&
    (financialStatus === 'partially_refunded' || (financialStatus === 'refunded' && hasActiveItems));

  // ✅ Simplified: cancelled OR full refund → LOSE
  const isLost = isCancelled || isFullRefund;

  // ✅ CRITICAL: Force LOSE for cancelled/full refund, PREPARATION for partial refund
  let stageId;
  if (isCancelled) {
    stageId = 'LOSE';
    const cancelReasons = [];
    if (isCancelledByStatus) cancelReasons.push('financial_status');
    if (isCancelledByField) cancelReasons.push('cancelled_at');
    if (isCancelledByReason) cancelReasons.push('cancel_reason');
    if (isCancelledByEmpty) cancelReasons.push('empty_order+refunded');
    logger.warn('order_cancelled', 'Order cancelled — forcing stage LOSE', { financialStatus: order.financial_status, cancelledAt: cancelledAt || null, cancelReason: cancelReason || null, totalPrice, hasActiveItems, detectedBy: cancelReasons, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  } else if (isFullRefund) {
    stageId = 'LOSE';
    logger.warn('order_full_refund', 'Full refund detected — forcing stage LOSE', { financialStatus: order.financial_status, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  } else if (isPartialRefund) {
    // ✅ FIX: Dynamic stage ID based on category to prevent loop for POS (Cat 0)
    // Also if it's already fulfilled, move to WON / SUCCESS
    const isFulfilled = (order.fulfillment_status || '').toLowerCase() === 'fulfilled';

    if (isFulfilled) {
      if (categoryId > 0) {
        stageId = `C${categoryId}:WON`;
      } else {
        stageId = 'WON';
      }
    } else {
      if (categoryId > 0) {
        stageId = `C${categoryId}:PREPARATION`;
      } else {
        // For Category 0 (Stock Shop), usually no 'PREPARATION' stage, or it matches 'NEW'.
        // Safe fallback to 'NEW' or 'PREPARATION' (unprefixed) if it exists.
        // Given 'partially_refunded' usually implies manual check, 'NEW' is safe.
        stageId = 'NEW';
      }
    }
    logger.warn('order_partial_refund', 'Partial refund detected — forcing stage', { financialStatus: order.financial_status, hasActiveItems, isFulfilled, stageId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  } else {
    // ✅ PRE-ORDER SPECIAL LOGIC: If pre-order (Cat 4 or 8) is PAID, move to WON
    // Pre-orders that are fully paid should go directly to Success
    const isPreorderCategory = categoryId === BITRIX_CONFIG.CATEGORY_SHOP_PREORDER || categoryId === BITRIX_CONFIG.CATEGORY_PREORDER;
    const isPaid = (order.financial_status || '').toLowerCase() === 'paid';

    if (isPreorderCategory && isPaid) {
      // Use category-prefixed WON stage (C4:WON for shop, C8:WON for site)
      stageId = `C${categoryId}:WON`;
      logger.info('stage_preorder_paid', 'Pre-order is paid — setting stage to WON', { categoryId, stageId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
    } else {
      stageId = financialStatusToStageId(order.financial_status || '', categoryId);
      logger.info('stage_mapped', 'Deal stage mapped from financial status', { financialStatus: order.financial_status, categoryId, stageId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
    }
  }
  logger.info('stage_mapped', 'Deal stage determined', { financialStatus: order.financial_status, categoryId, stageId });

  // Map financial status to payment status field
  // ✅ CRITICAL: For cancelled orders, ALWAYS set payment status to '58' (Unpaid)
  // regardless of financial_status (cancelled orders should never show as paid)
  let paymentStatusEnumId;
  if (isCancelled) {
    paymentStatusEnumId = '58'; // Unpaid - cancelled orders are never paid
    logger.warn('payment_status_forced', 'Order is cancelled — forcing payment status to Unpaid (58)', { financialStatus: order.financial_status, paymentStatusEnumId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  } else {
    paymentStatusEnumId = financialStatusToPaymentStatus(order.financial_status);
    logger.info('payment_status_mapped', 'Payment status mapped from financial status', { financialStatus: order.financial_status, paymentStatusEnumId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  }

  // Map source name to source ID
  const sourceId = sourceNameToSourceId(order.source_name);
  // SOURCE_DESCRIPTION: use actual source_name if available, otherwise default to 'shopify_draft_order'
  const sourceDescription = order.source_name || 'shopify_draft_order';

  // Determine order type based on source and pre-order status
  // Bitrix field: UF_CRM_1739183268662 (enumeration)
  // Values: "44" = "online (stock)", "46" = "ofline (stock)", "48" = "online (pre-order)", "50" = "ofline (pre-order)"
  let orderTypeId = null;
  if (order.source_name === 'pos') {
    orderTypeId = hasPreorderTag ? '50' : '46'; // ofline (pre-order) or ofline (stock)
  } else {
    orderTypeId = hasPreorderTag ? '48' : '44'; // online (pre-order) or online (stock)
  }
  logger.info('order_type_determined', 'Order type determined', { orderTypeId, sourceName: order.source_name, hasPreorderTag, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });

  // Determine delivery method from shipping_lines
  // Bitrix field: UF_CRM_1739183302609 (enumeration)
  // Values: "52" = "Pick up in shop", "54" = "Delivery by courier"
  let deliveryMethodId = null;
  if (order.shipping_lines && Array.isArray(order.shipping_lines) && order.shipping_lines.length > 0) {
    const shippingLine = order.shipping_lines[0];
    // Check if it's pickup (shop pickup, store pickup, etc.)
    const shippingTitle = (shippingLine.title || shippingLine.code || '').toLowerCase();
    const shippingCode = (shippingLine.code || '').toLowerCase();

    if (shippingTitle.includes('pick') || shippingTitle.includes('shop') ||
      shippingCode.includes('pick') || shippingCode.includes('shop') ||
      shippingTitle.includes('самовывоз') || shippingTitle.includes('магазин')) {
      deliveryMethodId = '52'; // Pick up in shop
    } else {
      deliveryMethodId = '54'; // Delivery by courier
    }
  } else {
    // Also check fulfillment status for pickup
    if (order.fulfillment_status) {
      const fulfillmentStatus = String(order.fulfillment_status).toLowerCase();
      if (fulfillmentStatus.includes('pick') || fulfillmentStatus.includes('shop')) {
        deliveryMethodId = '52'; // Pick up in shop
      } else {
        deliveryMethodId = '54'; // Delivery by courier
      }
    } else if (shippingPrice > 0) {
      // Default to courier delivery if shipping price > 0
      deliveryMethodId = '54'; // Delivery by courier
    }
  }

  logger.info('delivery_method_determined', 'Delivery method determined', { deliveryMethodId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });

  // ✅ Calculate paid amount (total - refunds)
  // current_total_price reflects refunds, total_price is original
  const paidAmount = Number(order.current_total_price || order.total_price || 0);

  // Deal fields - using REAL Bitrix UF_CRM_* fields only
  const dealFields = {
    TITLE: order.name || `Order #${order.id}`,
    OPPORTUNITY: totalPrice, // Final amount as in Shopify
    CURRENCY_ID: order.currency || 'EUR',
    COMMENTS: `Shopify order ${order.name || order.id}`,
    CATEGORY_ID: categoryId, // 2 = Stock (site), 8 = Pre-order (site) - REQUIRED for create, immutable after
    STAGE_ID: stageId,
    SOURCE_ID: sourceId || 'WEB', // Default to 'WEB' if not mapped
    SOURCE_DESCRIPTION: sourceDescription || 'shopify_draft_order',

    // ✅ Key to Shopify order - REAL Bitrix field
    // UF_CRM_1742556489 (Shopify number) - store stable order.id (numeric Shopify order ID)
    // NEVER use eventId here - eventId is webhook-specific and changes per webhook call
    UF_CRM_1742556489: String(order.id),

    // Order total - REAL Bitrix field
    // UF_CRM_1741634415367 (Order total)
    UF_CRM_1741634415367: Number(totalPrice),

    // Paid amount - REAL Bitrix field
    // UF_CRM_1741634439258 (Paid amount) - фактически оплачено (total - refunds)
    UF_CRM_1741634439258: paidAmount,

    // Delivery price - REAL Bitrix field (optional)
    // UF_CRM_67BEF8B2AA721 (Delivery price)
    ...(shippingPrice > 0 ? { UF_CRM_67BEF8B2AA721: shippingPrice } : {}),

    // Payment status (enumeration) - REAL Bitrix field
    // UF_CRM_1739183959976 (Payment status)
    // Values: "56" = "Paid", "58" = "Unpaid", "60" = "10% prepayment"
    UF_CRM_1739183959976: paymentStatusEnumId,

    // Order type (enumeration) - UF_CRM_1739183268662
    // Values: "44" = "online (stock)", "46" = "ofline (stock)", "48" = "online (pre-order)", "50" = "ofline (pre-order)"
    UF_CRM_1739183268662: orderTypeId,

    // Delivery method (enumeration) - UF_CRM_1739183302609
    // Values: "52" = "Pick up in shop", "54" = "Delivery by courier"
    // Only set if determined, otherwise leave empty (Bitrix will show empty)
    ...(deliveryMethodId ? { UF_CRM_1739183302609: deliveryMethodId } : {}),
  };

  logger.info('deal_fields_prepared', 'Deal fields prepared', { orderTypeId, deliveryMethodId, paymentStatusEnumId: dealFields.UF_CRM_1739183959976, categoryId, stageId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });

  // Resolve responsible: find current shift manager by phone 100 in Bitrix
  const assigneeId = await resolveResponsibleId(order);
  if (assigneeId) {
    dealFields.ASSIGNED_BY_ID = assigneeId;
  }

  // Extract product properties from ACTIVE line_items (current_quantity > 0) for UF-fields
  // Aggregate Size and Color across all active positions to preserve ordering
  if (order.line_items && Array.isArray(order.line_items) && order.line_items.length > 0) {
    // ✅ FILTER: Only process active items (current_quantity > 0) for UF-fields
    const activeLineItems = order.line_items.filter(item => {
      const currentQty = Number(item.__resolved_current_quantity ?? item.current_quantity ?? item.quantity ?? 0);
      return currentQty > 0;
    });
    const lineItems = activeLineItems;
    const itemsCount = lineItems.length;

    // ===== SIZE AGGREGATION =====
    if (itemsCount === 1) {
      const firstItem = lineItems[0];
      let sizeValue = null;
      if (firstItem.variant_title) {
        sizeValue = String(firstItem.variant_title).trim();
      } else if (firstItem.name) {
        const nameParts = firstItem.name.split(' - ');
        if (nameParts.length > 1) {
          sizeValue = nameParts[nameParts.length - 1].trim();
        }
      }
      if (sizeValue) {
        dealFields.UF_CRM_1739793720585 = sizeValue;
      }
    } else {
      const sizeParts = [];
      for (let i = 0; i < itemsCount; i++) {
        const item = lineItems[i];
        const position = i + 1;
        let sizeValue = null;
        if (item.variant_title) {
          sizeValue = String(item.variant_title).trim();
        } else if (item.name) {
          const nameParts = item.name.split(' - ');
          if (nameParts.length > 1) {
            sizeValue = nameParts[nameParts.length - 1].trim();
          }
        }
        const sizeDisplay = sizeValue || '-';
        sizeParts.push(`${position}: ${sizeDisplay}`);
      }
      if (sizeParts.length > 0) {
        dealFields.UF_CRM_1739793720585 = sizeParts.join('; ');
        logger.info('uf_fields_aggregated', 'Size aggregated for multi-item order', { size: dealFields.UF_CRM_1739793720585, itemsCount, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
      }
    }

    // ===== COLOR AGGREGATION =====
    if (itemsCount === 1) {
      const firstItem = lineItems[0];
      // ✅ FIX: Check if firstItem exists and has title property
      if (firstItem && firstItem.title) {
        const color = parseColorFromTitle(firstItem.title, firstItem.properties || []);
        if (color) {
          dealFields.UF_CRM_1739793651654 = color;
          logger.info('uf_fields_aggregated', 'Color set for single-item order', { color, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
        }
      }
    } else {
      const colorParts = [];
      for (let i = 0; i < itemsCount; i++) {
        const item = lineItems[i];
        // ✅ FIX: Check if item exists before accessing properties
        if (!item) continue;
        const position = i + 1;
        const color = parseColorFromTitle(item.title || '', item.properties || []);
        const colorDisplay = color || '-';
        colorParts.push(`${position}: ${colorDisplay}`);
      }
      if (colorParts.length > 0) {
        dealFields.UF_CRM_1739793651654 = colorParts.join('; ');
        logger.info('uf_fields_aggregated', 'Color aggregated for multi-item order', { color: dealFields.UF_CRM_1739793651654, itemsCount, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
      }
    }

    // ===== MODEL AND BRAND (first item as reference) =====
    const firstItem = lineItems[0];

    // ✅ FIX: Check if firstItem exists and has title property
    if (firstItem && firstItem.title) {
      const model = parseModelFromTitle(firstItem.title);
      if (model) {
        dealFields.UF_CRM_1739793668182 = model;
        logger.warn('heuristic_parse', 'Product parsed from title', { title: firstItem.title, model, color: dealFields.UF_CRM_1739793651654|| null });
      }

      if (firstItem.vendor) {
        const vendorUpper = String(firstItem.vendor).toUpperCase().trim();
        const brandId = brandMapping[vendorUpper];
        if (brandId) {
          dealFields.UF_CRM_1741642513658 = brandId; // Enum field - use ID
        } else {
          logger.warn('brand_not_found', 'Brand not found in brandMapping, skipping UF_CRM_1741642513658', { vendor: vendorUpper, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
        }
      }
    }

    logger.info('uf_fields_extracted', 'UF-fields extracted from line items', { size: dealFields.UF_CRM_1739793720585 || null, color: dealFields.UF_CRM_1739793651654 || null, model: dealFields.UF_CRM_1739793668182 || null, brand: dealFields.UF_CRM_1741642513658 || null, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  } else {
    logger.warn('no_line_items', 'No line_items found in order — cannot extract product properties', { orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  }

  // Product rows
  const productRows = [];

  // Shipping variables (defined early for final validation)
  let actualShippingPrice = 0;
  let shippingLineTitle = null;

  if (order.line_items && Array.isArray(order.line_items)) {
    // Get shipping product ID to avoid confusion
    const shippingProductId = BITRIX_CONFIG.SHIPPING_PRODUCT_ID > 0
      ? BITRIX_CONFIG.SHIPPING_PRODUCT_ID
      : 11648; // ACS delivery product ID

    for (const item of order.line_items) {
      const originalQuantity = Number(item.quantity ?? 0);
      let currentQuantity = Number(item.__resolved_current_quantity ?? item.current_quantity ?? item.quantity ?? 0);

      let effectiveQuantity = currentQuantity;

      if (effectiveQuantity <= 0) {
        logger.info('item_skipped', 'Skipping item — current_quantity is 0 (refunded/removed)', { itemId: item.id, sku: item.sku || null, currentQuantity, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
        continue;
      }

      // CRITICAL: line_items are ALWAYS products, NEVER shipping
      // Even if a product has the same ID as shipping, it's still a product from line_items

      // ===== STRICT MAPPING: variant_id (XML_ID) FIRST — globally unique. =====
      // Shopify variant_id == Bitrix XML_ID. SKU (Bitrix CODE) is NOT unique and can collide
      // across products, so it is only ever a guarded/last-resort fallback — never used when
      // variant_id resolves a product.
      let productId = null;
      let mappingMethod = 'none';

      // 1) PRIMARY: resolve by variant_id → Bitrix XML_ID (unique, collision-free)
      if (item.variant_id) {
        productId = await findProductIdByVariantId(item.variant_id);
        if (productId) {
          mappingMethod = 'variant_id/xml_id';
          logger.info('sku_resolved', 'Resolved via ' + mappingMethod, { sku: item.sku || null, variantId: String(item.variant_id), productId, layer: mappingMethod });
        }
      }

      // 2) Certificate fallback by variant_id (certs have no XML_ID-keyed catalog product)
      if (!productId && item.variant_id) {
        const variantId = Number(item.variant_id);
        const certProductId = CERT_VARIANT_TO_PRODUCT_ID[variantId];
        if (certProductId) {
          productId = certProductId;
          mappingMethod = 'variant_id_certificate';
          logger.info('sku_resolved', 'Resolved via ' + mappingMethod, { sku: item.sku || null, variantId: String(item.variant_id), productId, layer: mappingMethod });
        }
      }

      // 3) GUARDED SKU fallback — rescue legacy products not yet linked to a variant_id/XML_ID.
      //    Fires only when variant_id is present but the XML_ID lookup missed. Accept a CODE=SKU
      //    match ONLY if there is exactly one candidate AND its XML_ID is empty (legacy/unlinked)
      //    or already equals this variant. A SKU whose XML_ID points to a DIFFERENT variant is the
      //    duplicate-SKU collision we are fixing — reject it.
      if (!productId && item.variant_id && item.sku) {
        try {
          const { callBitrix } = await import('./client.js');
          const skuResp = await callBitrix('/crm.product.list.json', {
            filter: { CODE: item.sku, ACTIVE: 'Y' },
            select: ['ID', 'CODE', 'XML_ID']
          });
          const candidates = Array.isArray(skuResp?.result) ? skuResp.result : [];
          const variantIdStr = String(item.variant_id);
          if (candidates.length === 1) {
            const candidate = candidates[0];
            const xmlId = candidate.XML_ID == null ? '' : String(candidate.XML_ID);
            if (xmlId === '' || xmlId === variantIdStr) {
              productId = parseInt(candidate.ID, 10);
              mappingMethod = 'sku_legacy_fallback';
              logger.info('sku_resolved', 'Resolved via ' + mappingMethod, { sku: item.sku, productId, variantId: variantIdStr, candidateXmlId: xmlId, layer: mappingMethod });
            } else {
              logger.warn('sku_ambiguous', 'SKU match rejected: Bitrix product XML_ID belongs to a different variant', { sku: item.sku, candidateId: candidate.ID, candidateXmlId: xmlId, thisVariantId: variantIdStr, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
            }
          } else if (candidates.length > 1) {
            logger.warn('sku_ambiguous', 'SKU match rejected: multiple Bitrix products share this CODE', { sku: item.sku, candidateCount: candidates.length, thisVariantId: variantIdStr, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
          }
        } catch (skuErr) {
          logger.warn('sku_fallback_error', 'Guarded SKU fallback lookup failed', { sku: item.sku, error: skuErr.message, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
        }
      }

      // 4) LAST-RESORT: SKU lookup when the item has NO variant_id at all (legacy/edge items)
      if (!productId && !item.variant_id && item.sku) {
        productId = await findProductIdBySku(item.sku);
        if (productId) {
          mappingMethod = 'sku_no_variant';
          logger.info('sku_resolved', 'Resolved via ' + mappingMethod, { sku: item.sku, productId, layer: mappingMethod });
        } else {
          logger.error('sku_not_found', 'SKU not found in Bitrix (item has no variant_id)', { sku: item.sku, itemTitle: item.title || null, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
        }
      } else if (!productId && !item.variant_id && !item.sku) {
        logger.warn('sku_missing', 'Item has neither variant_id nor SKU', { itemTitle: item.title || null, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
      }

      // ✅ ON-DEMAND PRODUCT CREATION: If product not found, auto-create in Bitrix
      if (!productId && item.variant_id) {
        try {
          const { callBitrix } = await import('./client.js');
          const variantIdStr = String(item.variant_id);

          // Check if product already exists by XML_ID (variant_id)
          const existingProductResp = await callBitrix('/crm.product.list.json', {
            filter: { 'XML_ID': variantIdStr },
            select: ['ID', 'NAME', 'CODE', 'XML_ID']
          });

          if (existingProductResp.result && existingProductResp.result.length > 0) {
            // Product exists by XML_ID
            productId = parseInt(existingProductResp.result[0].ID, 10);
            mappingMethod = 'xml_id_lookup';
            logger.info('sku_resolved', 'SKU resolved via ' + mappingMethod, { sku: item.sku, productId, layer: mappingMethod });
          } else {
            // Create new product in Bitrix
            const sku = item.sku || '';
            const price = parseFloat(item.price || 0);
            const variantTitle = item.variant_title || '';
            const productTitle = item.title || 'Unknown Product';
            const fullTitle = variantTitle && variantTitle !== 'Default Title'
              ? `${productTitle} - ${variantTitle}`
              : productTitle;

            // Fetch Real Description
            // ✅ FIX: Improved fallback description
            let productDescription = `Shopify Product: ${fullTitle}\nSKU: ${sku || 'N/A'}\nVariant ID: ${variantIdStr}`;
            try {
              const realDesc = await getShopifyProductDescription(item.variant_id);
              if (realDesc) {
                productDescription = realDesc;
              }
            } catch (descErr) {
              logger.warn('description_fetch_failed', 'Failed to fetch Shopify product description', { variantId: item.variant_id, error: descErr.message, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
            }

            const createProductResp = await callBitrix('/crm.product.add.json', {
              fields: {
                NAME: fullTitle,
                CODE: sku || variantIdStr,
                XML_ID: variantIdStr, // variant_id as XML_ID for mapping
                PRICE: price,
                CURRENCY_ID: 'EUR',
                SECTION_ID: getSectionIdBySku(sku), // Main catalog section
                ACTIVE: 'Y',
                DESCRIPTION: productDescription,
                DESCRIPTION_TYPE: 'html', // Fix: Explicitly set type to HTML
                DETAIL_TEXT: productDescription,
                DETAIL_TEXT_TYPE: 'html',
                PREVIEW_TEXT: productDescription,
                PREVIEW_TEXT_TYPE: 'html'
              }
            });

            if (createProductResp.result) {
              productId = createProductResp.result;
              mappingMethod = 'on_demand_created';
              logger.info('on_demand_product_created', 'On-demand product created in Bitrix', { variantId: variantIdStr, sku, fullTitle, price, bitrixProductId: productId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });

              const orderQty = parseInt(item.quantity) || 1; // Usually 1-2

              // --- Property & Stock Logic ---

              // 1. Fetch Properties from Shopify (same as sync_inventory_batch.py)
              let brand = '';
              let productType = '';  // This goes to PROPERTY_104 (not SKU-based category!)
              let sizeVal = '';
              let colorVal = '';

              try {
                const metadata = await getShopifyProductMetadata(item.variant_id);
                if (metadata) {
                  brand = metadata.vendor;
                  productType = metadata.product_type;
                  sizeVal = metadata.size;
                  colorVal = metadata.color;
                }
              } catch (metaErr) {
                logger.warn('shopify_metadata_fetch_failed', 'Failed to fetch Shopify metadata for on-demand product', { variantId: item.variant_id, error: metaErr.message, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
              }

              const sizeEnum = getSizeEnumId(sizeVal);

              // 2. Update Product with Properties (UNIFIED with sync_inventory_batch.py)
              try {
                const updateFields = {};
                if (brand) updateFields["PROPERTY_102"] = brand;           // Brand (vendor)
                if (productType) updateFields["PROPERTY_104"] = productType; // Category (product_type, e.g. "Atlas MJ")
                if (colorVal) updateFields["PROPERTY_106"] = colorVal;     // Color
                if (sizeEnum) updateFields["PROPERTY_98"] = sizeEnum;      // Size Enum

                if (Object.keys(updateFields).length > 0) {
                  await callBitrix('/crm.product.update.json', {
                    id: productId,
                    fields: updateFields
                  });
                }
              } catch (propErr) {
                logger.error('product_properties_update_failed', 'Failed to update on-demand product properties', { productId, error: propErr.message, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
              }

              // 3. Add Pre-Order Stock (Store 2)
              // ✅ FIX: Add +1 to orderQty to handle deal reservation AND keep positive stock
              const stockAmount = orderQty + 1;

              try {
                // Create Store Adjustment document (Type 'S' - simpler than Arrival 'A' as it doesn't need supplier)
                const docResp = await callBitrix('/catalog.document.add.json', {
                  fields: {
                    docType: 'S', // Store Adjustment
                    title: `Pre-order stock: ${fullTitle} (Order item)`,
                    responsibleId: 52,
                    currency: 'EUR',
                    status: 'N'
                  }
                });

                let docId = null;
                if (docResp.result?.document?.id) {
                  docId = docResp.result.document.id;
                } else if (docResp.result) {
                  docId = docResp.result;
                }

                if (docId) {
                  // Add element to document
                  await callBitrix('/catalog.document.element.add.json', {
                    fields: {
                      docId: docId,
                      elementId: productId,
                      amount: stockAmount, // ✅ Updated to orderQty + 1
                      purchasingPrice: 0,
                      storeTo: 2 // Warehouse ID 2
                    }
                  });

                  // Conduct document
                  await callBitrix('/catalog.document.conduct.json', { id: docId });
                  logger.info('preorder_stock_added', 'Pre-order stock added successfully', { productId, docId, stockAmount, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
                } else {
                  logger.warn('preorder_stock_doc_failed', 'Failed to create stock document for on-demand product', { productId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
                }
              } catch (stockError) {
                logger.error('preorder_stock_error', 'Error adding pre-order stock', { productId, stockAmount, error: stockError.message, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
                // Continue anyway - product is created, stock issue can be fixed manually
              }

              // 4. Image Sync (New)
              try {
                const imageBase64 = await getShopifyImageBase64(item.variant_id);
                if (imageBase64) {
                  await callBitrix('/crm.product.update.json', {
                    id: productId,
                    fields: {
                      "PREVIEW_PICTURE": { "fileData": ["image.jpg", imageBase64] },
                      "DETAIL_PICTURE": { "fileData": ["image.jpg", imageBase64] }
                    }
                  });
                  logger.info('product_image_synced', 'Product image uploaded to Bitrix', { productId, variantId: item.variant_id, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
                }
              } catch (imgErr) {
                logger.warn('product_image_sync_failed', 'Failed to sync product image', { productId, variantId: item.variant_id, error: imgErr.message, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
              }

            } else {
              logger.error('on_demand_create_failed', 'Failed to create on-demand product', { variantId: variantIdStr, sku, error: createProductResp.error || 'Unknown error', orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
            }
          }
        } catch (onDemandError) {
          logger.error('on_demand_error', 'Error during on-demand product creation', { variantId: item.variant_id, error: onDemandError.message, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
        }
      }

      // Final check - if still no productId, skip
      if (!productId) {
        logger.error('product_id_missing', 'No PRODUCT_ID found and auto-create failed — item will not be added to deal', { itemTitle: item.title || null, sku: item.sku || null, variantId: item.variant_id || null, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
      }

      // Safety check: if product ID matches shipping ID, log warning but keep it as product
      // (line_items are always products, even if they accidentally have shipping ID)
      if (productId && productId == shippingProductId) {
        logger.warn('product_id_matches_shipping', 'Product from line_items has PRODUCT_ID matching shipping product ID — treating as product', { sku: item.sku || null, itemTitle: item.title || null, productId, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
      }

      // Extract size and properties from Shopify line_item
      // variant_title usually contains the size (e.g., "31", "36-39", "S", "M")
      const variantTitle = item.variant_title || null;

      // Extract properties (array of {name, value} objects)
      const properties = item.properties || [];
      const sizeProperty = properties.find(p =>
        p.name && (
          p.name.toLowerCase().includes('size') ||
          p.name.toLowerCase().includes('размер') ||
          p.name.toLowerCase() === 'size'
        )
      );
      const colorProperty = properties.find(p =>
        p.name && (
          p.name.toLowerCase().includes('color') ||
          p.name.toLowerCase().includes('цвет') ||
          p.name.toLowerCase() === 'color'
        )
      );

      // Get size from variant_title or properties
      const size = variantTitle || sizeProperty?.value || null;

      // Build descriptive name with size/variant/vendor/color/model if available
      // ✅ FIX: Check if item exists and has title property
      const parts = [(item && item.title) ? item.title : ''];

      // Add size if available (most important - should be visible)
      if (size) {
        parts.push(`Size: ${size}`);
      }

      // Add color if available
      if (colorProperty?.value) {
        parts.push(`Color: ${colorProperty.value}`);
      }

      // Add other options if they differ from variant_title
      if (item.option1 && item.option1 !== variantTitle && item.option1 !== size) {
        parts.push(item.option1);
      }
      if (item.option2 && item.option2 !== variantTitle && item.option2 !== size) {
        parts.push(item.option2);
      }
      if (item.option3) {
        parts.push(item.option3);
      }

      // Add vendor/brand if available
      if (item.vendor) {
        parts.push(`Brand: ${item.vendor}`);
      }

      // Join all parts with separator
      const productName = parts.filter(Boolean).join(' | ');

      // Prices and discounts
      const priceBrutto = Number(item.price || item.price_set?.shop_money?.amount || 0);
      const discountAmount = Number(
        item.discount_allocations?.[0]?.amount ||
        item.discount_allocations?.[0]?.amount_set?.shop_money?.amount ||
        item.total_discount ||
        0
      );
      const priceAfterDiscount = priceBrutto - discountAmount;
      const discountRate = priceBrutto > 0 ? (discountAmount / priceBrutto) * 100 : 0;

      // Tax
      let taxRate = 19.0;
      if (item.tax_lines && item.tax_lines.length > 0) {
        taxRate = Number(item.tax_lines[0].rate || 0) * 100;
      } else if (order.tax_lines && order.tax_lines.length > 0) {
        taxRate = Number(order.tax_lines[0].rate || 0) * 100;
      }

      // ✅ FIX: Use effectiveQuantity (handles pre-orders with current_quantity=0)
      const quantity = effectiveQuantity;

      // Add one row per quantity
      // IMPORTANT: Always include PRODUCT_NAME even when PRODUCT_ID is set
      // This ensures size and properties are visible in Bitrix24 product card
      for (let i = 0; i < quantity; i++) {
        const row = {
          PRICE: priceAfterDiscount,
          PRICE_BRUTTO: priceBrutto,
          QUANTITY: 1,
          DISCOUNT_TYPE_ID: 1,
          DISCOUNT_SUM: discountAmount,
          DISCOUNT_RATE: discountRate,
          TAX_INCLUDED: order.taxes_included ? 'Y' : 'N',
          TAX_RATE: taxRate,
        };

        if (productId && productId !== 0) {
          row.PRODUCT_ID = Number(productId);
          row.MEASURE_CODE = 1;
        } else if (item.title) {
          // Ad-hoc POS item (e.g. "Custom sale") — no catalog product, use name only
          row.PRODUCT_NAME = productName || item.title;
          logger.warn('item_custom_name_only', 'No PRODUCT_ID — using PRODUCT_NAME for ad-hoc item', { rowIndex: i + 1, itemTitle: item.title, sku: item.sku || null, variantId: item.variant_id || null, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
        } else {
          logger.error('item_skipped', 'Skipping product row — no PRODUCT_ID and no title', { rowIndex: i + 1, itemTitle: null, sku: item.sku || null, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
          continue;
        }

        productRows.push(row);
      }
      logger.info('item_processed', 'Finished processing line item', { itemTitle: item.title || item.sku || null, quantity, rowsAdded: quantity, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
    }
  }

  // ✅ CRITICAL: Log summary of product rows (PRODUCT_ID vs PRODUCT_NAME)
  const rowsWithProductId = productRows.filter(r => r.PRODUCT_ID && r.PRODUCT_ID !== 0).length;
  const rowsWithProductName = productRows.filter(r => r.PRODUCT_NAME && !r.PRODUCT_ID).length;
  logger.info('product_rows_summary', 'Product rows assembled', { totalRows: productRows.length, rowsWithProductId, rowsWithProductName, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });

  // Shipping as separate row - ONLY from shipping_lines, NEVER from line_items
  // Extract shipping price STRICTLY from shipping_lines to avoid confusion with regular products
  if (order.shipping_lines && Array.isArray(order.shipping_lines) && order.shipping_lines.length > 0) {
    // Get shipping from the first shipping_line (most reliable source)
    const shippingLine = order.shipping_lines[0];

    // CRITICAL VALIDATION: shipping_lines should NOT contain product information
    // If shipping_line has product-like fields (sku, variant_id, product_id), it's likely a data error
    if (shippingLine.sku || shippingLine.variant_id || shippingLine.product_id || shippingLine.line_item_id) {
      logger.error('shipping_line_has_product_data', 'shipping_line contains product data — skipping to avoid confusion', { shippingLine, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
      // Don't process this as shipping - it's likely a product incorrectly placed in shipping_lines
      actualShippingPrice = 0;
      shippingLineTitle = null;
    } else {
      actualShippingPrice = Number(
        shippingLine.price ||
        shippingLine.price_set?.shop_money?.amount ||
        shippingLine.amount ||
        0
      );
      shippingLineTitle = shippingLine.title || shippingLine.code || 'Shipping';
    }
  } else {
    // Fallback: try to get from order-level shipping fields (less reliable)
    actualShippingPrice = Number(
      order.current_total_shipping_price_set?.shop_money?.amount ||
      order.total_shipping_price_set?.shop_money?.amount ||
      order.shipping_price ||
      0
    );
    shippingLineTitle = 'Shipping';
  }

  // Only add shipping row if we have actual shipping_lines OR explicit shipping price > 0
  // AND shipping price matches what we calculated (to avoid confusion with products)
  // AND shippingLineTitle is valid (not null, which would indicate invalid shipping data)
  const hasShippingLines = order.shipping_lines && Array.isArray(order.shipping_lines) && order.shipping_lines.length > 0;
  const hasExplicitShippingPrice = actualShippingPrice > 0 && Math.abs(actualShippingPrice - shippingPrice) < 0.01;
  const hasValidShippingTitle = shippingLineTitle && shippingLineTitle.trim().length > 0;

  if (actualShippingPrice > 0 && hasValidShippingTitle && (hasShippingLines || hasExplicitShippingPrice)) {
    // Use PRODUCT_ID for shipping (matching working script)
    const shippingProductId = BITRIX_CONFIG.SHIPPING_PRODUCT_ID > 0
      ? BITRIX_CONFIG.SHIPPING_PRODUCT_ID
      : 11648; // ACS delivery product ID

    const shippingName = shippingLineTitle || 'Shipping';

    productRows.push({
      PRODUCT_ID: shippingProductId, // ACS delivery product ID
      PRODUCT_NAME: shippingName, // Explicit name for visibility
      PRICE: actualShippingPrice,
      QUANTITY: 1,
      DISCOUNT_TYPE_ID: 1,
      DISCOUNT_SUM: 0.0,
      TAX_INCLUDED: order.taxes_included ? 'Y' : 'N',
      TAX_RATE: 19.0, // Default tax rate for shipping
    });

    logger.info('shipping_row_added', 'Shipping row added to product rows', { shippingProductId, shippingName, actualShippingPrice, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  } else if (shippingPrice > 0 && !hasShippingLines) {
    // Log warning if we have shipping price but no shipping_lines (potential data issue)
    logger.warn('shipping_price_no_lines', 'Shipping price detected but no shipping_lines found — skipping shipping row', { shippingPrice, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  }

  // Final validation: count products vs shipping
  const productRowsCount = productRows.length;
  const shippingRowsCount = productRows.filter(r =>
    r.PRODUCT_NAME && r.PRODUCT_NAME.toLowerCase().includes('shipping')
  ).length;
  const regularProductRowsCount = productRowsCount - shippingRowsCount;

  // Count expected items from Shopify (using current_quantity for accurate count)
  const expectedLineItemsCount = order.line_items
    ? order.line_items.reduce((sum, item) => {
      const currentQty = Number(item.current_quantity ?? item.quantity ?? 0);
      return sum + (currentQty > 0 ? currentQty : 0); // Only count active items
    }, 0)
    : 0;
  const expectedShippingCount = (order.shipping_lines && order.shipping_lines.length > 0 && actualShippingPrice > 0) ? 1 : 0;
  const expectedTotalRows = expectedLineItemsCount + expectedShippingCount;

  logger.info('order_mapping_summary', 'Order mapping complete', { orderId: order.id || order.name, lineItemsInShopify: order.line_items?.length || 0, expectedLineItemQuantity: expectedLineItemsCount, shippingLinesInShopify: order.shipping_lines?.length || 0, productRowsCreated: regularProductRowsCount, shippingRowsCreated: shippingRowsCount, totalRows: productRowsCount, expectedTotalRows }, { entityType: 'order', entityId: String(order.id) });

  if (regularProductRowsCount !== expectedLineItemsCount) {
    logger.warn('product_rows_mismatch', 'Product rows count mismatch', { expectedLineItemsCount, actualProductRows: regularProductRowsCount, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  }

  if (shippingRowsCount !== expectedShippingCount) {
    logger.warn('shipping_rows_mismatch', 'Shipping rows count mismatch', { expectedShippingCount, actualShippingRows: shippingRowsCount, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
  }

  // ✅ CRITICAL: Verify TITLE is set before returning (Fix for on-demand flow)
  if (!dealFields.TITLE) {
    logger.warn('deal_title_empty', 'TITLE was empty — setting from order.name or fallback', { orderName: order.name || null, orderId: order.id }, { entityType: 'order', entityId: String(order.id) });
    dealFields.TITLE = order.name || `Order #${order.id}`;
  }

  return { dealFields, productRows };
}
