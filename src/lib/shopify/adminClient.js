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
 * @param {string} criteria.size - Option value
 * @returns {Promise<Object|null>} Found variant or null
 */
export async function findShopifyVariantByAttributes({ brand, model, size }) {
  // Use REST API logic EXACTLY matching user's robust Python script
  // 1. Fetch products by Vendor (limit 50)
  // 2. Filter Client-side: Title must contain Model
  // 3. Variant Check: Size must be in [option1, option2, option3]
  try {
    const endpoint = `/products.json?limit=50&vendor=${encodeURIComponent(brand)}`;
    const response = await callShopifyAdmin(endpoint);
    const products = response.products || [];

    // Debug: Log what we're searching for and what we found
    console.log(JSON.stringify({
      event: 'FIND_VARIANT_DEBUG',
      searchCriteria: { brand, model, size },
      productsFound: products.length,
      productTitles: products.slice(0, 5).map(p => ({ title: p.title, vendor: p.vendor })),
      timestamp: new Date().toISOString()
    }));

    for (const product of products) {
      // 1. Strict Brand Check (case-insensitive)
      if (product.vendor.toLowerCase() !== brand.toLowerCase()) continue;

      // 2. Model Check (Title must contain model)
      if (!product.title.toLowerCase().includes(model.toLowerCase())) continue;

      // 3. Variant Check (Size must match one of the option values exactly)
      for (const variant of product.variants) {
        // Collect all option values (option1, option2, option3)
        const variantValues = [
          variant.option1,
          variant.option2,
          variant.option3
        ].map(v => v ? String(v).toLowerCase() : '');

        // Check if size is in the values (exact match)
        if (variantValues.includes(size.toLowerCase())) {
          // Found match!
          // Normalize structure to match expected format
          return {
            variant: {
              id: String(variant.id), // Ensure string ID
              title: variant.title,
              sku: variant.sku,
              price: variant.price,
              inventoryQuantity: variant.inventory_quantity,
              imageId: variant.image_id // Capture variant image ID
            },
            productTitle: product.title,
            vendor: product.vendor,
            description: product.body_html, // HTML Description
            images: product.images || [] // All images for fallback logic
          };
        }
      }
    }

    // No match found
    console.warn(`[FIND VARIANT] No match for ${brand} ${model} ${size} in ${products.length} products`);
    return null;
  } catch (error) {
    console.error(`[FIND VARIANT] Error searching Shopify (REST): ${error.message}`);
    throw error;
  }
}

/**
 * Create a pending order in Shopify for Pre-order
 * @param {string} variantGraphQLId - Variant ID (gid://...)
 * @param {Object} options - extra fields (dealId, email, customer, etc.)
 * @param {string} options.dealId - Bitrix deal ID
 * @param {string} options.email - Customer email
 * @param {Object} options.customer - Customer data { firstName, lastName, phone, address }
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

  // Customer handling
  if (options.customerId) {
    orderData.customer = { id: options.customerId };
  } else if (options.email) {
    orderData.email = options.email;
  }

  // ✅ Build shipping/billing address from customer data
  const customer = options.customer || {};
  if (customer.firstName || customer.lastName || customer.phone || customer.address) {
    const addressObj = {
      first_name: customer.firstName || '',
      last_name: customer.lastName || '',
      phone: customer.phone || '',
    };

    // Add address fields if present
    if (customer.address) {
      addressObj.address1 = customer.address.address1 || '';
      addressObj.address2 = customer.address.address2 || '';
      addressObj.city = customer.address.city || '';
      addressObj.zip = customer.address.zip || '';
      addressObj.province = customer.address.province || '';
      addressObj.country = customer.address.country || '';
    }

    // Set both shipping and billing address
    orderData.shipping_address = addressObj;
    orderData.billing_address = addressObj;
  }

  const response = await callShopifyAdmin('/orders.json', {
    method: 'POST',
    body: JSON.stringify({ order: orderData })
  });

  return response.order;
}

