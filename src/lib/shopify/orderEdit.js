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
                editableQuantity
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
      lineItems: calculatedOrder.lineItems?.edges?.map(e => e.node) || [],
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
 * Choose which of several matching line items to edit.
 *
 * An order can hold more than one line item for the same variant (prior Order Edit re-adds).
 * Picking by `quantity > 0` alone lands on line items whose fulfillment order is already
 * closed — `quantity` is the historical ordered amount, so a fully refunded/removed line
 * still reports a positive value. Editing one fails the whole session with
 * "Could not save the order edit". `editableQuantity` is the portion Shopify will actually
 * let us change, so prefer the largest editable line and fall back to the old behaviour only
 * when the field is absent.
 *
 * @param {Array} matches - calculated line items for one variant/SKU
 * @param {Object} logContext - included in the multi-line warning
 */
function pickEditableLineItem(matches, logContext = {}) {
  const editable = matches
    .filter(item => Number(item.editableQuantity ?? item.quantity ?? 0) > 0)
    .sort((a, b) => Number(b.editableQuantity ?? b.quantity ?? 0) - Number(a.editableQuantity ?? a.quantity ?? 0));

  if (editable.length > 1) {
    // Quantity is applied to a single line item, so spreading a target across several
    // editable duplicates would under-correct. Not observed in practice — log it so we
    // find out if it ever happens rather than silently syncing to a wrong total.
    logger.warn('order_edit_multiple_editable_lines', 'Variant has several editable line items — quantity applied to the largest only', {
      ...logContext,
      editableLineItems: editable.map(item => ({ id: item.id, quantity: item.quantity, editableQuantity: item.editableQuantity })),
    });
  }

  return editable[0]
    || matches.find(item => item.quantity > 0)
    || matches[0];
}

function findLineItemBySku(lineItems, sku, logContext = {}) {
  const matches = lineItems.filter(item => item.variant && item.variant.sku === sku);
  return pickEditableLineItem(matches, { ...logContext, sku });
}

function findLineItemByVariantId(lineItems, variantId, logContext = {}) {
  const id = String(variantId);
  const matches = lineItems.filter(item => item.variant && (item.variant.legacyResourceId === id || item.variant.id?.split('/').pop() === id));
  return pickEditableLineItem(matches, { ...logContext, variantId: id });
}

/**
 * Increment quantity for line item by SKU
 * @param {string|number} orderId - Shopify order ID
 * @param {string} sku - SKU of the product to increment
 * @param {number} quantityToAdd - Quantity to add (will be added to current quantity)
 * @returns {Promise<Object>} Result with updated order data
 */
export async function incrementLineItemQuantity(orderId, sku, quantityToAdd, variantId = null) {
  if (!orderId) {
    return {
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'Order ID is required'
    };
  }

  if (!sku && !variantId) {
    return {
      success: false,
      error: 'MISSING_SKU',
      message: 'SKU or variant ID is required'
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

    // Step 2: Find line item — variant_id first (handles empty-sku POS items), then SKU
    const targetLineItem = (variantId && findLineItemByVariantId(lineItems, variantId, { orderId }))
      || findLineItemBySku(lineItems, sku, { orderId });

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

    // Step 4: Set new quantity or re-add removed item
    let setResult;
    if (currentQuantity === 0) {
      const variantNumericId = targetLineItem.variant?.legacyResourceId
        || targetLineItem.variant?.id?.split('/').pop();

      if (!variantNumericId) {
        logger.warn('increment_line_item_no_variant', 'Cannot re-add removed line item: variant ID unavailable', { orderId, sku });
        return {
          success: false,
          error: 'LINE_ITEM_NO_VARIANT',
          message: `Cannot re-add SKU ${sku}: variant GID is null`
        };
      }

      setResult = await addVariantToEdit(calculatedOrderId, variantNumericId, quantityToAdd);
    } else {
      setResult = await setLineItemQuantity(calculatedOrderId, targetLineItem.id, newQuantity);
    }
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
export async function decrementLineItemQuantity(orderId, sku, newQuantity, variantId = null) {
  if (!orderId) {
    return {
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'Order ID is required'
    };
  }

  if (!sku && !variantId) {
    return {
      success: false,
      error: 'MISSING_SKU',
      message: 'SKU or variant ID is required'
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

    // Step 2: Find line item — variant_id first (handles empty-sku POS items), then SKU
    const targetLineItem = (variantId && findLineItemByVariantId(lineItems, variantId, { orderId }))
      || findLineItemBySku(lineItems, sku, { orderId });

    if (!targetLineItem) {
      logger.warn('decrement_line_item_not_found', 'SKU not found in order for decrement', { orderId, sku });
      return {
        success: false,
        error: 'LINE_ITEM_NOT_FOUND',
        message: `Line item with SKU ${sku} not found in order`
      };
    }

    const currentQuantity = targetLineItem.quantity || 0;

    if (currentQuantity === 0) {
      if (newQuantity === 0) {
        logger.info('decrement_line_item_already_removed', 'Line item already removed (qty=0), no action needed', { orderId, sku });
        return { success: true, alreadyRemoved: true, previousQuantity: 0, newQuantity: 0 };
      }
      logger.warn('decrement_line_item_removed_state', 'Cannot set quantity on removed line item', { orderId, sku, newQuantity });
      return { success: false, error: 'LINE_ITEM_REMOVED', message: `Cannot set quantity on removed SKU ${sku}` };
    }

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


/**
 * Set the TOTAL quantity a variant holds across every line item in an order.
 *
 * increment/decrementLineItemQuantity write an absolute quantity to ONE line item. When a
 * variant sits on several live line items (an operator adding a position for an item the
 * order already holds, or duplicates left by older concurrent order edits), no single-line
 * write can produce a correct sum: with lines of 2 and 3 and a target of 4, writing 4 to
 * either line yields 7 or 6. This spreads the difference across the matching lines instead,
 * inside a single edit session.
 *
 * Quantities here come from the calculated order, where `quantity` is the live amount for
 * the line — not the order's historical `line_item.quantity`, which keeps counting units
 * that were refunded or removed long ago.
 *
 * @param {string|number} orderId
 * @param {Object} params
 * @param {string|number} [params.variantId] - preferred identifier
 * @param {string} [params.sku] - fallback identifier
 * @param {number} params.targetTotal - desired total across all matching line items
 * @param {number} [params.expectedCurrentTotal] - total the caller measured from the REST
 *   order. When given, a mismatch aborts the edit rather than writing a guessed quantity.
 * @param {Object} [params.logContext]
 */
export async function setVariantTotalQuantity(orderId, { variantId, sku, targetTotal, expectedCurrentTotal = null, logContext = {} } = {}) {
  if (!orderId) {
    return { success: false, error: 'MISSING_ORDER_ID', message: 'Order ID is required' };
  }
  if (!variantId && !sku) {
    return { success: false, error: 'MISSING_SKU', message: 'SKU or variant ID is required' };
  }
  if (!Number.isFinite(targetTotal) || targetTotal < 0) {
    return { success: false, error: 'INVALID_QUANTITY', message: 'targetTotal must be zero or greater' };
  }

  try {
    const beginResult = await beginOrderEdit(orderId);
    if (!beginResult.success) return beginResult;

    const { calculatedOrderId, lineItems } = beginResult;
    const id = variantId != null ? String(variantId) : null;

    let matches = id
      ? lineItems.filter(item => item.variant && (item.variant.legacyResourceId === id || item.variant.id?.split('/').pop() === id))
      : [];
    if (matches.length === 0 && sku) {
      matches = lineItems.filter(item => item.variant && item.variant.sku === sku);
    }

    if (matches.length === 0) {
      logger.warn('set_variant_total_not_found', 'Variant not found in order', { orderId, variantId, sku, ...logContext });
      return { success: false, error: 'LINE_ITEM_NOT_FOUND', message: `No line item for variant ${variantId ?? sku}` };
    }

    const currentTotal = matches.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);

    // The caller measured the current total from the REST order; if the edit session
    // disagrees, one of the two readings is wrong and writing either would corrupt the
    // order. Bail out visibly instead.
    if (expectedCurrentTotal != null && Math.abs(currentTotal - expectedCurrentTotal) > 0.01) {
      logger.error('set_variant_total_mismatch', 'Calculated order disagrees with the measured total — edit aborted', {
        orderId, variantId, sku, currentTotal, expectedCurrentTotal,
        lines: matches.map(m => ({ id: m.id, quantity: m.quantity, editableQuantity: m.editableQuantity })),
        ...logContext,
      });
      return { success: false, error: 'CURRENT_TOTAL_MISMATCH', message: `Calculated total ${currentTotal} != expected ${expectedCurrentTotal}` };
    }

    let delta = targetTotal - currentTotal;
    if (Math.abs(delta) < 0.01) {
      return { success: true, unchanged: true, currentTotal, targetTotal };
    }

    // Largest editable line first: it absorbs the most before another line is touched.
    const editable = matches
      .filter(item => Number(item.editableQuantity ?? item.quantity ?? 0) > 0)
      .sort((a, b) => Number(b.editableQuantity ?? b.quantity ?? 0) - Number(a.editableQuantity ?? a.quantity ?? 0));

    const writes = [];

    if (delta < 0) {
      let toRemove = -delta;
      for (const item of editable) {
        if (toRemove <= 0.01) break;
        const lineQuantity = Number(item.quantity ?? 0);
        // editableQuantity should never exceed quantity; clamp so a surprising response
        // cannot produce a negative write.
        const capacity = Math.min(Number(item.editableQuantity ?? lineQuantity), lineQuantity);
        const taken = Math.min(toRemove, capacity);
        writes.push({ lineItemId: item.id, quantity: Math.max(0, lineQuantity - taken) });
        toRemove -= taken;
      }
      if (toRemove > 0.01) {
        logger.error('set_variant_total_insufficient_editable', 'Not enough editable quantity to reach the target — edit aborted', {
          orderId, variantId, sku, currentTotal, targetTotal, shortBy: toRemove, ...logContext,
        });
        return { success: false, error: 'INSUFFICIENT_EDITABLE_QUANTITY', message: `Cannot reduce by ${-delta}: only ${-delta - toRemove} is editable` };
      }
    } else {
      // Growing: one line absorbs the whole increase. Adding a variant that already sits on
      // the order would create yet another duplicate line, so only do that if none exists.
      const target = editable[0] || matches.find(item => Number(item.quantity ?? 0) > 0);
      if (target) {
        writes.push({ lineItemId: target.id, quantity: Number(target.quantity ?? 0) + delta });
      } else {
        const variantNumericId = matches[0].variant?.legacyResourceId || matches[0].variant?.id?.split('/').pop();
        if (!variantNumericId) {
          return { success: false, error: 'VARIANT_ID_UNAVAILABLE', message: 'Cannot re-add removed line item: variant ID unavailable' };
        }
        const addResult = await addVariantToEdit(calculatedOrderId, variantNumericId, delta);
        if (!addResult.success) return addResult;
      }
    }

    for (const write of writes) {
      const setResult = await setLineItemQuantity(calculatedOrderId, write.lineItemId, write.quantity);
      if (!setResult.success) return setResult;
    }

    const commitResult = await commitOrderEdit(calculatedOrderId);
    if (!commitResult.success) return commitResult;

    logger.info('set_variant_total_quantity', 'Variant total quantity set across line items', {
      orderId, variantId, sku, currentTotal, targetTotal, linesTouched: writes.length, ...logContext,
    });
    return { ...commitResult, currentTotal, targetTotal, linesTouched: writes.length };
  } catch (error) {
    logger.error('set_variant_total_error', 'Failed to set variant total quantity', { orderId, variantId, sku, targetTotal, error: error.message, ...logContext });
    return { success: false, error: 'SET_VARIANT_TOTAL_ERROR', message: error.message };
  }
}
