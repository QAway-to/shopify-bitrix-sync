/**
 * Shopify Admin API Client
 * Authenticates via OAuth 2.0 client_credentials grant (Shopify Jan 2026+)
 */

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_24_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';

let _tokenCache = null;   // { accessToken: string, expiresAtMs: number }
let _inflightFetch = null; // Promise<string> | null

/**
 * Request a new access token from Shopify using client credentials.
 * Writes result to _tokenCache before returning. Always clears _inflightFetch.
 */
export async function getValidAccessToken() {
  const now = Date.now();
  if (_tokenCache && now < _tokenCache.expiresAtMs - 60 * 60 * 1000) {
    return _tokenCache.accessToken;
  }

  if (_inflightFetch) return _inflightFetch;

  _inflightFetch = (async () => {
    try {
      const clientId = process.env.SHOPIFY_CLIENT_ID;
      const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error('Shopify OAuth credentials not configured. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.');
      }

      const domain = SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });

      const body = await response.json();

      if (!response.ok || body.error) {
        throw new Error(`Shopify OAuth error: ${body.error || response.status}`);
      }

      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 86399;
      _tokenCache = {
        accessToken: body.access_token,
        expiresAtMs: Date.now() + expiresIn * 1000,
      };

      return _tokenCache.accessToken;
    } finally {
      _inflightFetch = null;
    }
  })();

  return _inflightFetch;
}

/**
 * Get Shopify Admin API base URL. Synchronous — validates env, no network I/O.
 */
export function getShopifyAdminBase() {
  if (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
    throw new Error('Shopify OAuth credentials not configured. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.');
  }

  const domain = SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${domain}/admin/api/${SHOPIFY_API_VERSION}`;
}

/**
 * Internal fetch wrapper: injects auth header, handles 401 with single retry.
 * @param {string} url
 * @param {object} fetchOptions
 * @param {boolean} retried - prevents infinite retry loop
 */
async function shopifyFetch(url, fetchOptions = {}, retried = false) {
  const token = await getValidAccessToken();

  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
    ...fetchOptions.headers,
  };

  const response = await fetch(url, { ...fetchOptions, headers });

  if (response.status === 401 && !retried) {
    _tokenCache = null;
    return shopifyFetch(url, fetchOptions, true);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Make authenticated request to Shopify Admin REST API.
 * @param {string} endpoint - e.g. '/orders.json'
 * @param {object} options - fetch options (method, body, etc.)
 */
export async function callShopifyAdmin(endpoint, options = {}) {
  const baseUrl = getShopifyAdminBase();
  return shopifyFetch(`${baseUrl}${endpoint}`, options);
}

/**
 * Make authenticated GraphQL request to Shopify Admin API.
 * @param {string} query
 * @param {object} variables
 */
export async function callShopifyGraphQL(query, variables = {}) {
  const domain = SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const result = await shopifyFetch(url, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });

  if (result.errors && result.errors.length > 0) {
    const errorMessages = result.errors.map(e => e.message).join('; ');
    throw new Error(`Shopify GraphQL errors: ${errorMessages}`);
  }

  return result.data;
}

/**
 * Get order by ID.
 * @param {string|number} orderId
 */
export async function getOrder(orderId) {
  const response = await callShopifyAdmin(`/orders/${orderId}.json`);
  return response.order;
}

/**
 * Update order in Shopify.
 * @param {string|number} orderId
 * @param {object} orderData
 */
export async function updateOrder(orderId, orderData) {
  const response = await callShopifyAdmin(`/orders/${orderId}.json`, {
    method: 'PUT',
    body: JSON.stringify({ order: orderData }),
  });
  return response.order;
}

/**
 * Find Shopify variant by brand, model, size.
 */
export async function findShopifyVariantByAttributes({ brand, model, size }) {
  try {
    const endpoint = `/products.json?limit=50&title=${encodeURIComponent(model)}`;
    const response = await callShopifyAdmin(endpoint);
    const products = response.products || [];

    const targetBrand = brand.toLowerCase().trim();
    const targetModel = model.toLowerCase().trim();
    const targetSize = String(size).toLowerCase().trim();

    for (const product of products) {
      const pTitle = product.title.toLowerCase();
      const pVendor = (product.vendor || '').toLowerCase();

      const brandMatch = pVendor.includes(targetBrand) || pTitle.includes(targetBrand);
      const modelMatch = pTitle.includes(targetModel);

      if (!brandMatch || !modelMatch) continue;

      for (const variant of product.variants) {
        const vOptions = [
          String(variant.option1 || '').toLowerCase().trim(),
          String(variant.option2 || '').toLowerCase().trim(),
          String(variant.option3 || '').toLowerCase().trim()
        ];

        if (vOptions.includes(targetSize)) {
          return formatVariantResult(variant, product);
        }

        if (vOptions.some(opt => opt && opt.includes(targetSize))) {
          return formatVariantResult(variant, product);
        }
      }
    }

    return null;
  } catch (error) {
    throw new Error(`Shopify variant search failed: ${error.message}`);
  }
}

function formatVariantResult(variant, product) {
  return {
    variant: {
      id: String(variant.id),
      title: variant.title,
      sku: variant.sku,
      price: variant.price,
      inventoryQuantity: variant.inventory_quantity,
      imageId: variant.image_id
    },
    productTitle: product.title,
    vendor: product.vendor,
    description: product.body_html,
    images: product.images || []
  };
}

/**
 * Create a pending order in Shopify for Pre-order.
 * @param {string} variantGraphQLId
 * @param {object} options - dealId, email, customer, customerId
 */
export async function createShopifyOrderForPreorder(variantGraphQLId, options = {}) {
  const variantId = variantGraphQLId.split('/').pop();

  const orderData = {
    line_items: [{ variant_id: Number(variantId), quantity: 1 }],
    financial_status: 'pending',
    tags: `Bitrix Pre-order, BITRIX:${options.dealId || ''}`,
    note: `Pre-order from Bitrix Deal #${options.dealId || ''}`,
  };

  if (options.customerId) {
    orderData.customer = { id: options.customerId };
  } else if (options.email) {
    orderData.email = options.email;
  }

  const customer = options.customer || {};
  const addressObj = {
    first_name: customer.firstName || 'Preorder',
    last_name: customer.lastName || '',
    phone: customer.phone || '',
  };

  if (customer.address) {
    addressObj.address1 = customer.address.address1 || '';
    addressObj.address2 = customer.address.address2 || '';
    addressObj.city = customer.address.city || '';
    addressObj.zip = customer.address.zip || '';
    addressObj.province = customer.address.province || '';
    addressObj.country = customer.address.country || '';
  }

  orderData.shipping_address = addressObj;
  orderData.billing_address = addressObj;

  const response = await callShopifyAdmin('/orders.json', {
    method: 'POST',
    body: JSON.stringify({ order: orderData }),
  });

  return response.order;
}
