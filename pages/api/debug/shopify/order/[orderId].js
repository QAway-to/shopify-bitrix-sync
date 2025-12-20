/**
 * Debug endpoint to check Shopify order fulfillment status
 * GET /api/debug/shopify/order/:orderId
 * Returns: fulfillments, fulfillment_orders, fulfillment_status, line_items summary
 */
import { callShopifyAdmin } from '../../../../../src/lib/shopify/adminClient.js';
import { getPostFulfillmentState } from '../../../../../src/lib/shopify/fulfillment.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { orderId } = req.query;

  if (!orderId) {
    return res.status(400).json({ error: 'Order ID is required' });
  }

  try {
    // Get order
    const orderResponse = await callShopifyAdmin(`/orders/${orderId}.json`);
    const order = orderResponse.order || {};

    // Get fulfillments
    let fulfillments = [];
    try {
      const fulfillmentsResponse = await callShopifyAdmin(`/orders/${orderId}/fulfillments.json`);
      fulfillments = fulfillmentsResponse.fulfillments || [];
    } catch (fulfillmentsError) {
      // If fulfillments endpoint fails, continue with empty array
      console.error('Error fetching fulfillments:', fulfillmentsError);
    }

    // Get fulfillment orders
    let fulfillmentOrders = [];
    try {
      const fulfillmentOrdersResponse = await callShopifyAdmin(`/orders/${orderId}/fulfillment_orders.json`);
      fulfillmentOrders = fulfillmentOrdersResponse.fulfillment_orders || [];
    } catch (fulfillmentOrdersError) {
      // If fulfillment_orders endpoint fails, continue with empty array
      console.error('Error fetching fulfillment orders:', fulfillmentOrdersError);
    }

    // Get post-fulfillment state summary
    const postState = await getPostFulfillmentState(orderId);

    // Build line items summary
    const lineItems = order.line_items || [];
    const lineItemsSummary = lineItems.map(item => ({
      id: item.id,
      sku: item.sku || 'N/A',
      title: item.title || 'N/A',
      quantity: item.quantity || 0,
      fulfillable_quantity: item.fulfillable_quantity || 0,
      fulfilled_quantity: item.fulfilled_quantity || 0,
      requires_shipping: item.requires_shipping || false
    }));

    return res.status(200).json({
      success: true,
      orderId: String(orderId),
      orderName: order.name || 'N/A',
      fulfillmentStatus: postState.orderFulfillmentStatus,
      fulfillments: fulfillments.map(f => ({
        id: f.id,
        status: f.status,
        created_at: f.created_at,
        updated_at: f.updated_at,
        tracking_number: f.tracking_number,
        tracking_urls: f.tracking_urls,
        line_items: f.line_items || []
      })),
      fulfillmentOrders: fulfillmentOrders.map(fo => ({
        id: fo.id,
        status: fo.status,
        request_status: fo.request_status,
        line_items: fo.line_items || []
      })),
      lineItemsSummary,
      postFulfillmentState: {
        fulfillmentIds: postState.fulfillmentIds,
        fulfillmentStatuses: postState.fulfillmentStatuses,
        orderFulfillmentStatus: postState.orderFulfillmentStatus
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const statusMatch = error.message.match(/\((\d+)\)/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : 500;

    return res.status(httpStatus).json({
      success: false,
      error: 'Failed to fetch order data',
      message: error.message,
      orderId: String(orderId)
    });
  }
}

