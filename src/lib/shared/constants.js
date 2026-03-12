/**
 * Shared Constants
 * Single source of truth for mappings used across multiple modules
 * 
 * Previously duplicated in:
 * - src/lib/bitrix/orderMapper.js
 * - src/lib/bitrix/products.js
 * - src/lib/sync/inventorySyncCore.js
 */

// ============ SIZE ENUM MAPPING ============
// Maps Shopify size text to Bitrix PROPERTY_98 enum ID
export const SIZE_ENUM_MAP = {
    "20": 154, "21": 156, "22": 158, "23": 160, "24": 162,
    "25": 164, "26": 166, "27": 168, "28": 170, "29": 172,
    "30": 174, "31": 176, "32": 178, "33": 320, "34": 322,
    "35": 324, "36": 326, "37": 328, "38": 330, "39": 332,
    "40": 334, "41": 336, "42": 338, "43": 340, "44": 342,
    "45": 344, "46": 346, "47": 348, "48": 350, "49": 352,
    "50": 354, "51": 356, "52": 358, "53": 360, "54": 362
};

/**
 * Get Bitrix enum ID for a size text
 * @param {string} sizeText - Size text (e.g., "37", "37.5")
 * @returns {number|null} Enum ID or null if not found
 */
export function getSizeEnumId(sizeText) {
    if (!sizeText) return null;
    const clean = String(sizeText).trim();
    return SIZE_ENUM_MAP[clean] || null;
}

// ============ SECTION MAPPING ============
// Maps category names to Bitrix Section IDs
export const SECTION_MAP = {
    'category-a-f': 36,
    'category-g-m': 38,
    'category-n-s': 40,
    'category-t-z': 42,
};

export const SECTION_NAMES = {
    36: 'A-F',
    38: 'G-M',
    40: 'N-S',
    42: 'T-Z',
};

/**
 * Get category name by SKU first letter
 * @param {string} sku - Product SKU
 * @returns {string} Category name
 */
export function getCategoryBySku(sku) {
    if (!sku) return 'category-g-m';
    const firstChar = sku[0].toLowerCase();
    if (firstChar >= 'a' && firstChar <= 'f') return 'category-a-f';
    if (firstChar >= 'g' && firstChar <= 'm') return 'category-g-m';
    if (firstChar >= 'n' && firstChar <= 's') return 'category-n-s';
    if (firstChar >= 't' && firstChar <= 'z') return 'category-t-z';
    return 'category-g-m';
}

/**
 * Get Bitrix Section ID by SKU
 * @param {string} sku - Product SKU
 * @returns {number} Section ID
 */
export function getSectionIdBySku(sku) {
    return SECTION_MAP[getCategoryBySku(sku)] || 38;
}

// ============ BITRIX PROPERTY IDs ============
export const BITRIX_PROPERTIES = {
    SIZE: 98,       // PROPERTY_98
    BRAND: 102,     // PROPERTY_102
    CATEGORY: 104,  // PROPERTY_104
    COLOR: 106,     // PROPERTY_106
};

// ============ BITRIX USER FIELD IDs ============
export const BITRIX_DEAL_FIELDS = {
    SHOPIFY_ORDER_ID: 'UF_CRM_1742556489',
    BRAND: 'UF_CRM_1741642513658', // New Select List Field (formerly UF_CRM_1768251890190)
    MODEL: 'UF_CRM_1739793668182',
    SIZE: 'UF_CRM_1739793720585',
    COLOR: 'UF_CRM_1739793651654',
    ADDRESS: 'UF_CRM_1742037435676',
    DELIVERY_PRICE: 'UF_CRM_67BEF8B2AA721',
    PAYMENT_STATUS: 'UF_CRM_1739183959976',
    MW_ACTION: 'UF_MW_SHOPIFY_ACTION',
    CREATE_MODE: 'UF_CRM_1768864699586', // 0 = search existing, 1 = create new product
    PRODUCT_PRICE: 'UF_CRM_1768869578330', // Price for product creation
};

// ============ PAYMENT STATUS ENUM ============
export const PAYMENT_STATUS = {
    PAID: '56',
    UNPAID: '58',
    PREPAYMENT: '60',
};

// ============ STORE IDs ============
export const STORE_ID = {
    MAIN_WAREHOUSE: 2,
};

export default {
    SIZE_ENUM_MAP,
    getSizeEnumId,
    SECTION_MAP,
    SECTION_NAMES,
    getCategoryBySku,
    getSectionIdBySku,
    BITRIX_PROPERTIES,
    BITRIX_DEAL_FIELDS,
    PAYMENT_STATUS,
    STORE_ID,
};
