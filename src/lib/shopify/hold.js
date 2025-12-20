/**
 * Shopify Hold Order Operations
 * Handles creation of hold orders with product reservation
 */

import { callShopifyGraphQL } from './adminClient.js';

/**
 * Get variant IDs by SKUs using GraphQL query
 * @param {string[]} skus - Array of SKU strings
 * @returns {Promise<Map<string, string>>} Map of SKU -> variantId
 */
export async function getVariantIdsBySkus(skus) {
  if (!skus || skus.length === 0) {
    return new Map();
  }

  const skuToVariantId = new Map();

  // Shopify GraphQL query syntax: "sku:SKU1 OR sku:SKU2 OR sku:SKU3"
  const skuQueries = skus.map(sku => `sku:${sku}`).join(' OR ');
  
  const query = `
    query getVariantsBySkus($query: String!) {
      productVariants(first: 250, query: $query) {
        edges {
          node {
            id
            sku
          }
        }
      }
    }
  `;

  try {
    const data = await callShopifyGraphQL(query, {
      query: skuQueries
    });

    if (data?.productVariants?.edges) {
      for (const edge of data.productVariants.edges) {
        const variant = edge.node;
        if (variant.sku && variant.id) {
          // Extract numeric ID from "gid://shopify/ProductVariant/123456"
          const variantId = variant.id.split('/').pop();
          skuToVariantId.set(variant.sku, variantId);
        }
      }
    }

    // Log if some SKUs were not found
    const foundSkus = Array.from(skuToVariantId.keys());
    const missingSkus = skus.filter(sku => !foundSkus.includes(sku));
    if (missingSkus.length > 0) {
      console.warn(`[HOLD] Some SKUs not found: ${missingSkus.join(', ')}`);
    }

    return skuToVariantId;
  } catch (error) {
    throw new Error(`Failed to get variant IDs by SKUs: ${error.message}`);
  }
}

/**
 * Create hold order in Shopify using GraphQL mutation
 * @param {Array<{sku: string, qty: number}>} items - Array of items with SKU and quantity
 * @param {string} correlationId - Correlation ID for tracking
 * @param {string} payloadHash - Payload hash for loop guard
 * @returns {Promise<Object>} Created order data
 */
export async function createHoldOrder(items, correlationId, payloadHash) {
  if (!items || items.length === 0) {
    throw new Error('Items array is required and cannot be empty');
  }

  // Step 1: Get variant IDs for all SKUs
  const skus = items.map(item => item.sku);
  const variantIdMap = await getVariantIdsBySkus(skus);

  // Build line items with variant IDs
  const lineItems = [];
  for (const item of items) {
    const variantId = variantIdMap.get(item.sku);
    if (!variantId) {
      throw new Error(`Variant ID not found for SKU: ${item.sku}`);
    }

    // GraphQL requires variant ID in format "gid://shopify/ProductVariant/{id}"
    lineItems.push({
      variantId: `gid://shopify/ProductVariant/${variantId}`,
      quantity: item.qty
    });
  }

  // Build tags: ["MW:HOLD", "TECH", payloadHash]
  const tags = ['MW:HOLD', 'TECH'];
  if (payloadHash) {
    tags.push(`MW:HASH:${payloadHash}`);
  }

  // Build note with correlationId and payloadHash
  const note = `CorrelationId: ${correlationId}${payloadHash ? `, PayloadHash: ${payloadHash}` : ''}`;

  const mutation = `
    mutation orderCreate($input: OrderInput!) {
      orderCreate(input: $input) {
        order {
          id
          name
          legacyResourceId
          confirmed
          tags
          note
          lineItems(first: 250) {
            edges {
              node {
                id
                title
                variant {
                  id
                  sku
                }
                quantity
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      lineItems: lineItems,
      inventoryBehavior: 'DECREMENT_OBEYING_POLICY', // Reserve inventory
      tags: tags,
      note: note
    }
  };

  try {
    const data = await callShopifyGraphQL(mutation, variables);

    if (!data?.orderCreate) {
      throw new Error('Invalid GraphQL response: orderCreate is missing');
    }

    const { order, userErrors } = data.orderCreate;

    // Check for user errors (business logic errors from Shopify)
    if (userErrors && userErrors.length > 0) {
      const errorMessages = userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify orderCreate userErrors: ${errorMessages}`);
    }

    if (!order) {
      throw new Error('Order creation failed: order is null');
    }

    // Extract numeric order ID from GraphQL ID
    const orderId = order.legacyResourceId || order.id.split('/').pop();

    return {
      success: true,
      order: order,
      orderId: orderId,
      orderName: order.name,
      lineItems: order.lineItems?.edges?.map(e => e.node) || []
    };
  } catch (error) {
    return {
      success: false,
      error: 'HOLD_ORDER_CREATE_ERROR',
      message: error.message
    };
  }
}

