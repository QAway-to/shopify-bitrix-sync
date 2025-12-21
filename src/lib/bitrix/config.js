// Bitrix24 Configuration
// TODO: Replace with actual IDs from your Bitrix24 instance

export const BITRIX_CONFIG = {
  // Category IDs (Funnel IDs) for deals
  CATEGORY_STOCK: 2, // Stock (in the shop)
  CATEGORY_PREORDER: 8, // Pre-order (site)

  // Default stage IDs (matching Bitrix24 stages)
  STAGES: {
    PAID: 'WON', // Success stage for paid orders
    PENDING: 'NEW', // New stage for pending payment
    PREPARATION: 'C2:PREPARATION', // Preparation stage (for partially refunded - order still active)
    REFUNDED: 'LOSE', // Loss stage for fully refunded
    CANCELLED: 'LOSE', // Loss stage for cancelled
    DEFAULT: 'NEW' // Default to NEW stage
  },

  // Source IDs mapping
  SOURCES: {
    SHOPIFY_DRAFT_ORDER: 'WEB', // Use WEB for draft orders
    SHOPIFY: 'WEB' // Use WEB for shopify orders
  },

  // Product ID for shipping (from working script)
  SHIPPING_PRODUCT_ID: 3000, // Real shipping product ID

  // SKU to Product ID mapping
  // TODO: Replace with actual product IDs from Bitrix24
  SKU_TO_PRODUCT_ID: {
    'ALB0002': 0, // TODO: Replace with actual product ID
    'ALB0005': 0, // TODO: Replace with actual product ID
    // Add more SKU mappings as needed
  }
};

// Financial status to stage ID mapping
// Note: categoryId parameter is accepted for future use if different categories have different stage mappings
export const financialStatusToStageId = (financialStatus, categoryId = null) => {
  const status = financialStatus?.toLowerCase() || '';
  const mapping = {
    'paid': BITRIX_CONFIG.STAGES.PAID, // WON - полностью оплачен
    'pending': BITRIX_CONFIG.STAGES.PENDING, // NEW - ожидает оплаты
    'refunded': BITRIX_CONFIG.STAGES.REFUNDED, // LOSE - полностью возвращен
    'cancelled': BITRIX_CONFIG.STAGES.CANCELLED, // LOSE - отменен
    'partially_paid': BITRIX_CONFIG.STAGES.PENDING, // NEW - частично оплачен, ожидает полной оплаты
    'partially_refunded': BITRIX_CONFIG.STAGES.PREPARATION, // C2:PREPARATION - частично возвращен, заказ еще активен
    'voided': BITRIX_CONFIG.STAGES.CANCELLED // LOSE - аннулирован
  };
  return mapping[status] || BITRIX_CONFIG.STAGES.DEFAULT;
};

// Financial status to payment status enum ID mapping
// Bitrix field: UF_CRM_1739183959976 (Payment status)
// Values: "56" = "Paid", "58" = "Unpaid", "60" = "10% prepayment"
export const financialStatusToPaymentStatus = (financialStatus) => {
  const status = financialStatus?.toLowerCase() || '';
  const mapping = {
    'paid': '56', // Paid - полная оплата
    'pending': '58', // Unpaid - не оплачен
    'partially_paid': '60', // 10% prepayment - частичная оплата
    'refunded': '58', // Unpaid - после полного возврата не оплачен
    'partially_refunded': '60', // 10% prepayment - частично возвращен, но частично оплачен
    'cancelled': '58', // Unpaid - отменен, не оплачен
    'voided': '58' // Unpaid - аннулирован
  };
  return mapping[status] || '58'; // Default to Unpaid
};

// Source name to source ID mapping
export const sourceNameToSourceId = (sourceName) => {
  const source = sourceName?.toLowerCase() || '';
  const mapping = {
    'shopify_draft_order': BITRIX_CONFIG.SOURCES.SHOPIFY_DRAFT_ORDER,
    'shopify': BITRIX_CONFIG.SOURCES.SHOPIFY,
    'web': BITRIX_CONFIG.SOURCES.SHOPIFY,
    'pos': BITRIX_CONFIG.SOURCES.SHOPIFY
  };
  return mapping[source] || null;
};

