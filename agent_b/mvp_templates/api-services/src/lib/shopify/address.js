/**
 * Shopify Address Operations
 * Handles shipping address updates in Shopify orders
 */

import { callShopifyAdmin, getOrder } from './adminClient.js';

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

  // Handle country: convert ISO2 to country name if needed
  if (addressData.country) {
    const countryValue = String(addressData.country);
    // If it's a 2-letter code, try to get country name
    if (countryValue.length === 2) {
      const countryName = await getCountryNameFromISO2(countryValue);
      normalized.country = countryName || countryValue;
    } else {
      normalized.country = countryValue;
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

    // Step 3: Update order shipping address
    const updateResponse = await callShopifyAdmin(`/orders/${orderId}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        order: {
          id: orderId,
          shipping_address: normalizedAddress
        }
      })
    });

    const updatedOrder = updateResponse.order;

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






