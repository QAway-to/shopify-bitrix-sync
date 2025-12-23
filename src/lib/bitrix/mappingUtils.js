/**
 * Mapping Utilities
 * Handles category-based SKU to Product ID mapping with hybrid approach (cache + Bitrix API)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { callBitrix } from './client.js';

// Get current directory in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mappings directory relative to this file
const MAPPINGS_DIR = join(__dirname, 'mappings');

// Ensure mappings directory exists
try {
  if (!existsSync(MAPPINGS_DIR)) {
    mkdirSync(MAPPINGS_DIR, { recursive: true });
  }
} catch (error) {
  console.warn(`[MAPPING UTILS] Could not create mappings directory: ${error.message}`);
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
 * Load mapping file for a category
 * @param {string} category - Category name
 * @returns {Object} Mapping object (SKU -> Product ID)
 */
export function loadCategoryMapping(category) {
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
 * Find Product ID by SKU using hybrid approach (cache + Bitrix API)
 * @param {string} sku - SKU to find
 * @returns {Promise<number|null>} Product ID or null if not found
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

  // 3. Try Bitrix API (dynamic lookup)
  try {
    console.log(`[MAPPING UTILS] 🔍 Searching in Bitrix API for SKU: ${sku}`);
    const response = await callBitrix('crm.product.list', {
      filter: { XML_ID: sku },
      select: ['ID', 'NAME', 'CODE', 'XML_ID']
    });

    if (response.result && response.result.length > 0) {
      const productId = parseInt(response.result[0].ID);
      console.log(`[MAPPING UTILS] ✅ Found in Bitrix API: ${sku} -> ${productId}`);
      
      // Update cache for future lookups
      if (category) {
        updateSkuMapping(sku, productId);
      }
      
      return productId;
    }
  } catch (error) {
    console.error(`[MAPPING UTILS] ❌ Error searching Bitrix API for ${sku}:`, error);
  }

  console.warn(`[MAPPING UTILS] ⚠️ Product not found for SKU: ${sku}`);
  return null;
}

