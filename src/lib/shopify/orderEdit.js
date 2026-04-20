/**
 * Shopify Order Edit Operations
 * Handles order editing operations: add position, increment/decrement quantity
 * Uses GraphQL orderEdit API (orderEditBegin → orderEditAddVariant/orderEditSetQuantity → orderEditCommit)
 */

import { callShopifyGraphQL } from './adminClient.js';
import { getVariantIdsBySkus } from './hold.js';
import { logger } from '../logging/logger.js';

/**
 * Begin order edit session
 * @param {string|number} orderId - Shopify order ID
 * @returns {Promise<Object>} Calculated order with line items
 */
export async function beginOrderEdit(orderId) {
  const orderGid = `gid://shopify/Order/${orderId}`;
  
  const mutation = `
    mutation orderEditBegin($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder {
          id
          lineItems(first: 250) {
            edges {
              node {
                id
                quantity
                variant {
                  id
                  legacyResourceId
                  sku
                }
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

  try {
    const data = await callShopifyGraphQL(mutation, { id: orderGid });
    
    if (!data?.orderEditBegin) {
      throw new Error('Invalid GraphQL response: orderEditBegin is missing');
    }

    const { calculatedOrder, userErrors } = data.orderEditBegin;

    if (userErrors && userErrors.length > 0) {
      const errorMessages = userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify orderEditBegin userErrors: ${errorMessages}`);
    }

    if (!calculatedOrder) {
      throw new Error('Order edit session failed: calculatedOrder is null (order may be closed or fulfilled)');
    }

    logger.info('order_edit_begin', 'Order edit session started', { orderId });
    return {
      success: true,
      calculatedOrderId: calculatedOrder.id,
      lineItems: calculatedOrder.lineItems?.edges?.map(e => e.node) || []
    };
  } catch (error) {
    logger.error('order_edit_begin_error', 'Failed to begin order edit', { orderId, error: error.message });
    return {
      success: false,
      error: 'ORDER_EDIT_BEGIN_ERROR',
      message: error.message
    };
  }
}

/**
 * Add variant to order edit session
 * @param {string} calculatedOrderId - Calculated order ID from orderEditBegin
 * @param {string|number} variantId - Shopify variant ID
 * @param {number} quantity - Quantity to add
 * @returns {Promise<Object>} Result
 */
async function addVariantToEdit(calculatedOrderId, variantId, quantity) {
  const variantGid = `gid://shopify/ProductVariant/${variantId}`;
  
  const mutation = `
    mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
      orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const data = await callShopifyGraphQL(mutation, {
      id: calculatedOrderId,
      variantId: variantGid,
      quantity: quantity
    });

    if (!data?.orderEditAddVariant) {
      throw new Error('Invalid GraphQL response: orderEditAddVariant is missing');
    }

    const { userErrors } = data.orderEditAddVariant;

    if (userErrors && userErrors.length > 0) {
      const errorMessages = userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify orderEditAddVariant userErrors: ${errorMessages}`);
    }

    logger.info('order_edit_add_variant', 'Variant added to order edit', { calculatedOrderId, variantId, quantity });
    return { success: true };
  } catch (error) {
    logger.error('order_edit_add_variant_error', 'Failed to add variant to order edit', { calculatedOrderId, variantId, quantity, error: error.message });
    return {
      success: false,
      error: 'ORDER_EDIT_ADD_VARIANT_ERROR',
      message: error.message
    };
  }
}

/**
 * Set quantity for line item in order edit session
 * @param {string} calculatedOrderId - Calculated order ID from orderEditBegin
 * @param {string} lineItemId - Line item ID from calculated order
 * @param {number} quantity - New quantity
 * @returns {Promise<Object>} Result
 */
export async function setLineItemQuantity(calculatedOrderId, lineItemId, quantity) {
  const mutation = `
    mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
      orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const data = await callShopifyGraphQL(mutation, {
      id: calculatedOrderId,
      lineItemId: lineItemId,
      quantity: quantity
    });

    if (!data?.orderEditSetQuantity) {
      throw new Error('Invalid GraphQL response: orderEditSetQuantity is missing');
    }

    const { userErrors } = data.orderEditSetQuantity;

    if (userErrors && userErrors.length > 0) {
      const errorMessages = userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify orderEditSetQuantity userErrors: ${errorMessages}`);
    }

    logger.info('order_edit_set_quantity', 'Line item quantity set', { calculatedOrderId, lineItemId, quantity });
    return { success: true };
  } catch (error) {
    logger.error('order_edit_set_quantity_error', 'Failed to set line item quantity', { calculatedOrderId, lineItemId, quantity, error: error.message });
    return {
      success: false,
      error: 'ORDER_EDIT_SET_QUANTITY_ERROR',
      message: error.message
    };
  }
}

/**
 * Commit order edit session
 * @param {string} calculatedOrderId - Calculated order ID from orderEditBegin
 * @returns {Promise<Object>} Updated order data
 */
export async function commitOrderEdit(calculatedOrderId) {
  const mutation = `
    mutation orderEditCommit($id: ID!) {
      orderEditCommit(id: $id) {
        order {
          id
          name
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalReceivedSet {
            shopMoney {
              amount
              currencyCode
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

  try {
    const data = await callShopifyGraphQL(mutation, { id: calculatedOrderId });

    if (!data?.orderEditCommit) {
      throw new Error('Invalid GraphQL response: orderEditCommit is missing');
    }

    const { order, userErrors } = data.orderEditCommit;

    if (userErrors && userErrors.length > 0) {
      const errorMessages = userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify orderEditCommit userErrors: ${errorMessages}`);
    }

    if (!order) {
      throw new Error('Order edit commit failed: order is null');
    }

    // Extract numeric order ID
    const orderId = order.id.split('/').pop();

    logger.info('order_edit_commit', 'Order edit committed', { calculatedOrderId, orderId, orderName: order.name });
    return {
      success: true,
      orderId: orderId,
      orderName: order.name,
      totalPrice: parseFloat(order.totalPriceSet?.shopMoney?.amount || 0),
      totalReceived: parseFloat(order.totalReceivedSet?.shopMoney?.amount || 0),
      currencyCode: order.totalPriceSet?.shopMoney?.currencyCode || 'EUR'
    };
  } catch (error) {
    logger.error('order_edit_commit_error', 'Failed to commit order edit', { calculatedOrderId, error: error.message });
    return {
      success: false,
      error: 'ORDER_EDIT_COMMIT_ERROR',
      message: error.message
    };
  }
}

/**
 * Add new position to order
 * @param {string|number} orderId - Shopify order ID
 * @param {string|number} variantId - Shopify variant ID (or SKU to resolve)
 * @param {number} quantity - Quantity to add
 * @returns {Promise<Object>} Result with updated order data
 */
export async function addPositionToOrder(orderId, variantId, quantity) {
  if (!orderId) {
    logger.warn('add_position_validation_error', 'addPositionToOrder called without orderId', {});
    return {
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'Order ID is required'
    };
  }

  if (!variantId) {
    logger.warn('add_position_validation_error', 'addPositionToOrder called without variantId', { orderId });
    return {
      success: false,
      error: 'MISSING_VARIANT_ID',
      message: 'Variant ID or SKU is required'
    };
  }

  if (!quantity || quantity <= 0) {
    logger.warn('add_position_validation_error', 'addPositionToOrder called with invalid quantity', { orderId, variantId, quantity });
    return {
      success: false,
      error: 'INVALID_QUANTITY',
      message: 'Quantity must be greater than 0'
    };
  }

  try {
    // Resolve SKU to variantId if needed
    let resolvedVariantId = variantId;
    if (typeof variantId === 'string' && !variantId.match(/^\d+$/)) {
      // Assume it's a SKU, resolve to variantId
      const variantIdMap = await getVariantIdsBySkus([variantId]);
      resolvedVariantId = variantIdMap.get(variantId);
      
      if (!resolvedVariantId) {
        return {
          success: false,
          error: 'VARIANT_NOT_FOUND',
          message: `Variant ID not found for SKU: ${variantId}`
        };
      }
    }

    // Step 1: Begin edit session
    const beginResult = await beginOrderEdit(orderId);
    if (!beginResult.success) {
      return beginResult;
    }

    const { calculatedOrderId } = beginResult;

    // Step 2: Add variant
    const addResult = await addVariantToEdit(calculatedOrderId, resolvedVariantId, quantity);
    if (!addResult.success) {
      return addResult;
    }

    // Step 3: Commit changes
    const commitResult = await commitOrderEdit(calculatedOrderId);
    return commitResult;
  } catch (error) {
    logger.error('add_position_error', 'Failed to add position to order', { orderId, variantId, quantity, error: error.message });
    return {
      success: false,
      error: 'ADD_POSITION_ERROR',
      message: error.message
    };
  }
}

/**
 * Increment quantity for line item by SKU
 * @param {string|number} orderId - Shopify order ID
 * @param {string} sku - SKU of the product to increment
 * @param {number} quantityToAdd - Quantity to add (will be added to current quantity)
 * @returns {Promise<Object>} Result with updated order data
 */
export async function incrementLineItemQuantity(orderId, sku, quantityToAdd) {
  if (!orderId) {
    return {
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'Order ID is required'
    };
  }

  if (!sku) {
    return {
      success: false,
      error: 'MISSING_SKU',
      message: 'SKU is required'
    };
  }

  if (!quantityToAdd || quantityToAdd <= 0) {
    return {
      success: false,
      error: 'INVALID_QUANTITY',
      message: 'Quantity to add must be greater than 0'
    };
  }

  try {
    // Step 1: Begin edit session
    const beginResult = await beginOrderEdit(orderId);
    if (!beginResult.success) {
      return beginResult;
    }

    const { calculatedOrderId, lineItems } = beginResult;

    // Step 2: Find line item by SKU
    const targetLineItem = lineItems.find(item => 
      item.variant && item.variant.sku === sku
    );

    if (!targetLineItem) {
      logger.warn('increment_line_item_not_found', 'SKU not found in order for increment', { orderId, sku });
      return {
        success: false,
        error: 'LINE_ITEM_NOT_FOUND',
        message: `Line item with SKU ${sku} not found in order`
      };
    }

    // Step 3: Calculate new quantity
    const currentQuantity = targetLineItem.quantity || 0;
    const newQuantity = currentQuantity + quantityToAdd;

    // Step 4: Set new quantity
    const setResult = await setLineItemQuantity(
      calculatedOrderId,
      targetLineItem.id,
      newQuantity
    );
    if (!setResult.success) {
      return setResult;
    }

    // Step 5: Commit changes
    const commitResult = await commitOrderEdit(calculatedOrderId);
    return {
      ...commitResult,
      previousQuantity: currentQuantity,
      newQuantity: newQuantity
    };
  } catch (error) {
    logger.error('increment_quantity_error', 'Failed to increment line item quantity', { orderId, sku, quantityToAdd, error: error.message });
    return {
      success: false,
      error: 'INCREMENT_QUANTITY_ERROR',
      message: error.message
    };
  }
}

/**
 * Decrement quantity for line item by SKU
 * @param {string|number} orderId - Shopify order ID
 * @param {string} sku - SKU of the product to decrement
 * @param {number} newQuantity - New quantity (will replace current quantity)
 * @returns {Promise<Object>} Result with updated order data
 */
export async function decrementLineItemQuantity(orderId, sku, newQuantity) {
  if (!orderId) {
    return {
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'Order ID is required'
    };
  }

  if (!sku) {
    return {
      success: false,
      error: 'MISSING_SKU',
      message: 'SKU is required'
    };
  }

  if (newQuantity < 0) {
    return {
      success: false,
      error: 'INVALID_QUANTITY',
      message: 'New quantity cannot be negative'
    };
  }

  try {
    // Step 1: Begin edit session
    const beginResult = await beginOrderEdit(orderId);
    if (!beginResult.success) {
      return beginResult;
    }

    const { calculatedOrderId, lineItems } = beginResult;

    // Step 2: Find line item by SKU
    const targetLineItem = lineItems.find(item => 
      item.variant && item.variant.sku === sku
    );

    if (!targetLineItem) {
      logger.warn('decrement_line_item_not_found', 'SKU not found in order for decrement', { orderId, sku });
      return {
        success: false,
        error: 'LINE_ITEM_NOT_FOUND',
        message: `Line item with SKU ${sku} not found in order`
      };
    }

    const currentQuantity = targetLineItem.quantity || 0;

    // Step 3: Set new quantity
    const setResult = await setLineItemQuantity(
      calculatedOrderId,
      targetLineItem.id,
      newQuantity
    );
    if (!setResult.success) {
      return setResult;
    }

    // Step 4: Commit changes
    const commitResult = await commitOrderEdit(calculatedOrderId);
    return {
      ...commitResult,
      previousQuantity: currentQuantity,
      newQuantity: newQuantity
    };
  } catch (error) {
    logger.error('decrement_quantity_error', 'Failed to decrement line item quantity', { orderId, sku, newQuantity, error: error.message });
    return {
      success: false,
      error: 'DECREMENT_QUANTITY_ERROR',
      message: error.message
    };
  }
}

