/**
 * Address Update Block Handler
 * Extracted from bitrix.js handleDealUpdate (lines 2088-2394)
 * 
 * Purpose: Sync address and delivery price from Bitrix to Shopify order
 * Trigger: shopifyOrderId exists AND address/delivery price fields changed
 * 
 * Flow:
 * 1. Get current Shopify order address
 * 2. Parse Bitrix address string
 * 3. Resolve country code
 * 4. Enrich with contact name/phone
 * 5. Update Shopify order
 */

import { getOrder, callShopifyAdmin } from '../shopify/adminClient.js';
import { updateShippingAddress } from '../shopify/address.js';
import { callBitrix } from '../bitrix/client.js';
import { BITRIX_DEAL_FIELDS } from '../shared/constants.js';
import { logger } from '../logging/logger.js';

/**
 * Parse Bitrix address string into Shopify address format
 * Format: "Street, ZIP City Region, Country | coordinate"
 * Example: "Rue de l'Église 78, 1081 Koekelberg Brussels-Capital, Belgium | 50.859"
 * @param {string} addressString - Address string from Bitrix
 * @returns {Object|null} Parsed address object or null if parsing fails
 */
export function parseBitrixAddressString(addressString) {
    if (!addressString || typeof addressString !== 'string') return null;

    try {
        // Remove coordinate part (after |)
        const mainPart = addressString.split('|')[0].trim();
        if (!mainPart) return null;

        // Split by comma to get parts
        const parts = mainPart.split(',').map(p => p.trim());
        if (parts.length < 2) return null;

        // First part is street address
        const address1 = parts[0];

        // Last part usually contains country
        const lastPart = parts[parts.length - 1];

        // Second-to-last or middle parts contain ZIP, City, Region
        const middleParts = parts.slice(1, -1).join(', ') + (parts.length > 2 ? '' : ', ' + parts[1]);

        // Try to extract ZIP (usually 4-5 digits at the start of middle part)
        const zipMatch = middleParts.match(/^(\d{4,5})\s+/);
        const zip = zipMatch ? zipMatch[1] : '';
        const cityRegion = zipMatch ? middleParts.substring(zipMatch[0].length) : middleParts;

        // Split city and region
        const cityParts = cityRegion.split(/\s+/);
        const city = cityParts[0] || '';
        const province = cityParts.slice(1).join(' ') || '';

        return {
            address1,
            city,
            zip,
            province,
            country: lastPart
        };
    } catch (error) {
        logger.warn('address_parse_error', 'Failed to parse address string', { error: error.message });
        return null;
    }
}

/**
 * Check if address has changed by comparing key fields
 * @param {Object} newAddress - New address from Bitrix
 * @param {Object} currentAddress - Current address from Shopify
 * @returns {boolean} True if address changed
 */
export function hasAddressChanged(newAddress, currentAddress) {
    const fields = ['address1', 'city', 'zip', 'country'];

    for (const field of fields) {
        const newVal = (newAddress[field] || '').trim().toLowerCase();
        const curVal = (currentAddress[field] || '').trim().toLowerCase();
        if (newVal !== curVal) return true;
    }

    return false;
}

/**
 * Handle Address Update from Bitrix to Shopify
 * @param {string} shopifyOrderId - Shopify order ID
 * @param {Object} dealData - Full deal data from Bitrix
 * @param {string} requestId - Request correlation ID
 * @param {string} dealId - Bitrix deal ID
 * @returns {Promise<{updated: boolean, addressUpdated?: boolean, priceUpdated?: boolean}>}
 */
export async function handleAddressUpdate(shopifyOrderId, dealData, requestId, dealId) {
    if (!shopifyOrderId || shopifyOrderId.trim() === '') {
        return { updated: false, reason: 'no_order_id' };
    }

    try {
        const shopifyOrder = await getOrder(shopifyOrderId);
        if (!shopifyOrder) {
            return { updated: false, reason: 'order_not_found' };
        }

        const currentShippingLines = shopifyOrder.shipping_lines || [];

        // Check delivery price
        const deliveryPriceField = dealData[BITRIX_DEAL_FIELDS.DELIVERY_PRICE] ||
            dealData[BITRIX_DEAL_FIELDS.DELIVERY_PRICE.toLowerCase()] || '';
        const deliveryPrice = deliveryPriceField ? parseFloat(deliveryPriceField) : null;
        const currentShippingPrice = currentShippingLines.length > 0
            ? parseFloat(currentShippingLines[0].price || '0')
            : 0;
        const deliveryPriceChanged = deliveryPrice !== null &&
            !isNaN(deliveryPrice) &&
            Math.abs(deliveryPrice - currentShippingPrice) > 0.01;

        // Extract and parse address
        const bitrixAddressField = dealData[BITRIX_DEAL_FIELDS.ADDRESS] ||
            dealData[BITRIX_DEAL_FIELDS.ADDRESS.toLowerCase()] || '';
        let addressChanged = false;
        let parsedAddress = null;
        let addressUpdateAttempted = false;

        if (bitrixAddressField && typeof bitrixAddressField === 'string' && bitrixAddressField.trim() !== '') {
            parsedAddress = parseBitrixAddressString(bitrixAddressField);

            if (parsedAddress && Object.keys(parsedAddress).length > 0) {
                // Try to get country code from country name
                if (parsedAddress.country && !parsedAddress.country_code) {
                    try {
                        const countriesResponse = await callShopifyAdmin('/countries.json');
                        const countries = countriesResponse.countries || [];
                        const countryMatch = countries.find(c =>
                            c.name.toLowerCase() === parsedAddress.country.toLowerCase()
                        );
                        if (countryMatch) {
                            parsedAddress.country_code = countryMatch.code;
                            parsedAddress.country = countryMatch.name;
                        }
                    } catch (countryError) {
                        logger.warn('address_country_resolve_error', 'Failed to resolve country code', { error: countryError.message });
                    }
                }

                // Compare with current Shopify address
                const currentAddress = shopifyOrder.shipping_address || {};
                addressChanged = hasAddressChanged(parsedAddress, currentAddress);

                logger.info('address_update_check', 'Checking address update', { requestId, dealId, shopifyOrderId, bitrixAddress: bitrixAddressField, parsedAddress, addressChanged, deliveryPriceChanged });

                // Always update if address is provided
                const shouldUpdateAddress = addressChanged || Object.keys(parsedAddress).length > 0;

                if (shouldUpdateAddress || deliveryPriceChanged) {
                    const updatePayload = {};

                    if (parsedAddress && Object.keys(parsedAddress).length > 0) {
                        const addressForShopify = { ...parsedAddress };
                        // Remove province - Shopify validates strictly
                        delete addressForShopify.province;

                        // Enrich with contact name/phone
                        try {
                            const contactIdRaw = dealData.CONTACT_ID || dealData.contact_id || null;
                            const contactId = contactIdRaw && String(contactIdRaw) !== '0' ? String(contactIdRaw) : null;
                            if (contactId) {
                                const contactResp = await callBitrix('/crm.contact.get.json', { id: contactId });
                                const contact = contactResp?.result || null;
                                if (contact) {
                                    if (contact.NAME && !addressForShopify.first_name) {
                                        addressForShopify.first_name = String(contact.NAME);
                                    }
                                    if (contact.LAST_NAME && !addressForShopify.last_name) {
                                        addressForShopify.last_name = String(contact.LAST_NAME);
                                    }
                                    const phoneRaw = contact.PHONE;
                                    const phoneValue = Array.isArray(phoneRaw) ? phoneRaw?.[0]?.VALUE : phoneRaw?.VALUE;
                                    if (phoneValue && !addressForShopify.phone) {
                                        addressForShopify.phone = String(phoneValue);
                                    }
                                }
                            }
                        } catch (contactError) {
                            logger.warn('address_contact_enrich_error', 'Failed to enrich from contact', { error: contactError.message });
                        }

                        updatePayload.shipping_address = addressForShopify;
                    }

                    // Add shipping lines if price changed
                    if (deliveryPriceChanged && deliveryPrice !== null) {
                        const currentShippingTitle = currentShippingLines.length > 0
                            ? currentShippingLines[0].title
                            : 'Standard Shipping';

                        updatePayload.shipping_lines = [{
                            title: currentShippingTitle,
                            price: deliveryPrice.toFixed(2),
                            code: currentShippingLines[0]?.code || 'CUSTOM_EDIT'
                        }];
                    }

                    logger.info('address_update_payload', 'Address update payload prepared', { requestId, dealId, shopifyOrderId, updatePayloadKeys: Object.keys(updatePayload) });

                    const correlationId = `${dealId}:${Date.now()}`;
                    addressUpdateAttempted = true;
                    const addressResult = await updateShippingAddress(shopifyOrderId, updatePayload, correlationId, null);

                    if (addressResult.success) {
                        logger.info('address_update_success', 'Address updated successfully in Shopify', { requestId, dealId, shopifyOrderId });
                        return { updated: true, addressUpdated: true, priceUpdated: deliveryPriceChanged };
                    } else {
                        logger.warn('address_update_error', 'Address update failed in Shopify', { requestId, dealId, shopifyOrderId, error: addressResult.error, message: addressResult.message });
                        return { updated: false, error: addressResult.error };
                    }
                } else {
                    logger.info('address_update_no_change', 'No address change detected', { requestId, dealId, shopifyOrderId });
                }
            } else {
                logger.warn('address_parse_failed', 'Failed to parse Bitrix address string', { requestId, dealId, shopifyOrderId, bitrixAddress: bitrixAddressField });
            }
        }

        // Handle delivery price only update (if address wasn't updated)
        if (deliveryPriceChanged && !addressUpdateAttempted) {
            logger.info('delivery_price_update_detected', 'Delivery price change detected', { requestId, dealId, shopifyOrderId, newDeliveryPrice: deliveryPrice, currentDeliveryPrice: currentShippingPrice });

            const correlationId = `${dealId}:${Date.now()}`;
            const currentShippingTitle = currentShippingLines.length > 0
                ? currentShippingLines[0].title
                : 'Standard Shipping';

            const addressResult = await updateShippingAddress(shopifyOrderId, {
                shipping_lines: [{
                    title: currentShippingTitle,
                    price: deliveryPrice.toFixed(2),
                    code: currentShippingLines[0]?.code || 'CUSTOM_EDIT'
                }]
            }, correlationId, null);

            if (addressResult.success) {
                logger.info('delivery_price_update_success', 'Delivery price updated successfully', { requestId, dealId, shopifyOrderId, newDeliveryPrice: deliveryPrice });
                return { updated: true, addressUpdated: false, priceUpdated: true };
            } else {
                logger.warn('delivery_price_update_error', 'Delivery price update failed', { requestId, dealId, shopifyOrderId, error: addressResult.error });
                return { updated: false, error: addressResult.error };
            }
        }

        return { updated: false, reason: 'no_changes' };

    } catch (orderCheckError) {
        logger.error('address_update_exception', 'Unexpected exception during address update', { shopifyOrderId, error: orderCheckError.message });
        return { updated: false, error: orderCheckError.message };
    }
}

export default { handleAddressUpdate, parseBitrixAddressString, hasAddressChanged };
