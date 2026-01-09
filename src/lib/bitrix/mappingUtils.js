/**
 * Mapping Utilities
 * Handles category-based SKU to Product ID mapping with hybrid approach (cache + Bitrix API)
 */

import { callBitrix } from './client.js';

// Check if we're on the server
const isServer = typeof window === 'undefined';

// Server-only imports (will be tree-shaken on client)
let readFileSync, writeFileSync, existsSync, mkdirSync, join, dirname, fileURLToPath;
let __dirname, MAPPINGS_DIR;

// Initialize server-only modules (only on server)
// Use lazy initialization to avoid client-side execution
let serverModulesInitialized = false;

function initServerModules() {
  if (serverModulesInitialized || !isServer) {
    return;
  }

  try {
    // Dynamic import for server-only modules
    // This will be evaluated at runtime on server only
    const fs = eval('require')('fs');
    const path = eval('require')('path');
    const url = eval('require')('url');

    readFileSync = fs.readFileSync;
    writeFileSync = fs.writeFileSync;
    existsSync = fs.existsSync;
    mkdirSync = fs.mkdirSync;
    join = path.join;
    dirname = path.dirname;
    fileURLToPath = url.fileURLToPath;

    // Get current directory in ES modules
    const __filename = fileURLToPath(import.meta.url);
    __dirname = dirname(__filename);

    // Mappings directory - use .data for persistent storage on Render (same as other data)
    MAPPINGS_DIR = join(process.cwd(), '.data', 'mappings');

    serverModulesInitialized = true;
  } catch (error) {
    // If initialization fails, set to null
    console.warn('[MAPPING UTILS] Could not initialize server modules:', error.message);
    MAPPINGS_DIR = null;
  }
}

// Initialize on first use (server only)
if (isServer) {
  initServerModules();
} else {
  MAPPINGS_DIR = null;
}

// Ensure mappings directory exists (server only)
if (isServer && MAPPINGS_DIR && existsSync && mkdirSync) {
  try {
    if (!existsSync(MAPPINGS_DIR)) {
      mkdirSync(MAPPINGS_DIR, { recursive: true });
    }
  } catch (error) {
    console.warn(`[MAPPING UTILS] Could not create mappings directory: ${error.message}`);
  }
}

/**
 * Determine category by handle or SKU first letter
 * @param {string} handleOrSku - Product handle or SKU
 * @returns {string} Category name
 */
export function getCategoryByHandle(handleOrSku) {
  if (!handleOrSku || typeof handleOrSku !== 'string') {
    return null;
  }

  const firstChar = handleOrSku.toLowerCase().charAt(0);

  // Certificates (special category)
  if (handleOrSku.includes('certificate') || handleOrSku.startsWith('e-certificate') ||
    handleOrSku.startsWith('gift-certificate') || handleOrSku.startsWith('printed-gift')) {
    return 'certificates';
  }

  // Alphabetical categories
  if (firstChar >= 'a' && firstChar <= 'f') {
    return 'category-a-f';
  } else if (firstChar >= 'g' && firstChar <= 'm') {
    return 'category-g-m';
  } else if (firstChar >= 'n' && firstChar <= 's') {
    return 'category-n-s';
  } else if (firstChar >= 't' && firstChar <= 'z') {
    return 'category-t-z';
  }

  // Default to first category if not in range
  return 'category-a-f';
}

/**
 * Get Bitrix Section ID by category or SKU
 * Maps alphabetical categories to Bitrix folder sections
 * @param {string} categoryOrSku - Category name or SKU
 * @returns {number} Section ID in Bitrix catalog
 */
export function getSectionIdByCategory(categoryOrSku) {
  // If passed a SKU, first get the category
  let category = categoryOrSku;
  if (!categoryOrSku?.startsWith('category-') && categoryOrSku !== 'certificates') {
    category = getCategoryByHandle(categoryOrSku);
  }

  // Map category to section ID
  const sectionMap = {
    'category-a-f': 36,
    'category-g-m': 38,
    'category-n-s': 40,
    'category-t-z': 42,
    'certificates': 38 // Default to G-M section for certificates
  };

  return sectionMap[category] || 38; // Default to 38 (G-M) if unknown
}

/**
 * Load mapping file for a category
 * @param {string} category - Category name
 * @returns {Object} Mapping object (SKU -> Product ID)
 */
export function loadCategoryMapping(category) {
  // Client-side: return empty mapping
  if (!isServer || !MAPPINGS_DIR) {
    return {};
  }

  const filePath = join(MAPPINGS_DIR, `${category}.json`);

  if (!existsSync(filePath)) {
    console.warn(`[MAPPING UTILS] Mapping file not found: ${filePath}, returning empty mapping`);
    return {};
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const mapping = JSON.parse(content);

    // Remove metadata fields
    const cleanMapping = {};
    for (const [key, value] of Object.entries(mapping)) {
      if (!key.startsWith('_')) {
        cleanMapping[key] = value;
      }
    }

    return cleanMapping;
  } catch (error) {
    console.error(`[MAPPING UTILS] Error loading mapping ${category}:`, error);
    return {};
  }
}

/**
 * Load all category mappings
 * @returns {Object} Combined mapping object
 */
export function loadAllMappings() {
  const categories = ['certificates', 'category-a-f', 'category-g-m', 'category-n-s', 'category-t-z'];
  const combinedMapping = {};

  for (const category of categories) {
    const mapping = loadCategoryMapping(category);
    Object.assign(combinedMapping, mapping);
  }

  return combinedMapping;
}

/**
 * Save mapping to category file
 * @param {string} category - Category name
 * @param {Object} mapping - Mapping object to save
 */
export function saveCategoryMapping(category, mapping) {
  // Initialize server modules if needed
  if (isServer && !serverModulesInitialized) {
    initServerModules();
  }

  // Client-side: no-op
  if (!isServer || !MAPPINGS_DIR) {
    console.warn(`[MAPPING UTILS] Cannot save mapping on client side`);
    return;
  }

  const filePath = join(MAPPINGS_DIR, `${category}.json`);

  // Add metadata
  const mappingWithMetadata = {
    _comment: category === 'certificates'
      ? 'Certificate products mapping - SKU to Bitrix Product ID'
      : `Products ${category} category mapping - SKU to Bitrix Product ID`,
    _updated: new Date().toISOString().split('T')[0],
    ...mapping
  };

  try {
    writeFileSync(filePath, JSON.stringify(mappingWithMetadata, null, 2), 'utf-8');
    console.log(`[MAPPING UTILS] ✅ Saved mapping to ${category}.json`);
  } catch (error) {
    console.error(`[MAPPING UTILS] ❌ Error saving mapping ${category}:`, error);
    throw error;
  }
}

/**
 * Add or update SKU mapping in category file
 * @param {string} sku - SKU
 * @param {number} productId - Bitrix Product ID
 */
export function updateSkuMapping(sku, productId) {
  const category = getCategoryByHandle(sku);
  if (!category) {
    console.warn(`[MAPPING UTILS] Cannot determine category for SKU: ${sku}`);
    return;
  }

  const mapping = loadCategoryMapping(category);
  mapping[sku] = productId;
  saveCategoryMapping(category, mapping);

  console.log(`[MAPPING UTILS] ✅ Updated mapping: ${sku} -> ${productId} in ${category}`);
}

/**
 * Update mapping for a given SKU without logging (used in bulk refresh)
 * @param {string} sku
 * @param {number} productId
 */
export function updateSkuMappingSilent(sku, productId) {
  const category = getCategoryByHandle(sku);
  if (!category) {
    return;
  }
  const mapping = loadCategoryMapping(category);
  mapping[sku] = productId;
  saveCategoryMapping(category, mapping);
}

/**
 * Add or update variant_id mapping in category file
 * @param {string|number} variant_id - Shopify variant_id
 * @param {number} productId - Bitrix Product ID
 */
export function updateVariantIdMapping(variant_id, productId) {
  const variantIdStr = String(variant_id);
  // Use first character of variant_id to determine category (fallback to category-a-f)
  const category = getCategoryByHandle(variantIdStr) || 'category-a-f';

  const mapping = loadCategoryMapping(category);
  mapping[variantIdStr] = productId;
  saveCategoryMapping(category, mapping);

  console.log(`[MAPPING UTILS] ✅ Updated variant_id mapping: ${variantIdStr} -> ${productId} in ${category}`);
}

/**
 * Find Product ID by variant_id (Shopify unique identifier) using hybrid approach (cache + Bitrix API)
 * @param {string|number} variant_id - Shopify variant_id to find
 * @returns {Promise<number|null>} Product ID or null if not found
 */
export async function findProductIdByVariantId(variant_id) {
  if (!variant_id) {
    return null;
  }

  const variantIdStr = String(variant_id);

  // 1. Try cache first (fast) - check variant_id mapping
  const category = getCategoryByHandle(variantIdStr);
  if (category) {
    const mapping = loadCategoryMapping(category);
    if (mapping[variantIdStr]) {
      console.log(`[MAPPING UTILS] ✅ Found in cache: variant_id ${variantIdStr} -> ${mapping[variantIdStr]}`);
      return parseInt(mapping[variantIdStr]);
    }
  }

  // 2. Try all mappings (fallback)
  const allMappings = loadAllMappings();
  if (allMappings[variantIdStr]) {
    console.log(`[MAPPING UTILS] ✅ Found in all mappings: variant_id ${variantIdStr} -> ${allMappings[variantIdStr]}`);
    if (category) {
      updateVariantIdMapping(variantIdStr, allMappings[variantIdStr]);
    }
    return parseInt(allMappings[variantIdStr]);
  }

  // 3. Try Bitrix API (dynamic lookup by XML_ID = variant_id)
  try {
    console.log(`[MAPPING UTILS] 🔍 Searching in Bitrix API for variant_id: ${variantIdStr}`);
    const response = await callBitrix('crm.product.list', {
      filter: { XML_ID: variantIdStr },
      select: ['ID', 'NAME', 'CODE', 'XML_ID']
    });

    console.log(`[MAPPING UTILS] 📋 Bitrix API response for XML_ID="${variantIdStr}":`, JSON.stringify({
      hasResult: !!response.result,
      resultLength: response.result?.length || 0,
      result: response.result || null,
      error: response.error || null
    }, null, 2));

    if (response.result && response.result.length > 0) {
      const product = response.result[0];
      const productId = parseInt(product.ID);
      console.log(`[MAPPING UTILS] ✅ Found in Bitrix API: variant_id ${variantIdStr} -> ${productId}`);
      console.log(`[MAPPING UTILS]   Product details: ID=${productId}, NAME="${product.NAME}", CODE="${product.CODE}", XML_ID="${product.XML_ID}"`);

      // Update cache for future lookups
      if (category) {
        updateVariantIdMapping(variantIdStr, productId);
      }

      return productId;
    } else {
      console.warn(`[MAPPING UTILS] ⚠️ No products found in Bitrix with XML_ID="${variantIdStr}"`);
      console.warn(`[MAPPING UTILS]   Required: Product in Bitrix must have XML_ID field = "${variantIdStr}"`);
      if (response.error) {
        console.error(`[MAPPING UTILS]   Bitrix API error:`, response.error);
      }
    }
  } catch (error) {
    console.error(`[MAPPING UTILS] ❌ Error searching Bitrix API for variant_id ${variantIdStr}:`, error);
    console.error(`[MAPPING UTILS]   Error details:`, JSON.stringify(error, null, 2));
  }

  console.warn(`[MAPPING UTILS] ⚠️ Product not found for variant_id: ${variantIdStr}`);
  return null;
}

/**
 * Find Product ID by SKU using hybrid approach (cache + Bitrix API)
 * @param {string} sku - SKU to find
 * @returns {Promise<number|null>} Product ID or null if not found
 * @deprecated Use findProductIdByVariantId instead for new products
 */
export async function findProductIdBySku(sku) {
  if (!sku || typeof sku !== 'string') {
    return null;
  }

  // 1. Try cache first (fast)
  const category = getCategoryByHandle(sku);
  if (category) {
    const mapping = loadCategoryMapping(category);
    if (mapping[sku]) {
      console.log(`[MAPPING UTILS] ✅ Found in cache: ${sku} -> ${mapping[sku]}`);
      return parseInt(mapping[sku]);
    }
  }

  // 2. Try all mappings (fallback)
  const allMappings = loadAllMappings();
  if (allMappings[sku]) {
    console.log(`[MAPPING UTILS] ✅ Found in all mappings: ${sku} -> ${allMappings[sku]}`);
    // Update category-specific mapping for faster future lookups
    if (category) {
      updateSkuMapping(sku, allMappings[sku]);
    }
    return parseInt(allMappings[sku]);
  }

  // 3. Try Bitrix API (dynamic lookup by CODE = SKU)
  try {
    console.log(`[MAPPING UTILS] 🔍 Searching in Bitrix API for SKU: ${sku}`);
    const response = await callBitrix('crm.product.list', {
      filter: { CODE: sku },
      select: ['ID', 'NAME', 'CODE', 'XML_ID']
    });

    console.log(`[MAPPING UTILS] 📋 Bitrix API response for CODE="${sku}":`, JSON.stringify({
      hasResult: !!response.result,
      resultLength: response.result?.length || 0,
      result: response.result || null,
      error: response.error || null
    }, null, 2));

    if (response.result && response.result.length > 0) {
      const product = response.result[0];
      const productId = parseInt(product.ID);
      console.log(`[MAPPING UTILS] ✅ Found in Bitrix API: ${sku} -> ${productId}`);
      console.log(`[MAPPING UTILS]   Product details: ID=${productId}, NAME="${product.NAME}", CODE="${product.CODE}", XML_ID="${product.XML_ID}"`);

      // Update cache for future lookups
      if (category) {
        updateSkuMapping(sku, productId);
      }

      return productId;
    } else {
      console.warn(`[MAPPING UTILS] ⚠️ No products found in Bitrix with CODE="${sku}"`);
      console.warn(`[MAPPING UTILS]   Required: Product in Bitrix must have CODE field = "${sku}"`);
      if (response.error) {
        console.error(`[MAPPING UTILS]   Bitrix API error:`, response.error);
      }
    }
  } catch (error) {
    console.error(`[MAPPING UTILS] ❌ Error searching Bitrix API for ${sku}:`, error);
    console.error(`[MAPPING UTILS]   Error details:`, JSON.stringify(error, null, 2));
  }

  console.warn(`[MAPPING UTILS] ⚠️ Product not found for SKU: ${sku}`);
  return null;
}

