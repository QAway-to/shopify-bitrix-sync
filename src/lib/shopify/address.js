/**
 * Shopify Address Operations
 * Handles shipping address updates in Shopify orders
 */

import { callShopifyAdmin, getOrder } from './adminClient.js';
import { addTagToOrder } from './order.js';

/**
 * Get country name from ISO2 code
 * @param {string} iso2Code - ISO2 country code (e.g., 'US', 'GB')
 * @returns {Promise<string|null>} Country name or null
 */
async function getCountryNameFromISO2(iso2Code) {
  if (!iso2Code || iso2Code.length !== 2) {
    return null;
  }

  try {
    // Get countries list from Shopify
    const response = await callShopifyAdmin('/countries.json');
    const countries = response.countries || [];
    
    const country = countries.find(c => c.code === iso2Code.toUpperCase());
    return country ? country.name : null;
  } catch (error) {
    console.warn(`[SHOPIFY ADDRESS] Failed to fetch countries: ${error.message}`);
    // Return ISO2 code as fallback
    return iso2Code.toUpperCase();
  }
}

/**
 * Normalize address data for Shopify
 * @param {Object} addressData - Raw address data
 * @returns {Promise<Object>} Normalized address
 */
async function normalizeAddress(addressData) {
  const normalized = {};

  // Map common fields
  if (addressData.first_name) normalized.first_name = String(addressData.first_name);
  if (addressData.last_name) normalized.last_name = String(addressData.last_name);
  if (addressData.company) normalized.company = String(addressData.company);
  if (addressData.address1) normalized.address1 = String(addressData.address1);
  if (addressData.address2) normalized.address2 = String(addressData.address2);
  if (addressData.city) normalized.city = String(addressData.city);
  if (addressData.province) normalized.province = String(addressData.province);
  if (addressData.zip) normalized.zip = String(addressData.zip);
  if (addressData.phone) normalized.phone = String(addressData.phone);

  // Handle country: Shopify requires both country_code (ISO2) and country (full name)
  // Priority: if country_code is provided, use it; otherwise try to extract from country
  let countryCode = addressData.country_code || null;
  let countryName = addressData.country || null;

  if (countryCode && countryCode.length === 2) {
    // country_code provided - get full country name
    normalized.country_code = countryCode.toUpperCase();
    if (!countryName) {
      countryName = await getCountryNameFromISO2(countryCode);
    }
    normalized.country = countryName || countryCode;
  } else if (countryName) {
    // Only country name provided - try to extract code or use as-is
    const countryValue = String(countryName);
    if (countryValue.length === 2) {
      // Looks like ISO2 code
      normalized.country_code = countryValue.toUpperCase();
      const resolvedName = await getCountryNameFromISO2(countryValue);
      normalized.country = resolvedName || countryValue;
    } else {
      // Full country name - try to find code
      normalized.country = countryValue;
      // Note: We can't easily reverse lookup country code from name without API call
      // If country_code is needed, it should be provided in addressData
    }
  }

  return normalized;
}

/**
 * Update shipping address for a Shopify order
 * @param {string|number} orderId - Shopify order ID
 * @param {Object} addressPayload - Address payload from normalized action
 * @param {string} correlationId - Correlation ID for tracking
 * @param {string} payloadHash - Payload hash for loop guard
 * @returns {Promise<Object>} Address update result
 */
export async function updateShippingAddress(orderId, addressPayload, correlationId, payloadHash) {
  if (!orderId) {
    return {
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'Shopify order ID is required for address update'
    };
  }

  if (!addressPayload || !addressPayload.shipping_address || Object.keys(addressPayload.shipping_address).length === 0) {
    return {
      success: false,
      error: 'MISSING_ADDRESS_DATA',
      message: 'Shipping address data is required'
    };
  }

  try {
    // Log incoming payload for debugging
    console.log(JSON.stringify({
      event: 'ADDRESS_UPDATE_PAYLOAD_RECEIVED',
      orderId,
      correlationId,
      payloadHash,
      addressFields: Object.keys(addressPayload.shipping_address || {}),
      hasShippingLines: !!(addressPayload.shipping_lines),
      hasDeliveryTitle: !!(addressPayload.delivery_title),
      timestamp: new Date().toISOString()
    }));

    // Step 1: Get order to verify it exists
    const order = await getOrder(orderId);
    if (!order) {
      return {
        success: false,
        error: 'ORDER_NOT_FOUND',
        message: `Order ${orderId} not found in Shopify`
      };
    }

    // Step 2: Normalize address data
    const normalizedAddress = await normalizeAddress(addressPayload.shipping_address);
    
    console.log(JSON.stringify({
      event: 'ADDRESS_NORMALIZED',
      orderId,
      normalizedAddressFields: Object.keys(normalizedAddress),
      countryCode: normalizedAddress.country_code,
      country: normalizedAddress.country,
      timestamp: new Date().toISOString()
    }));

    // Step 3: Prepare update payload
    const updatePayload = {
      order: {
        id: orderId,
        shipping_address: normalizedAddress
      }
    };

    // Step 4: Add shipping_lines if provided (delivery method update)
    if (addressPayload.shipping_lines && Array.isArray(addressPayload.shipping_lines) && addressPayload.shipping_lines.length > 0) {
      updatePayload.order.shipping_lines = addressPayload.shipping_lines.map(line => ({
        title: line.title || '',
        price: String(line.price || '0.00'),
        code: line.code || 'CUSTOM_EDIT'
      }));
    } else if (addressPayload.delivery_title || addressPayload.delivery_price) {
      // Support simplified format: delivery_title and delivery_price
      updatePayload.order.shipping_lines = [{
        title: addressPayload.delivery_title || 'Custom Delivery',
        price: String(addressPayload.delivery_price || '0.00'),
        code: addressPayload.delivery_code || 'CUSTOM_EDIT'
      }];
    }

    // Step 5: Update order (address and optionally shipping_lines)
    console.log(JSON.stringify({
      event: 'ADDRESS_UPDATE_REQUEST',
      orderId,
      updatePayloadKeys: Object.keys(updatePayload.order),
      hasShippingLines: !!(updatePayload.order.shipping_lines),
      timestamp: new Date().toISOString()
    }));

    const updateResponse = await callShopifyAdmin(`/orders/${orderId}.json`, {
      method: 'PUT',
      body: JSON.stringify(updatePayload)
    });

    const updatedOrder = updateResponse.order;
    
    console.log(JSON.stringify({
      event: 'ADDRESS_UPDATE_SUCCESS',
      orderId,
      orderName: updatedOrder.name,
      updatedAddress: updatedOrder.shipping_address ? {
        address1: updatedOrder.shipping_address.address1,
        city: updatedOrder.shipping_address.city,
        country: updatedOrder.shipping_address.country,
        country_code: updatedOrder.shipping_address.country_code
      } : null,
      updatedShippingLines: updatedOrder.shipping_lines?.length || 0,
      timestamp: new Date().toISOString()
    }));

    // Step 4: Add BitrixUpdated tag for loop guard (prevent webhook from sending back to Bitrix)
    try {
      const tagResult = await addTagToOrder(orderId, 'BitrixUpdated');
      if (tagResult.success) {
        console.log(`[SHOPIFY ADDRESS] ✅ Added BitrixUpdated tag to order ${orderId} for loop guard`);
      } else {
        console.warn(`[SHOPIFY ADDRESS] ⚠️ Failed to add BitrixUpdated tag: ${tagResult.message}`);
      }
    } catch (tagError) {
      console.warn(`[SHOPIFY ADDRESS] ⚠️ Error adding BitrixUpdated tag (non-blocking):`, tagError.message);
    }

    return {
      success: true,
      orderId: String(orderId),
      orderName: updatedOrder.name,
      shippingAddress: updatedOrder.shipping_address
    };
  } catch (error) {
    return {
      success: false,
      error: 'ADDRESS_UPDATE_ERROR',
      message: error.message,
      httpStatus: error.status || 500
    };
  }
}






