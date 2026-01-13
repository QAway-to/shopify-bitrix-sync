/**
 * Order Create Block Handler
 * Extracted from bitrix.js handleDealUpdate (lines 2800-3198)
 * 
 * Purpose: Create Shopify order from Bitrix deal when no order exists
 * Trigger: shopifyOrderId is empty AND deal has product rows
 * 
 * Flow:
 * 1. Double-check for existing order (race condition prevention)
 * 2. Get product rows from Bitrix deal
 * 3. Map products to Shopify variants (by SKU or XML_ID)
 * 4. Create stub order if no valid products (optional)
 * 5. Create order with customer email and shipping info
 * 6. Update deal with new shopifyOrderId
 */

import { getOrder, callShopifyAdmin } from '../shopify/adminClient.js';
import { createOrderFromBitrix, findExistingOrderByDealId } from '../shopify/order.js';
import { callBitrix } from '../bitrix/client.js';
import { parseBitrixAddressString } from './addressUpdate.js';
import { BITRIX_DEAL_FIELDS } from '../shared/constants.js';

// Configuration from environment
const BITRIX_ALLOW_EMPTY_PRODUCT_LINES = process.env.BITRIX_ALLOW_EMPTY_PRODUCT_LINES === 'true';
const BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID = String(process.env.BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID || '53051786756360');
const BITRIX_EMPTY_ORDER_DEFAULT_QTY = Number(process.env.BITRIX_EMPTY_ORDER_DEFAULT_QTY || 1) || 1;
const BITRIX_FALLBACK_CUSTOMER_EMAIL = String(process.env.BITRIX_FALLBACK_CUSTOMER_EMAIL || 'hold@bfcshoes.local');

/**
 * Resolve customer email from deal data
 * @param {Object} dealData - Deal data from Bitrix
 * @param {string} requestId - Request correlation ID
 * @param {string} dealId - Bitrix deal ID
 * @returns {Promise<string>} Customer email
 */
async function resolveCustomerEmailFromDeal(dealData, requestId, dealId) {
    // Try to get contact email from deal
    const contactIdRaw = dealData.CONTACT_ID || dealData.contact_id || null;
    const contactId = contactIdRaw && String(contactIdRaw) !== '0' ? String(contactIdRaw) : null;

    if (contactId) {
        try {
            const contactResp = await callBitrix('/crm.contact.get.json', { id: contactId });
            const contact = contactResp?.result || null;
            if (contact) {
                const emailRaw = contact.EMAIL;
                const emailValue = Array.isArray(emailRaw) ? emailRaw?.[0]?.VALUE : emailRaw?.VALUE;
                if (emailValue && emailValue.includes('@')) {
                    return String(emailValue);
                }
            }
        } catch (contactError) {
            console.warn(`[ORDER CREATE] Failed to get contact email: ${contactError.message}`);
        }
    }

    return BITRIX_FALLBACK_CUSTOMER_EMAIL;
}

/**
 * Handle Order Creation from Bitrix deal
 * @param {string} dealId - Bitrix deal ID
 * @param {Object} dealData - Full deal data from Bitrix
 * @param {string} requestId - Request correlation ID
 * @param {string} currentShopifyOrderId - Current Shopify order ID (may be empty)
 * @returns {Promise<{created: boolean, shopifyOrderId?: string}>}
 */
export async function handleOrderCreate(dealId, dealData, requestId, currentShopifyOrderId) {
    console.log(JSON.stringify({
        event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRE_CHECK',
        requestId,
        dealId,
        eventType: 'handleOrderCreate',
        shopifyOrderId: currentShopifyOrderId || 'empty',
        shopifyOrderIdExists: !!(currentShopifyOrderId && currentShopifyOrderId.trim() !== ''),
        timestamp: new Date().toISOString()
    }));

    let shouldCreateOrder = !currentShopifyOrderId || currentShopifyOrderId.trim() === '';
    let existingShopifyOrderId = currentShopifyOrderId;

    if (!shouldCreateOrder) {
        return { created: false, reason: 'order_already_exists', shopifyOrderId: currentShopifyOrderId };
    }

    // Race condition protection: Re-check after short delay
    await new Promise(resolve => setTimeout(resolve, 200));

    try {
        const dealRecheckResp = await callBitrix('/crm.deal.get.json', { id: dealId });
        if (dealRecheckResp.result) {
            const recheckShopifyOrderId = dealRecheckResp.result[BITRIX_DEAL_FIELDS.SHOPIFY_ORDER_ID] ||
                dealRecheckResp.result[BITRIX_DEAL_FIELDS.SHOPIFY_ORDER_ID.toLowerCase()];
            if (recheckShopifyOrderId && recheckShopifyOrderId.trim() !== '') {
                console.log(JSON.stringify({
                    event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK',
                    requestId,
                    dealId,
                    message: 'Found shopifyOrderId on recheck (race condition prevented)',
                    shopifyOrderId: recheckShopifyOrderId,
                    timestamp: new Date().toISOString()
                }));
                return { created: false, reason: 'race_condition_prevented', shopifyOrderId: recheckShopifyOrderId };
            }
        }
    } catch (recheckError) {
        console.warn(`[ORDER CREATE] Error rechecking deal for shopifyOrderId:`, recheckError);
    }

    // Check Shopify for existing order by tag
    const existingOrderId = await findExistingOrderByDealId(dealId);
    if (existingOrderId) {
        console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK',
            requestId,
            dealId,
            message: 'Found existing order in Shopify by BITRIX tag (duplicate prevented)',
            existingShopifyOrderId: existingOrderId,
            timestamp: new Date().toISOString()
        }));

        // Update deal with found shopifyOrderId
        try {
            await callBitrix('/crm.deal.update.json', {
                id: dealId,
                fields: { [BITRIX_DEAL_FIELDS.SHOPIFY_ORDER_ID]: existingOrderId }
            });
        } catch (updateError) {
            console.warn(`[ORDER CREATE] Failed to update deal with found shopifyOrderId:`, updateError);
        }

        return { created: false, reason: 'existing_order_found', shopifyOrderId: existingOrderId };
    }

    // Get product rows from deal
    try {
        const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', { id: dealId });

        console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRODUCT_ROWS_RESPONSE',
            requestId,
            dealId,
            productRowsExists: !!(productRowsResp && productRowsResp.result),
            productRowsCount: productRowsResp?.result?.length || 0,
            timestamp: new Date().toISOString()
        }));

        if (!productRowsResp.result || !Array.isArray(productRowsResp.result)) {
            return { created: false, reason: 'no_product_rows' };
        }

        // Convert Bitrix product rows to Shopify items
        const items = [];
        let isStubOrder = false;
        let stubReason = null;

        for (const row of productRowsResp.result) {
            const productId = row.PRODUCT_ID;
            if (!productId) continue;

            try {
                const productResp = await callBitrix('/crm.product.get.json', { id: productId });
                if (productResp.result) {
                    const product = productResp.result;
                    const code = product.CODE;
                    const xmlId = product.XML_ID;

                    if (code && code.trim() !== '') {
                        items.push({ sku: code.trim(), qty: row.QUANTITY || 1 });
                        console.log(`[ORDER CREATE] Product ${productId}: Using CODE as SKU: ${code.trim()}`);
                    } else if (xmlId && xmlId.toString().trim() !== '') {
                        items.push({ variantId: xmlId.toString().trim(), qty: row.QUANTITY || 1 });
                        console.log(`[ORDER CREATE] Product ${productId}: Using XML_ID as variantId: ${xmlId}`);
                    } else {
                        console.warn(`[ORDER CREATE] Product ${productId} has no CODE or XML_ID, skipping`);
                    }
                }
            } catch (productError) {
                console.error(`[ORDER CREATE] Error getting product ${productId}:`, productError);
            }
        }

        console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ITEMS_COLLECTED',
            requestId,
            dealId,
            itemsCount: items.length,
            items: items.map(i => ({ sku: i.sku, qty: i.qty })),
            timestamp: new Date().toISOString()
        }));

        // Add default product if empty (stub order)
        if (items.length === 0 && BITRIX_ALLOW_EMPTY_PRODUCT_LINES) {
            items.push({
                variantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
                qty: BITRIX_EMPTY_ORDER_DEFAULT_QTY
            });
            isStubOrder = true;
            stubReason = productRowsResp.result.length === 0 ? 'empty_product_rows' : 'no_mappable_items';

            console.log(JSON.stringify({
                event: 'BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED',
                requestId,
                dealId,
                defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
                reason: stubReason,
                timestamp: new Date().toISOString()
            }));
        }

        if (items.length === 0) {
            return { created: false, reason: 'no_valid_items' };
        }

        // Parse shipping address
        let shippingAddress = null;
        const bitrixAddressField = dealData[BITRIX_DEAL_FIELDS.ADDRESS] ||
            dealData[BITRIX_DEAL_FIELDS.ADDRESS.toLowerCase()] || '';
        if (bitrixAddressField && typeof bitrixAddressField === 'string' && bitrixAddressField.trim() !== '') {
            const parsedAddress = parseBitrixAddressString(bitrixAddressField);
            if (parsedAddress && Object.keys(parsedAddress).length > 0) {
                // Try to resolve country code
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
                        console.warn(`[ORDER CREATE] Failed to resolve country code: ${countryError.message}`);
                    }
                }
                shippingAddress = parsedAddress;
            }
        }

        // Default shipping lines
        const shippingLines = [{
            title: 'Standard Shipping',
            price: '0.00',
            code: 'Free'
        }];

        // Create order
        console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ATTEMPT',
            requestId,
            dealId,
            itemsCount: items.length,
            timestamp: new Date().toISOString()
        }));

        const correlationId = `bitrix:${dealId}:${requestId}`;
        const customerEmail = await resolveCustomerEmailFromDeal(dealData, requestId, dealId);

        const orderResult = await createOrderFromBitrix(items, dealId, correlationId, {
            shippingAddress,
            shippingLines,
            customerEmail,
            isStubOrder,
            stubReason,
            stubDefaultVariantId: null
        });

        if (!orderResult.success) {
            console.log(JSON.stringify({
                event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ERROR',
                requestId,
                dealId,
                error: orderResult.error,
                message: orderResult.message,
                timestamp: new Date().toISOString()
            }));
            return { created: false, error: orderResult.error };
        }

        // Update Bitrix deal with new order ID
        const createdOrderId = String(orderResult.orderId);
        let orderName = orderResult.orderName;

        // Fetch real order name if duplicate
        if (orderResult.wasDuplicate && orderName && !orderName.startsWith('#')) {
            try {
                const existingOrder = await getOrder(createdOrderId);
                if (existingOrder && existingOrder.name) {
                    orderName = existingOrder.name;
                }
            } catch (fetchError) {
                console.warn(`[ORDER CREATE] Failed to fetch order name: ${fetchError.message}`);
            }
        }

        // Update deal
        try {
            const currentTitle = dealData.TITLE || '';
            const updateFields = { [BITRIX_DEAL_FIELDS.SHOPIFY_ORDER_ID]: createdOrderId };

            // Update TITLE with order number
            const orderNumberFromName = orderName ? orderName.replace('#', '') : null;
            const orderNumberPattern = orderNumberFromName ? new RegExp(`#?${orderNumberFromName}\\b`) : /#\d+/;
            const alreadyContainsThisOrderNumber = orderNumberFromName && orderNumberPattern.test(currentTitle);

            const isValidOrderName = orderName && orderName.trim() !== '' &&
                (orderName.startsWith('#') || /^#?\d+$/.test(orderName.replace('#', '')));
            const isNotPlaceholderName = !orderName.includes('Existing order') && !orderName.includes('Order ');

            if (!alreadyContainsThisOrderNumber && isValidOrderName && isNotPlaceholderName) {
                const formattedOrderName = orderName.startsWith('#') ? orderName : `#${orderName}`;
                updateFields.TITLE = formattedOrderName;
            }

            await callBitrix('/crm.deal.update.json', {
                id: dealId,
                fields: updateFields
            });

            console.log(JSON.stringify({
                event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SUCCESS',
                requestId,
                dealId,
                shopifyOrderId: createdOrderId,
                orderName: orderResult.orderName,
                titleUpdated: !!updateFields.TITLE,
                lineItemsCount: orderResult.lineItems?.length || 0,
                timestamp: new Date().toISOString()
            }));

            return { created: true, shopifyOrderId: createdOrderId, orderName };

        } catch (updateError) {
            console.error(`[ORDER CREATE] Error updating deal with shopifyOrderId:`, updateError);
            return { created: true, shopifyOrderId: createdOrderId, error: updateError.message };
        }

    } catch (orderCreateError) {
        console.error(`[ORDER CREATE] Error checking/creating order:`, orderCreateError);
        return { created: false, error: orderCreateError.message };
    }
}

export default { handleOrderCreate };
