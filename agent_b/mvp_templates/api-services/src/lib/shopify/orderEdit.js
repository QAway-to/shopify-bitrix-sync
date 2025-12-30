/**
 * Shopify Order Edit Operations
 * Handles adding items, adjusting quantities on existing orders
 */

import { callShopifyGraphQL } from './adminClient.js';
import { getVariantIdsBySkus } from './hold.js';

/**
 * Begin order edit
 * @param {string} orderId - Shopify Order ID
 */
export async function beginOrderEdit(orderId) {
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

    const response = await callShopifyGraphQL(mutation, { id: `gid://shopify/Order/${orderId}` });

    if (response?.orderEditBegin?.userErrors?.length > 0) {
        return {
            success: false,
            error: response.orderEditBegin.userErrors[0].message
        };
    }

    return {
        success: true,
        calculatedOrderId: response.orderEditBegin.calculatedOrder.id,
        lineItems: response.orderEditBegin.calculatedOrder.lineItems.edges.map(e => e.node)
    };
}

/**
 * Add variant to order edit
 */
export async function addVariantToOrderEdit(calculatedOrderId, variantId, quantity) {
    const mutation = `
    mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
      orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
        calculatedLineItem {
          id
          quantity
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

    const response = await callShopifyGraphQL(mutation, {
        id: calculatedOrderId,
        variantId: `gid://shopify/ProductVariant/${variantId}`,
        quantity: parseInt(quantity)
    });

    if (response?.orderEditAddVariant?.userErrors?.length > 0) {
        return {
            success: false,
            error: response.orderEditAddVariant.userErrors[0].message
        };
    }

    return {
        success: true,
        lineItemId: response.orderEditAddVariant.calculatedLineItem.id
    };
}

/**
 * Set line item quantity in order edit
 */
export async function setLineItemQuantity(calculatedOrderId, lineItemId, quantity) {
    const mutation = `
    mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
      orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
        calculatedLineItem {
          id
          quantity
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

    const response = await callShopifyGraphQL(mutation, {
        id: calculatedOrderId,
        lineItemId: lineItemId,
        quantity: parseInt(quantity)
    });

    if (response?.orderEditSetQuantity?.userErrors?.length > 0) {
        return {
            success: false,
            error: response.orderEditSetQuantity.userErrors[0].message
        };
    }

    return {
        success: true,
        newQuantity: response.orderEditSetQuantity.calculatedLineItem.quantity
    };
}

/**
 * Commit order edit
 */
export async function commitOrderEdit(calculatedOrderId) {
    const mutation = `
    mutation orderEditCommit($id: ID!) {
      orderEditCommit(id: $id) {
        order {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

    const response = await callShopifyGraphQL(mutation, { id: calculatedOrderId });

    if (response?.orderEditCommit?.userErrors?.length > 0) {
        return {
            success: false,
            error: response.orderEditCommit.userErrors[0].message
        };
    }

    return {
        success: true,
        orderId: response.orderEditCommit.order.id
    };
}

/**
 * High-level: Add position (SKU) to existing order
 */
export async function addPositionToOrder(orderId, sku, quantity) {
    try {
        // 1. Get variant ID for SKU
        const variantIdMap = await getVariantIdsBySkus([sku]);
        const variantId = variantIdMap.get(sku);

        if (!variantId) {
            return { success: false, error: `Variant not found for SKU ${sku}` };
        }

        // 2. Begin Edit
        const beginRes = await beginOrderEdit(orderId);
        if (!beginRes.success) return beginRes;

        // 3. Add Variant
        const addRes = await addVariantToOrderEdit(beginRes.calculatedOrderId, variantId, quantity);
        if (!addRes.success) return addRes;

        // 4. Commit
        const commitRes = await commitOrderEdit(beginRes.calculatedOrderId);
        return commitRes;
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * High-level: Increment line item quantity
 */
export async function incrementLineItemQuantity(orderId, sku, incrementQty) {
    try {
        // 1. Begin Edit
        const beginRes = await beginOrderEdit(orderId);
        if (!beginRes.success) return beginRes;

        // 2. Find line item by SKU
        const lineItem = beginRes.lineItems.find(li => li.variant?.sku === sku);
        if (!lineItem) {
            return { success: false, error: `Line item with SKU ${sku} not found in order` };
        }

        // 3. Set new quantity
        const newQty = lineItem.quantity + incrementQty;
        const setRes = await setLineItemQuantity(beginRes.calculatedOrderId, lineItem.id, newQty);
        if (!setRes.success) return setRes;

        // 4. Commit
        const commitRes = await commitOrderEdit(beginRes.calculatedOrderId);
        return { ...commitRes, newQuantity: newQty };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * High-level: Decrement line item quantity
 */
export async function decrementLineItemQuantity(orderId, sku, newQty) {
    try {
        // 1. Begin Edit
        const beginRes = await beginOrderEdit(orderId);
        if (!beginRes.success) return beginRes;

        // 2. Find line item by SKU
        const lineItem = beginRes.lineItems.find(li => li.variant?.sku === sku);
        if (!lineItem) {
            return { success: false, error: `Line item with SKU ${sku} not found in order` };
        }

        // 3. Set new quantity
        const setRes = await setLineItemQuantity(beginRes.calculatedOrderId, lineItem.id, newQty);
        if (!setRes.success) return setRes;

        // 4. Commit
        const commitRes = await commitOrderEdit(beginRes.calculatedOrderId);
        return { ...commitRes, newQuantity: newQty };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
