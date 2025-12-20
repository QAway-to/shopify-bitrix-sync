// Bitrix24 Configuration
// TODO: Replace with actual IDs from your Bitrix24 instance

export const BITRIX_CONFIG = {
  // Category ID (Funnel ID) for deals
  CATEGORY_ID: 0, // Stock (in the shop) - default category

  // Default stage IDs (matching Bitrix24 stages)
  STAGES: {
    PAID: 'WON', // Success stage for paid orders
    PENDING: 'NEW', // New stage for pending payment
    REFUNDED: 'LOSE', // Loss stage for refunded
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
export const financialStatusToStageId = (financialStatus) => {
  const status = financialStatus?.toLowerCase() || '';
  const mapping = {
    'paid': BITRIX_CONFIG.STAGES.PAID,
    'pending': BITRIX_CONFIG.STAGES.PENDING,
    'refunded': BITRIX_CONFIG.STAGES.REFUNDED,
    'cancelled': BITRIX_CONFIG.STAGES.CANCELLED,
    'partially_paid': BITRIX_CONFIG.STAGES.PENDING,
    'partially_refunded': BITRIX_CONFIG.STAGES.REFUNDED,
    'voided': BITRIX_CONFIG.STAGES.CANCELLED
  };
  return mapping[status] || BITRIX_CONFIG.STAGES.DEFAULT;
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

