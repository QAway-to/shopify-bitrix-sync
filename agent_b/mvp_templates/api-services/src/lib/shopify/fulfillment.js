/**
 * Shopify Fulfillment API
 * Handles fulfillment-related operations for Shopify orders
 */

import { callShopifyAdmin } from './adminClient.js';

/**
 * Get fulfillments for a specific order
 * @param {string|number} orderId - Shopify order ID
 * @returns {Promise<Object>} Response with fulfillments data
 */
export async function getFulfillmentOrders(orderId) {
  try {
    // Use Shopify Admin API to get order fulfillments
    // Endpoint: GET /admin/api/{version}/orders/{order_id}/fulfillments.json
    const response = await callShopifyAdmin(`/orders/${orderId}/fulfillments.json`);
    
    return {
      success: true,
      httpStatus: 200,
      fulfillments: response.fulfillments || [],
      count: response.fulfillments ? response.fulfillments.length : 0,
      fulfillmentIds: response.fulfillments ? response.fulfillments.map(f => f.id) : [],
      rawResponse: response
    };
  } catch (error) {
    // callShopifyAdmin throws Error with message like "Shopify Admin API error (401): ..."
    // Extract HTTP status code from error message
    const statusMatch = error.message.match(/\((\d+)\)/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;
    
    // Handle authentication errors (401/403)
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        success: false,
        httpStatus,
        error: 'SHOPIFY_ADMIN_AUTH_ERROR',
        message: error.message,
        fulfillments: [],
        count: 0,
        fulfillmentIds: []
      };
    }
    
    // Other errors (network, 404, 500, etc.)
    return {
      success: false,
      httpStatus: httpStatus || 500,
      error: 'SHOPIFY_FULFILLMENT_FETCH_ERROR',
      message: error.message,
      fulfillments: [],
      count: 0,
      fulfillmentIds: []
    };
  }
}

/**
 * Alternative: Get order with fulfillments included
 * This uses the order endpoint which includes fulfillments in the response
 * @param {string|number} orderId - Shopify order ID
 * @returns {Promise<Object>} Response with order and fulfillments data
 */
export async function getFulfillments(orderId) {
  try {
    // Get full order data (includes fulfillments)
    const response = await callShopifyAdmin(`/orders/${orderId}.json`);
    const order = response.order || {};
    const fulfillments = order.fulfillments || [];
    
    return {
      success: true,
      httpStatus: 200,
      fulfillments: fulfillments,
      count: fulfillments.length,
      fulfillmentIds: fulfillments.map(f => f.id),
      orderId: order.id,
      orderName: order.name,
      rawResponse: response
    };
  } catch (error) {
    // callShopifyAdmin throws Error with message like "Shopify Admin API error (401): ..."
    // Extract HTTP status code from error message
    const statusMatch = error.message.match(/\((\d+)\)/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;
    
    // Handle authentication errors (401/403)
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        success: false,
        httpStatus,
        error: 'SHOPIFY_ADMIN_AUTH_ERROR',
        message: error.message,
        fulfillments: [],
        count: 0,
        fulfillmentIds: []
      };
    }
    
    // Other errors (network, 404, 500, etc.)
    return {
      success: false,
      httpStatus: httpStatus || 500,
      error: 'SHOPIFY_FULFILLMENT_FETCH_ERROR',
      message: error.message,
      fulfillments: [],
      count: 0,
      fulfillmentIds: []
    };
  }
}

/**
 * Get order with line items to check fulfillment status
 * @param {string|number} orderId - Shopify order ID
 * @returns {Promise<Object>} Response with order, line items, and fulfillment status
 */
export async function getOrderForFulfillment(orderId) {
  try {
    const response = await callShopifyAdmin(`/orders/${orderId}.json`);
    const order = response.order || {};
    const lineItems = order.line_items || [];
    const fulfillments = order.fulfillments || [];
    
    // Calculate total fulfillable quantity
    let totalFulfillableQuantity = 0;
    const itemsToFulfill = [];
    
    lineItems.forEach(item => {
      const fulfillableQuantity = item.fulfillable_quantity || 0;
      if (fulfillableQuantity > 0) {
        totalFulfillableQuantity += fulfillableQuantity;
        itemsToFulfill.push({
          id: item.id,
          quantity: fulfillableQuantity,
          variant_id: item.variant_id
        });
      }
    });
    
    // Check if order is already fully fulfilled
    const isFullyFulfilled = fulfillments.some(f => f.status === 'success') && totalFulfillableQuantity === 0;
    
    return {
      success: true,
      httpStatus: 200,
      order: order,
      lineItems: lineItems,
      fulfillments: fulfillments,
      totalFulfillableQuantity,
      itemsToFulfill,
      isFullyFulfilled,
      needsFulfillment: totalFulfillableQuantity > 0
    };
  } catch (error) {
    const statusMatch = error.message.match(/\((\d+)\)/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;
    
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        success: false,
        httpStatus,
        error: 'SHOPIFY_ADMIN_AUTH_ERROR',
        message: error.message
      };
    }
    
    return {
      success: false,
      httpStatus: httpStatus || 500,
      error: 'SHOPIFY_ORDER_FETCH_ERROR',
      message: error.message
    };
  }
}

/**
 * Create fulfillment for an order
 * @param {string|number} orderId - Shopify order ID
 * @param {Array} lineItems - Array of line items to fulfill with {id, quantity}
 * @param {Object} options - Optional fulfillment options (tracking_number, notify_customer, etc.)
 * @returns {Promise<Object>} Response with created fulfillment
 */
export async function createFulfillment(orderId, lineItems, options = {}) {
  try {
    if (!lineItems || lineItems.length === 0) {
      return {
        success: false,
        error: 'SHOPIFY_FULFILLMENT_CREATE_ERROR',
        message: 'No line items provided for fulfillment',
        httpStatus: 400
      };
    }

    const fulfillmentData = {
      fulfillment: {
        location_id: options.location_id || null, // If null, Shopify will use default
        tracking_number: options.tracking_number || null,
        tracking_urls: options.tracking_urls || [],
        notify_customer: options.notify_customer !== false, // Default true
        line_items_by_fulfillment_order: lineItems.map(item => ({
          fulfillment_order_id: item.fulfillment_order_id || item.id,
          fulfillment_order_line_items: [{
            id: item.fulfillment_order_line_item_id || item.id,
            quantity: item.quantity
          }]
        }))
      }
    };

    // For REST API, we need to use fulfillment_orders endpoint first
    // Get fulfillment orders for this order
    let fulfillmentOrdersResponse;
    try {
      fulfillmentOrdersResponse = await callShopifyAdmin(`/orders/${orderId}/fulfillment_orders.json`);
    } catch (fulfillmentOrdersError) {
      return {
        success: false,
        error: 'SHOPIFY_FULFILLMENT_ORDERS_FETCH_ERROR',
        message: fulfillmentOrdersError.message,
        httpStatus: 500
      };
    }

    const fulfillmentOrders = fulfillmentOrdersResponse.fulfillment_orders || [];
    if (fulfillmentOrders.length === 0) {
      return {
        success: false,
        error: 'SHOPIFY_FULFILLMENT_CREATE_SKIP',
        skip_reason: 'missing_fulfillment_orders',
        message: 'No fulfillment orders found for this order',
        httpStatus: 200
      };
    }

    // Find open fulfillment orders
    const openFulfillmentOrders = fulfillmentOrders.filter(fo => 
      fo.status === 'open' || fo.status === 'in_progress'
    );

    if (openFulfillmentOrders.length === 0) {
      return {
        success: false,
        error: 'SHOPIFY_FULFILLMENT_CREATE_SKIP',
        skip_reason: 'nothing_to_fulfill',
        message: 'No open fulfillment orders found',
        httpStatus: 200
      };
    }

    // Build fulfillment request with fulfillment order line items
    const fulfillmentOrderLineItems = [];
    openFulfillmentOrders.forEach(fulfillmentOrder => {
      fulfillmentOrder.line_items.forEach(lineItem => {
        if (lineItem.fulfillable_quantity > 0) {
          fulfillmentOrderLineItems.push({
            id: lineItem.id,
            quantity: lineItem.fulfillable_quantity
          });
        }
      });
    });

    if (fulfillmentOrderLineItems.length === 0) {
      return {
        success: false,
        error: 'SHOPIFY_FULFILLMENT_CREATE_SKIP',
        skip_reason: 'nothing_to_fulfill',
        message: 'No fulfillable line items found',
        httpStatus: 200
      };
    }

    // Create fulfillment using fulfillment_orders endpoint
    // Build line_items_by_fulfillment_order array
    const lineItemsByFulfillmentOrder = openFulfillmentOrders.map(fulfillmentOrder => {
      const fulfillableLineItems = fulfillmentOrder.line_items
        .filter(li => li.fulfillable_quantity > 0)
        .map(li => ({
          id: li.id,
          quantity: li.fulfillable_quantity
        }));

      return {
        fulfillment_order_id: fulfillmentOrder.id,
        fulfillment_order_line_items: fulfillableLineItems
      };
    }).filter(item => item.fulfillment_order_line_items.length > 0); // Only include if there are items to fulfill

    if (lineItemsByFulfillmentOrder.length === 0) {
      return {
        success: false,
        error: 'SHOPIFY_FULFILLMENT_CREATE_SKIP',
        skip_reason: 'nothing_to_fulfill',
        message: 'No fulfillable line items in fulfillment orders',
        httpStatus: 200
      };
    }

    const fulfillmentRequest = {
      fulfillment: {
        notify_customer: options.notify_customer !== false,
        line_items_by_fulfillment_order: lineItemsByFulfillmentOrder
      }
    };

    const response = await callShopifyAdmin(`/orders/${orderId}/fulfillments.json`, {
      method: 'POST',
      body: JSON.stringify(fulfillmentRequest)
    });

    return {
      success: true,
      httpStatus: 201,
      fulfillment: response.fulfillment,
      fulfillmentId: response.fulfillment?.id,
      fulfillmentIds: response.fulfillment ? [response.fulfillment.id] : []
    };
  } catch (error) {
    const statusMatch = error.message.match(/\((\d+)\)/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;
    const errorText = error.message.substring(0, 500); // First 500 chars

    return {
      success: false,
      httpStatus: httpStatus || 500,
      error: 'SHOPIFY_FULFILLMENT_CREATE_ERROR',
      message: error.message,
      responseSnippet: errorText
    };
  }
}

/**
 * Get post-fulfillment state for logging and verification
 * Reads order and fulfillments after fulfillment creation
 * @param {string|number} orderId - Shopify order ID
 * @returns {Promise<Object>} Post-fulfillment state summary
 */
export async function getPostFulfillmentState(orderId) {
  try {
    // Get fulfillments
    const fulfillmentsResponse = await callShopifyAdmin(`/orders/${orderId}/fulfillments.json`);
    const fulfillments = fulfillmentsResponse.fulfillments || [];
    
    // Get order (brief)
    const orderResponse = await callShopifyAdmin(`/orders/${orderId}.json`);
    const order = orderResponse.order || {};
    const lineItems = order.line_items || [];
    
    // Extract fulfillment statuses
    const fulfillmentStatuses = fulfillments.map(f => f.status || 'unknown');
    const fulfillmentIds = fulfillments.map(f => f.id);
    
    // Determine order fulfillment status
    let orderFulfillmentStatus = 'unfulfilled';
    if (fulfillments.length > 0) {
      const allSuccessful = fulfillments.every(f => f.status === 'success');
      const hasPartial = fulfillments.some(f => f.status === 'success') && !allSuccessful;
      
      if (allSuccessful) {
        // Check if all items are fulfilled
        const totalQuantity = lineItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
        const fulfilledQuantity = lineItems.reduce((sum, item) => sum + (item.fulfilled_quantity || 0), 0);
        
        if (fulfilledQuantity >= totalQuantity) {
          orderFulfillmentStatus = 'fulfilled';
        } else if (fulfilledQuantity > 0) {
          orderFulfillmentStatus = 'partial';
        }
      } else if (hasPartial) {
        orderFulfillmentStatus = 'partial';
      }
    }
    
    // Build line items summary
    const lineItemsSummary = lineItems.map(item => ({
      sku: item.sku || 'N/A',
      quantity: item.quantity || 0,
      fulfilled_quantity: item.fulfilled_quantity || 0
    }));
    
    return {
      success: true,
      httpStatus: 200,
      shopifyOrderId: String(orderId),
      fulfillmentIds,
      fulfillmentStatuses,
      orderFulfillmentStatus,
      lineItemsSummary
    };
  } catch (error) {
    const statusMatch = error.message.match(/\((\d+)\)/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;
    
    return {
      success: false,
      httpStatus: httpStatus || 500,
      error: 'SHOPIFY_POST_FULFILLMENT_STATE_ERROR',
      message: error.message,
      shopifyOrderId: String(orderId),
      fulfillmentIds: [],
      fulfillmentStatuses: [],
      orderFulfillmentStatus: 'unknown',
      lineItemsSummary: []
    };
  }
}

