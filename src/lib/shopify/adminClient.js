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
 * Find Shopify variant by attributes (Brand, Model, Color, Size)
 * @param {Object} criteria
 * @param {string} criteria.brand - Vendor
 * @param {string} criteria.model - Part of Title
 * @param {string} criteria.color - Option value
 * @param {string} criteria.size - Option value
 * @returns {Promise<Object|null>} Found variant or null
 */
export async function findShopifyVariantByAttributes({ brand, model, color, size }) {
  // Search products by Vendor and Title query
  // We use GraphQL for flexible search
  const query = `
    query searchProducts($query: String!) {
      products(first: 10, query: $query) {
        nodes {
          id
          title
          vendor
          variants(first: 20) {
            nodes {
              id
              title
              sku
              price
              inventoryQuantity
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
    }
  `;

  // Construct search query
  // vendor:Brand AND title:Model
  // Note: Model might be fuzzy, so we might just search title:*Model*
  const searchQuery = `vendor:'${brand}' AND title:*${model}*`;

  try {
    const data = await callShopifyGraphQL(query, { query: searchQuery });
    const products = data?.products?.nodes || [];

    // Filter variants manually
    const candidates = [];

    for (const product of products) {
      for (const variant of product.variants.nodes) {
        // Check options
        // Shopify options are just Name/Value pairs. We need to match Color and Size loosely.
        const options = variant.selectedOptions;

        const hasColor = options.some(o =>
          (o.name.toLowerCase().includes('color') || o.name.toLowerCase().includes('цвет') || o.name.toLowerCase().includes('colour')) &&
          o.value.toLowerCase().includes(color.toLowerCase())
        );

        const hasSize = options.some(o =>
          (o.name.toLowerCase().includes('size') || o.name.toLowerCase().includes('размер')) &&
          o.value.toLowerCase().trim() === size.toLowerCase().trim()
        );

        if (hasColor && hasSize) {
          candidates.push({
            productTitle: product.title,
            variantTitle: variant.title,
            vendor: product.vendor,
            variant
          });
        }
      }
    }

    if (candidates.length === 1) {
      return candidates[0]; // Return { variant, productTitle, vendor }
    } else if (candidates.length > 1) {
      console.warn(`[FIND VARIANT] Ambiguous result: found ${candidates.length} variants for ${brand} ${model} ${color} ${size}`);
      // return first one? No, safer to return null.
      return null;
    }

    return null;
  } catch (error) {
    console.error(`[FIND VARIANT] Error searching Shopify: ${error.message}`);
    throw error;
  }
}

/**
 * Create a pending order in Shopify for Pre-order
 * @param {string} variantGraphQLId - Variant ID (gid://...)
 * @param {Object} options - extra fields (dealId, etc.)
 */
export async function createShopifyOrderForPreorder(variantGraphQLId, options = {}) {
  // Convert GID to numeric ID if needed (REST API often takes numeric, but variant_id can handle string sometimes?)
  // Actually REST API needs numeric variant_id usually.
  const variantId = variantGraphQLId.split('/').pop();

  const orderData = {
    line_items: [
      {
        variant_id: Number(variantId),
        quantity: 1
      }
    ],
    financial_status: 'pending',
    tags: `Bitrix Pre-order, BITRIX:${options.dealId || ''}`,
    note: `Pre-order from Bitrix Deal #${options.dealId || ''}`,
  };

  if (options.customerId) {
    orderData.customer = { id: options.customerId };
  } else if (options.email) {
    orderData.email = options.email;
  }

  const response = await callShopifyAdmin('/orders.json', {
    method: 'POST',
    body: JSON.stringify({ order: orderData })
  });

  return response.order;
}

