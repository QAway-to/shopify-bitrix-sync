/**
 * Map Shopify Order to Bitrix24 Deal
 * Returns both deal fields and product rows
 */

import { BITRIX_CONFIG, financialStatusToStageId, financialStatusToPaymentStatus, sourceNameToSourceId } from './config.js';
import skuMapping from './skuMapping.json' assert { type: 'json' };
import handleMapping from './handleMapping.json' assert { type: 'json' };
import brandMapping from './brandMapping.json' assert { type: 'json' };
// ENHANCED MAPPING (закомментировано - используется семантический маппинг)
// import skuMappingEnhanced from './skuMappingEnhanced.json' assert { type: 'json' };
// ✅ SEMANTIC MAPPING: Используем семантический маппинг с 100% совпадениями
import skuMappingSemantic from './skuMappingSemantic.json' assert { type: 'json' };
// ✅ NEW: Category-based mapping with hybrid search (cache + Bitrix API)
import { findProductIdBySku, loadAllMappings } from './mappingUtils.js';
import { resolveResponsibleId } from './responsible.js';

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
const SHOPIFY_STORE = "83bfa8-c4.myshopify.com";
const SHOPIFY_TOKEN = "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";

async function getShopifyImageBase64(variantId) {
  try {
    // 1. Get Variant to find image_id and product_id
    const vUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/variants/${variantId}.json`;
    const vResp = await fetch(vUrl, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!vResp.ok) return null;

    const vData = await vResp.json();
    const variant = vData.variant;

    if (!variant || !variant.image_id) return null;

    // 2. Get Product Image URL
    const pUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${variant.product_id}/images/${variant.image_id}.json`;
    const pResp = await fetch(pUrl, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!pResp.ok) return null;

    const pData = await pResp.json();
    const imageUrl = pData.image ? pData.image.src : null;

    if (!imageUrl) return null;

    // 3. Download and Convert to Base64
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) return null;

    const arrayBuffer = await imgResp.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');

  } catch (e) {
    console.error(`[ORDER MAPPER] Error fetching Shopify image: ${e.message}`);
    return null;
  }
}

async function getShopifyProductDescription(variantId) {
  try {
    // 1. Get Variant to find product_id
    const vUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/variants/${variantId}.json`;
    const vResp = await fetch(vUrl, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!vResp.ok) return null;

    const vData = await vResp.json();
    const productId = vData.variant?.product_id;
    if (!productId) return null;

    // 2. Get Product Description (body_html)
    const pUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}.json`;
    const pResp = await fetch(pUrl, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!pResp.ok) return null;

    const pData = await pResp.json();
    return pData.product?.body_html || "";

  } catch (e) {
    console.error(`[ORDER MAPPER] Error fetching Shopify description: ${e.message}`);
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
    const vUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/variants/${variantId}.json`;
    const vResp = await fetch(vUrl, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!vResp.ok) return null;

    const vData = await vResp.json();
    const variant = vData.variant;
    if (!variant?.product_id) return null;

    // 2. Get Product
    const pUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${variant.product_id}.json`;
    const pResp = await fetch(pUrl, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!pResp.ok) return null;

    const pData = await pResp.json();
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
    console.error(`[ORDER MAPPER] Error fetching Shopify metadata: ${e.message}`);
    return null;
  }
}

/**
 * Map Shopify order to Bitrix24 deal fields and product rows
 * @param {Object} order - Shopify order object
 * @returns {Object} { dealFields, productRows }
 */
export async function mapShopifyOrderToBitrixDeal(order) {
  // Aggregates - Log price calculation for refund detection
  console.log(`[ORDER MAPPER] ===== PRICE CALCULATION =====`);
  console.log(`[ORDER MAPPER] order.current_total_price: ${order.current_total_price}`);
  console.log(`[ORDER MAPPER] order.total_price: ${order.total_price}`);
  console.log(`[ORDER MAPPER] order.current_total_tax: ${order.current_total_tax}`);
  console.log(`[ORDER MAPPER] order.total_tax: ${order.total_tax}`);

  // ✅ Calculate total from active line_items (current_quantity > 0) to get sum of active items
  // This matches Shopify UI "Total" (sum of unfulfilled/active items), not "Paid" amount
  let totalPrice = 0;
  if (order.line_items && Array.isArray(order.line_items)) {
    for (const item of order.line_items) {
      const currentQuantity = Number(item.current_quantity ?? item.quantity ?? 0);
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

    console.log(`[ORDER MAPPER] ✅ Calculated totalPrice from active line_items: ${totalPrice}`);
  }

  // Fallback to current_total_price or total_price if line_items calculation failed
  if (totalPrice === 0) {
    totalPrice = Number(order.current_total_price || order.total_price || 0);
    console.log(`[ORDER MAPPER] ⚠️ Using fallback totalPrice from order totals: ${totalPrice}`);
  }

  const totalDiscount = Number(order.current_total_discounts || order.total_discounts || 0);
  const totalTax = Number(order.current_total_tax || 0);

  console.log(`[ORDER MAPPER] Calculated totalPrice: ${totalPrice}`);
  console.log(`[ORDER MAPPER] Calculated totalTax: ${totalTax}`);
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

    // ✅ NEW CHECK: Inventory-based pre-order detection (Site only)
    // If ANY item has inventory_quantity <= 0, consider it a pre-order (Category 8)
    // even if tags are missing.
    try {
      if (order.line_items && Array.isArray(order.line_items)) {
        for (const item of order.line_items) {
          if (item.variant_id) {
            const meta = await getShopifyProductMetadata(item.variant_id);
            // If inventory is 0 or less, it's a pre-order (unless it's the very last item sold, but strictly <=0 usually implies pre-order flow or overselling)
            // User requested: "quantity <= 0" -> Pre-order (site)
            if (meta && meta.inventory_quantity <= 0) {
              console.log(`[ORDER MAPPER] 📉 Inventory check: Item ${item.sku} has qty ${meta.inventory_quantity}. Marking as PRE-ORDER (Site).`);
              categoryId = BITRIX_CONFIG.CATEGORY_PREORDER; // Force Category 8
              break; // One pre-order item is enough to move the whole deal
            }
          }
        }
      }
    } catch (invError) {
      console.error(`[ORDER MAPPER] ⚠️ Error checking inventory for pre-order logic:`, invError);
    }
  }

  console.log(`[ORDER MAPPER] Category determined: ${categoryId} (Source: ${isPOS ? 'POS' : 'Site'}, Type: ${hasPreorderTag ? 'Pre-order' : 'Stock'}) based on source_name: "${sourceName}", tags:`, orderTags);

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
    const currentQty = Number(item.current_quantity ?? item.quantity ?? 0);
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

  // ✅ SIMPLIFIED: Full refund - refunded → always LOSE (matching backup repository)
  // BUT: if cancelled, it takes priority (cancelled > refunded)
  // No check for active items or amounts - just financial_status
  const isFullRefund = !isCancelled && financialStatus === 'refunded';

  // ✅ PARTIAL REFUND: partially_refunded + has active items → PREPARATION (our improvement)
  // BUT: if cancelled, it takes priority (cancelled > partial refund)
  const isPartialRefund = !isCancelled && financialStatus === 'partially_refunded' && hasActiveItems;

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
    console.log(`[ORDER MAPPER] ⚠️⚠️⚠️ ORDER CANCELLED: financial_status="${order.financial_status}", cancelled_at=${cancelledAt || 'N/A'}, cancel_reason=${cancelReason || 'N/A'}, totalPrice=${totalPrice}, hasActiveItems=${hasActiveItems}, detected_by=[${cancelReasons.join(', ')}] → FORCING Stage "LOSE"`);
  } else if (isFullRefund) {
    stageId = 'LOSE';
    console.log(`[ORDER MAPPER] ⚠️⚠️⚠️ FULL REFUND: financial_status="${order.financial_status}" → FORCING Stage "LOSE"`);
  } else if (isPartialRefund) {
    // ✅ FIX: Dynamic stage ID based on category to prevent loop for POS (Cat 0)
    if (categoryId > 0) {
      stageId = `C${categoryId}:PREPARATION`;
    } else {
      // For Category 0 (Stock Shop), usually no 'PREPARATION' stage, or it matches 'NEW'.
      // Safe fallback to 'NEW' or 'PREPARATION' (unprefixed) if it exists.
      // Given 'partially_refunded' usually implies manual check, 'NEW' is safe.
      stageId = 'NEW';
    }
    console.log(`[ORDER MAPPER] ⚠️⚠️⚠️ PARTIAL REFUND: financial_status="${order.financial_status}", hasActiveItems=${hasActiveItems} → FORCING Stage "${stageId}"`);
  } else {
    // ✅ PRE-ORDER SPECIAL LOGIC: If pre-order (Cat 4 or 8) is PAID, move to WON
    // Pre-orders that are fully paid should go directly to Success
    const isPreorderCategory = categoryId === BITRIX_CONFIG.CATEGORY_SHOP_PREORDER || categoryId === BITRIX_CONFIG.CATEGORY_PREORDER;
    const isPaid = (order.financial_status || '').toLowerCase() === 'paid';

    if (isPreorderCategory && isPaid) {
      // Use category-prefixed WON stage (C4:WON for shop, C8:WON for site)
      stageId = `C${categoryId}:WON`;
      console.log(`[ORDER MAPPER] ✅ PRE-ORDER PAID: Category ${categoryId} + financial_status="paid" → Stage "${stageId}" (Success)`);
    } else {
      stageId = financialStatusToStageId(order.financial_status || '', categoryId);
      console.log(`[ORDER MAPPER] Financial status "${order.financial_status}" → Stage "${stageId}" for category ${categoryId}`);
    }
  }

  // Map financial status to payment status field
  // ✅ CRITICAL: For cancelled orders, ALWAYS set payment status to '58' (Unpaid)
  // regardless of financial_status (cancelled orders should never show as paid)
  let paymentStatusEnumId;
  if (isCancelled) {
    paymentStatusEnumId = '58'; // Unpaid - cancelled orders are never paid
    console.log(`[ORDER MAPPER] ⚠️ Order is CANCELLED → FORCING Payment status to "58" (Unpaid), ignoring financial_status="${order.financial_status}"`);
  } else {
    paymentStatusEnumId = financialStatusToPaymentStatus(order.financial_status);
    console.log(`[ORDER MAPPER] Financial status "${order.financial_status}" → Payment status enum ID "${paymentStatusEnumId}"`);
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
  console.log(`[ORDER MAPPER] Order type determined: ID "${orderTypeId}" (source: ${order.source_name}, preorder: ${hasPreorderTag})`);

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

  console.log(`[ORDER MAPPER] Delivery method determined: ID "${deliveryMethodId}"`);

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

  // Log all fields being sent for debugging
  console.log(`[ORDER MAPPER] Deal fields prepared:`, {
    ORDER_TYPE_ID: orderTypeId,
    DELIVERY_METHOD_ID: deliveryMethodId,
    PAYMENT_STATUS_ID: paymentStatusEnumId,
    CATEGORY_ID: categoryId,
    STAGE_ID: stageId
  });

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
      const currentQty = Number(item.current_quantity ?? item.quantity ?? 0);
      return currentQty > 0;
    });
    const lineItems = activeLineItems;
    const itemsCount = lineItems.length;

    console.log(`[ORDER MAPPER] Processing ${itemsCount} active line_item(s) for UF-fields (filtered from ${order.line_items.length} total)`);

    // ===== SIZE AGGREGATION =====
    if (itemsCount === 1) {
      const firstItem = lineItems[0];
      let sizeValue = null;
      if (firstItem.variant_title) {
        sizeValue = String(firstItem.variant_title).trim();
        console.log(`[ORDER MAPPER] Size from variant_title (single): "${sizeValue}"`);
      } else if (firstItem.name) {
        const nameParts = firstItem.name.split(' - ');
        if (nameParts.length > 1) {
          sizeValue = nameParts[nameParts.length - 1].trim();
          console.log(`[ORDER MAPPER] Size from name (single): "${sizeValue}"`);
        }
      }
      if (sizeValue) {
        dealFields.UF_CRM_1739793720585 = sizeValue;
        console.log(`[ORDER MAPPER] ✅ Size (single) UF_CRM_1739793720585 = "${sizeValue}"`);
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
        console.log(`[ORDER MAPPER] ✅ Size (aggregated) UF_CRM_1739793720585 = "${dealFields.UF_CRM_1739793720585}"`);
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
          console.log(`[ORDER MAPPER] ✅ Color (single) UF_CRM_1739793651654 = "${color}"`);
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
        console.log(`[ORDER MAPPER] ✅ Color (aggregated) UF_CRM_1739793651654 = "${dealFields.UF_CRM_1739793651654}"`);
      }
    }

    // ===== MODEL AND BRAND (first item as reference) =====
    const firstItem = lineItems[0];

    // ✅ FIX: Check if firstItem exists and has title property
    if (firstItem && firstItem.title) {
      const model = parseModelFromTitle(firstItem.title);
      if (model) {
        dealFields.UF_CRM_1739793668182 = model;
      }

      if (firstItem.vendor) {
        const vendorUpper = String(firstItem.vendor).toUpperCase().trim();
        const brandId = brandMapping[vendorUpper];
        if (brandId) {
          dealFields.UF_CRM_1741642513658 = brandId; // Enum field - use ID
        } else {
          console.warn(`[ORDER MAPPER] Brand "${vendorUpper}" not found in brandMapping.json, skipping UF_CRM_1741642513658`);
        }
      }
    }

    console.log(`[ORDER MAPPER] Extracted UF-fields:`, {
      size: dealFields.UF_CRM_1739793720585 || 'N/A',
      color: dealFields.UF_CRM_1739793651654 || 'N/A',
      model: dealFields.UF_CRM_1739793668182 || 'N/A',
      brand: dealFields.UF_CRM_1741642513658 || 'N/A'
    });
  } else {
    console.warn(`[ORDER MAPPER] ⚠️ No line_items found in order, cannot extract product properties`);
  }

  // Log all UF-fields that will be sent to Bitrix
  const ufFields = Object.keys(dealFields).filter(key => key.startsWith('UF_'));
  console.log(`[ORDER MAPPER] All UF-fields in dealFields:`, ufFields.map(key => ({
    field: key,
    value: dealFields[key]
  })));

  // Product rows
  const productRows = [];

  // Shipping variables (defined early for final validation)
  let actualShippingPrice = 0;
  let shippingLineTitle = null;

  if (order.line_items && Array.isArray(order.line_items)) {
    // Get shipping product ID to avoid confusion
    const shippingProductId = BITRIX_CONFIG.SHIPPING_PRODUCT_ID > 0
      ? BITRIX_CONFIG.SHIPPING_PRODUCT_ID
      : 11640; // ACS delivery product ID

    for (const item of order.line_items) {
      // ✅ FIX: Handle pre-order items correctly
      // - For regular orders: current_quantity reflects active (after refunds)
      // - For pre-orders: current_quantity = 0 (not yet received) but quantity > 0
      const originalQuantity = Number(item.quantity ?? 0);
      const currentQuantity = Number(item.current_quantity ?? item.quantity ?? 0);

      // Skip only if BOTH are 0 (truly refunded/removed)
      // If quantity > 0 but current_quantity = 0:
      // - If fulfilled: treat as sold (use original quantity)
      // - If NOT fulfilled: treat as removed/refunded before fulfillment (use 0)
      const isFulfilled = item.fulfillment_status === 'fulfilled';

      let effectiveQuantity = currentQuantity;
      if (currentQuantity === 0) {
        if (isFulfilled) {
          // It was sold and fulfilled, so we keep it in the deal
          effectiveQuantity = originalQuantity;
        } else if (originalQuantity > 0) {
          // It was ordered but now current=0 and NOT fulfilled -> Removed from order
          // Treat as 0 to exclude from deal
          effectiveQuantity = 0;
          console.log(`[ORDER MAPPER] 🗑️ Item ${item.id} (SKU: ${item.sku}) marked as REMOVED (unfulfilled, current_qty=0)`);
        }
      }

      if (effectiveQuantity <= 0) {
        console.log(`[ORDER MAPPER] ⏭️ Skipping item ${item.id} (SKU: ${item.sku || 'N/A'}) - both quantity and current_quantity are 0 (fully refunded)`);
        continue;
      }

      // Log pre-order detection
      if (currentQuantity === 0 && originalQuantity > 0) {
        console.log(`[ORDER MAPPER] 📦 PRE-ORDER DETECTED: item ${item.id} (SKU: ${item.sku || 'N/A'}) - current_quantity=0, quantity=${originalQuantity}`);
      }

      // CRITICAL: line_items are ALWAYS products, NEVER shipping
      // Even if a product has the same ID as shipping, it's still a product from line_items

      // ===== STRICT MAPPING: SKU/XML_ID first, fallback to variant_id for certificates =====
      let productId = null;
      let mappingMethod = 'none';

      if (item.sku) {
        console.log(`[ORDER MAPPER] 🔍 Searching for Product ID by SKU/XML_ID: "${item.sku}"`);
        productId = await findProductIdBySku(item.sku);
        if (productId) {
          mappingMethod = 'sku/xml_id';
          console.log(`[ORDER MAPPER] ✅ Found by SKU/XML_ID: "${item.sku}" -> Product ID: ${productId}`);
        } else {
          console.error(`[ORDER MAPPER] ❌ SKU/XML_ID NOT FOUND in Bitrix: "${item.sku}"`);
        }
      } else {
        console.warn(`[ORDER MAPPER] ⚠️ SKU is missing for item: "${item.title || 'N/A'}"`);
      }

      // Fallback: variant_id for known certificates (no SKU in Shopify)
      if (!productId && item.variant_id) {
        const variantId = Number(item.variant_id);
        const certProductId = CERT_VARIANT_TO_PRODUCT_ID[variantId];
        if (certProductId) {
          productId = certProductId;
          mappingMethod = 'variant_id_certificate';
          console.log(`[ORDER MAPPER] ✅ Found by variant_id (certificate): ${variantId} -> Product ID: ${productId}`);
        } else {
          console.error(`[ORDER MAPPER] ❌ variant_id NOT FOUND in certificate map: ${variantId}`);
        }
      }

      // ✅ ON-DEMAND PRODUCT CREATION: If product not found, auto-create in Bitrix
      if (!productId && item.variant_id) {
        console.log(`[ORDER MAPPER] 🔧 ON-DEMAND: Product not found, attempting to auto-create from variant_id: ${item.variant_id}`);

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
            productId = existingProductResp.result[0].ID;
            mappingMethod = 'xml_id_lookup';
            console.log(`[ORDER MAPPER] ✅ ON-DEMAND: Found existing product by XML_ID: ${variantIdStr} -> Product ID: ${productId}`);
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
                console.log(`[ORDER MAPPER] 📝 Fetched real description for ${item.variant_id}`);
              }
            } catch (descErr) {
              console.warn(`[ORDER MAPPER] ⚠️ Failed to fetch description: ${descErr.message}`);
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
              console.log(`[ORDER MAPPER] ✅ ON-DEMAND: Created new product: ${fullTitle} -> Product ID: ${productId}`);
              console.log(JSON.stringify({
                event: 'ON_DEMAND_PRODUCT_CREATED',
                variantId: variantIdStr,
                sku,
                fullTitle,
                price,
                bitrixProductId: productId,
                timestamp: new Date().toISOString()
              }));

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
                  console.log(`[ORDER MAPPER] 📦 Fetched Shopify metadata: brand=${brand}, type=${productType}, size=${sizeVal}, color=${colorVal}`);
                }
              } catch (metaErr) {
                console.warn(`[ORDER MAPPER] ⚠️ Failed to fetch Shopify metadata: ${metaErr.message}`);
              }

              const sizeEnum = getSizeEnumId(sizeVal);

              console.log(`[ORDER MAPPER] 🔖 Updating properties for ${productId}: Brand=${brand}, Category=${productType}, Size=${sizeVal}(${sizeEnum}), Color=${colorVal}`);

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
                console.error(`[ORDER MAPPER] ❌ Failed to update properties: ${propErr.message}`);
              }

              // 3. Add Pre-Order Stock (Store 2)
              // ✅ FIX: Add +1 to orderQty to handle deal reservation AND keep positive stock
              const stockAmount = orderQty + 1;
              console.log(`[ORDER MAPPER] 📦 PRE-ORDER: Adding stock (${stockAmount} units = ${orderQty}+1) for on-demand product ${productId} (Store ID: 2)`);

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
                  console.log(`[ORDER MAPPER] ✅ PRE-ORDER: Stock added successfully (Document ID: ${docId}, Amount: ${stockAmount})`);
                } else {
                  console.warn(`[ORDER MAPPER] ⚠️ PRE-ORDER: Failed to create stock document for product ${productId}`);
                }
              } catch (stockError) {
                console.error(`[ORDER MAPPER] ❌ PRE-ORDER: Error adding stock:`, stockError.message);
                // Continue anyway - product is created, stock issue can be fixed manually
              }

              // 4. Image Sync (New)
              try {
                const imageBase64 = await getShopifyImageBase64(item.variant_id);
                if (imageBase64) {
                  console.log(`[ORDER MAPPER] 🖼️ Found image for variant ${item.variant_id}, uploading to Bitrix...`);
                  await callBitrix('/crm.product.update.json', {
                    id: productId,
                    fields: {
                      "PREVIEW_PICTURE": { "fileData": ["image.jpg", imageBase64] },
                      "DETAIL_PICTURE": { "fileData": ["image.jpg", imageBase64] }
                    }
                  });
                  console.log(`[ORDER MAPPER] ✅ Image uploaded successfully`);
                } else {
                  console.log(`[ORDER MAPPER] ℹ️ No image found for variant ${item.variant_id}`);
                }
              } catch (imgErr) {
                console.warn(`[ORDER MAPPER] ⚠️ Failed to sync image: ${imgErr.message}`);
              }

            } else {
              console.error(`[ORDER MAPPER] ❌ ON-DEMAND: Failed to create product:`, createProductResp.error || 'Unknown error');
            }
          }
        } catch (onDemandError) {
          console.error(`[ORDER MAPPER] ❌ ON-DEMAND: Error creating product:`, onDemandError.message);
        }
      }

      // Final check - if still no productId, skip
      if (!productId) {
        console.error(`[ORDER MAPPER] ❌❌❌ CRITICAL: NO PRODUCT_ID FOUND and auto-create failed. Item: "${item.title || 'N/A'}" (SKU: "${item.sku || 'N/A'}", variant_id: ${item.variant_id || 'N/A'})`);
        console.error(`[ORDER MAPPER]   ⚠️ This item will NOT be added to deal (no PRODUCT_ID available)`);
      }

      // Safety check: if product ID matches shipping ID, log warning but keep it as product
      // (line_items are always products, even if they accidentally have shipping ID)
      if (productId && productId == shippingProductId) {
        console.warn(`[ORDER MAPPER] WARNING: Product from line_items (SKU: ${item.sku || 'N/A'}, Title: ${item.title || 'N/A'}) has PRODUCT_ID ${productId} which matches shipping ID. Treating as product (not shipping).`);
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

      // ✅ LOG: Log item details for debugging
      console.log(`[ORDER MAPPER] 📦 Processing item: SKU=${item.sku || 'N/A'}, Title="${item.title || 'N/A'}"`);
      console.log(`[ORDER MAPPER]   - quantity (original): ${item.quantity}`);
      console.log(`[ORDER MAPPER]   - current_quantity: ${currentQuantity}`);
      console.log(`[ORDER MAPPER]   - effectiveQuantity: ${effectiveQuantity} (for pre-orders uses original)`);
      console.log(`[ORDER MAPPER]   - price: ${item.price}, priceAfterDiscount: ${priceAfterDiscount}`);
      console.log(`[ORDER MAPPER]   - Will create ${quantity} product row(s)`);

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

        // ✅ CRITICAL: ALWAYS use PRODUCT_ID (never PRODUCT_NAME)
        // Bitrix requires PRODUCT_ID (XML_ID/SKU) to link product to catalog
        // If productId is not found, skip this row (don't create custom row)
        if (productId && productId !== 0) {
          row.PRODUCT_ID = Number(productId); // Ensure it's a number, not string
          row.MEASURE_CODE = 1; // Pieces (как в рабочем скрипте)
          // Don't set PRODUCT_NAME - Bitrix will use product name from catalog
          console.log(`[ORDER MAPPER] ✅ Row ${i + 1}/${quantity}: Using PRODUCT_ID=${row.PRODUCT_ID} (mapped via ${mappingMethod})`);
          console.log(`[ORDER MAPPER]   - Item: "${item.title || 'N/A'}" (SKU: "${item.sku || 'N/A'}")`);
          console.log(`[ORDER MAPPER]   - PRODUCT_NAME is NOT set - Bitrix will use product name from catalog`);
          console.log(`[ORDER MAPPER]   📦 Row payload:`, JSON.stringify({
            PRODUCT_ID: row.PRODUCT_ID,
            PRICE: row.PRICE,
            QUANTITY: row.QUANTITY,
            TAX_INCLUDED: row.TAX_INCLUDED,
            MEASURE_CODE: row.MEASURE_CODE
          }, null, 2));
        } else {
          // ❌ CRITICAL: Skip this row if PRODUCT_ID is not found
          // Never create custom row with PRODUCT_NAME - always require PRODUCT_ID
          console.error(`[ORDER MAPPER] ❌❌❌ SKIPPING row ${i + 1}/${quantity}: No PRODUCT_ID found for item "${item.title || 'N/A'}"`);
          console.error(`[ORDER MAPPER]   This item will NOT be added to deal (requires PRODUCT_ID from Bitrix catalog)`);
          continue; // Skip this row
        }

        productRows.push(row);
        const rowType = productId ? `PRODUCT_ID=${productId}` : `PRODUCT_NAME="${row.PRODUCT_NAME}"`;
        console.log(`[ORDER MAPPER]   ✅ Added product row ${i + 1}/${quantity}: ${rowType}, Price: ${priceAfterDiscount}, QUANTITY: 1`);
      }
      console.log(`[ORDER MAPPER] 📦 Finished processing item "${item.title || item.sku}": ${quantity} row(s) added`);
    }
  }

  // ✅ LOG: Log total product rows before shipping
  console.log(`[ORDER MAPPER] 📊 Total product rows (before shipping): ${productRows.length}`);

  // ✅ CRITICAL: Log summary of product rows (PRODUCT_ID vs PRODUCT_NAME)
  const rowsWithProductId = productRows.filter(r => r.PRODUCT_ID && r.PRODUCT_ID !== 0).length;
  const rowsWithProductName = productRows.filter(r => r.PRODUCT_NAME && !r.PRODUCT_ID).length;
  console.log(`[ORDER MAPPER] 📋 Product rows summary: ${rowsWithProductId} with PRODUCT_ID (linked), ${rowsWithProductName} with PRODUCT_NAME only (custom)`);

  // Log each row for debugging
  productRows.forEach((row, idx) => {
    if (row.PRODUCT_ID) {
      console.log(`[ORDER MAPPER]   Row ${idx + 1}: PRODUCT_ID=${row.PRODUCT_ID}, PRICE=${row.PRICE}, QTY=${row.QUANTITY} ✅ LINKED TO CATALOG`);
    } else if (row.PRODUCT_NAME) {
      console.log(`[ORDER MAPPER]   Row ${idx + 1}: PRODUCT_NAME="${row.PRODUCT_NAME}", PRICE=${row.PRICE}, QTY=${row.QUANTITY} ⚠️ NOT LINKED (custom row)`);
    }
  });

  // Shipping as separate row - ONLY from shipping_lines, NEVER from line_items
  // Extract shipping price STRICTLY from shipping_lines to avoid confusion with regular products
  if (order.shipping_lines && Array.isArray(order.shipping_lines) && order.shipping_lines.length > 0) {
    // Get shipping from the first shipping_line (most reliable source)
    const shippingLine = order.shipping_lines[0];

    // CRITICAL VALIDATION: shipping_lines should NOT contain product information
    // If shipping_line has product-like fields (sku, variant_id, product_id), it's likely a data error
    if (shippingLine.sku || shippingLine.variant_id || shippingLine.product_id || shippingLine.line_item_id) {
      console.error(`[ORDER MAPPER] ERROR: shipping_line contains product data! This should NEVER happen. Skipping shipping to avoid confusion.`, shippingLine);
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
      : 11640; // ACS delivery product ID

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

    console.log(`[ORDER MAPPER] Added shipping row (PRODUCT_ID: ${shippingProductId}): ${shippingName}, Price: ${actualShippingPrice}`);
  } else if (shippingPrice > 0 && !hasShippingLines) {
    // Log warning if we have shipping price but no shipping_lines (potential data issue)
    console.warn(`[ORDER MAPPER] Shipping price detected (${shippingPrice}) but no shipping_lines found. Skipping shipping row to avoid confusion.`);
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

  // Log summary for debugging
  console.log(`[ORDER MAPPER] Order ${order.name || order.id} mapping summary:`);
  console.log(`  - Line items in Shopify: ${order.line_items?.length || 0} (total quantity: ${expectedLineItemsCount})`);
  console.log(`  - Shipping lines in Shopify: ${order.shipping_lines?.length || 0}`);
  console.log(`  - Product rows created: ${regularProductRowsCount}`);
  console.log(`  - Shipping rows created: ${shippingRowsCount}`);
  console.log(`  - Total rows: ${productRowsCount} (expected: ${expectedTotalRows})`);

  if (regularProductRowsCount !== expectedLineItemsCount) {
    console.warn(`[ORDER MAPPER] WARNING: Product rows count mismatch! Expected ${expectedLineItemsCount} from line_items, got ${regularProductRowsCount}`);
  }

  if (shippingRowsCount !== expectedShippingCount) {
    console.warn(`[ORDER MAPPER] WARNING: Shipping rows count mismatch! Expected ${expectedShippingCount}, got ${shippingRowsCount}`);
  }

  // ✅ CRITICAL: Verify TITLE is set before returning (Fix for on-demand flow)
  if (!dealFields.TITLE) {
    console.warn(`[ORDER MAPPER] ⚠️ TITLE was empty! Setting from order.name: "${order.name}" or fallback`);
    dealFields.TITLE = order.name || `Order #${order.id}`;
  }
  console.log(`[ORDER MAPPER] ✅ Final dealFields.TITLE: "${dealFields.TITLE}"`);

  return { dealFields, productRows };
}
