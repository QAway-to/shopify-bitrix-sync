/**
 * Shopify Order Operations
 * Handles creation of orders from Bitrix deals
 */

import { callShopifyGraphQL } from './adminClient.js';
import { getVariantIdsBySkus } from './hold.js';

/**
 * Create order in Shopify from Bitrix deal
 * @param {Array<{sku: string, qty: number}>} items - Array of items with SKU and quantity
 * @param {string} dealId - Bitrix deal ID
 * @param {string} correlationId - Correlation ID for tracking (optional)
 * @returns {Promise<Object>} Created order data
 */
export async function createOrderFromBitrix(items, dealId, correlationId = null) {
  if (!items || items.length === 0) {
    throw new Error('Items array is required and cannot be empty');
  }

  if (!dealId) {
    throw new Error('Deal ID is required');
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

  // Build tags: ["TECH", "BITRIX", dealId]
  // TECH tag indicates this is a technical order
  const tags = ['TECH', 'BITRIX'];
  if (dealId) {
    tags.push(`BITRIX:${dealId}`);
  }
  if (correlationId) {
    tags.push(`CORR:${correlationId}`);
  }

  // Build note with technical order information
  const note = `Технический ордер из Bitrix. Сделка: ${dealId}${correlationId ? `. CorrelationId: ${correlationId}` : ''}`;

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
      lineItems: order.lineItems?.edges?.map(e => e.node) || [],
      tags: order.tags || [],
      note: order.note || ''
    };
  } catch (error) {
    return {
      success: false,
      error: 'ORDER_CREATE_ERROR',
      message: error.message
    };
  }
}

