/**
 * Shopify Inventory Operations
 * Handles fetching product variants and inventory quantities from Shopify
 */

import { getShopifyAdminBase } from './adminClient.js';

/**
 * Get product variants with inventory by product title
 * @param {string} productTitle - Exact product title (e.g., "E-Certificate")
 * @returns {Promise<Array>} Array of variants with inventory data
 */
export async function getProductVariantsByTitle(productTitle) {
  if (!productTitle || typeof productTitle !== 'string') {
    throw new Error('Product title is required');
  }

  const allVariants = [];
  let pageInfo = null;
  let hasNextPage = true;

  try {
    while (hasNextPage) {
      // Build URL with query params
      const baseUrl = getShopifyAdminBase();
      const url = new URL(`${baseUrl}/products.json`);
      url.searchParams.append('limit', '50');
      url.searchParams.append('title', productTitle.trim());

      // Add pagination if we have page info
      if (pageInfo) {
        url.searchParams.append('page_info', pageInfo);
      }

      const fetchResponse = await fetch(url.toString(), {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_24_ADMIN,
          'Content-Type': 'application/json'
        }
      });

      if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text();
        throw new Error(`Shopify API error (${fetchResponse.status}): ${errorText}`);
      }

      const data = await fetchResponse.json();
      const products = data.products || [];

      // Filter by exact title match (API uses "contains" search)
      const matchingProducts = products.filter(p => p.title.trim() === productTitle.trim());

      for (const product of matchingProducts) {
        for (const variant of product.variants || []) {
          allVariants.push({
            product_id: product.id,
            product_handle: product.handle,
            product_title: product.title,
            variant_id: variant.id,
            variant_title: variant.title || '',
            sku: variant.sku || null,
            price: variant.price || '0.00',
            inventory_quantity: variant.inventory_quantity || 0,
            inventory_item_id: variant.inventory_item_id || null
          });
        }
      }

      // Check for pagination
      const linkHeader = fetchResponse.headers.get('Link');
      hasNextPage = false;
      pageInfo = null;

      if (linkHeader) {
        const links = linkHeader.split(', ');
        for (const link of links) {
          if (link.includes('rel="next"')) {
            const urlMatch = link.match(/<([^>]+)>/);
            if (urlMatch) {
              const nextUrl = new URL(urlMatch[1]);
              pageInfo = nextUrl.searchParams.get('page_info');
              hasNextPage = !!pageInfo;
            }
          }
        }
      }

      // If no Link header, check if we got less than limit (last page)
      if (!hasNextPage && products.length < 50) {
        hasNextPage = false;
      }

      // Rate limiting: wait a bit between requests
      if (hasNextPage) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    return allVariants;
  } catch (error) {
    console.error(`[SHOPIFY INVENTORY] Error fetching variants for "${productTitle}":`, error);
    throw error;
  }
}

/**
 * Get product variants by handle (more reliable than title)
 * @param {string} handle - Product handle (e.g., "e-certificate")
 * @returns {Promise<Array>} Array of variants with inventory data
 */
export async function getProductVariantsByHandle(handle) {
  if (!handle || typeof handle !== 'string') {
    throw new Error('Product handle is required');
  }

  try {
    // Use REST API with handle filter
    // Build URL with query params manually since callShopifyAdmin doesn't support query params
    const baseUrl = getShopifyAdminBase();
    const url = new URL(`${baseUrl}/products.json`);
    url.searchParams.append('handle', handle);

    const fetchResponse = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_24_ADMIN,
        'Content-Type': 'application/json'
      }
    });

    if (!fetchResponse.ok) {
      const errorText = await fetchResponse.text();
      throw new Error(`Shopify API error (${fetchResponse.status}): ${errorText}`);
    }

    const response = await fetchResponse.json();
    const products = response.products || [];
    const allVariants = [];

    for (const product of products) {
      // Double-check handle match (API uses "contains" search)
      if (product.handle !== handle) {
        continue;
      }

      for (const variant of product.variants || []) {
        allVariants.push({
          product_id: product.id,
          product_handle: product.handle,
          product_title: product.title,
          variant_id: variant.id,
          variant_title: variant.title || '',
          sku: variant.sku || null,
          price: variant.price || '0.00',
          inventory_quantity: variant.inventory_quantity || 0,
          inventory_item_id: variant.inventory_item_id || null
        });
      }
    }

    return allVariants;
  } catch (error) {
    console.error(`[SHOPIFY INVENTORY] Error fetching variants for handle "${handle}":`, error);
    throw error;
  }
}

/**
 * Get certificates data (all 3 certificate types)
 * @returns {Promise<Object>} Object with certificate data by handle
 */
export async function getCertificatesData() {
  const certificateHandles = [
    'e-certificate',
    'gift-certificate-fbfc',
    'printed-gift-certificate'
  ];

  const certificatesData = {};

  for (const handle of certificateHandles) {
    try {
      console.log(`[SHOPIFY INVENTORY] Fetching variants for handle: ${handle}`);
      const variants = await getProductVariantsByHandle(handle);
      certificatesData[handle] = variants;
      console.log(`[SHOPIFY INVENTORY] Found ${variants.length} variants for ${handle}`);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.error(`[SHOPIFY INVENTORY] Failed to fetch ${handle}:`, error);
      certificatesData[handle] = [];
    }
  }

  return certificatesData;
}

