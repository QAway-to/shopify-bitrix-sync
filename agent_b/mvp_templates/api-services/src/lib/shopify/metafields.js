/**
 * Shopify Metafields API
 * Handles metafield operations for Shopify orders
 */

import { callShopifyAdmin } from './adminClient.js';

/**
 * Set provenance marker metafield on order
 * @param {string|number} orderId - Shopify order ID
 * @param {string} correlationId - Correlation ID for tracking
 * @param {string} action - Action type (fulfillment_create, hold_create, refund_create, address_update)
 * @param {string} payloadHash - Payload hash for strong loop guard (optional)
 * @returns {Promise<Object>} Response with metafield data
 */
export async function setProvenanceMarker(orderId, correlationId, action = 'fulfillment_create', payloadHash = null) {
  try {
    const timestamp = new Date().toISOString();
    const markerValue = {
      source: 'bitrix',
      action: action,
      correlationId: correlationId,
      ts: timestamp
    };
    
    // Add payloadHash if provided (for strong loop guard)
    if (payloadHash) {
      markerValue.payloadHash = payloadHash;
    }
    
    const value = JSON.stringify(markerValue);

    // Get existing metafields first to check if we need to update or create
    let existingMetafield = null;
    try {
      const metafieldsResponse = await callShopifyAdmin(`/orders/${orderId}/metafields.json?namespace=middleware&key=last_write`);
      if (metafieldsResponse.metafields && metafieldsResponse.metafields.length > 0) {
        existingMetafield = metafieldsResponse.metafields[0];
      }
    } catch (error) {
      // If metafield doesn't exist, we'll create it
    }

    let response;
    if (existingMetafield) {
      // Update existing metafield
      response = await callShopifyAdmin(`/metafields/${existingMetafield.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({
          metafield: {
            id: existingMetafield.id,
            value: value,
            type: 'single_line_text_field'
          }
        })
      });
    } else {
      // Create new metafield
      response = await callShopifyAdmin(`/orders/${orderId}/metafields.json`, {
        method: 'POST',
        body: JSON.stringify({
          metafield: {
            namespace: 'middleware',
            key: 'last_write',
            value: value,
            type: 'single_line_text_field'
          }
        })
      });
    }

    return {
      success: true,
      httpStatus: existingMetafield ? 200 : 201,
      metafield: response.metafield || response.metafields?.[0],
      correlationId,
      payloadHash,
      timestamp
    };
  } catch (error) {
    const statusMatch = error.message.match(/\((\d+)\)/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

    return {
      success: false,
      httpStatus: httpStatus || 500,
      error: 'SHOPIFY_PROVENANCE_SET_ERROR',
      message: error.message,
      correlationId
    };
  }
}

/**
 * Get provenance marker metafield from order
 * @param {string|number} orderId - Shopify order ID
 * @returns {Promise<Object>} Response with metafield data or null
 */
export async function getProvenanceMarker(orderId) {
  try {
    const response = await callShopifyAdmin(`/orders/${orderId}/metafields.json?namespace=middleware&key=last_write`);
    
    if (response.metafields && response.metafields.length > 0) {
      const metafield = response.metafields[0];
      let parsedValue = null;
      
      try {
        parsedValue = JSON.parse(metafield.value);
      } catch (parseError) {
        // If value is not JSON, return raw value
        parsedValue = { raw: metafield.value };
      }

      return {
        success: true,
        httpStatus: 200,
        metafield: metafield,
        value: parsedValue,
        exists: true
      };
    }

    return {
      success: true,
      httpStatus: 200,
      metafield: null,
      value: null,
      exists: false
    };
  } catch (error) {
    const statusMatch = error.message.match(/\((\d+)\)/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

    // 404 means metafield doesn't exist, which is OK
    if (httpStatus === 404) {
      return {
        success: true,
        httpStatus: 404,
        metafield: null,
        value: null,
        exists: false
      };
    }

    return {
      success: false,
      httpStatus: httpStatus || 500,
      error: 'SHOPIFY_PROVENANCE_GET_ERROR',
      message: error.message,
      exists: false
    };
  }
}

