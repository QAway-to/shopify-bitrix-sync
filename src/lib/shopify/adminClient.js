/**
 * Shopify Admin API Client
 * Uses Shopify Admin API token for authenticated requests
 */

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_24_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN || '83bfa8-c4.myshopify.com';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';

const SHOPIFY_ADMIN_TOKEN_ENV_KEYS = [
  'SHOPIFY_24_ADMIN',
  'SHOPIFY_ADMIN_TOKEN',
  'SHOPIFY_ADMIN_API_ACCESS_TOKEN',
  'SHOPIFY_ACCESS_TOKEN',
  'SHOPIFY_TOKEN',
];

/**
 * Resolve Shopify Admin token from environment.
 * This intentionally supports multiple env var names because different deploy setups use different conventions.
 */
export function getShopifyAdminToken() {
  for (const key of SHOPIFY_ADMIN_TOKEN_ENV_KEYS) {
    const v = process.env[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function requireShopifyAdminToken() {
  const token = getShopifyAdminToken();
  if (!token) {
    throw new Error(
      `Shopify Admin token is not configured. Set one of: ${SHOPIFY_ADMIN_TOKEN_ENV_KEYS.join(', ')}`
    );
  }
  return token;
}

/**
 * Get Shopify Admin API base URL
 */
export function getShopifyAdminBase() {
  requireShopifyAdminToken();

  // Remove protocol if present, ensure it's just the domain
  const domain = SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');

  return `https://${domain}/admin/api/${SHOPIFY_API_VERSION}`;
}

/**
 * Make authenticated request to Shopify Admin API
 * @param {string} endpoint - API endpoint (e.g., '/orders.json')
 * @param {object} options - Fetch options (method, body, etc.)
 * @returns {Promise<object>} Response JSON
 */
export async function callShopifyAdmin(endpoint, options = {}) {
  const baseUrl = getShopifyAdminBase();
  const url = `${baseUrl}${endpoint}`;
  const token = requireShopifyAdminToken();

  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify Admin API error (${response.status}): ${errorText}`);
  }

  return await response.json();
}

/**
 * Get order by ID from Shopify Admin API
 * @param {string|number} orderId - Shopify order ID
 * @returns {Promise<object>} Order object
 */
export async function getOrder(orderId) {
  const response = await callShopifyAdmin(`/orders/${orderId}.json`);
  return response.order;
}

/**
 * Update order in Shopify (if needed in future)
 * @param {string|number} orderId - Shopify order ID
 * @param {object} orderData - Order data to update
 * @returns {Promise<object>} Updated order
 */
export async function updateOrder(orderId, orderData) {
  const response = await callShopifyAdmin(`/orders/${orderId}.json`, {
    method: 'PUT',
    body: JSON.stringify({ order: orderData }),
  });
  return response.order;
}

/**
 * Make GraphQL request to Shopify Admin API
 * @param {string} query - GraphQL query string
 * @param {object} variables - GraphQL variables (optional)
 * @returns {Promise<object>} GraphQL response data
 */
export async function callShopifyGraphQL(query, variables = {}) {
  const token = requireShopifyAdminToken();

  // GraphQL endpoint: https://{domain}/admin/api/{version}/graphql.json
  const domain = SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify GraphQL API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  // Check for GraphQL errors
  if (result.errors && result.errors.length > 0) {
    const errorMessages = result.errors.map(e => e.message).join('; ');
    throw new Error(`Shopify GraphQL errors: ${errorMessages}`);
  }

  return result.data;
}

/**
 * Find Shopify Variant by attributes (Brand, Model, Color, Size)
 * @param {object} params - { brand, model, color, size }
 * @returns {Promise<object|null>} Found variant or null
 */
export async function findShopifyVariantByAttributes({ brand, model, color, size }) {
  if (!brand) return null;

  // 1. Search products by Vendor (Brand)
  // Note: Vendor search is exact match
  const queryParams = new URLSearchParams({
    vendor: brand,
    limit: '250', // Fetch enough items
    status: 'active' // Only active products
  });

  const productsResp = await callShopifyAdmin(`/products.json?${queryParams.toString()}`);
  const products = productsResp.products || [];

  if (products.length === 0) return null;

  // 2. Filter by Model (Title match)
  const modelLower = (model || '').toLowerCase();
  const matchedProducts = products.filter(p =>
    !model || p.title.toLowerCase().includes(modelLower)
  );

  if (matchedProducts.length === 0) return null;

  // 3. Search for matching variant in matched products
  const colorLower = (color || '').toLowerCase();
  const sizeLower = (size || '').toLowerCase();

  const candidates = [];

  for (const product of matchedProducts) {
    for (const variant of product.variants) {
      // Check options
      const options = [
        (variant.option1 || '').toLowerCase(),
        (variant.option2 || '').toLowerCase(),
        (variant.option3 || '').toLowerCase()
      ];

      // Flexible matching for Color/Size in options
      const hasColor = !color || options.some(opt => opt.includes(colorLower) || colorLower.includes(opt));
      const hasSize = !size || options.some(opt => opt === sizeLower); // Size should be exact ideally

      if (hasColor && hasSize) {
        candidates.push({ variant, product });
      }
    }
  }

  // Return only if Unique match found
  if (candidates.length === 1) {
    return candidates[0].variant;
  }

  if (candidates.length > 1) {
    console.warn(`[Shopify Search] Ambiguous match: found ${candidates.length} variants for ${brand} ${model} ${color} ${size}`);
    return null;
  }

  return null;
}

/**
 * Create a pending Shopify Order for Pre-order
 * @param {number|string} variantId - Variant to order
 * @param {number|string} bitrixDealId - Source Deal ID
 * @returns {Promise<object>} Created order
 */
export async function createShopifyOrderForPreorder(variantId, bitrixDealId) {
  const orderData = {
    line_items: [
      {
        variant_id: Number(variantId),
        quantity: 1
      }
    ],
    financial_status: 'pending',
    tags: 'Bitrix Pre-order',
    note: `Created from Bitrix Deal #${bitrixDealId}`,
    // inventory_behaviour: 'decrement_obeying_policy' is default for REST API unless specified otherwise?
    // Actually, explicit property name logic might vary. 
    // For REST API orders/create: 'inventory_behaviour' is NOT a standard property in order object structure directly?
    // It's usually automatic for line items.
    // Ensure we trigger inventory claim.
  };

  const response = await callShopifyAdmin('/orders.json', {
    method: 'POST',
    body: JSON.stringify({ order: orderData })
  });

  return response.order;
}

/**
 * Smart Search for Shopify Variant (Robust 'q' param search)
 * Matches the logic of the proven Python script.
 */
export async function findShopifyVariantSmart({ brand, model, color, size }) {
  if (!brand || !model || !size) return null;

  // Use 'q' parameter for smart search: vendor:{brand} {model}
  const query = `vendor:${brand} ${model}`;
  const queryParams = new URLSearchParams({
    q: query,
    limit: '50',
    status: 'active'
  });

  console.log(`[Shopify Smart Search] Query: ${query}`);
  const productsResp = await callShopifyAdmin(`/products.json?${queryParams.toString()}`);
  const products = productsResp.products || [];

  if (products.length === 0) return null;

  const brandLower = brand.toLowerCase();
  const sizeLower = size.toLowerCase();
  const colorLower = (color || '').toLowerCase();

  for (const product of products) {
    // Double check vendor (case insensitive)
    if ((product.vendor || '').toLowerCase() !== brandLower) continue;

    // Search variants for size
    for (const variant of product.variants) {
      const options = [
        (variant.option1 || '').toLowerCase(),
        (variant.option2 || '').toLowerCase(),
        (variant.option3 || '').toLowerCase()
      ];

      // Check if Size matches any option
      if (options.includes(sizeLower)) {
        // Optional Color Check
        if (color) {
          const hasColor = options.some(opt => opt.includes(colorLower) || colorLower.includes(opt));
          if (!hasColor) continue;
        }
        return variant;
      }
    }
  }
  return null;
}

