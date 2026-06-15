// Bitrix24 Webhook endpoint - receives events from Bitrix and syncs to Shopify
// ⚠️ VERSION MARKER - Change this to verify deployed code version
const BITRIX_WEBHOOK_VERSION = 'v2026-01-08-A';
import '../../../src/lib/logging/consoleCapture.js';
import { createRequestLogger, logger } from '../../../src/lib/logging/logger.js';
import { callBitrix } from '../../../src/lib/bitrix/client.js';
import { bitrixAdapter } from '../../../src/lib/adapters/bitrix/index.js';
import { BITRIX_CONFIG } from '../../../src/lib/bitrix/config.js';
import { getFulfillmentOrders, getOrderForFulfillment, createFulfillment, getPostFulfillmentState } from '../../../src/lib/shopify/fulfillment.js';

import { createHoldOrder } from '../../../src/lib/shopify/hold.js';
import { createRefund } from '../../../src/lib/shopify/refund.js';
import { updateShippingAddress } from '../../../src/lib/shopify/address.js';
import { createOrderFromBitrix, findExistingOrderByDealId, cancelOrderByDealId, cancelOrderById, addTagToOrder } from '../../../src/lib/shopify/order.js';
import { getProvenanceMarker, setProvenanceMarker } from '../../../src/lib/shopify/metafields.js';
import { addPositionToOrder, incrementLineItemQuantity, decrementLineItemQuantity } from '../../../src/lib/shopify/orderEdit.js';
import { extractDealId, extractAuthToken, getPayloadKeys } from '../../../src/lib/bitrix/webhookParser.js';
import { payloadHash, cleanEmptyFields } from '../../../src/lib/utils/hash.js';
import { getBitrixExpectedAuthToken } from '../../../src/lib/bitrix/client.js';
import { findShopifyVariantByAttributes, createShopifyOrderForPreorder } from '../../../src/lib/shopify/adminClient.js';
import { syncProductVariantOptimized, getSizeEnumId } from '../../../src/lib/bitrix/products.js';
import { isDeliveryStage, DELIVERY_STAGES } from '../../../src/lib/bitrix/stageMapping.js';
import { resolveCatalogOrderItems, resolveRegularOrderItems } from '../../../src/lib/blocks/orderItems.js';
import { findOrCreateShopifyProduct } from '../../../src/lib/shopify/productCreate.js';
import { BITRIX_DEAL_FIELDS } from '../../../src/lib/shared/constants.js';

// ✅ EXTRACTED BLOCK MODULES (available for isolated debugging)
// These modules contain the same logic as inline code below.
// To switch to modular version, replace inline blocks with module calls.
// Modules: preOrder, cancel, addressUpdate, quantitySync, orderCreate
// import { handlePreOrder } from '../../../src/lib/blocks/preOrder.js';
// import { handleCancel, isLoseStage } from '../../../src/lib/blocks/cancel.js';
// import { handleAddressUpdate } from '../../../src/lib/blocks/addressUpdate.js';
// import { handleQuantitySync } from '../../../src/lib/blocks/quantitySync.js';
// import { handleOrderCreate } from '../../../src/lib/blocks/orderCreate.js';

// Expected auth token from Bitrix
const EXPECTED_AUTH_TOKEN = getBitrixExpectedAuthToken();
const BITRIX_FALLBACK_CUSTOMER_EMAIL = String(process.env.BITRIX_FALLBACK_CUSTOMER_EMAIL || 'admin@fbfcshoes.com');

async function resolveCustomerEmailFromDeal(dealData, requestId, dealId, context) {
  const contactIdRaw = dealData?.CONTACT_ID || dealData?.contact_id || null;
  const contactId = contactIdRaw && String(contactIdRaw) !== '0' ? String(contactIdRaw) : null;

  if (!contactId) {
        logger.info('BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED', 'BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED', {requestId,
      dealId,
      context,
      source: 'fallback_no_contact_id',
      email: BITRIX_FALLBACK_CUSTOMER_EMAIL});
    return BITRIX_FALLBACK_CUSTOMER_EMAIL;
  }

  try {
    const contactResp = await callBitrix('/crm.contact.get.json', { id: contactId });
    const contact = contactResp?.result || null;

    const emailRaw = contact?.EMAIL;
    const emailValue = Array.isArray(emailRaw) ? emailRaw?.[0]?.VALUE : (emailRaw?.VALUE || emailRaw);
    const email = emailValue && String(emailValue).trim() !== '' ? String(emailValue).trim() : null;

    if (email) {
            logger.info('BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED', 'BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED', {requestId,
        dealId,
        context,
        source: 'contact',
        contactId,
        email});
      return email;
    }


    // ✅ FALLBACK: If no email, use default admin email.
    // Phone is passed separately in the phone field — do NOT use it as email.
        logger.info('BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED', 'BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED', {requestId,
      dealId,
      context,
      source: 'fallback_contact_has_no_email',
      contactId,
      email: BITRIX_FALLBACK_CUSTOMER_EMAIL});
    return BITRIX_FALLBACK_CUSTOMER_EMAIL;
  } catch (err) {
        logger.info('BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED', 'BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED', {requestId,
      dealId,
      context,
      source: 'fallback_contact_fetch_error',
      contactId,
      email: BITRIX_FALLBACK_CUSTOMER_EMAIL,
      error: err?.message || String(err)});
    return BITRIX_FALLBACK_CUSTOMER_EMAIL;
  }
}

// ✅ Optional: allow creating Shopify order even when Bitrix deal has 0 product rows.
// Useful when Bitrix sends empty product line but we still want to reserve inventory / create placeholder order.
// ⚠️ TEMPORARILY DISABLED: User requested to disable stub/placeholder orders (leads without products)
const BITRIX_ALLOW_EMPTY_PRODUCT_LINES = false; // Was: String(process.env.BITRIX_ALLOW_EMPTY_PRODUCT_LINES || 'true').toLowerCase() === 'true';
const BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID = String(process.env.BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID || '53051786756360');
const BITRIX_EMPTY_ORDER_DEFAULT_QTY = Number(process.env.BITRIX_EMPTY_ORDER_DEFAULT_QTY || 1) || 1;

function bitrixPaymentEnumToDesiredFinancialStatus(paymentEnumId) {
  const v = paymentEnumId != null ? String(paymentEnumId) : '';
  // Bitrix field UF_CRM_1739183959976:
  // "56" = Paid, "58" = Unpaid, "60" = 10% prepayment
  if (v === '56') return 'paid';
  if (v === '58') return 'pending';
  if (v === '60') return 'partially_paid';
  return null;
}

async function syncShopifyPaymentStatusFromBitrix(dealData, shopifyOrderId, requestId, dealId) {
  const paymentEnumId = dealData?.UF_CRM_1739183959976 || dealData?.uf_crm_1739183959976 || null;
  const desired = bitrixPaymentEnumToDesiredFinancialStatus(paymentEnumId);

  if (!desired) {
        logger.info('PAYMENT_STATUS_SYNC_SKIP', 'PAYMENT_STATUS_SYNC_SKIP', {requestId,
      dealId,
      shopifyOrderId,
      reason: 'missing_or_unknown_payment_enum',
      paymentEnumId});
    return { success: true, skipped: true, reason: 'unknown_payment_enum' };
  }

  // ✅ Force pending status if deal is not in WON stage
  // ✅ Force pending status if deal is not in WON stage
  const stageId = dealData?.STAGE_ID || dealData?.stage_id || null;
  // Check for any stage ending in "WON" (e.g., "WON", "C4:WON", "C6:WON")
  const isWonStage = stageId && (stageId === 'WON' || stageId.endsWith(':WON'));

  if (!isWonStage) {
    if (desired !== 'pending') {
            logger.info('PAYMENT_STATUS_SYNC_FORCE_PENDING', 'PAYMENT_STATUS_SYNC_FORCE_PENDING', {requestId,
        dealId,
        shopifyOrderId,
        stageId,
        originalDesired: desired,
        reason: 'deal_not_won'});
      // Override desired status to pending because deal is not finished
      // We modify the 'desired' variable? No, 'desired' is const.
      // We'll just handle it in the checking logic below.
    }
  }

  try {
    const { getOrder, callShopifyAdmin, callShopifyGraphQL } = await import('../../../src/lib/shopify/adminClient.js');
    const currentOrder = await getOrder(shopifyOrderId);
    const current = currentOrder?.financial_status || null;
    const totalPrice = Number(currentOrder?.total_price || currentOrder?.current_total_price || 0);
    const currency = currentOrder?.currency || null;

    // Determine final desired status:
    // User Update 2024-12-31: Trust the 'desired' status from the enum implicitly.
    // Even if stage is not WON, if the payment field says PAID, we make it PAID.
    const finalDesired = desired; // !isWonStage ? 'pending' : desired;


        logger.info('PAYMENT_STATUS_SYNC_CHECK', 'PAYMENT_STATUS_SYNC_CHECK', {requestId,
      dealId,
      shopifyOrderId,
      bitrixPaymentEnumId: paymentEnumId,
      desiredFinancialStatus: finalDesired,
      originalDesired: desired,
      stageId,
      isWonStage,
      currentFinancialStatus: current,
      totalPrice,
      currency});

    // Logic:
    // 1. If desired is Pending and current is Paid -> Revert to Pending (via REST)
    // 2. If desired is Paid and current is Pending/PartiallyPaid -> Mark as Paid (via REST transaction)
    // Implementation: currently we only support reverting to pending (Unpaid -> Pending enforcement).

    // CASE 2: Pending -> Paid (GraphQL Mutation)
    if (finalDesired === 'paid' && current !== 'paid') {
      // ✅ GUARD 1: Don't re-mark as paid if order is already refunded/cancelled (race condition protection)
      // When Shopify refund fires → handleOrderUpdated updates Bitrix → Bitrix webhook fires back here.
      // Without this guard, we'd try to mark a refunded order as paid again.
      const refundedStatuses = ['refunded', 'partially_refunded', 'voided'];
      if (refundedStatuses.includes(current)) {
                logger.info('PAYMENT_STATUS_SYNC_BLOCKED_REFUNDED', 'PAYMENT_STATUS_SYNC_BLOCKED_REFUNDED', {requestId,
          dealId,
          shopifyOrderId,
          currentFinancialStatus: current,
          reason: 'order_already_refunded_or_cancelled'});
        return { success: true, skipped: true, reason: 'order_already_refunded', current };
      }

      // ✅ GUARD 2: Don't call orderMarkAsPaid if order has real gateway payments (e.g. Revolut)
      // orderMarkAsPaid creates a phantom "manual" sale transaction for the remaining balance,
      // which permanently breaks refund capability through the original gateway.
      // This protects Draft Orders with partial payment and any order with real card payments.
      let hasRealGatewayPayment = false;
      try {
        const txResp = await callShopifyAdmin(`/orders/${shopifyOrderId}/transactions.json`);
        const transactions = txResp?.transactions || [];
        hasRealGatewayPayment = transactions.some(t =>
          (t.kind === 'sale' || t.kind === 'capture') &&
          t.status === 'success' &&
          t.gateway && t.gateway !== 'manual'
        );
        if (hasRealGatewayPayment) {
          const realTx = transactions.find(t =>
            (t.kind === 'sale' || t.kind === 'capture') && t.status === 'success' && t.gateway !== 'manual'
          );
                    logger.info('PAYMENT_STATUS_SYNC_BLOCKED_GATEWAY', 'PAYMENT_STATUS_SYNC_BLOCKED_GATEWAY', {requestId,
            dealId,
            shopifyOrderId,
            reason: 'real_gateway_payment_exists',
            gateway: realTx?.gateway,
            amount: realTx?.amount,
            transactionId: realTx?.id});
          return { success: true, skipped: true, reason: 'real_gateway_payment_exists', gateway: realTx?.gateway };
        }
      } catch (txError) {
        logger.warn('payment_tx_check_error', 'Could not check transactions (non-blocking)', { shopifyOrderId, dealId, error: txError?.message });
        // Non-blocking: if we can't check, proceed with caution (existing behavior)
      }

            logger.info('PAYMENT_STATUS_SYNC_ATTEMPT_PAID', 'PAYMENT_STATUS_SYNC_ATTEMPT_PAID', {requestId,
        dealId,
        shopifyOrderId,
        current,
        totalPrice,
        method: 'GraphQL orderMarkAsPaid'});

      let transactionError = null;
      try {
        const orderGid = `gid://shopify/Order/${shopifyOrderId}`;
        const mutation = `
          mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
            orderMarkAsPaid(input: $input) {
              order {
                id
                displayFinancialStatus
                fullyPaid
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

        const variables = {
          input: {
            id: orderGid
          }
        };

        const result = await callShopifyGraphQL(mutation, variables);
        const payload = result?.orderMarkAsPaid;

        if (payload?.userErrors && payload.userErrors.length > 0) {
          transactionError = JSON.stringify(payload.userErrors);
          logger.error('payment_mark_paid_graphql_error', 'GraphQL userErrors on orderMarkAsPaid', { shopifyOrderId, dealId, errors: payload.userErrors }, { entityType: 'order', entityId: shopifyOrderId });
        } else if (!payload?.order) {
          transactionError = "Unknown GraphQL error (missing order in response)";
        } else {
          const orderData = payload.order;
          logger.info('payment_mark_paid_success', 'Order marked as paid via GraphQL', { shopifyOrderId, dealId, orderName: orderData?.name, displayStatus: orderData?.displayFinancialStatus, fullyPaid: orderData?.fullyPaid }, { entityType: 'order', entityId: shopifyOrderId });
        }

      } catch (err) {
        transactionError = err?.message || String(err);
        logger.error('payment_mark_paid_error', 'Failed to execute orderMarkAsPaid', { shopifyOrderId, dealId, error: err?.message }, { entityType: 'order', entityId: shopifyOrderId });
      }

      // Re-fetch to verify
      const after = await getOrder(shopifyOrderId);
      const success = after?.financial_status === 'paid';

            logger.info('PAYMENT_STATUS_SYNC_RESULT_PAID', 'PAYMENT_STATUS_SYNC_RESULT_PAID', {requestId,
        dealId,
        shopifyOrderId,
        before: current,
        after: after?.financial_status,
        success,
        error: transactionError});

      return { success, from: current, to: after?.financial_status, operation: 'graphql_mark_paid' };
    }

    if (finalDesired === 'pending' && current === 'paid') {
      let updateError = null;
      try {
        await callShopifyAdmin(`/orders/${shopifyOrderId}.json`, {
          method: 'PUT',
          body: JSON.stringify({
            order: {
              id: shopifyOrderId,
              financial_status: 'pending'
            }
          })
        });
      } catch (err) {
        updateError = err?.message || String(err);
      }

      // Re-fetch to verify
      const after = await getOrder(shopifyOrderId);
      const afterStatus = after?.financial_status || null;

            logger.info('PAYMENT_STATUS_SYNC_RESULT', 'PAYMENT_STATUS_SYNC_RESULT', {requestId,
        dealId,
        shopifyOrderId,
        desiredFinancialStatus: finalDesired,
        beforeFinancialStatus: current,
        afterFinancialStatus: afterStatus,
        updateError});

      return {
        success: true,
        attempted: true,
        before: current,
        after: afterStatus,
        updateError
      };
    }

    // Optional: Handle Pending -> Paid if needed in future (requires creating transaction)

    return { success: true, skipped: true, reason: 'no_change_needed', desired: finalDesired, current };
  } catch (err) {
        logger.error('payment_status_sync_error', 'Payment status sync failed', {requestId,
      dealId,
      shopifyOrderId,
      error: err?.message || String(err),
      stack: err?.stack});
    return { success: false, error: 'PAYMENT_STATUS_SYNC_ERROR', message: err?.message || String(err) };
  }
}

/**
 * Parse Bitrix address string into Shopify address format
 * Format: "Street, ZIP City Region, Country | coordinate"
 * Example: "Rue de l'Église Sainte-Anne - Sint-Annakerkstraat 78, 1081 Koekelberg Brussels-Capital, Belgium | 50.859"
 * @param {string} addressString - Address string from Bitrix
 * @returns {Object|null} Parsed address object or null if parsing fails
 */
function parseBitrixAddressString(addressString) {
  if (!addressString || typeof addressString !== 'string') {
    return null;
  }

  try {
    // Remove coordinate part if present (everything after |)
    const addressPart = addressString.split('|')[0].trim();

    // Split by commas
    const parts = addressPart.split(',').map(p => p.trim()).filter(p => p);

    if (parts.length < 2) {
      // Not enough parts, return as address1
      return {
        address1: addressPart
      };
    }

    // Last part should be country
    const country = parts[parts.length - 1];

    // Second to last part should be "ZIP City Region"
    let zip = '';
    let city = '';
    let province = '';

    if (parts.length >= 2) {
      const locationPart = parts[parts.length - 2];
      // Try to extract ZIP (usually at the start, 4-5 digits)
      // Support formats like "1030 Schaerbeek - Schaarbeek Brussels-Capital"
      const zipMatch = locationPart.match(/^(\d{4,5})\s+(.+)/);
      if (zipMatch) {
        zip = zipMatch[1];
        const cityRegion = zipMatch[2];
        // Handle formats with dashes like "Schaerbeek - Schaarbeek Brussels-Capital"
        // Remove city variant after dash (e.g., "Schaerbeek - Schaarbeek" -> "Schaerbeek")
        const cityRegionClean = cityRegion.replace(/\s*-\s*[^-]+(?=\s|$)/, '').trim();
        const cityRegionParts = cityRegionClean.split(/\s+/);
        if (cityRegionParts.length > 1) {
          // Check if last part contains dash (likely region like "Brussels-Capital")
          const lastPart = cityRegionParts[cityRegionParts.length - 1];
          if (lastPart.includes('-') || cityRegionParts.length > 2) {
            // Last part is likely region
            city = cityRegionParts.slice(0, -1).join(' ');
            province = cityRegionParts[cityRegionParts.length - 1];
          } else {
            // All parts are city
            city = cityRegionClean;
          }
        } else {
          city = cityRegionClean;
        }
      } else {
        // No ZIP found, treat whole part as city
        city = locationPart;
      }
    }

    // First part(s) should be street address
    const streetParts = parts.slice(0, parts.length - 2);
    const address1 = streetParts.join(', ');

    const parsed = {
      address1: address1 || addressPart
    };

    if (city) parsed.city = city;
    if (zip) parsed.zip = zip;
    if (province) parsed.province = province;
    if (country) parsed.country = country;

    return parsed;
  } catch (error) {
    logger.warn('address_parse_error', 'Failed to parse Bitrix address string', { addressString, error: error.message });
    // Fallback: return as address1
    return {
      address1: addressString.split('|')[0].trim()
    };
  }
}

/**
 * Check if address has changed by comparing key fields
 * @param {Object} newAddress - New address from Bitrix
 * @param {Object} currentAddress - Current address from Shopify
 * @returns {boolean} True if address changed
 */
function hasAddressChanged(newAddress, currentAddress) {
  if (!newAddress || !currentAddress) {
    return !!newAddress;
  }

  // Compare key fields
  const fieldsToCompare = ['address1', 'city', 'zip', 'country', 'province'];

  for (const field of fieldsToCompare) {
    const newValue = (newAddress[field] || '').trim().toLowerCase();
    const currentValue = (currentAddress[field] || '').trim().toLowerCase();

    if (newValue && newValue !== currentValue) {
      return true;
    }
  }

  return false;
}

// Configure body parser - support both JSON and form-urlencoded
// Next.js automatically parses form-urlencoded when bodyParser is enabled
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
      // Next.js will parse both JSON and form-urlencoded automatically
    },
  },
};

/**
 * Normalize payload for hash calculation based on action type
 */
function normalizePayload(action, rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return null;
  }

  switch (action) {
    case 'hold_create': {
      // Normalize: {action, items:[{sku,qty}...]} - items сортировать по sku
      const items = Array.isArray(rawPayload.items) ? rawPayload.items : [];
      const normalizedItems = items
        .map(item => ({
          sku: String(item.sku || ''),
          qty: Number(item.qty || 0)
        }))
        .filter(item => item.sku && item.qty > 0)
        .sort((a, b) => a.sku.localeCompare(b.sku));

      return {
        action: 'hold_create',
        items: normalizedItems
      };
    }

    case 'refund_create': {
      // Normalize: {action, mode, items?, restock_type, refund_shipping_full, note}
      // items сортировать по sku/line_item_id
      const normalized = {
        action: 'refund_create',
        mode: String(rawPayload.mode || ''),
        restock_type: String(rawPayload.restock_type || ''),
        refund_shipping_full: Boolean(rawPayload.refund_shipping_full),
        note: String(rawPayload.note || '')
      };

      if (Array.isArray(rawPayload.items) && rawPayload.items.length > 0) {
        const normalizedItems = rawPayload.items
          .map(item => {
            const cleaned = {};
            if (item.sku) cleaned.sku = String(item.sku);
            if (item.line_item_id) cleaned.line_item_id = String(item.line_item_id);
            if (item.quantity !== undefined && item.quantity !== null) cleaned.quantity = Number(item.quantity);
            if (item.restock_type) cleaned.restock_type = String(item.restock_type);
            return cleaned;
          })
          .filter(item => Object.keys(item).length > 0 && (item.sku || item.line_item_id))
          .sort((a, b) => {
            // Sort by sku first, then by line_item_id
            if (a.sku && b.sku) {
              return a.sku.localeCompare(b.sku);
            }
            if (a.line_item_id && b.line_item_id) {
              return String(a.line_item_id).localeCompare(String(b.line_item_id));
            }
            return 0;
          });
        if (normalizedItems.length > 0) {
          normalized.items = normalizedItems;
        }
      }

      return normalized;
    }

    case 'address_update': {
      // Normalize: {action, shipping_address:{...}} - ключи сортировать, пустые поля выкинуть
      const shippingAddress = rawPayload.shipping_address || {};
      const cleanedAddress = cleanEmptyFields(shippingAddress);

      // Log raw payload for debugging
            logger.info('ADDRESS_UPDATE_NORMALIZE', 'ADDRESS_UPDATE_NORMALIZE', {rawPayloadKeys: Object.keys(rawPayload),
        shippingAddressKeys: Object.keys(shippingAddress),
        cleanedAddressKeys: Object.keys(cleanedAddress),
        hasShippingLines: !!(rawPayload.shipping_lines),
        hasDeliveryTitle: !!(rawPayload.delivery_title)});

      const normalized = {
        action: 'address_update',
        shipping_address: cleanedAddress || {}
      };

      // Include shipping_lines if provided
      if (rawPayload.shipping_lines && Array.isArray(rawPayload.shipping_lines)) {
        normalized.shipping_lines = rawPayload.shipping_lines;
      }

      // Support simplified format: delivery_title, delivery_price, delivery_code
      if (rawPayload.delivery_title || rawPayload.delivery_price) {
        normalized.delivery_title = rawPayload.delivery_title;
        normalized.delivery_price = rawPayload.delivery_price;
        normalized.delivery_code = rawPayload.delivery_code || 'CUSTOM_EDIT';
      }

      return normalized;
    }

    case 'order_cancel': {
      // Normalize: {action, refund: boolean}
      return {
        action: 'order_cancel',
        refund: Boolean(rawPayload.refund !== undefined ? rawPayload.refund : false)
      };
    }

    case 'order_position_add': {
      // Normalize: {action, variant_id: string|number, sku: string, quantity: number}
      const normalized = {
        action: 'order_position_add',
        quantity: Number(rawPayload.quantity || 1)
      };

      if (rawPayload.variant_id) {
        normalized.variant_id = String(rawPayload.variant_id);
      }
      if (rawPayload.sku) {
        normalized.sku = String(rawPayload.sku);
      }

      return normalized;
    }

    case 'order_position_increment': {
      // Normalize: {action, sku: string, quantity: number}
      return {
        action: 'order_position_increment',
        sku: String(rawPayload.sku || ''),
        quantity: Number(rawPayload.quantity || 1)
      };
    }

    case 'order_position_decrement': {
      // Normalize: {action, sku: string, new_quantity: number}
      return {
        action: 'order_position_decrement',
        sku: String(rawPayload.sku || ''),
        new_quantity: Number(rawPayload.new_quantity !== undefined ? rawPayload.new_quantity : 0)
      };
    }

    default:
      return null;
  }
}

/**
 * Handle Product Create Mode (UF_CRM_1768864699586 = 1)
 * Creates product in Shopify → Bitrix → returns variant_id for order creation
 * @param {string} dealId - Bitrix deal ID
 * @param {Object} dealData - Full deal data from Bitrix
 * @param {string} requestId - Request ID for logging
 * @returns {Promise<Object>} Result with variant_id and product data
 */
async function handleProductCreateMode(dealId, dealData, requestId) {
    logger.info('PRODUCT_CREATE_MODE_START', 'PRODUCT_CREATE_MODE_START', {requestId,
    dealId});

  try {
    // Extract product data from deal UF fields
    const brand = dealData.UF_CRM_1768251890190 || dealData.uf_crm_1768251890190 || 'BFC';
    const model = dealData.UF_CRM_1739793668182 || dealData.uf_crm_1739793668182 || '';
    const size = dealData.UF_CRM_1739793720585 || dealData.uf_crm_1739793720585 || '40';
    const color = dealData.UF_CRM_1739793651654 || dealData.uf_crm_1739793651654 || '';

    // Get price from dedicated UF field UF_CRM_1768869578330
    const priceRaw = dealData.UF_CRM_1768869578330 || dealData.uf_crm_1768869578330 || '0';
    const price = parseFloat(priceRaw) || 0;

    if (price <= 0) {
      logger.error('product_create_missing_price', 'Price is 0 or not set in UF_CRM_1768869578330', { dealId, priceRaw }, { entityType: 'deal', entityId: dealId });
      return {
        success: false,
        error: 'Price not set in UF_CRM_1768869578330',
        reason: 'missing_price'
      };
    }

    // Build product title: Brand + Model (+ Color if present)
    let title = brand;
    if (model && model.trim() !== '') {
      title += ` ${model}`;
    }
    if (color && color.trim() !== '') {
      title += ` ${color}`;
    }

    // Generate SKU from brand + size
    const sku = `${brand.replace(/\s+/g, '-').toUpperCase()}-${size}`;

        logger.info('PRODUCT_CREATE_MODE_DATA', 'PRODUCT_CREATE_MODE_DATA', {requestId,
      dealId,
      title,
      brand,
      model,
      size,
      color,
      price,
      sku});

    // Step 1: Find or Create product in Shopify
    const shopifyResult = await findOrCreateShopifyProduct({
      title,
      vendor: brand,
      size,
      price,
      sku,
      description: `${title} - Size ${size}`,
      productType: 'Shoes'
    });

    if (!shopifyResult.success) {
      logger.error('product_create_shopify_failed', 'Failed to create product in Shopify', { dealId, error: shopifyResult.error }, { entityType: 'deal', entityId: dealId });
      return {
        success: false,
        error: shopifyResult.error,
        reason: 'shopify_product_create_failed'
      };
    }

    const { variantId, productId, action } = shopifyResult;

        logger.info('PRODUCT_CREATE_MODE_SHOPIFY_SUCCESS', 'PRODUCT_CREATE_MODE_SHOPIFY_SUCCESS', {requestId,
      dealId,
      variantId,
      productId,
      action});

    // Step 2: Create/Update product in Bitrix with XML_ID = variant_id
    let bitrixProductId = null;
    try {
      // Check if product already exists in Bitrix by XML_ID
      const existingProductResp = await callBitrix('/crm.product.list.json', {
        filter: { 'XML_ID': variantId },
        select: ['ID', 'NAME', 'CODE', 'XML_ID']
      });

      if (existingProductResp.result && existingProductResp.result.length > 0) {
        bitrixProductId = existingProductResp.result[0].ID;
        logger.info('product_create_bitrix_exists', 'Bitrix product already exists', { dealId, bitrixProductId, variantId }, { entityType: 'deal', entityId: dealId });
      } else {
        // Create new product in Bitrix
        const { getSectionIdBySku } = await import('../../../src/lib/shared/constants.js');
        const sectionId = getSectionIdBySku(sku);

        const createProductResp = await callBitrix('/crm.product.add.json', {
          fields: {
            NAME: `${title} - ${size}`,
            CODE: sku,
            XML_ID: variantId, // Link to Shopify variant
            PRICE: price,
            CURRENCY_ID: 'EUR',
            SECTION_ID: sectionId,
            ACTIVE: 'Y',
            DESCRIPTION: `${title} - Size ${size}. Created from Bitrix Deal ${dealId}`,
            // Product properties
            PROPERTY_102: brand,
            PROPERTY_104: model,
            PROPERTY_106: color,
            PROPERTY_98: getSizeEnumId(size) || size  // Size Enum ID (fallback to string if not mapped)
          }
        });

        if (createProductResp.result) {
          bitrixProductId = createProductResp.result;
          logger.info('product_create_bitrix_created', 'Bitrix product created', { dealId, bitrixProductId, variantId, sku }, { entityType: 'deal', entityId: dealId });
        }
      }
    } catch (bitrixError) {
      logger.warn('product_create_bitrix_error', 'Bitrix product creation failed (non-blocking)', { dealId, error: bitrixError.message }, { entityType: 'deal', entityId: dealId });
    }

    // Step 3: Update deal's product rows with the new product
    if (bitrixProductId) {
      try {
        await callBitrix('/crm.deal.productrows.set.json', {
          id: dealId,
          rows: [{
            PRODUCT_ID: bitrixProductId,
            PRODUCT_NAME: `${title} - ${size}`,
            PRICE: price,
            QUANTITY: 1
          }]
        });
        logger.info('product_create_rows_updated', 'Deal product rows updated', { dealId, bitrixProductId }, { entityType: 'deal', entityId: dealId });
      } catch (rowsError) {
        logger.warn('product_create_rows_error', 'Failed to update deal product rows', { dealId, bitrixProductId, error: rowsError.message }, { entityType: 'deal', entityId: dealId });
      }
    }

        logger.info('PRODUCT_CREATE_MODE_SUCCESS', 'PRODUCT_CREATE_MODE_SUCCESS', {requestId,
      dealId,
      shopifyVariantId: variantId,
      shopifyProductId: productId,
      bitrixProductId,
      action});

    return {
      success: true,
      variantId,
      productId,
      bitrixProductId,
      action,
      title,
      size,
      price,
      sku
    };

  } catch (error) {
    logger.error('product_create_mode_error', 'Product create mode failed', { dealId, error: error.message }, { entityType: 'deal', entityId: dealId });
    return {
      success: false,
      error: error.message,
      reason: 'product_create_mode_error'
    };
  }
}

/**
 * Handle MW action from UF_MW_SHOPIFY_ACTION field (DRY-RUN)
 */
async function handleMWAction(dealId, requestId, dealData, shopifyOrderId) {
  // Extract UF_MW_SHOPIFY_ACTION (case-insensitive)
  const mwActionRaw = dealData.UF_MW_SHOPIFY_ACTION || dealData.uf_mw_shopify_action || '';

  if (!mwActionRaw || typeof mwActionRaw !== 'string' || mwActionRaw.trim() === '') {
    return null; // No MW action, continue with normal flow
  }

  // Parse JSON string
  let actionData = null;
  try {
    actionData = JSON.parse(mwActionRaw);
  } catch (parseError) {
    logger.warn('MW_ACTION_PARSE_ERROR', 'Failed to parse mwAction JSON', { requestId, dealId, shopifyOrderId, error: parseError.message, rawValue: mwActionRaw.substring(0, 200) });
    return { success: false, reason: 'parse_error', error: parseError.message };
  }

  // Validate action
  const action = actionData.action;
  const supportedActions = [
    'hold_create',
    'refund_create',
    'address_update',
    'order_cancel',
    'order_position_add',
    'order_position_increment',
    'order_position_decrement'
  ];

  if (!action || !supportedActions.includes(action)) {
        logger.info('MW_ACTION_PARSE_ERROR', 'MW_ACTION_PARSE_ERROR', {requestId,
      dealId,
      shopifyOrderId,
      error: `Unsupported action: ${action}`,
      supportedActions,
      receivedAction: action});
    return { success: false, reason: 'unsupported_action', action };
  }

    logger.info('MW_ACTION_PARSE_OK', 'MW_ACTION_PARSE_OK', {requestId,
    dealId,
    shopifyOrderId,
    action,
    rawPayload: actionData});

  // Normalize payload
  const normalizedPayload = normalizePayload(action, actionData);

  if (!normalizedPayload) {
        logger.info('MW_ACTION_PARSE_ERROR', 'MW_ACTION_PARSE_ERROR', {requestId,
      dealId,
      shopifyOrderId,
      action,
      error: 'Failed to normalize payload'});
    return { success: false, reason: 'normalization_failed' };
  }

  // Calculate payloadHash
  const hash = payloadHash(normalizedPayload);
  const correlationId = `${dealId}:${hash}`;

    logger.info('MW_ACTION_HASH', 'MW_ACTION_HASH', {requestId,
    dealId,
    shopifyOrderId,
    action,
    payloadHash: hash,
    correlationId,
    normalizedPayload});

  // Decision logging
  const decision = {
    hasAction: true,
    action,
    hasShopifyOrderId: !!shopifyOrderId,
    payloadHash: hash,
    correlationId
  };

    logger.info('MW_ACTION_DECISION', 'MW_ACTION_DECISION', {requestId,
    dealId,
    shopifyOrderId,
    action,
    payloadHash: hash,
    correlationId,
    decision});

  // DRY-RUN done - no Shopify write
    logger.info('MW_ACTION_DRYRUN_DONE', 'MW_ACTION_DRYRUN_DONE', {requestId,
    dealId,
    shopifyOrderId,
    action,
    payloadHash: hash,
    correlationId});

  // ✅ Write operation for hold_create
  if (action === 'hold_create' && normalizedPayload.items && normalizedPayload.items.length > 0) {
    try {
            logger.info('HOLD_CREATE_ATTEMPT', 'HOLD_CREATE_ATTEMPT', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        itemsCount: normalizedPayload.items.length,
        items: normalizedPayload.items.map(i => ({ sku: i.sku, qty: i.qty }))});

      // Create hold order in Shopify
      const holdResult = await createHoldOrder(normalizedPayload.items, correlationId, hash);

      if (holdResult.success) {
        // Set provenance marker with payloadHash (use orderId from created order)
        const createdOrderId = String(holdResult.orderId);
        const provenanceResult = await setProvenanceMarker(createdOrderId, correlationId, 'hold_create', hash);

        if (provenanceResult.success) {
                    logger.info('SHOPIFY_PROVENANCE_SET', 'SHOPIFY_PROVENANCE_SET', {requestId,
            dealId,
            correlationId,
            shopifyOrderId: holdResult.orderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus});
        }

                logger.info('HOLD_CREATE_SUCCESS', 'HOLD_CREATE_SUCCESS', {requestId,
          dealId,
          shopifyOrderId: holdResult.orderId,
          orderName: holdResult.orderName,
          correlationId,
          payloadHash: hash,
          lineItemsCount: holdResult.lineItems?.length || 0});

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          holdOrderId: holdResult.orderId,
          holdOrderName: holdResult.orderName
        };
      } else {
                logger.info('HOLD_CREATE_ERROR', 'HOLD_CREATE_ERROR', {requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: holdResult.error,
          message: holdResult.message});

        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: holdResult.error,
          message: holdResult.message
        };
      }
    } catch (holdError) {
            logger.info('HOLD_CREATE_ERROR', 'HOLD_CREATE_ERROR', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'HOLD_CREATE_EXCEPTION',
        message: holdError.message,
        stack: holdError.stack});

      return {
        success: false,
        action,
        payloadHash: hash,
        correlationId,
        error: 'HOLD_CREATE_EXCEPTION',
        message: holdError.message
      };
    }
  }

  // ✅ Write operation for refund_create
  if (action === 'refund_create' && shopifyOrderId) {
    try {
            logger.info('REFUND_CREATE_ATTEMPT', 'REFUND_CREATE_ATTEMPT', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        mode: normalizedPayload.mode,
        itemsCount: normalizedPayload.items?.length || 0,
        refundShippingFull: normalizedPayload.refund_shipping_full});

      // Create refund in Shopify
      const refundResult = await createRefund(shopifyOrderId, normalizedPayload, correlationId, hash);

      if (refundResult.success) {
        // Set provenance marker with payloadHash
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'refund_create', hash);

        if (provenanceResult.success) {
                    logger.info('SHOPIFY_PROVENANCE_SET', 'SHOPIFY_PROVENANCE_SET', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus});
        }

        // Add BitrixUpdated tag to prevent webhook loop
        try {
          const { addTagToOrder } = await import('../../../src/lib/shopify/order.js');
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
                        logger.info('BITRIX_UPDATED_TAG_ADDED', 'BITRIX_UPDATED_TAG_ADDED', {requestId,
              dealId,
              shopifyOrderId,
              action: 'refund_create'});
          } else {
                        logger.warn('BITRIX_UPDATED_TAG_ADD_ERROR', 'BITRIX_UPDATED_TAG_ADD_ERROR', {requestId,
              dealId,
              shopifyOrderId,
              error: tagResult.message});
          }
        } catch (tagError) {
                    logger.warn('BITRIX_UPDATED_TAG_ADD_EXCEPTION', 'BITRIX_UPDATED_TAG_ADD_EXCEPTION', {requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message});
        }

                logger.info('REFUND_CREATE_SUCCESS', 'REFUND_CREATE_SUCCESS', {requestId,
          dealId,
          shopifyOrderId,
          refundId: refundResult.refundId,
          refundAmount: refundResult.refundAmount,
          refundLineItemsCount: refundResult.refundLineItemsCount,
          correlationId,
          payloadHash: hash});

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          refundId: refundResult.refundId,
          refundAmount: refundResult.refundAmount
        };
      } else {
                logger.info('REFUND_CREATE_ERROR', 'REFUND_CREATE_ERROR', {requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: refundResult.error,
          message: refundResult.message,
          httpStatus: refundResult.httpStatus});

        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: refundResult.error,
          message: refundResult.message
        };
      }
    } catch (refundError) {
            logger.info('REFUND_CREATE_ERROR', 'REFUND_CREATE_ERROR', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'REFUND_CREATE_EXCEPTION',
        message: refundError.message,
        stack: refundError.stack});

      return {
        success: false,
        action,
        payloadHash: hash,
        correlationId,
        error: 'REFUND_CREATE_EXCEPTION',
        message: refundError.message
      };
    }
  }

  // ✅ Write operation for address_update
  if (action === 'address_update' && shopifyOrderId) {
    try {
            logger.info('ADDRESS_UPDATE_ATTEMPT', 'ADDRESS_UPDATE_ATTEMPT', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        addressFields: Object.keys(normalizedPayload.shipping_address || {})});

      // Update shipping address in Shopify
      const addressResult = await updateShippingAddress(shopifyOrderId, normalizedPayload, correlationId, hash);

      if (addressResult.success) {
        // Set provenance marker with payloadHash
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'address_update', hash);

        if (provenanceResult.success) {
                    logger.info('SHOPIFY_PROVENANCE_SET', 'SHOPIFY_PROVENANCE_SET', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus});
        }

                logger.info('ADDRESS_UPDATE_SUCCESS', 'ADDRESS_UPDATE_SUCCESS', {requestId,
          dealId,
          shopifyOrderId,
          orderName: addressResult.orderName,
          correlationId,
          payloadHash: hash});

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          orderName: addressResult.orderName
        };
      } else {
                logger.info('ADDRESS_UPDATE_ERROR', 'ADDRESS_UPDATE_ERROR', {requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: addressResult.error,
          message: addressResult.message,
          httpStatus: addressResult.httpStatus});

        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: addressResult.error,
          message: addressResult.message
        };
      }
    } catch (addressError) {
            logger.info('ADDRESS_UPDATE_ERROR', 'ADDRESS_UPDATE_ERROR', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ADDRESS_UPDATE_EXCEPTION',
        message: addressError.message,
        stack: addressError.stack});

      return {
        success: false,
        action,
        payloadHash: hash,
        correlationId,
        error: 'ADDRESS_UPDATE_EXCEPTION',
        message: addressError.message
      };
    }
  }

  // ✅ Write operation for order_cancel
  if (action === 'order_cancel' && shopifyOrderId) {
    try {
            logger.info('ORDER_CANCEL_ATTEMPT', 'ORDER_CANCEL_ATTEMPT', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        refund: normalizedPayload.refund});

      const cancelResult = await cancelOrderById(shopifyOrderId, normalizedPayload.refund);

      if (cancelResult.success) {
        // Set provenance marker
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'order_cancel', hash);

        if (provenanceResult.success) {
                    logger.info('SHOPIFY_PROVENANCE_SET', 'SHOPIFY_PROVENANCE_SET', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus});
        }

        // Add BitrixUpdated tag
        try {
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
                        logger.info('BITRIX_UPDATED_TAG_ADDED', 'BITRIX_UPDATED_TAG_ADDED', {requestId,
              dealId,
              shopifyOrderId,
              action: 'order_cancel'});
          }
        } catch (tagError) {
                    logger.warn('BITRIX_UPDATED_TAG_ADD_EXCEPTION', 'BITRIX_UPDATED_TAG_ADD_EXCEPTION', {requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message});
        }

                logger.info('ORDER_CANCEL_SUCCESS', 'ORDER_CANCEL_SUCCESS', {requestId,
          dealId,
          shopifyOrderId,
          jobId: cancelResult.jobId,
          refunded: cancelResult.refunded,
          correlationId,
          payloadHash: hash});

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          jobId: cancelResult.jobId,
          refunded: cancelResult.refunded
        };
      } else {
                logger.info('ORDER_CANCEL_ERROR', 'ORDER_CANCEL_ERROR', {requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: cancelResult.error,
          message: cancelResult.message});

        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: cancelResult.error,
          message: cancelResult.message
        };
      }
    } catch (cancelError) {
            logger.info('ORDER_CANCEL_ERROR', 'ORDER_CANCEL_ERROR', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ORDER_CANCEL_EXCEPTION',
        message: cancelError.message,
        stack: cancelError.stack});

      return {
        success: false,
        action,
        payloadHash: hash,
        correlationId,
        error: 'ORDER_CANCEL_EXCEPTION',
        message: cancelError.message
      };
    }
  }

  // ✅ Write operation for order_position_add
  if (action === 'order_position_add' && shopifyOrderId) {
    try {
            logger.info('ORDER_POSITION_ADD_ATTEMPT', 'ORDER_POSITION_ADD_ATTEMPT', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        variantId: normalizedPayload.variant_id,
        sku: normalizedPayload.sku,
        quantity: normalizedPayload.quantity});

      const variantId = normalizedPayload.variant_id || normalizedPayload.sku;
      if (!variantId) {
        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: 'MISSING_VARIANT_ID',
          message: 'variant_id or sku is required'
        };
      }

      const addResult = await addPositionToOrder(shopifyOrderId, variantId, normalizedPayload.quantity);

      if (addResult.success) {
        // Set provenance marker
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'order_position_add', hash);

        if (provenanceResult.success) {
                    logger.info('SHOPIFY_PROVENANCE_SET', 'SHOPIFY_PROVENANCE_SET', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus});
        }

        // Add BitrixUpdated tag
        try {
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
                        logger.info('BITRIX_UPDATED_TAG_ADDED', 'BITRIX_UPDATED_TAG_ADDED', {requestId,
              dealId,
              shopifyOrderId,
              action: 'order_position_add'});
          }
        } catch (tagError) {
                    logger.warn('BITRIX_UPDATED_TAG_ADD_EXCEPTION', 'BITRIX_UPDATED_TAG_ADD_EXCEPTION', {requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message});
        }

                logger.info('ORDER_POSITION_ADD_SUCCESS', 'ORDER_POSITION_ADD_SUCCESS', {requestId,
          dealId,
          shopifyOrderId,
          orderName: addResult.orderName,
          totalPrice: addResult.totalPrice,
          correlationId,
          payloadHash: hash});

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          orderName: addResult.orderName,
          totalPrice: addResult.totalPrice
        };
      } else {
                logger.info('ORDER_POSITION_ADD_ERROR', 'ORDER_POSITION_ADD_ERROR', {requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: addResult.error,
          message: addResult.message});

        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: addResult.error,
          message: addResult.message
        };
      }
    } catch (addError) {
            logger.info('ORDER_POSITION_ADD_ERROR', 'ORDER_POSITION_ADD_ERROR', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ORDER_POSITION_ADD_EXCEPTION',
        message: addError.message,
        stack: addError.stack});

      return {
        success: false,
        action,
        payloadHash: hash,
        correlationId,
        error: 'ORDER_POSITION_ADD_EXCEPTION',
        message: addError.message
      };
    }
  }

  // ✅ Write operation for order_position_increment
  if (action === 'order_position_increment' && shopifyOrderId) {
    try {
            logger.info('ORDER_POSITION_INCREMENT_ATTEMPT', 'ORDER_POSITION_INCREMENT_ATTEMPT', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        sku: normalizedPayload.sku,
        quantity: normalizedPayload.quantity});

      if (!normalizedPayload.sku) {
        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: 'MISSING_SKU',
          message: 'sku is required'
        };
      }

      const incrementResult = await incrementLineItemQuantity(
        shopifyOrderId,
        normalizedPayload.sku,
        normalizedPayload.quantity
      );

      if (incrementResult.success) {
        // Set provenance marker
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'order_position_increment', hash);

        if (provenanceResult.success) {
                    logger.info('SHOPIFY_PROVENANCE_SET', 'SHOPIFY_PROVENANCE_SET', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus});
        }

        // Add BitrixUpdated tag
        try {
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
                        logger.info('BITRIX_UPDATED_TAG_ADDED', 'BITRIX_UPDATED_TAG_ADDED', {requestId,
              dealId,
              shopifyOrderId,
              action: 'order_position_increment'});
          }
        } catch (tagError) {
                    logger.warn('BITRIX_UPDATED_TAG_ADD_EXCEPTION', 'BITRIX_UPDATED_TAG_ADD_EXCEPTION', {requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message});
        }

                logger.info('ORDER_POSITION_INCREMENT_SUCCESS', 'ORDER_POSITION_INCREMENT_SUCCESS', {requestId,
          dealId,
          shopifyOrderId,
          sku: normalizedPayload.sku,
          previousQuantity: incrementResult.previousQuantity,
          newQuantity: incrementResult.newQuantity,
          totalPrice: incrementResult.totalPrice,
          correlationId,
          payloadHash: hash});

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          previousQuantity: incrementResult.previousQuantity,
          newQuantity: incrementResult.newQuantity,
          totalPrice: incrementResult.totalPrice
        };
      } else {
                logger.info('ORDER_POSITION_INCREMENT_ERROR', 'ORDER_POSITION_INCREMENT_ERROR', {requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: incrementResult.error,
          message: incrementResult.message});

        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: incrementResult.error,
          message: incrementResult.message
        };
      }
    } catch (incrementError) {
            logger.info('ORDER_POSITION_INCREMENT_ERROR', 'ORDER_POSITION_INCREMENT_ERROR', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ORDER_POSITION_INCREMENT_EXCEPTION',
        message: incrementError.message,
        stack: incrementError.stack});

      return {
        success: false,
        action,
        payloadHash: hash,
        correlationId,
        error: 'ORDER_POSITION_INCREMENT_EXCEPTION',
        message: incrementError.message
      };
    }
  }

  // ✅ Write operation for order_position_decrement
  if (action === 'order_position_decrement' && shopifyOrderId) {
    try {
            logger.info('ORDER_POSITION_DECREMENT_ATTEMPT', 'ORDER_POSITION_DECREMENT_ATTEMPT', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        sku: normalizedPayload.sku,
        newQuantity: normalizedPayload.new_quantity});

      if (!normalizedPayload.sku) {
        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: 'MISSING_SKU',
          message: 'sku is required'
        };
      }

      const decrementResult = await decrementLineItemQuantity(
        shopifyOrderId,
        normalizedPayload.sku,
        normalizedPayload.new_quantity
      );

      if (decrementResult.success) {
        // Set provenance marker
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'order_position_decrement', hash);

        if (provenanceResult.success) {
                    logger.info('SHOPIFY_PROVENANCE_SET', 'SHOPIFY_PROVENANCE_SET', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus});
        }

        // Add BitrixUpdated tag
        try {
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
                        logger.info('BITRIX_UPDATED_TAG_ADDED', 'BITRIX_UPDATED_TAG_ADDED', {requestId,
              dealId,
              shopifyOrderId,
              action: 'order_position_decrement'});
          }
        } catch (tagError) {
                    logger.warn('BITRIX_UPDATED_TAG_ADD_EXCEPTION', 'BITRIX_UPDATED_TAG_ADD_EXCEPTION', {requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message});
        }

                logger.info('ORDER_POSITION_DECREMENT_SUCCESS', 'ORDER_POSITION_DECREMENT_SUCCESS', {requestId,
          dealId,
          shopifyOrderId,
          sku: normalizedPayload.sku,
          previousQuantity: decrementResult.previousQuantity,
          newQuantity: decrementResult.newQuantity,
          totalPrice: decrementResult.totalPrice,
          totalReceived: decrementResult.totalReceived,
          correlationId,
          payloadHash: hash});

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          previousQuantity: decrementResult.previousQuantity,
          newQuantity: decrementResult.newQuantity,
          totalPrice: decrementResult.totalPrice,
          totalReceived: decrementResult.totalReceived
        };
      } else {
                logger.info('ORDER_POSITION_DECREMENT_ERROR', 'ORDER_POSITION_DECREMENT_ERROR', {requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: decrementResult.error,
          message: decrementResult.message});

        return {
          success: false,
          action,
          payloadHash: hash,
          correlationId,
          error: decrementResult.error,
          message: decrementResult.message
        };
      }
    } catch (decrementError) {
            logger.info('ORDER_POSITION_DECREMENT_ERROR', 'ORDER_POSITION_DECREMENT_ERROR', {requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ORDER_POSITION_DECREMENT_EXCEPTION',
        message: decrementError.message,
        stack: decrementError.stack});

      return {
        success: false,
        action,
        payloadHash: hash,
        correlationId,
        error: 'ORDER_POSITION_DECREMENT_EXCEPTION',
        message: decrementError.message
      };
    }
  }

  // For unsupported actions or missing required data - return dryRun
  return {
    success: true,
    dryRun: true,
    action,
    payloadHash: hash,
    correlationId,
    normalizedPayload
  };
}

/**
 * Handle deal update event from Bitrix
 * Checks for MW action (UF_MW_SHOPIFY_ACTION) first, then Delivery trigger: CATEGORY_ID == 2, STAGE_ID == "C2:EXECUTING"
 */
async function handleDealUpdate(dealId, requestId) {
  // ✅ Structured logging: [BITRIX_WEBHOOK_RECEIVED]
    logger.info('BITRIX_WEBHOOK_RECEIVED', 'BITRIX_WEBHOOK_RECEIVED', {requestId,
    dealId,
    eventType: 'UPDATE'}, { entityType: 'deal', entityId: String(dealId) });

  // Get full deal data from Bitrix REST API
  let dealData = null;
  try {
    const dealResp = await callBitrix('/crm.deal.get.json', {
      id: dealId,
    });

    if (!dealResp.result) {
      logger.warn('DEAL_GET_FAILED', 'Deal not found or failed to fetch', { requestId, dealId, response: dealResp });
      return { success: false, reason: 'deal_not_found' };
    }

    dealData = dealResp.result;
  } catch (error) {
    logger.error('DEAL_GET_ERROR', 'Failed to fetch deal from Bitrix', { requestId, dealId, error: error.message });
    return { success: false, reason: 'deal_get_error', error: error.message };
  }

  // Extract required fields
  const categoryId = dealData.CATEGORY_ID;
  const stageId = dealData.STAGE_ID;
  let shopifyOrderId = dealData.UF_CRM_1742556489 || dealData.uf_crm_1742556489;
  const comments = dealData.COMMENTS || '';

  // ✅ Fallback: If shopifyOrderId is missing, try to find it by tag (resilience against race conditions)
  if (!shopifyOrderId || shopifyOrderId.trim() === '') {
    try {
      // Import explicitly if needed, but it should be available in scope from top imports
      const foundOrderId = await findExistingOrderByDealId(dealId);
      if (foundOrderId) {
        shopifyOrderId = foundOrderId;
                logger.info('SHOPIFY_ORDER_ID_RECOVERED', 'SHOPIFY_ORDER_ID_RECOVERED', {requestId,
          dealId,
          recoveredOrderId: shopifyOrderId});
      }
    } catch (lookupError) {
      logger.warn('order_lookup_error', 'Failed to look up existing order by dealId', { dealId, requestId, error: lookupError.message }, { entityType: 'deal', entityId: dealId });
    }
  }

  // ✅ PRE-ORDER LOGIC MOVED TO UNIFIED ORDER CREATION BLOCK (refactoring)
  // Category 4: Uses resolveCatalogOrderItems() from orderItems.js
  // All others: Uses resolveRegularOrderItems() from orderItems.js

  // ✅ STUB LOGIC REMOVED (refactoring: unified order creation)

  // ✅ Structured logging: [DEAL_DATA_RECEIVED]
    logger.info('DEAL_DATA_RECEIVED', 'DEAL_DATA_RECEIVED', {requestId,
    dealId,
    categoryId,
    stageId,
    shopifyOrderId});

  // ✅ STEP 0: Sync Item Quantities (Full Control)
  // Ensure Shopify items match Bitrix items exactly (add/remove/update)
  // SKIPPED if in LOSE stage (to allow handleCancel to manage partial refunds gracefully)
  if (shopifyOrderId && shopifyOrderId.trim() !== '') {
    try {
      const { isLoseStage: checkLose } = await import('../../../src/lib/blocks/cancel.js');
      const isLose = checkLose(stageId);

      if (!isLose) {
        // ✅ LOOP GUARD: Check Provenance
        let skipQuantitySync = false;
        try {
          const { getProvenanceMarker } = await import('../../../src/lib/shopify/metafields.js');
          const lastWrite = await getProvenanceMarker(shopifyOrderId);
          if (lastWrite && lastWrite.exists && lastWrite.value && lastWrite.value.source === 'shopify') {
            const timeDiff = Date.now() - new Date(lastWrite.value.ts).getTime();
            if (timeDiff < 60000) { // 60 seconds debounce for loop guard
              logger.warn('loop_guard_quantity', 'Skipping quantity sync: last write was from Shopify', { shopifyOrderId, dealId, timeDiff_ms: timeDiff }, { entityType: 'order', entityId: shopifyOrderId });
              skipQuantitySync = true;
            }
          }
        } catch (pmError) {
          logger.error('loop_guard_provenance_error', 'Failed to read provenance marker', { shopifyOrderId, dealId, error: pmError.message }, { entityType: 'order', entityId: shopifyOrderId });
        }

        if (!skipQuantitySync) {
          const { handleQuantitySync } = await import('../../../src/lib/blocks/quantitySync.js');
          await handleQuantitySync(shopifyOrderId, dealId, requestId, { forceRemove: true });
        }
      } else {
        logger.info('quantity_sync_skipped_lose', 'Quantity sync skipped in LOSE stage', { shopifyOrderId, dealId, stageId }, { entityType: 'order', entityId: shopifyOrderId });
      }
    } catch (syncError) {
      logger.warn('quantity_sync_error', 'Quantity sync failed', { shopifyOrderId, dealId, error: syncError.message }, { entityType: 'order', entityId: shopifyOrderId });
    }
  }

  // ✅ STEP A: Cancel/Refund logic from Bitrix -> Shopify is now DISABLED
  // User request: All refund/return logic mastered in Shopify and pushed to Bitrix.
  // Bitrix deals will passively adapt to Shopify refunds.
  /*
  const { handleCancel, isLoseStage } = await import('../../../src/lib/blocks/cancel.js');

  if (isLoseStage(stageId)) {
    const cancelResult = await handleCancel(shopifyOrderId, dealId, stageId, requestId);
    if (cancelResult && cancelResult.handled) {
      if (cancelResult.success) {
        return {
          success: true,
          triggerMatch: true,
          action: cancelResult.action,
          shopifyOrderId: cancelResult.shopifyOrderId
        };
      } else {
        // Logged internally in block, proceed effectively "handled" but maybe failed specific step
        return {
          success: false,
          triggerMatch: true,
          action: 'cancel_failed',
          error: cancelResult.error
        };
      }
    }
  }
  */



  // Store event in adapter for UI display (will be updated with fulfillment state later if needed)
  let storedEvent = null;
  try {
    storedEvent = bitrixAdapter.storeEvent({
      dealId,
      categoryId,
      stageId,
      shopifyOrderId,
      comments,
      received_at: new Date().toISOString(),
      rawDealData: dealData,
      fulfillmentState: null // Will be updated after fulfillment creation
    });
  } catch (storeError) {
    logger.warn('store_event_error', 'Failed to store event (non-blocking)', { dealId, requestId, error: storeError?.message }, { entityType: 'deal', entityId: dealId });
  }

  // ✅ STEP C: Check for MW action first (UF_MW_SHOPIFY_ACTION)
  const mwActionResult = await handleMWAction(dealId, requestId, dealData, shopifyOrderId);
  if (mwActionResult !== null) {
    if (mwActionResult.success) {
      try {
        await callBitrix('/crm.deal.update.json', { id: dealId, fields: { UF_MW_SHOPIFY_ACTION: '' } });
        logger.info('MW_ACTION_CONSUMED', 'UF_MW_SHOPIFY_ACTION cleared after successful execution', {
          requestId, dealId, action: mwActionResult.action
        }, { entityType: 'deal', entityId: String(dealId) });
      } catch (consumeErr) {
        logger.warn('MW_ACTION_CONSUME_FAILED', 'Failed to clear UF_MW_SHOPIFY_ACTION (non-blocking)', {
          requestId, dealId, action: mwActionResult.action, error: consumeErr.message
        }, { entityType: 'deal', entityId: String(dealId) });
      }
    }
    return mwActionResult;
  }

  // ✅ STEP C.1: Check if we need to update address for existing Shopify order
  // Extract address from UF_CRM_1742037435676 field and update if changed
  if (shopifyOrderId && shopifyOrderId.trim() !== '') {
    try {
      // Get order from Shopify to check current address
      const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
      const shopifyOrder = await getOrder(shopifyOrderId);

      if (shopifyOrder) {
        // Get current shipping lines for potential update
        const currentShippingLines = shopifyOrder.shipping_lines || [];

        // Check delivery price first (UF_CRM_67BEF8B2AA721)
        const deliveryPriceField = dealData.UF_CRM_67BEF8B2AA721 || dealData.uf_crm_67bef8b2aa721 || '';
        const deliveryPrice = deliveryPriceField ? parseFloat(deliveryPriceField) : null;
        const currentShippingPrice = currentShippingLines.length > 0 ? parseFloat(currentShippingLines[0].price || '0') : 0;
        const deliveryPriceChanged = deliveryPrice !== null && !isNaN(deliveryPrice) && Math.abs(deliveryPrice - currentShippingPrice) > 0.01;

        // Update address for all orders (both technical and regular)
        // Extract address from Bitrix field UF_CRM_1742037435676
        const bitrixAddressField = dealData.UF_CRM_1742037435676 || dealData.uf_crm_1742037435676 || '';
        let addressChanged = false;
        let parsedAddress = null;
        let addressUpdateAttempted = false;

        if (bitrixAddressField && typeof bitrixAddressField === 'string' && bitrixAddressField.trim() !== '') {
          // Parse address string: "Street, ZIP City Region, Country | coordinate"
          // Example: "Rue Verwée - Verwéestraat 8, 1030 Schaerbeek - Schaarbeek Brussels-Capital, Belgium | 50.866888495699;4.3742416799068|190"
          parsedAddress = parseBitrixAddressString(bitrixAddressField);

          if (parsedAddress && Object.keys(parsedAddress).length > 0) {
            // Try to get country code from country name
            if (parsedAddress.country && !parsedAddress.country_code) {
              try {
                const { callShopifyAdmin } = await import('../../../src/lib/shopify/adminClient.js');
                const countriesResponse = await callShopifyAdmin('/countries.json');
                const countries = countriesResponse.countries || [];
                const countryMatch = countries.find(c =>
                  c.name.toLowerCase() === parsedAddress.country.toLowerCase()
                );
                if (countryMatch) {
                  parsedAddress.country_code = countryMatch.code;
                  parsedAddress.country = countryMatch.name; // Use exact name from Shopify
                }
              } catch (countryError) {
                logger.warn('address_country_resolve_error', 'Failed to resolve country code', { shopifyOrderId, dealId, country: parsedAddress.country, error: countryError.message });
              }
            }

            // ✅ VALIDATION: City is required for Shopify
            if (!parsedAddress.city || parsedAddress.city.trim() === '') {
              logger.warn('address_city_missing', 'Skipping address update: City is missing', { shopifyOrderId, dealId, bitrixAddressField });
              parsedAddress = null; // Invalidate parsing
            }

            // Compare with current Shopify address
            if (parsedAddress) {
              const currentAddress = shopifyOrder.shipping_address || {};
              addressChanged = hasAddressChanged(parsedAddress, currentAddress);

              // Debug: Log detailed comparison
              const addressComparison = {
                address1: {
                  new: parsedAddress.address1,
                  current: currentAddress.address1,
                  changed: (parsedAddress.address1 || '').trim().toLowerCase() !== (currentAddress.address1 || '').trim().toLowerCase()
                },
                city: {
                  new: parsedAddress.city,
                  current: currentAddress.city,
                  changed: (parsedAddress.city || '').trim().toLowerCase() !== (currentAddress.city || '').trim().toLowerCase()
                },
                zip: {
                  new: parsedAddress.zip,
                  current: currentAddress.zip,
                  changed: (parsedAddress.zip || '').trim().toLowerCase() !== (currentAddress.zip || '').trim().toLowerCase()
                },
                country: {
                  new: parsedAddress.country,
                  current: currentAddress.country,
                  changed: (parsedAddress.country || '').trim().toLowerCase() !== (currentAddress.country || '').trim().toLowerCase()
                },
                province: {
                  new: parsedAddress.province,
                  current: currentAddress.province,
                  changed: (parsedAddress.province || '').trim().toLowerCase() !== (currentAddress.province || '').trim().toLowerCase()
                }
              };

                            logger.info('AUTO_ADDRESS_CHECK', 'AUTO_ADDRESS_CHECK', {requestId,
                dealId,
                shopifyOrderId,
                bitrixAddress: bitrixAddressField,
                parsedAddress,
                currentShopifyAddress: {
                  address1: currentAddress.address1,
                  city: currentAddress.city,
                  zip: currentAddress.zip,
                  country: currentAddress.country,
                  country_code: currentAddress.country_code,
                  province: currentAddress.province
                },
                addressComparison,
                addressChanged,
                deliveryPrice: deliveryPrice,
                currentShippingPrice: currentShippingPrice,
                deliveryPriceChanged: deliveryPriceChanged});
            } else {
              addressChanged = false;
            }

            // Always update if address is provided (even if comparison says no change)
            // This ensures address is synced even if comparison logic has issues
            const shouldUpdateAddress = addressChanged || (parsedAddress && Object.keys(parsedAddress).length > 0);

            // ✅ LOOP GUARD: Check Provenance
            let isLoop = false;
            try {
              const lastWrite = await getProvenanceMarker(shopifyOrderId);
              if (lastWrite && lastWrite.exists && lastWrite.value && lastWrite.value.source === 'shopify') {
                const timeDiff = Date.now() - new Date(lastWrite.value.ts).getTime();
                if (timeDiff < 60000) { // 60 seconds debounce for loop guard
                  logger.warn('loop_guard_address', 'Skipping address update: last write was from Shopify', { shopifyOrderId, dealId, timeDiff_ms: timeDiff }, { entityType: 'order', entityId: shopifyOrderId });
                  isLoop = true;
                }
              }
            } catch (pErr) {
              logger.warn('loop_guard_address_provenance_error', 'Provenance check failed for address loop guard', { shopifyOrderId, dealId, error: pErr.message });
            }

            if ((shouldUpdateAddress || deliveryPriceChanged) && !isLoop) {
                            logger.info('AUTO_ADDRESS_UPDATE_DETECTED', 'AUTO_ADDRESS_UPDATE_DETECTED', {requestId,
                dealId,
                shopifyOrderId,
                bitrixAddress: bitrixAddressField,
                parsedAddress,
                currentShopifyAddress: {
                  address1: shopifyOrder.shipping_address?.address1,
                  city: shopifyOrder.shipping_address?.city,
                  zip: shopifyOrder.shipping_address?.zip,
                  country: shopifyOrder.shipping_address?.country
                },
                addressChanged: addressChanged,
                deliveryPriceChanged: deliveryPriceChanged,
                newDeliveryPrice: deliveryPrice,
                currentDeliveryPrice: currentShippingPrice});

              // Prepare update payload with address and shipping lines
              // Match the working user script: send minimal payload
              const updatePayload = {};

              // Always include shipping_address if we have parsed address
              if (parsedAddress && Object.keys(parsedAddress).length > 0) {
                const addressForShopify = { ...parsedAddress };
                // IMPORTANT: Shopify часто валидирует province строго по списку для страны.
                // Bitrix строка даёт "Brussels-Capital/Flanders", что вызывает 422.
                // Пользовательский рабочий скрипт province не отправляет — делаем так же.
                delete addressForShopify.province;

                // Try to enrich with contact name/phone if available (non-blocking)
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
                  logger.warn('address_contact_enrich_error', 'Failed to enrich shipping_address from contact', { shopifyOrderId, dealId, error: contactError.message });
                }

                updatePayload.shipping_address = addressForShopify;
              }

              // Only include shipping_lines if delivery price changed (do not send existing lines unnecessarily)
              if (deliveryPriceChanged && deliveryPrice !== null) {
                // Update with new price
                const currentShippingTitle = currentShippingLines.length > 0
                  ? currentShippingLines[0].title
                  : 'Standard Shipping';

                updatePayload.shipping_lines = [{
                  title: currentShippingTitle,
                  price: deliveryPrice.toFixed(2),
                  code: currentShippingLines.length > 0 && currentShippingLines[0].code
                    ? currentShippingLines[0].code
                    : 'CUSTOM_EDIT'
                }];
              }

              // Log what we're about to send (for debugging)
                            logger.info('AUTO_ADDRESS_UPDATE_PAYLOAD', 'AUTO_ADDRESS_UPDATE_PAYLOAD', {requestId,
                dealId,
                shopifyOrderId,
                updatePayloadKeys: Object.keys(updatePayload),
                hasShippingAddress: !!(updatePayload.shipping_address),
                hasShippingLines: !!(updatePayload.shipping_lines),
                shippingAddressFields: updatePayload.shipping_address ? Object.keys(updatePayload.shipping_address) : [],
                shippingLinesCount: updatePayload.shipping_lines ? updatePayload.shipping_lines.length : 0});

              // Update address and shipping in Shopify
              const { updateShippingAddress } = await import('../../../src/lib/shopify/address.js');
              const correlationId = `${dealId}:${Date.now()}`;
              addressUpdateAttempted = true;
              const addressResult = await updateShippingAddress(shopifyOrderId, updatePayload, correlationId, null);

              if (addressResult.success) {
                // ✅ SET PROVENANCE MARKER (Source: Bitrix)
                try {
                  await setProvenanceMarker(shopifyOrderId, correlationId, 'address_update_from_bitrix', null, 'bitrix');
                } catch (pmErr) {
                  logger.warn('provenance_marker_set_error', 'Failed to set provenance marker after address update', { shopifyOrderId, dealId, error: pmErr?.message });
                }

                                logger.info('AUTO_ADDRESS_UPDATE_SUCCESS', 'AUTO_ADDRESS_UPDATE_SUCCESS', {requestId,
                  dealId,
                  shopifyOrderId});
              } else {
                                logger.info('AUTO_ADDRESS_UPDATE_ERROR', 'AUTO_ADDRESS_UPDATE_ERROR', {requestId,
                  dealId,
                  shopifyOrderId,
                  error: addressResult.error,
                  message: addressResult.message});
              }
            } else {
                            logger.info('AUTO_ADDRESS_NO_CHANGE', 'AUTO_ADDRESS_NO_CHANGE', {requestId,
                dealId,
                shopifyOrderId});
            }
          } else {
                        logger.info('AUTO_ADDRESS_PARSE_FAILED', 'AUTO_ADDRESS_PARSE_FAILED', {requestId,
              dealId,
              shopifyOrderId,
              bitrixAddress: bitrixAddressField});
          }
        }

        // Check if delivery price needs to be updated (only if address wasn't updated above)
        // If address was updated, shipping_lines were already included in that update
        const wasAddressUpdated = addressUpdateAttempted;

        if (deliveryPriceChanged && !wasAddressUpdated) {
                    logger.info('AUTO_DELIVERY_PRICE_UPDATE_DETECTED', 'AUTO_DELIVERY_PRICE_UPDATE_DETECTED', {requestId,
            dealId,
            shopifyOrderId,
            newDeliveryPrice: deliveryPrice,
            currentDeliveryPrice: currentShippingPrice});

          // Update only shipping price
          const { updateShippingAddress } = await import('../../../src/lib/shopify/address.js');
          const correlationId = `${dealId}:${Date.now()}`;

          // Get current shipping line title or use default
          const currentShippingTitle = currentShippingLines.length > 0
            ? currentShippingLines[0].title
            : 'Standard Shipping';

          const addressResult = await updateShippingAddress(shopifyOrderId, {
            shipping_lines: [{
              title: currentShippingTitle,
              price: deliveryPrice.toFixed(2),
              code: currentShippingLines.length > 0 && currentShippingLines[0].code
                ? currentShippingLines[0].code
                : 'CUSTOM_EDIT'
            }]
          }, correlationId, null);

          if (addressResult.success) {
                        logger.info('AUTO_DELIVERY_PRICE_UPDATE_SUCCESS', 'AUTO_DELIVERY_PRICE_UPDATE_SUCCESS', {requestId,
              dealId,
              shopifyOrderId,
              newDeliveryPrice: deliveryPrice});
          } else {
                        logger.info('AUTO_DELIVERY_PRICE_UPDATE_ERROR', 'AUTO_DELIVERY_PRICE_UPDATE_ERROR', {requestId,
              dealId,
              shopifyOrderId,
              error: addressResult.error,
              message: addressResult.message});
          }
        }
      }
    } catch (orderCheckError) {
      // Non-blocking: if we can't check order, continue with normal flow
      logger.warn('address_order_check_error', 'Could not check order for address update', { shopifyOrderId, dealId, error: orderCheckError.message }, { entityType: 'order', entityId: shopifyOrderId });
    }
  }

  // ✅ STEP C1.5: Sync contact data (email, phone, name) from Bitrix to Shopify
  if (shopifyOrderId && shopifyOrderId.trim() !== '') {
    try {
      const { syncContactToShopify } = await import('../../../src/lib/blocks/contactSync.js');
      await syncContactToShopify(shopifyOrderId, dealData, requestId, dealId);
    } catch (contactSyncError) {
      logger.warn('contact_sync_error', 'Contact sync error (non-blocking)', { shopifyOrderId, dealId, error: contactSyncError.message }, { entityType: 'order', entityId: shopifyOrderId });
    }
  }

  // ✅ STEP C2: Sync product quantities from Bitrix to Shopify (if order exists)
  // NOTE: This only runs if shopifyOrderId exists, so it won't block order creation
  if (shopifyOrderId && shopifyOrderId.trim() !== '') {
    // LOOP GUARD: Skip if last write was from Shopify within 60s.
    // Race condition: crm.deal.update triggers this Bitrix webhook BEFORE
    // crm.deal.productrows.set completes, so old Bitrix rows would be re-added to Shopify.
    let c2LoopGuard = false;
    try {
      const prov = await getProvenanceMarker(shopifyOrderId);
      if (prov?.exists && prov.value?.source === 'shopify') {
        const diff = Date.now() - new Date(prov.value.ts).getTime();
        if (diff < 60000) {
          logger.warn('loop_guard_quantity_c2', 'STEP C2 skipped: last write from Shopify within 60s', { shopifyOrderId, dealId, timeDiff_ms: diff }, { entityType: 'order', entityId: shopifyOrderId });
          c2LoopGuard = true;
        }
      }
    } catch (pmErr) { /* non-blocking: if marker check fails, proceed normally */ }

    if (!c2LoopGuard) {
    try {
            logger.info('QUANTITY_SYNC_START', 'QUANTITY_SYNC_START', {requestId,
        dealId,
        shopifyOrderId});
      const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
      const shopifyOrder = await getOrder(shopifyOrderId);

      if (shopifyOrder) {
        // ✅ UPDATED: Sync quantities for ALL linked orders (Bitrix-created OR Shopify-created)
        // Same logic as LOSE/Cancel bypass: if order is linked, allow updates to propagate
        // Loop prevention: BitrixUpdated tag is added after sync, Shopify webhook will skip
        const orderTags = Array.isArray(shopifyOrder.tags)
          ? shopifyOrder.tags
          : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
        const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));

        // Sync for ALL linked orders (removed isBitrixOrder restriction)
        {
          // Get product rows from Bitrix
          const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', {
            id: dealId
          });

          const bitrixRows = Array.isArray(productRowsResp?.result) ? productRowsResp.result : [];
                    logger.info('QUANTITY_SYNC_BITRIX_ROWS', 'QUANTITY_SYNC_BITRIX_ROWS', {requestId,
            dealId,
            shopifyOrderId,
            rowsCount: bitrixRows.length});

          // Get line items from Shopify
          const shopifyLineItems = shopifyOrder.line_items || [];
          logger.info('quantity_sync_shopify_snapshot', 'Shopify line items snapshot', { requestId, dealId, shopifyOrderId, itemsCount: shopifyLineItems.length, items: shopifyLineItems.map(li => ({ sku: li.sku, variantId: li.variant_id, lineItemId: li.id, quantity: li.quantity, title: li.title, fulfillmentStatus: li.fulfillment_status, fulfillableQuantity: li.fulfillable_quantity })) });

          // Build map of identifier -> { quantity, isVariantId } from Bitrix
          // Priority: XML_ID (Shopify variant ID) first, CODE (SKU) as fallback
          const bitrixQuantities = new Map();
          for (const row of bitrixRows) {
            const productId = row.PRODUCT_ID;
            if (productId) {
              try {
                const productResp = await callBitrix('/crm.product.get.json', { id: productId });
                if (productResp.result) {
                  const product = productResp.result;
                  const xmlId = product.XML_ID; // Shopify variant ID stored here
                  const code = product.CODE || product.code || product.SKU || product.sku;
                  const quantity = parseFloat(row.QUANTITY || row.quantity || 0);

                  if (xmlId && xmlId.toString().trim() !== '') {
                    // XML_ID = Shopify variant ID: addPositionToOrder uses it directly
                    bitrixQuantities.set(xmlId.toString().trim(), { quantity, isVariantId: true });
                    logger.info('quantity_sync_bitrix_row_resolved', 'Bitrix row resolved', { requestId, dealId, shopifyOrderId, productId, resolvedBy: 'xml_id', identifier: xmlId.toString().trim(), quantity, productName: product.NAME || product.name || null });
                  } else if (code && code.trim() !== '') {
                    // Numeric-only CODE (≥10 digits) means variant_id was stored as fallback when Shopify sku was empty.
                    // Monitor 'code_as_variant_id' log events — if EAN barcodes are ever used as SKUs this heuristic would misclassify them.
                    const isVariantIdCode = /^\d{10,}$/.test(code.trim());
                    bitrixQuantities.set(code.trim(), { quantity, isVariantId: isVariantIdCode });
                    logger.info('quantity_sync_bitrix_row_resolved', 'Bitrix row resolved', { requestId, dealId, shopifyOrderId, productId, resolvedBy: isVariantIdCode ? 'code_as_variant_id' : 'sku', identifier: code.trim(), quantity, productName: product.NAME || product.name || null });
                  } else {
                    logger.warn('quantity_sync_bitrix_row_sku_missing', 'Bitrix product has no XML_ID or CODE', { requestId, dealId, shopifyOrderId, productId, availableKeys: typeof product === 'object' && product !== null ? Object.keys(product) : [] });
                  }
                }
              } catch (productError) {
                logger.warn('quantity_sync_product_fetch_error', 'Failed to get Bitrix product', { requestId, dealId, shopifyOrderId, productId, error: productError.message });
              }
            }
          }

          logger.info('quantity_sync_bitrix_items', 'Bitrix quantities map built', { requestId, dealId, shopifyOrderId, items: Array.from(bitrixQuantities.entries()).map(([identifier, { quantity, isVariantId }]) => ({ identifier, quantity, isVariantId })) });

          const orphans = shopifyLineItems.filter(li => {
            const varId = li.variant_id ? String(li.variant_id).trim() : null;
            const sku = li.sku ? String(li.sku).trim() : null;
            if (!varId && !sku) return false;
            return !bitrixQuantities.has(varId) && !bitrixQuantities.has(sku);
          });
          if (orphans.length > 0) {
            logger.warn('quantity_sync_shopify_orphans', 'Shopify items not found in Bitrix', { requestId, dealId, shopifyOrderId, orphans: orphans.map(li => ({ sku: li.sku, variantId: li.variant_id, lineItemId: li.id, quantity: li.quantity })) });
          }

          // Compare with Shopify and find differences.
          // IMPORTANT: If Bitrix rows are empty, we still must decrement all Shopify SKU-backed line items to 0.
          const quantityChanges = [];
          for (const lineItem of shopifyLineItems) {
            const lineVariantId = lineItem.variant_id ? String(lineItem.variant_id).trim() : null;
            const lineSku = lineItem.sku ? String(lineItem.sku).trim() : null;

            // Match by variant_id first (unambiguous), then fall back to SKU
            const matchKey = (lineVariantId && bitrixQuantities.has(lineVariantId))
              ? lineVariantId
              : (lineSku && bitrixQuantities.has(lineSku))
                ? lineSku
                : null;

            const shopifyQty = parseFloat(lineItem.quantity || 0);
            const bitrixQty = matchKey ? bitrixQuantities.get(matchKey).quantity : 0;
            const sku = lineSku || lineVariantId;
            if (!sku) continue;

            if (Math.abs(bitrixQty - shopifyQty) > 0.01) {
              quantityChanges.push({ sku, lineVariantId, bitrixQty, shopifyQty, newQty: bitrixQty });
            }
          }

          // Also check for new items in Bitrix that don't exist in Shopify
          for (const [identifier, { quantity: bitrixQty, isVariantId }] of bitrixQuantities.entries()) {
            const existsInShopify = shopifyLineItems.some(li => {
              if (isVariantId) return String(li?.variant_id || '').trim() === identifier;
              return String(li?.sku || '').trim() === identifier;
            });
            if (!existsInShopify && bitrixQty > 0) {
              quantityChanges.push({
                sku: identifier, // numeric variantId string or SKU — addPositionToOrder handles both
                lineVariantId: null,
                bitrixQty,
                shopifyQty: 0,
                newQty: bitrixQty,
                isNew: true
              });
            }
          }

          if (quantityChanges.length > 0) {
            logger.info('quantity_sync_detected', 'Quantity changes detected', { requestId, dealId, shopifyOrderId, changesCount: quantityChanges.length, changes: quantityChanges });

            // Apply changes using orderEdit API
            const { incrementLineItemQuantity, decrementLineItemQuantity, addPositionToOrder } = await import('../../../src/lib/shopify/orderEdit.js');
            const { addTagToOrder } = await import('../../../src/lib/shopify/order.js');

            let hasChanges = false;
            let added = 0, incremented = 0, decremented = 0, errorsCount = 0;

            for (const change of quantityChanges) {
              try {
                if (change.isNew) {
                  // Add new position
                  logger.info('quantity_sync_add_intent', 'Adding new position to Shopify order', { requestId, dealId, shopifyOrderId, identifier: change.sku, quantity: change.newQty });
                  const addResult = await addPositionToOrder(shopifyOrderId, change.sku, change.newQty);
                  if (addResult.success) {
                    hasChanges = true;
                    added++;
                    logger.info('quantity_sync_add_success', 'Position added to Shopify order', { requestId, dealId, shopifyOrderId, sku: change.sku, quantity: change.newQty, shopifyOrderName: addResult.orderName || null });
                  } else {
                    errorsCount++;
                    logger.warn('quantity_sync_add_error', 'Failed to add position to Shopify order', { requestId, dealId, shopifyOrderId, sku: change.sku, quantity: change.newQty, error: addResult.error, message: addResult.message });
                  }
                } else if (change.newQty > change.shopifyQty) {
                  // Increment quantity
                  const incrementQty = change.newQty - change.shopifyQty;
                  const incrementResult = await incrementLineItemQuantity(shopifyOrderId, change.sku, incrementQty, change.lineVariantId);
                  if (incrementResult.success) {
                    hasChanges = true;
                    incremented++;
                    logger.info('quantity_sync_increment_success', 'Line item quantity incremented', { requestId, dealId, shopifyOrderId, sku: change.sku, previousQty: change.shopifyQty, newQty: incrementResult.newQuantity });
                  } else {
                    errorsCount++;
                    logger.warn('quantity_sync_increment_error', 'Failed to increment line item quantity', { requestId, dealId, shopifyOrderId, sku: change.sku, incrementQty, error: incrementResult.error, message: incrementResult.message });
                  }
                } else if (change.newQty < change.shopifyQty) {
                  // Decrement quantity
                  const decrementResult = await decrementLineItemQuantity(shopifyOrderId, change.sku, change.newQty, change.lineVariantId);
                  if (decrementResult.success) {
                    hasChanges = true;
                    decremented++;
                    logger.info('quantity_sync_decrement_success', 'Line item quantity decremented', { requestId, dealId, shopifyOrderId, sku: change.sku, previousQty: change.shopifyQty, newQty: decrementResult.newQuantity });
                  } else {
                    errorsCount++;
                    logger.warn('quantity_sync_decrement_error', 'Failed to decrement line item quantity', { requestId, dealId, shopifyOrderId, sku: change.sku, newQty: change.newQty, error: decrementResult.error, message: decrementResult.message });
                  }
                }
              } catch (changeError) {
                errorsCount++;
                logger.warn('quantity_sync_change_error', 'Unexpected error applying quantity change', { requestId, dealId, shopifyOrderId, sku: change.sku, error: changeError.message });
              }
            }

            logger.info('quantity_sync_complete', 'Quantity sync finished', { requestId, dealId, shopifyOrderId, added, incremented, decremented, orphansCount: orphans.length, discrepanciesCount: quantityChanges.length, errorsCount, hasChanges });

            // ✅ STEP C2.1: Clean up stub order if real products were added
            // If order was a stub (has BITRIX_STUB tag) and now has real products, remove stub marker
            const hasStubTag = orderTags.includes('BITRIX_STUB');
            const hasRealProducts = bitrixQuantities.size > 0;

            if (hasStubTag && hasRealProducts) {
                            logger.info('STUB_ORDER_CLEANUP_START', 'STUB_ORDER_CLEANUP_START', {requestId,
                dealId,
                shopifyOrderId,
                bitrixProductsCount: bitrixQuantities.size});

              try {
                // Step 1: Remove default variant (53051786756360) if it exists
                const defaultVariantId = BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID;

                // Use orderEdit API to find and remove the default variant line item
                const { beginOrderEdit, setLineItemQuantity, commitOrderEdit } = await import('../../../src/lib/shopify/orderEdit.js');

                const beginResult = await beginOrderEdit(shopifyOrderId);
                if (beginResult.success) {
                  // Find the line item with default variant in calculated order
                  const calculatedLineItems = beginResult.lineItems || [];
                  const calculatedDefaultItem = calculatedLineItems.find(li => {
                    if (!li.variant) return false;
                    // Try legacyResourceId first (numeric ID), then extract from GraphQL ID
                    const liVariantId = li.variant.legacyResourceId
                      ? String(li.variant.legacyResourceId)
                      : (li.variant.id ? String(li.variant.id).split('/').pop() : null);
                    return liVariantId === defaultVariantId;
                  });

                  if (calculatedDefaultItem && calculatedDefaultItem.quantity > 0) {
                    // Set quantity to 0 to remove it
                    const setResult = await setLineItemQuantity(
                      beginResult.calculatedOrderId,
                      calculatedDefaultItem.id,
                      0
                    );

                    if (setResult.success) {
                      const commitResult = await commitOrderEdit(beginResult.calculatedOrderId);
                      if (commitResult.success) {
                                                logger.info('STUB_ORDER_DEFAULT_VARIANT_REMOVED', 'STUB_ORDER_DEFAULT_VARIANT_REMOVED', {requestId,
                          dealId,
                          shopifyOrderId,
                          defaultVariantId});
                      }
                    }
                  }
                }

                // Step 2: Remove BITRIX_STUB tag and update note
                const { callShopifyAdmin, getOrder } = await import('../../../src/lib/shopify/adminClient.js');
                const currentOrder = await getOrder(shopifyOrderId);

                if (currentOrder) {
                  const currentTags = Array.isArray(currentOrder.tags)
                    ? currentOrder.tags
                    : (currentOrder.tags ? String(currentOrder.tags).split(',').map(t => t.trim()) : []);

                  const updatedTags = currentTags.filter(tag => tag !== 'BITRIX_STUB');
                  const currentNote = currentOrder.note || '';
                  const shouldUpdateNote = currentNote.includes('STUB ORDER');
                  const updatedNote = shouldUpdateNote ? `Ордер из Bitrix. Сделка: ${dealId}` : currentNote;

                  // Update order to remove BITRIX_STUB tag and update note if needed
                  if (updatedTags.length !== currentTags.length || shouldUpdateNote) {
                    await callShopifyAdmin(`/orders/${shopifyOrderId}.json`, {
                      method: 'PUT',
                      body: JSON.stringify({
                        order: {
                          id: shopifyOrderId,
                          tags: updatedTags.join(', '),
                          note: updatedNote
                        }
                      })
                    });

                    if (updatedTags.length !== currentTags.length) {
                                            logger.info('STUB_ORDER_TAG_REMOVED', 'STUB_ORDER_TAG_REMOVED', {requestId,
                        dealId,
                        shopifyOrderId,
                        removedTag: 'BITRIX_STUB'});
                    }

                    if (shouldUpdateNote) {
                                            logger.info('STUB_ORDER_NOTE_UPDATED', 'STUB_ORDER_NOTE_UPDATED', {requestId,
                        dealId,
                        shopifyOrderId,
                        oldNote: currentNote.substring(0, 100),
                        newNote: updatedNote});
                    }
                  }
                }

                                logger.info('STUB_ORDER_CLEANUP_SUCCESS', 'STUB_ORDER_CLEANUP_SUCCESS', {requestId,
                  dealId,
                  shopifyOrderId});
              } catch (stubCleanupError) {
                logger.warn('stub_cleanup_error', 'Failed to clean up stub order', { shopifyOrderId, dealId, error: stubCleanupError.message }, { entityType: 'order', entityId: shopifyOrderId });
                                logger.info('STUB_ORDER_CLEANUP_ERROR', 'STUB_ORDER_CLEANUP_ERROR', {requestId,
                  dealId,
                  shopifyOrderId,
                  error: stubCleanupError.message,
                  stack: stubCleanupError.stack});
              }
            }

            // Add BitrixUpdated tag if any changes were made
            if (hasChanges) {
              try {
                await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
                                logger.info('QUANTITY_SYNC_TAG_ADDED', 'QUANTITY_SYNC_TAG_ADDED', {requestId,
                  dealId,
                  shopifyOrderId});
              } catch (tagError) {
                logger.warn('quantity_sync_tag_error', 'Failed to add BitrixUpdated tag', { shopifyOrderId, dealId, error: tagError.message }, { entityType: 'order', entityId: shopifyOrderId });
              }
            }
          } else {
                        logger.info('QUANTITY_SYNC_NO_CHANGES', 'QUANTITY_SYNC_NO_CHANGES', {requestId,
              dealId,
              shopifyOrderId,
              bitrixItemsCount: bitrixQuantities.size,
              shopifyItemsCount: shopifyLineItems.length,
              orphansCount: orphans.length});
          }
        }
      }
    } catch (quantitySyncError) {
      // Non-blocking: if we can't sync quantities, continue with normal flow
            logger.info('QUANTITY_SYNC_ERROR', 'QUANTITY_SYNC_ERROR', {requestId,
        dealId,
        shopifyOrderId,
        error: quantitySyncError.message,
        stack: quantitySyncError.stack});
      // Continue with normal flow - don't block order creation
    }
    } // end if (!c2LoopGuard)
  } else {
        logger.info('QUANTITY_SYNC_SKIP', 'QUANTITY_SYNC_SKIP', {requestId,
      dealId,
      shopifyOrderId: shopifyOrderId || 'empty',
      reason: 'no_shopify_order_id'});
  }

  // ✅ STEP C3: Sync payment status from Bitrix to Shopify (best-effort)
  // Bitrix field UF_CRM_1739183959976: 56=Paid, 58=Unpaid, 60=prepayment
  if (shopifyOrderId && shopifyOrderId.trim() !== '') {
    await syncShopifyPaymentStatusFromBitrix(dealData, shopifyOrderId, requestId, dealId);
  }

  // ✅ STEP D: Check if we need to create order in Shopify from Bitrix deal
  // Condition: No shopifyOrderId but deal has product rows
    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_PRE_CHECK', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRE_CHECK', {requestId,
    dealId,
    eventType: 'UPDATE',
    shopifyOrderId: shopifyOrderId || 'empty',
    shopifyOrderIdExists: !!(shopifyOrderId && shopifyOrderId.trim() !== '')});

  // ✅ CRITICAL: Multiple duplicate checks to prevent race conditions (same as CREATE)
  let shouldCreateOrder = !shopifyOrderId || shopifyOrderId.trim() === '';
  let existingShopifyOrderId = shopifyOrderId;

  if (shouldCreateOrder) {
    // Re-check shopifyOrderId after a short delay (race condition protection)
    await new Promise(resolve => setTimeout(resolve, 200));

    try {
      const dealRecheckResp = await callBitrix('/crm.deal.get.json', { id: dealId });
      if (dealRecheckResp.result) {
        const recheckShopifyOrderId = dealRecheckResp.result.UF_CRM_1742556489 || dealRecheckResp.result.uf_crm_1742556489;
        if (recheckShopifyOrderId && recheckShopifyOrderId.trim() !== '') {
                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK', {requestId,
            dealId,
            eventType: 'UPDATE',
            message: 'Found shopifyOrderId on recheck (race condition prevented)',
            shopifyOrderId: recheckShopifyOrderId});
          shouldCreateOrder = false;
          existingShopifyOrderId = recheckShopifyOrderId;
        }
      }
    } catch (recheckError) {
      logger.warn('deal_recheck_error', 'Error rechecking deal for shopifyOrderId', { dealId, requestId, error: recheckError?.message }, { entityType: 'deal', entityId: dealId });
    }

    // If still should create, check Shopify for existing order by tag
    if (shouldCreateOrder) {
      const existingOrderId = await findExistingOrderByDealId(dealId);

      if (existingOrderId) {
                logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK', {requestId,
          dealId,
          eventType: 'UPDATE',
          message: 'Found existing order in Shopify by BITRIX tag (duplicate prevented)',
          existingShopifyOrderId: existingOrderId});
        shouldCreateOrder = false;
        existingShopifyOrderId = existingOrderId;

        // Update deal with found shopifyOrderId
        try {
          await callBitrix('/crm.deal.update.json', {
            id: dealId,
            fields: {
              UF_CRM_1742556489: existingOrderId
            }
          });
          logger.info('deal_shopify_order_id_updated', 'Updated deal with found shopifyOrderId', { dealId, existingOrderId }, { entityType: 'deal', entityId: dealId });
        } catch (updateError) {
          logger.warn('deal_shopify_order_id_update_error', 'Failed to update deal with found shopifyOrderId', { dealId, existingOrderId, error: updateError?.message }, { entityType: 'deal', entityId: dealId });
        }
      }
    }
  }

  if (shouldCreateOrder) {
    // ═══════════════════════════════════════════════════════════════════════════
    // UNIFIED ORDER CREATION (refactored)
    // Category 4: Catalog Order (Brand/Model/Size UF fields)
    // All others: Regular Order (Product Rows)
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      let items = [];

            logger.info('UNIFIED_ORDER_CREATION_START', 'UNIFIED_ORDER_CREATION_START', {requestId,
        dealId,
        categoryId,
        orderType: String(categoryId) === '4' ? 'REGULAR_OR_CATALOG' : 'REGULAR'});

      let orderType = 'REGULAR';

      if (String(categoryId) === '4') {
        // ✅ Category 4: First try Product Rows, then fallback to Brand/Model/Size UF fields
        items = await resolveRegularOrderItems(dealId, requestId);

        if (items.length > 0) {
                    logger.info('CATEGORY_4_PRODUCT_ROWS_FOUND', 'CATEGORY_4_PRODUCT_ROWS_FOUND', {requestId,
            dealId,
            itemsCount: items.length,
            message: 'Using product rows for Category 4 order'});
        } else {
          // Fallback to CATALOG (Brand/Model/Size UF fields)
                    logger.info('CATEGORY_4_CATALOG_FALLBACK', 'CATEGORY_4_CATALOG_FALLBACK', {requestId,
            dealId,
            message: 'No product rows found, trying Brand/Model/Size UF fields'});
          items = await resolveCatalogOrderItems(dealId, dealData, requestId);
          if (items.length > 0) {
            orderType = 'CATALOG';
          }
        }

        // ✅ RACE CONDITION GUARD: If no items found, skip order creation
        // Next UPDATE webhook will handle it after product data is populated
        if (items.length === 0) {
                    logger.info('CATEGORY_4_NO_ITEMS_SKIP', 'CATEGORY_4_NO_ITEMS_SKIP', {requestId,
            dealId,
            message: 'No product rows or UF fields found, skipping order creation (race condition guard)'});
          // Don't throw error, just skip - next webhook will process
        }
      } else {
        // REGULAR ORDER: Use Product Rows
        items = await resolveRegularOrderItems(dealId, requestId);
      }

      if (items.length > 0) {
                logger.info('UNIFIED_ORDER_ITEMS_RESOLVED', 'UNIFIED_ORDER_ITEMS_RESOLVED', {requestId,
          dealId,
          itemsCount: items.length});

        // Extract shipping address from Bitrix deal
        let shippingAddress = null;
        const bitrixAddressField = dealData.UF_CRM_1742037435676 || dealData.uf_crm_1742037435676 || '';
        if (bitrixAddressField && typeof bitrixAddressField === 'string' && bitrixAddressField.trim() !== '') {
          const parsedAddress = parseBitrixAddressString(bitrixAddressField);
          if (parsedAddress && Object.keys(parsedAddress).length > 0) {
            if (parsedAddress.country && !parsedAddress.country_code) {
              try {
                const { callShopifyAdmin } = await import('../../../src/lib/shopify/adminClient.js');
                const countriesResponse = await callShopifyAdmin('/countries.json');
                const countries = countriesResponse.countries || [];
                const countryMatch = countries.find(c => c.name.toLowerCase() === parsedAddress.country.toLowerCase());
                if (countryMatch) {
                  parsedAddress.country_code = countryMatch.code;
                  parsedAddress.country = countryMatch.name;
                }
              } catch (countryError) {
                logger.warn('order_create_country_resolve_error', 'Failed to resolve country code for order create', { dealId, country: parsedAddress?.country, error: countryError.message }, { entityType: 'deal', entityId: dealId });
              }
            }
            shippingAddress = parsedAddress;
          }
        }

        const shippingLines = [{ title: 'Standard Shipping', price: '0.00', code: 'Free' }];
        const correlationId = `bitrix:${dealId}:${requestId}`;
        const customerEmail = await resolveCustomerEmailFromDeal(dealData, requestId, dealId, 'UNIFIED_ORDER_CREATE');

        const orderResult = await createOrderFromBitrix(items, dealId, correlationId, {
          shippingAddress,
          shippingLines,
          customerEmail
        });

        if (orderResult.success) {
          const createdOrderId = String(orderResult.orderId);
          let orderName = orderResult.orderName;

          // Fetch real order name if duplicate
          if (orderResult.wasDuplicate && orderName && !orderName.startsWith('#')) {
            try {
              const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
              const existingOrder = await getOrder(createdOrderId);
              if (existingOrder && existingOrder.name) {
                orderName = existingOrder.name;
              }
            } catch (fetchError) {
              logger.warn('order_name_fetch_error', 'Failed to fetch order name', { dealId, createdOrderId, error: fetchError.message }, { entityType: 'order', entityId: createdOrderId });
            }
          }

          // Update Bitrix deal
          try {
            const updateFields = { UF_CRM_1742556489: createdOrderId };
            const currentTitle = dealData.TITLE || '';
            const orderNumberFromName = orderName ? orderName.replace('#', '') : null;
            const orderNumberPattern = orderNumberFromName ? new RegExp(`#?${orderNumberFromName}\\b`) : /#\d+/;
            const alreadyContainsThisOrderNumber = orderNumberFromName && orderNumberPattern.test(currentTitle);
            const isValidOrderName = orderName && orderName.trim() !== '' && (orderName.startsWith('#') || /^#?\d+$/.test(orderName.replace('#', '')));
            const isNotPlaceholderName = orderName && !orderName.includes('Existing order') && !orderName.includes('Order ');

            if (!alreadyContainsThisOrderNumber && isValidOrderName && isNotPlaceholderName) {
              updateFields.TITLE = orderName.startsWith('#') ? orderName : `#${orderName}`;
            }

            await callBitrix('/crm.deal.update.json', { id: dealId, fields: updateFields });
            shopifyOrderId = createdOrderId;

                        logger.info('UNIFIED_ORDER_CREATE_SUCCESS', 'UNIFIED_ORDER_CREATE_SUCCESS', {requestId,
              dealId,
              shopifyOrderId: createdOrderId,
              orderName,
              titleUpdated: !!updateFields.TITLE});
            logger.info('order_created', 'Shopify order created from Bitrix deal', {
              entity_id: String(dealId),
              shopify_order_id: createdOrderId,
              order_name: orderName,
            });
          } catch (updateError) {
            logger.error('deal_update_after_order_error', 'Error updating deal after order creation', { dealId, error: updateError.message }, { entityType: 'deal', entityId: dealId });
          }
        } else {
                    logger.info('UNIFIED_ORDER_CREATE_ERROR', 'UNIFIED_ORDER_CREATE_ERROR', {requestId,
            dealId,
            error: orderResult.error,
            message: orderResult.message});
          logger.error('order_create_failed', 'Failed to create Shopify order from Bitrix deal', {
            entity_id: String(dealId),
            error_message: orderResult.error || orderResult.message,
          });
        }
      } else {
                logger.info('UNIFIED_ORDER_NO_ITEMS', 'UNIFIED_ORDER_NO_ITEMS', {requestId,
          dealId,
          categoryId,
          message: String(categoryId) === '4' ? 'Missing Brand/Model/Size or variant not found' : 'No product rows'});
      }
    } catch (orderCreateError) {
      logger.error('unified_order_create_error', 'Error in unified order creation', { dealId, requestId, error: orderCreateError.message }, { entityType: 'deal', entityId: dealId });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // STEP: COMMENT SYNC (Bitrix COMMENTS → Shopify note)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (shopifyOrderId && shopifyOrderId.trim() !== '' && comments) {
    try {
      const { updateOrder, getOrder } = await import('../../../src/lib/shopify/adminClient.js');
      const shopifyOrder = await getOrder(shopifyOrderId);
      const currentNote = (shopifyOrder?.note || '').trim();
      const bitrixComment = comments.trim();

      // Only sync if Bitrix comment differs from current Shopify note
      if (bitrixComment && currentNote !== bitrixComment) {
        await updateOrder(shopifyOrderId, { id: shopifyOrderId, note: bitrixComment });
                logger.info('COMMENT_SYNC_SUCCESS', 'COMMENT_SYNC_SUCCESS', {requestId,
          dealId,
          shopifyOrderId,
          noteBefore: currentNote.substring(0, 100),
          noteAfter: bitrixComment.substring(0, 100)});
      }
    } catch (commentErr) {
      logger.warn('comment_sync_error', 'Comment sync failed', { shopifyOrderId, dealId, error: commentErr.message }, { entityType: 'order', entityId: shopifyOrderId });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // STEP: TITLE IDENTITY CHECK (always verify deal TITLE = #orderName)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (shopifyOrderId && shopifyOrderId.trim() !== '') {
    try {
      const { getOrder: getShopifyOrder } = await import('../../../src/lib/shopify/adminClient.js');
      const shopifyOrder = await getShopifyOrder(shopifyOrderId);
      const expectedTitle = shopifyOrder?.name || null; // e.g. "#2990"

      if (expectedTitle && dealData.TITLE !== expectedTitle) {
        logger.warn('title_mismatch_detected', 'Deal title mismatch with Shopify order name', { dealId, shopifyOrderId, dealTitle: dealData.TITLE, expectedTitle }, { entityType: 'deal', entityId: dealId });
        try {
          await callBitrix('/crm.deal.update.json', {
            id: dealId,
            fields: { TITLE: expectedTitle }
          });
          logger.info('title_identity_fixed', 'Deal title fixed to match Shopify order name', { requestId, dealId, shopifyOrderId, oldTitle: dealData.TITLE, newTitle: expectedTitle }, { entityType: 'deal', entityId: dealId });
        } catch (titleErr) {
          logger.error('title_fix_error', 'Failed to fix deal title', { dealId, shopifyOrderId, error: titleErr.message }, { entityType: 'deal', entityId: dealId });
        }
      }
    } catch (titleCheckErr) {
      logger.warn('title_check_error', 'Title identity check failed', { shopifyOrderId, dealId, error: titleCheckErr.message });
    }
  }

  // No MW action found, continue with DELIVERY trigger (all categories)
  // Check Delivery trigger conditions
  // ✅ Updated: Now uses centralized stage mapping for C2:EXECUTING, C4:2, C8:2
  // Unified fulfillment logic: check existence first, then update or create
  const correlationId = `${dealId}:${shopifyOrderId || 'no-shopify-id'}`;
  const decision = {
    // ✅ Remove category restriction - delivery applies to all categories
    stageMatch: isDeliveryStage(stageId),
    shopifyOrderIdPresent: shopifyOrderId && shopifyOrderId.trim() !== '',
  };

  // ✅ Structured logging: [DELIVERY_TRIGGER_CHECK]
    logger.info('DELIVERY_TRIGGER_CHECK', 'DELIVERY_TRIGGER_CHECK', {requestId,
    dealId,
    correlationId,
    categoryId,
    stageId,
    shopifyOrderId,
    decision,
    supportedDeliveryStages: DELIVERY_STAGES});

  // Check if all conditions are met (removed categoryMatch - now using stageMatch only)
  if (decision.stageMatch && decision.shopifyOrderIdPresent) {

    // 🚀 FULL CONTROL SYNC: DELIVERY AUTOMATION (Intercepted)
    logger.info('delivery_trigger_start', 'Starting Full Fulfillment Sync', { shopifyOrderId, dealId, requestId, stageId }, { entityType: 'order', entityId: shopifyOrderId });
    const { fulfillAllOpenItems } = await import('../../../src/lib/shopify/fulfillment.js');
    const { addTagToOrder } = await import('../../../src/lib/shopify/order.js');
    const { updateOrder, getOrder } = await import('../../../src/lib/shopify/adminClient.js');

    // 1. Get Tracking info
    const trackingNumber = dealData.UF_CRM_1741776378819 || dealData.uf_crm_1741776378819 || null;
    const trackingUrl = dealData.UF_CRM_TRACKING_URL || dealData.uf_crm_tracking_url || null;

    // 2. Fulfill All Open Items
    const fulfillmentResult = await fulfillAllOpenItems(shopifyOrderId, {
      tracking_number: trackingNumber,
      tracking_url: trackingUrl,
      notify_customer: true,
      message: 'Auto-fulfilled via Bitrix C2:Delivery'
    });

    if (fulfillmentResult.success) {
      logger.info('delivery_trigger_fulfilled', 'Fulfillment sync result', { shopifyOrderId, dealId, skipped: fulfillmentResult.skipped, result: fulfillmentResult }, { entityType: 'order', entityId: shopifyOrderId });
    } else {
      logger.error('delivery_trigger_fulfillment_error', 'Fulfillment sync failed', { shopifyOrderId, dealId, error: fulfillmentResult.message }, { entityType: 'order', entityId: shopifyOrderId });
    }

    // 3. Update Order Note & Tags
    try {
      await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
      await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');

      const shopifyOrder = await getOrder(shopifyOrderId);
      if (shopifyOrder) {
        const currentNote = shopifyOrder.note || '';
        if (!currentNote.toLowerCase().includes('in delivery')) {
          const newNote = currentNote ? `${currentNote}\n\n[Bitrix] Order in delivery` : `[Bitrix] Order in delivery`;
          await updateOrder(shopifyOrderId, { id: shopifyOrderId, note: newNote });
        }
      }
    } catch (e) {
      logger.warn('delivery_trigger_tag_note_error', 'Tag/Note update failed after delivery trigger', { shopifyOrderId, dealId, error: e.message }, { entityType: 'order', entityId: shopifyOrderId });
    }

    // Return immediately to bypass legacy logic
    return { success: true, triggerMatch: true, correlationId };

    // ⬇️ LEGACY LOGIC BELOW (UNREACHABLE) ⬇️
    // ✅ DELIVERY TRIGGER MATCHED
        logger.info('DELIVERY_TRIGGER_MATCH', 'DELIVERY_TRIGGER_MATCH', {requestId,
      dealId,
      correlationId,
      categoryId,
      stageId,
      shopifyOrderId});

    // ✅ UNIFIED FULFILLMENT LOGIC: Check existence first, then update or create
    try {
      // Step 1: Check if order is technical order
      const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
      const shopifyOrder = await getOrder(shopifyOrderId);

      if (!shopifyOrder) {
                logger.info('DELIVERY_ORDER_NOT_FOUND', 'DELIVERY_ORDER_NOT_FOUND', {requestId,
          dealId,
          shopifyOrderId});
        return { success: true, triggerMatch: true, correlationId };
      }

      const orderTags = Array.isArray(shopifyOrder.tags)
        ? shopifyOrder.tags
        : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
      const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));

      // ✅ REMOVED: isBitrixOrder skip - we WANT fulfillment to work for ALL orders
      // Previously this was skipping Bitrix-created orders, but user needs fulfillment+tracking for them too
            logger.info('DELIVERY_BITRIX_ORDER_CHECK', 'DELIVERY_BITRIX_ORDER_CHECK', {requestId,
        dealId,
        shopifyOrderId,
        isBitrixOrder,
        proceedingWithFulfillment: true});

      // Step 2: Set provenance marker first
      const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId);

      if (provenanceResult.success) {
                logger.info('SHOPIFY_PROVENANCE_SET', 'SHOPIFY_PROVENANCE_SET', {requestId,
          dealId,
          correlationId,
          shopifyOrderId,
          httpStatus: provenanceResult.httpStatus});
      } else {
                logger.info('SHOPIFY_PROVENANCE_SET_ERROR', 'SHOPIFY_PROVENANCE_SET_ERROR', {requestId,
          dealId,
          correlationId,
          shopifyOrderId,
          httpStatus: provenanceResult.httpStatus,
          error: provenanceResult.error,
          message: provenanceResult.message});
      }

      // Step 3: Check if tracking info is provided in deal fields
      // User field: UF_CRM_1741776378819 = Tracking Number
      const trackingNumber = dealData.UF_CRM_1741776378819 || dealData.uf_crm_1741776378819 || null;
      const trackingUrl = dealData.UF_CRM_TRACKING_URL || dealData.uf_crm_tracking_url || null;
      const trackingUrls = trackingUrl ? [trackingUrl] : [];

      // Step 4: Check if fulfillment exists
      const { getFulfillmentOrders, updateOrderFulfillmentForDelivery } = await import('../../../src/lib/shopify/fulfillment.js');
      const fulfillmentsResponse = await getFulfillmentOrders(shopifyOrderId);
      const hasFulfillment = fulfillmentsResponse.success && fulfillmentsResponse.fulfillments && fulfillmentsResponse.fulfillments.length > 0;

      // Step 5: Update order note to show "в доставке" / "in delivery" status
      const { updateOrder } = await import('../../../src/lib/shopify/adminClient.js');
      const { addTagToOrder } = await import('../../../src/lib/shopify/order.js');

      try {
        const currentNote = shopifyOrder.note || '';
        const deliveryNote = `[Bitrix: C2:EXECUTING] Заказ в доставке / Order in delivery${trackingNumber ? ` | Tracking: ${trackingNumber}` : ''}`;

        // Only update note if it doesn't already contain delivery status
        let updatedNote = currentNote;
        if (!currentNote.includes('в доставке') && !currentNote.includes('in delivery')) {
          updatedNote = currentNote ? `${currentNote}\n\n${deliveryNote}` : deliveryNote;
        } else if (trackingNumber && !currentNote.includes(trackingNumber)) {
          // Update note with tracking if not present
          updatedNote = currentNote.replace(/Tracking:.*/, `Tracking: ${trackingNumber}`);
        }

        // Update order with note
        await updateOrder(shopifyOrderId, {
          id: shopifyOrderId,
          note: updatedNote
        });

                logger.info('DELIVERY_ORDER_NOTE_UPDATED', 'DELIVERY_ORDER_NOTE_UPDATED', {requestId,
          dealId,
          shopifyOrderId,
          stageId,
          noteUpdated: true});
      } catch (noteError) {
        logger.warn('order_note_update_error', 'Failed to update order note', { shopifyOrderId, dealId, error: noteError.message }, { entityType: 'order', entityId: shopifyOrderId });
      }

      // Step 6: Update existing fulfillment OR create new one
      let fulfillmentResult = null;

      if (hasFulfillment) {
        // Update existing fulfillment with tracking
                logger.info('DELIVERY_FULFILLMENT_UPDATE_ATTEMPT', 'DELIVERY_FULFILLMENT_UPDATE_ATTEMPT', {requestId,
          dealId,
          shopifyOrderId,
          trackingNumber});

        fulfillmentResult = await updateOrderFulfillmentForDelivery(shopifyOrderId, {
          notify_customer: true,
          tracking_number: trackingNumber,
          tracking_urls: trackingUrls.length > 0 ? trackingUrls : undefined
        });

        if (fulfillmentResult && fulfillmentResult.success) {
                    logger.info('DELIVERY_FULFILLMENT_UPDATE_SUCCESS', 'DELIVERY_FULFILLMENT_UPDATE_SUCCESS', {requestId,
            dealId,
            shopifyOrderId,
            stageId,
            fulfillmentId: fulfillmentResult.fulfillmentId});
        } else if (fulfillmentResult && !fulfillmentResult.success) {
                    logger.info('DELIVERY_FULFILLMENT_UPDATE_ERROR', 'DELIVERY_FULFILLMENT_UPDATE_ERROR', {requestId,
            dealId,
            shopifyOrderId,
            stageId,
            error: fulfillmentResult.error,
            message: fulfillmentResult.message});
        }
      } else {
        // Fulfillment doesn't exist - check if we need to create it
        const orderData = await getOrderForFulfillment(shopifyOrderId);

        if (!orderData.success) {
                    logger.info('SHOPIFY_FULFILLMENT_CREATE_SKIP', 'SHOPIFY_FULFILLMENT_CREATE_SKIP', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            skip_reason: 'order_fetch_error',
            error: orderData.error,
            message: orderData.message});
          // Add tags even if fulfillment creation skipped
          try {
            await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
            await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');
          } catch (tagError) {
            logger.warn('tags_add_error', 'Failed to add tags to order', { shopifyOrderId, dealId, error: tagError.message }, { entityType: 'order', entityId: shopifyOrderId });
          }
          return { success: true, triggerMatch: true, correlationId };
        }

        // Check if already fulfilled
        if (orderData.isFullyFulfilled) {
                    logger.info('SHOPIFY_FULFILLMENT_ALREADY_FULFILLED', 'SHOPIFY_FULFILLMENT_ALREADY_FULFILLED', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            message: 'Order is already fulfilled - no action needed'});
          // Add tags
          try {
            await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
            await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');
          } catch (tagError) {
            logger.warn('tags_add_error', 'Failed to add tags to order', { shopifyOrderId, dealId, error: tagError.message }, { entityType: 'order', entityId: shopifyOrderId });
          }
          return { success: true, triggerMatch: true, correlationId };
        }

        // Check if fulfillment is needed
        if (!orderData.needsFulfillment) {
                    logger.info('SHOPIFY_FULFILLMENT_CREATE_SKIP', 'SHOPIFY_FULFILLMENT_CREATE_SKIP', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            skip_reason: 'nothing_to_fulfill',
            totalFulfillableQuantity: orderData.totalFulfillableQuantity});
          // Add tags even if fulfillment creation skipped
          try {
            await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
            await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');
          } catch (tagError) {
            logger.warn('tags_add_error', 'Failed to add tags to order', { shopifyOrderId, dealId, error: tagError.message }, { entityType: 'order', entityId: shopifyOrderId });
          }
          return { success: true, triggerMatch: true, correlationId };
        }

        // Create fulfillment
                logger.info('SHOPIFY_FULFILLMENT_CREATE_ATTEMPT', 'SHOPIFY_FULFILLMENT_CREATE_ATTEMPT', {requestId,
          dealId,
          correlationId,
          shopifyOrderId,
          totalFulfillableQuantity: orderData.totalFulfillableQuantity,
          itemsToFulfill: orderData.itemsToFulfill.length});

        const { createFulfillment } = await import('../../../src/lib/shopify/fulfillment.js');
        fulfillmentResult = await createFulfillment(shopifyOrderId, orderData.itemsToFulfill, {
          notify_customer: true,
          tracking_number: trackingNumber,
          tracking_url: trackingUrl, // Single URL preferred by new logic
          // tracking_company: dealData.UF_CRM_CARRIER, // Uncomment and map field when available
          tracking_urls: trackingUrls // Legacy fallback
        });

        if (fulfillmentResult.success) {
                    logger.info('SHOPIFY_FULFILLMENT_CREATE_SUCCESS', 'SHOPIFY_FULFILLMENT_CREATE_SUCCESS', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            fulfillmentId: fulfillmentResult.fulfillmentId,
            fulfillmentIds: fulfillmentResult.fulfillmentIds,
            httpStatus: fulfillmentResult.httpStatus});

          // ✅ A3.1: Get post-fulfillment state for verification
          try {
            const postState = await getPostFulfillmentState(shopifyOrderId);

                        logger.info('SHOPIFY_POST_FULFILLMENT_STATE', 'SHOPIFY_POST_FULFILLMENT_STATE', {requestId,
              dealId,
              correlationId,
              shopifyOrderId: postState.shopifyOrderId,
              fulfillmentIds: postState.fulfillmentIds,
              fulfillmentStatuses: postState.fulfillmentStatuses,
              orderFulfillmentStatus: postState.orderFulfillmentStatus,
              lineItemsSummary: postState.lineItemsSummary});

            // Update stored event with fulfillment state for UI
            if (storedEvent) {
              storedEvent.fulfillmentState = postState.orderFulfillmentStatus;
            }
          } catch (postStateError) {
                        logger.info('SHOPIFY_POST_FULFILLMENT_STATE_ERROR', 'SHOPIFY_POST_FULFILLMENT_STATE_ERROR', {requestId,
              dealId,
              correlationId,
              shopifyOrderId,
              error: postStateError.message});
          }
        } else if (fulfillmentResult && fulfillmentResult.error === 'SHOPIFY_FULFILLMENT_CREATE_SKIP') {
                    logger.info('SHOPIFY_FULFILLMENT_CREATE_SKIP', 'SHOPIFY_FULFILLMENT_CREATE_SKIP', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            skip_reason: fulfillmentResult.skip_reason,
            message: fulfillmentResult.message});
        } else if (fulfillmentResult && !fulfillmentResult.success) {
                    logger.info('SHOPIFY_FULFILLMENT_CREATE_ERROR', 'SHOPIFY_FULFILLMENT_CREATE_ERROR', {requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            error: fulfillmentResult.error,
            httpStatus: fulfillmentResult.httpStatus,
            message: fulfillmentResult.message,
            responseSnippet: fulfillmentResult.responseSnippet});
        }
      } // Close else block for fulfillment creation

      // Step 7: Add tags to prevent webhook loop and mark as in delivery (for both update and create)
      try {
        await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
        await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');
      } catch (tagError) {
        logger.warn('tags_add_error', 'Failed to add tags to order', { shopifyOrderId, dealId, error: tagError.message }, { entityType: 'order', entityId: shopifyOrderId });
      }
    } catch (error) {
      // Log any unexpected errors during fulfillment creation
            logger.info('SHOPIFY_FULFILLMENT_CREATE_ERROR', 'SHOPIFY_FULFILLMENT_CREATE_ERROR', {requestId,
        dealId,
        correlationId,
        shopifyOrderId,
        error: error.message,
        stack: error.stack});
    }

    return { success: true, triggerMatch: true, correlationId };
  } else {
    // Conditions not met - log skip reason
    // Conditions not met - log skip reason
    const skipReasons = [];
    // Category check removed as delivery applies to multiple categories
    if (!decision.stageMatch) {
      const { DELIVERY_STAGES } = await import('../../../src/lib/bitrix/stageMapping.js');
      skipReasons.push(`stageId=${stageId} is not in [${Object.values(DELIVERY_STAGES).join(', ')}]`);
    }
    if (!decision.shopifyOrderIdPresent) {
      skipReasons.push('shopifyOrderId is missing or empty');
    }

    const skipReason = skipReasons.join('; ');

    // ✅ Structured logging: [DELIVERY_TRIGGER_SKIP]
        logger.info('DELIVERY_TRIGGER_SKIP', 'DELIVERY_TRIGGER_SKIP', {requestId,
      dealId,
      correlationId,
      categoryId,
      stageId,
      shopifyOrderId,
      skip_reason: skipReason,
      decision});

    return { success: true, triggerMatch: false, skip_reason: skipReason };
  }
}

/**
 * Handle deal creation event from Bitrix
 * Creates Shopify order if deal has products but no shopifyOrderId
 */
async function handleDealCreate(dealId, requestId) {
  // ✅ Structured logging: [BITRIX_WEBHOOK_RECEIVED] (CREATE)
    logger.info('BITRIX_WEBHOOK_RECEIVED', 'BITRIX_WEBHOOK_RECEIVED', {requestId,
    dealId,
    eventType: 'CREATE'}, { entityType: 'deal', entityId: String(dealId) });

  // Get full deal data from Bitrix REST API
  let dealData = null;
  try {
    const dealResp = await callBitrix('/crm.deal.get.json', {
      id: dealId,
    });

    if (!dealResp.result) {
      logger.warn('DEAL_GET_FAILED', 'Deal not found or failed to fetch', { requestId, dealId, response: dealResp });
      return { success: false, reason: 'deal_not_found' };
    }

    dealData = dealResp.result;
  } catch (error) {
    logger.error('DEAL_GET_ERROR', 'Failed to fetch deal from Bitrix', { requestId, dealId, error: error.message });
    return { success: false, reason: 'deal_get_error', error: error.message };
  }

  // Extract required fields
  const categoryId = dealData.CATEGORY_ID;
  const stageId = dealData.STAGE_ID;
  let shopifyOrderId = dealData.UF_CRM_1742556489 || dealData.uf_crm_1742556489;
  const comments = dealData.COMMENTS || '';

  // ✅ Structured logging: [DEAL_DATA_RECEIVED] (CREATE)
  logger.info('DEAL_DATA_RECEIVED', 'Deal data received (CREATE)', { requestId, dealId, eventType: 'CREATE', categoryId, stageId, shopifyOrderId });

  // Store event in adapter for UI display
  let storedEvent = null;
  try {
    storedEvent = bitrixAdapter.storeEvent({
      dealId,
      categoryId,
      stageId,
      shopifyOrderId,
      comments,
      received_at: new Date().toISOString(),
      rawDealData: dealData,
      fulfillmentState: null
    });
  } catch (storeError) {
    logger.warn('store_event_error', 'Failed to store event (non-blocking)', { dealId, requestId, error: storeError?.message }, { entityType: 'deal', entityId: dealId });
  }

  // ✅ Check for MW action first (UF_MW_SHOPIFY_ACTION)
  const mwActionResult = await handleMWAction(dealId, requestId, dealData, shopifyOrderId);
  if (mwActionResult !== null) {
    if (mwActionResult.success) {
      try {
        await callBitrix('/crm.deal.update.json', { id: dealId, fields: { UF_MW_SHOPIFY_ACTION: '' } });
        logger.info('MW_ACTION_CONSUMED', 'UF_MW_SHOPIFY_ACTION cleared after successful execution', {
          requestId, dealId, action: mwActionResult.action
        }, { entityType: 'deal', entityId: String(dealId) });
      } catch (consumeErr) {
        logger.warn('MW_ACTION_CONSUME_FAILED', 'Failed to clear UF_MW_SHOPIFY_ACTION (non-blocking)', {
          requestId, dealId, action: mwActionResult.action, error: consumeErr.message
        }, { entityType: 'deal', entityId: String(dealId) });
      }
    }
    return mwActionResult;
  }

  // ✅ CHECK CREATE MODE (UF_CRM_1768864699586)
  // 0 = search existing product (default, no change to existing logic)
  // 1 = create new product in Shopify before order creation
  const createModeRaw = dealData.UF_CRM_1768864699586 || dealData.uf_crm_1768864699586 || '0';
  const createMode = String(createModeRaw).trim();

    logger.info('CREATE_MODE_CHECK', 'CREATE_MODE_CHECK', {requestId,
    dealId,
    createMode});

  let productCreateResult = null;
  if (createMode === '1') {
    logger.info('product_create_mode_start', 'Create Mode = 1: Creating product in Shopify before order', { dealId, requestId }, { entityType: 'deal', entityId: dealId });
    productCreateResult = await handleProductCreateMode(dealId, dealData, requestId);

    if (!productCreateResult.success) {
      logger.error('product_create_mode_failed', 'Product create mode failed', { dealId, error: productCreateResult.error }, { entityType: 'deal', entityId: dealId });
      return {
        success: false,
        reason: 'product_create_mode_failed',
        error: productCreateResult.error
      };
    }

    logger.info('product_create_mode_success', 'Product created before order', { dealId, variantId: productCreateResult.variantId, bitrixProductId: productCreateResult.bitrixProductId }, { entityType: 'deal', entityId: dealId });

    // Refresh deal data after product rows were updated
    try {
      const refreshedDealResp = await callBitrix('/crm.deal.get.json', { id: dealId });
      if (refreshedDealResp.result) {
        dealData = refreshedDealResp.result;
        logger.info('deal_data_refreshed', 'Deal data refreshed after product creation', { dealId }, { entityType: 'deal', entityId: dealId });
      }
    } catch (refreshError) {
      logger.warn('deal_data_refresh_error', 'Failed to refresh deal data after product creation', { dealId, error: refreshError.message }, { entityType: 'deal', entityId: dealId });
    }
  }

  // ✅ ON-DEMAND SKU CREATION moved to orderMapper.js (Shopify-triggered flow)
  // Products are now auto-created when Shopify order arrives with unknown variant_id

  // ✅ Check if we need to create order in Shopify from Bitrix deal
  // Condition: No shopifyOrderId but deal has product rows
    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_PRE_CHECK', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRE_CHECK', {requestId,
    dealId,
    eventType: 'CREATE',
    shopifyOrderId: shopifyOrderId || 'empty',
    shopifyOrderIdExists: !!(shopifyOrderId && shopifyOrderId.trim() !== '')});

  // ✅ CRITICAL: Multiple duplicate checks to prevent race conditions
  // Check 1: shopifyOrderId from deal data
  // Check 2: Re-check shopifyOrderId after delay (in case another request just updated it)
  // Check 3: Search Shopify for existing order by BITRIX:{dealId} tag
  let shouldCreateOrder = !shopifyOrderId || shopifyOrderId.trim() === '';
  let existingShopifyOrderId = shopifyOrderId;

  if (shouldCreateOrder) {
    // Re-check shopifyOrderId after a short delay (race condition protection)
    await new Promise(resolve => setTimeout(resolve, 200));

    try {
      const dealRecheckResp = await callBitrix('/crm.deal.get.json', { id: dealId });
      if (dealRecheckResp.result) {
        const recheckShopifyOrderId = dealRecheckResp.result.UF_CRM_1742556489 || dealRecheckResp.result.uf_crm_1742556489;
        if (recheckShopifyOrderId && recheckShopifyOrderId.trim() !== '') {
                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK', {requestId,
            dealId,
            eventType: 'CREATE',
            message: 'Found shopifyOrderId on recheck (race condition prevented)',
            shopifyOrderId: recheckShopifyOrderId});
          shouldCreateOrder = false;
          existingShopifyOrderId = recheckShopifyOrderId;
        }
      }
    } catch (recheckError) {
      logger.warn('deal_recheck_error', 'Error rechecking deal for shopifyOrderId', { dealId, requestId, error: recheckError?.message }, { entityType: 'deal', entityId: dealId });
    }

    // If still should create, check Shopify for existing order by tag
    if (shouldCreateOrder) {
      const existingOrderId = await findExistingOrderByDealId(dealId);

      if (existingOrderId) {
                logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK', {requestId,
          dealId,
          eventType: 'CREATE',
          message: 'Found existing order in Shopify by BITRIX tag (duplicate prevented)',
          existingShopifyOrderId: existingOrderId});
        shouldCreateOrder = false;
        existingShopifyOrderId = existingOrderId;

        // Update deal with found shopifyOrderId
        try {
          await callBitrix('/crm.deal.update.json', {
            id: dealId,
            fields: {
              UF_CRM_1742556489: existingOrderId
            }
          });
          logger.info('deal_shopify_order_id_updated', 'Updated deal with found shopifyOrderId', { dealId, existingOrderId }, { entityType: 'deal', entityId: dealId });
        } catch (updateError) {
          logger.warn('deal_shopify_order_id_update_error', 'Failed to update deal with found shopifyOrderId', { dealId, existingOrderId, error: updateError?.message }, { entityType: 'deal', entityId: dealId });
        }
      }
    }
  }

  if (shouldCreateOrder) {
    try {
      // ═══════════════════════════════════════════════════════════════════════════
      // UNIFIED ORDER CREATION - Category-based logic
      // Category 4: Try Product Rows first (REGULAR), fallback to Catalog if empty
      // All others: Regular Order (Product Rows)
      // ═══════════════════════════════════════════════════════════════════════════

      // Category 4: Try REGULAR first, fallback to CATALOG if no product rows
      let orderType = 'REGULAR';
            logger.info('UNIFIED_ORDER_CREATION_START', 'UNIFIED_ORDER_CREATION_START', {requestId,
        dealId,
        eventType: 'CREATE',
        categoryId,
        orderType});

      let items = [];

      // ✅ CREATE MODE: Use variant directly from product creation result
      if (productCreateResult && productCreateResult.success && productCreateResult.variantId) {
        items.push({
          variantId: productCreateResult.variantId,
          qty: 1
        });
                logger.info('CREATE_MODE_USING_DIRECT_VARIANT', 'CREATE_MODE_USING_DIRECT_VARIANT', {requestId,
          dealId,
          variantId: productCreateResult.variantId,
          price: productCreateResult.price,
          title: productCreateResult.title});

        // ✅ CREATE MODE: Immediately create order with this variant
                logger.info('CREATE_MODE_ORDER_CREATION_START', 'CREATE_MODE_ORDER_CREATION_START', {requestId,
          dealId,
          variantId: productCreateResult.variantId});

        const correlationId = `CREATE_MODE:${dealId}:${Date.now()}`;

        // Get customer email from deal or fetch from Contact
        let customerEmail = dealData.UF_CRM_1741232139524 || dealData.uf_crm_1741232139524;
        let contactData = { firstName: '', lastName: '', phone: '', email: '' };

        if (!customerEmail && dealData.CONTACT_ID) {
          try {
            logger.info('create_mode_contact_fetch', 'Fetching contact for email/address', { dealId, contactId: dealData.CONTACT_ID }, { entityType: 'deal', entityId: dealId });
            const contactRes = await callBitrix('crm.contact.get', { id: dealData.CONTACT_ID });
            if (contactRes && contactRes.result) {
              const contact = contactRes.result;
              contactData.firstName = contact.NAME || '';
              contactData.lastName = contact.LAST_NAME || '';
              contactData.phone = Array.isArray(contact.PHONE) && contact.PHONE.length > 0 ? contact.PHONE[0].VALUE : '';

              if (Array.isArray(contact.EMAIL) && contact.EMAIL.length > 0) {
                customerEmail = contact.EMAIL[0].VALUE;
                contactData.email = customerEmail;
                logger.info('create_mode_email_found', 'Found email in contact', { dealId, email: customerEmail }, { entityType: 'deal', entityId: dealId });
              }

              // Bitrix fields: ADDRESS, ADDRESS_2, ADDRESS_CITY, ADDRESS_POSTAL_CODE, ADDRESS_REGION, ADDRESS_COUNTRY
              // Note: Bitrix sometimes puts region in ADDRESS_PROVINCE instead of ADDRESS_REGION
              // Bitrix fields: ADDRESS, ADDRESS_2, ADDRESS_CITY, ADDRESS_POSTAL_CODE, ADDRESS_REGION, ADDRESS_COUNTRY
              // Note: Bitrix sometimes puts region in ADDRESS_PROVINCE instead of ADDRESS_REGION
              contactData.address = {
                address1: contact.ADDRESS || '',
                address2: contact.ADDRESS_2 || '',
                city: contact.ADDRESS_CITY || '',
                zip: contact.ADDRESS_POSTAL_CODE || '',
                province: contact.ADDRESS_REGION || contact.ADDRESS_PROVINCE || '',
                country: contact.ADDRESS_COUNTRY || ''
              };

              // FALLBACK: If Contact address is empty, try to parse the "Update Address Field" from Deal
              // Logic copied from Update field as requested
              const isContactAddressEmpty = !contactData.address.address1 && !contactData.address.city;
              // Support both casing just in case, though usually uppercase keys in this context
              const updateAddressString = dealData.UF_CRM_1742037435676 || dealData.uf_crm_1742037435676;

              if (isContactAddressEmpty && updateAddressString) {
                logger.info('create_mode_address_fallback', 'Contact address empty, parsing fallback field', { dealId, updateAddressString }, { entityType: 'deal', entityId: dealId });
                try {
                  // Dynamic import to allow using the logic from a different module
                  const { parseBitrixAddressString } = await import('../../../src/lib/blocks/addressUpdate.js');
                  const parsed = parseBitrixAddressString(updateAddressString);

                  if (parsed) {
                    logger.info('create_mode_address_parsed', 'Successfully parsed fallback address', { dealId, parsed }, { entityType: 'deal', entityId: dealId });
                    contactData.address.address1 = parsed.address1 || contactData.address.address1;
                    contactData.address.city = parsed.city || contactData.address.city;
                    contactData.address.zip = parsed.zip || contactData.address.zip;
                    contactData.address.country = parsed.country || contactData.address.country;
                    contactData.address.province = parsed.province || contactData.address.province;
                  }
                } catch (parseErr) {
                  logger.warn('create_mode_address_fallback_parse_error', 'Failed to parse fallback address in create mode', { dealId, error: parseErr.message }, { entityType: 'deal', entityId: dealId });
                }
              }

              logger.info('create_mode_contact_address_found', 'Found address in contact for create mode', { dealId, city: contactData.address.city, country: contactData.address.country, province: contactData.address.province }, { entityType: 'deal', entityId: dealId });

              // Try to resolve Country Name to Code if > 2 chars
              if (contactData.address.country && contactData.address.country.length > 2) {
                try {
                  logger.info('create_mode_country_resolve_start', 'Resolving country name to code in create mode', { dealId, country: contactData.address.country }, { entityType: 'deal', entityId: dealId });
                  const { callShopifyAdmin } = await import('../../../src/lib/shopify/adminClient.js');
                  // Fetch countries (TODO: Cache this?)
                  const countriesResponse = await callShopifyAdmin('/countries.json');
                  const countries = countriesResponse.countries || [];

                  const countryMatch = countries.find(c =>
                    c.name.toLowerCase() === contactData.address.country.toLowerCase() ||
                    (c.code && c.code.toLowerCase() === contactData.address.country.toLowerCase())
                  );

                  if (countryMatch) {
                    logger.info('create_mode_country_resolved', 'Country name resolved to code in create mode', { dealId, countryName: contactData.address.country, countryCode: countryMatch.code }, { entityType: 'deal', entityId: dealId });
                    contactData.address.country = countryMatch.code; // Set to ISO 2-char code
                  } else {
                    logger.warn('create_mode_country_unresolved', 'Could not resolve country to Shopify country code in create mode', { dealId, country: contactData.address.country, availableCountriesCount: countries.length }, { entityType: 'deal', entityId: dealId });
                  }
                } catch (countryErr) {
                  logger.warn('create_mode_country_resolve_error', 'Error resolving country code in create mode', { dealId, error: countryErr.message }, { entityType: 'deal', entityId: dealId });
                }
              }
            }
          } catch (contactErr) {
            logger.warn('create_mode_contact_fetch_error', 'Error fetching contact in create mode', { dealId, contactId: dealData.CONTACT_ID, error: contactErr.message }, { entityType: 'deal', entityId: dealId });
          }
        }

        // Fallback default if still no email
        if (!customerEmail) customerEmail = 'order@bfriendsclub.com';

        const orderResult = await createOrderFromBitrix(items, dealId, correlationId, {
          customerEmail,
          contactData, // Pass contact details for address/billing
          isStubOrder: false,
          stubReason: null
        });

        if (orderResult.success) {
          const createdOrderId = String(orderResult.orderId);

          // Update deal with Shopify Order ID and Title
          try {
            let orderName = orderResult.orderName || `#${createdOrderId}`;
            const updateFields = {
              UF_CRM_1742556489: createdOrderId
            };

            // Update title with order name (Force replace)
            updateFields.TITLE = orderName;

            await callBitrix('/crm.deal.update.json', {
              id: dealId,
              fields: updateFields
            });

                        logger.info('CREATE_MODE_ORDER_SUCCESS', 'CREATE_MODE_ORDER_SUCCESS', {requestId,
              dealId,
              shopifyOrderId: createdOrderId,
              orderName});
            logger.info('order_created', 'Shopify order created from Bitrix deal (create mode)', {
              entity_id: String(dealId),
              shopify_order_id: createdOrderId,
              order_name: orderName,
            });
          } catch (updateError) {
            logger.warn('create_mode_deal_update_error', 'Failed to update deal after create mode order', { dealId, error: updateError.message }, { entityType: 'deal', entityId: dealId });
          }

          return {
            success: true,
            action: 'order_created',
            shopifyOrderId: orderResult.orderId,
            orderName: orderResult.orderName
          };
        } else {
          logger.error('create_mode_order_create_failed', 'Order creation failed in create mode', { dealId, error: orderResult.error }, { entityType: 'deal', entityId: dealId });
          return {
            success: false,
            error: 'order_creation_failed',
            message: orderResult.error
          };
        }
      }

      // For REGULAR orders (when no Create Mode items), continue with standard order creation
      if (items.length === 0 && orderType === 'REGULAR') {
        // Get product rows from deal (original logic for non-Category-4)
        const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', {
          id: dealId
        });

                logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_PRODUCT_ROWS_RESPONSE', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRODUCT_ROWS_RESPONSE', {requestId,
          dealId,
          eventType: 'CREATE',
          productRowsExists: !!(productRowsResp && productRowsResp.result),
          productRowsIsArray: Array.isArray(productRowsResp?.result),
          productRowsCount: productRowsResp?.result?.length || 0,
          productRowsRespKeys: productRowsResp ? Object.keys(productRowsResp) : []});

        if (!productRowsResp || !productRowsResp.result) {
                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', {requestId,
            dealId,
            eventType: 'CREATE',
            skip_reason: 'no_product_rows_response',
            productRowsRespExists: !!productRowsResp});
        } else if (!Array.isArray(productRowsResp.result)) {
                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', {requestId,
            dealId,
            eventType: 'CREATE',
            skip_reason: 'product_rows_not_array',
            productRowsType: typeof productRowsResp.result});
        } else if (productRowsResp.result && Array.isArray(productRowsResp.result)) {
                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_CHECK', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_CHECK', {requestId,
            dealId,
            eventType: 'CREATE',
            productRowsCount: productRowsResp.result.length});

          // Convert Bitrix product rows to Shopify items
          // Need to get SKU from Bitrix product by PRODUCT_ID
          const items = [];
          let isStubOrder = false;
          let stubReason = null;
          for (const row of productRowsResp.result) {
            const productId = row.PRODUCT_ID;
            if (!productId) continue;

            // Get product details from Bitrix to get SKU
            try {
              const productResp = await callBitrix('/crm.product.get.json', {
                id: productId
              });

              if (productResp.result) {
                const product = productResp.result;
                const code = product.CODE;
                const xmlId = product.XML_ID; // XML_ID = variant_id in Shopify

                // Priority: CODE (SKU) first, then XML_ID (variant_id) directly
                if (code && code.trim() !== '') {
                  // Use CODE as SKU - will look up variant_id by SKU
                  items.push({
                    sku: code.trim(),
                    qty: row.QUANTITY || 1
                  });
                  logger.info('product_sku_resolved', 'Bitrix product resolved via CODE as SKU', { dealId, productId, sku: code.trim() }, { entityType: 'deal', entityId: dealId });
                } else if (xmlId && xmlId.toString().trim() !== '') {
                  // Use XML_ID directly as variant_id (no SKU lookup needed)
                  items.push({
                    variantId: xmlId.toString().trim(),
                    qty: row.QUANTITY || 1
                  });
                  logger.info('product_variant_id_resolved', 'Bitrix product resolved via XML_ID as variantId', { dealId, productId, variantId: xmlId }, { entityType: 'deal', entityId: dealId });
                } else {
                  logger.warn('product_sku_missing', 'Bitrix product has no CODE (SKU) or XML_ID (variant_id), skipping', { dealId, productId }, { entityType: 'deal', entityId: dealId });
                }
              }
            } catch (productError) {
              logger.error('product_fetch_error', 'Error fetching Bitrix product during order create', { dealId, productId, error: productError?.message || String(productError) }, { entityType: 'deal', entityId: dealId });
            }
          }

                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_ITEMS_COLLECTED', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ITEMS_COLLECTED', {requestId,
            dealId,
            eventType: 'CREATE',
            itemsCount: items.length,
            items: items.map(i => ({
              sku: i.sku || null,
              variantId: i.variantId || null,
              qty: i.qty
            })),
            itemsWithSku: items.filter(i => i.sku).length,
            itemsWithVariantId: items.filter(i => i.variantId).length});

          // ✅ Category 4 fallback: If no product rows, try CATALOG (Brand/Model/Size UF fields)
          if (items.length === 0 && categoryId === '4') {
                        logger.info('CATEGORY_4_CATALOG_FALLBACK', 'CATEGORY_4_CATALOG_FALLBACK', {requestId,
              dealId,
              message: 'No product rows, trying CATALOG fallback with Brand/Model/Size fields'});
            const catalogItems = await resolveCatalogOrderItems(dealId, dealData, requestId);
            if (catalogItems.length > 0) {
              items.push(...catalogItems);
              orderType = 'CATALOG';
            }
          }

          // ✅ If Bitrix sent empty product rows (0 items), optionally add default product
          if (items.length === 0 && productRowsResp.result.length === 0 && BITRIX_ALLOW_EMPTY_PRODUCT_LINES) {
            items.push({
              variantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
              qty: BITRIX_EMPTY_ORDER_DEFAULT_QTY
            });
            isStubOrder = true;
            stubReason = 'empty_product_rows';
                        logger.info('BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED', 'BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED', {requestId,
              dealId,
              eventType: 'CREATE',
              defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
              defaultQty: BITRIX_EMPTY_ORDER_DEFAULT_QTY,
              reason: 'empty_product_rows'});
          }

          // ✅ If product rows exist but we couldn't map any valid items, optionally add default product
          if (items.length === 0 && productRowsResp.result.length > 0 && BITRIX_ALLOW_EMPTY_PRODUCT_LINES) {
            items.push({
              variantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
              qty: BITRIX_EMPTY_ORDER_DEFAULT_QTY
            });
            isStubOrder = true;
            stubReason = 'no_mappable_items';
                        logger.info('BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED', 'BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED', {requestId,
              dealId,
              eventType: 'CREATE',
              defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
              defaultQty: BITRIX_EMPTY_ORDER_DEFAULT_QTY,
              reason: 'no_mappable_items'});
          }

          if (items.length > 0) {
                        logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_ATTEMPT', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ATTEMPT', {requestId,
              dealId,
              eventType: 'CREATE',
              itemsCount: items.length,
              items: items.map(i => ({ sku: i.sku, qty: i.qty }))});

            // Extract shipping address and delivery info from Bitrix deal
            let shippingAddress = null;
            let shippingLines = null;

            // Parse shipping address from UF_CRM_1742037435676
            const bitrixAddressField = dealData.UF_CRM_1742037435676 || dealData.uf_crm_1742037435676 || '';
            if (bitrixAddressField && typeof bitrixAddressField === 'string' && bitrixAddressField.trim() !== '') {
              const parsedAddress = parseBitrixAddressString(bitrixAddressField);
              if (parsedAddress && Object.keys(parsedAddress).length > 0) {
                // Try to get country code from country name if needed
                if (parsedAddress.country && !parsedAddress.country_code) {
                  try {
                    const { callShopifyAdmin } = await import('../../../src/lib/shopify/adminClient.js');
                    const countriesResponse = await callShopifyAdmin('/countries.json');
                    const countries = countriesResponse.countries || [];
                    const countryMatch = countries.find(c =>
                      c.name.toLowerCase() === parsedAddress.country.toLowerCase()
                    );
                    if (countryMatch) {
                      parsedAddress.country_code = countryMatch.code;
                      parsedAddress.country = countryMatch.name; // Use exact name from Shopify
                    }
                  } catch (countryError) {
                    logger.warn('order_create_country_code_resolve_error', 'Failed to resolve country code during order create', { dealId, country: parsedAddress?.country, error: countryError.message }, { entityType: 'deal', entityId: dealId });
                  }
                }
                shippingAddress = parsedAddress;
              }
            }

            // Extract delivery info (if available in deal fields)
            // Default shipping line (0.00 to not change Total)
            shippingLines = [{
              title: 'Standard Shipping',
              price: '0.00',
              code: 'Free'
            }];

            // Create order in Shopify (stable per webhook request for traceability)
            const correlationId = `bitrix:${dealId}:${requestId}`;
            const customerEmail = await resolveCustomerEmailFromDeal(dealData, requestId, dealId, 'ORDER_CREATE_CREATE');
            const orderResult = await createOrderFromBitrix(items, dealId, correlationId, {
              shippingAddress,
              shippingLines,
              customerEmail,
              isStubOrder,
              stubReason,
              stubDefaultVariantId: isStubOrder ? BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID : null
            });

            if (orderResult.success) {
              // Handle duplicate case
              if (orderResult.wasDuplicate) {
                                logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE', {requestId,
                  dealId,
                  eventType: 'CREATE',
                  message: 'Order creation prevented - duplicate found',
                  existingShopifyOrderId: orderResult.orderId});
                // Use existing order ID
                existingShopifyOrderId = String(orderResult.orderId);
              } else {
                // Save shopifyOrderId back to Bitrix deal
                const createdOrderId = String(orderResult.orderId);

                // ✅ CRITICAL: Re-check for duplicate immediately after creation (race condition protection)
                await new Promise(resolve => setTimeout(resolve, 100));
                const postCreateCheck = await findExistingOrderByDealId(dealId);
                if (postCreateCheck && postCreateCheck !== createdOrderId) {
                                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_AFTER_CREATE', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_AFTER_CREATE', {requestId,
                    dealId,
                    eventType: 'CREATE',
                    message: 'Duplicate detected immediately after creation',
                    createdOrderId: createdOrderId,
                    foundOrderId: postCreateCheck});
                  logger.warn('race_condition_detected', 'Duplicate Shopify order detected immediately after creation', {
                    entity_id: String(dealId),
                    created_order_id: createdOrderId,
                    found_order_id: postCreateCheck,
                  });
                  // Use the first found order
                  existingShopifyOrderId = postCreateCheck;
                } else {
                  existingShopifyOrderId = createdOrderId;
                }

                try {
                  // Get current deal title to check if order number is already added
                  const currentTitle = dealData.TITLE || '';
                  let orderName = orderResult.orderName; // e.g., "#2491" or "Existing order 1234"

                  // If order was duplicate, try to get real order name from Shopify
                  if (orderResult.wasDuplicate && orderName && !orderName.startsWith('#')) {
                    try {
                      const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
                      const existingOrder = await getOrder(existingShopifyOrderId);
                      if (existingOrder && existingOrder.name) {
                        orderName = existingOrder.name; // Get real order name like "#2491"
                                                logger.info('BITRIX_ORDER_NAME_FETCHED', 'BITRIX_ORDER_NAME_FETCHED', {requestId,
                          dealId,
                          shopifyOrderId: existingShopifyOrderId,
                          fetchedOrderName: orderName,
                          reason: 'duplicate_order_real_name_fetch'});
                      }
                    } catch (fetchError) {
                      logger.warn('order_name_fetch_duplicate_error', 'Failed to fetch order name for duplicate order', { dealId, shopifyOrderId: existingShopifyOrderId, error: fetchError.message }, { entityType: 'deal', entityId: dealId });
                    }
                  }

                  // Check if title already contains THIS specific order number (prevent duplicate updates)
                  const orderNumberFromName = orderName ? orderName.replace('#', '') : null;
                  const orderNumberPattern = orderNumberFromName ? new RegExp(`#?${orderNumberFromName}\\b`) : /#\d+/;
                  const alreadyContainsThisOrderNumber = orderNumberFromName && orderNumberPattern.test(currentTitle);

                  // Prepare update fields
                  const updateFields = {
                    UF_CRM_1742556489: existingShopifyOrderId // Shopify Order ID field
                  };

                  // Update TITLE only if:
                  // 1. orderName is available and contains "#" (real Shopify order name format)
                  // 2. This specific order number is not already in title
                  // 3. orderName is not in format "Existing order X" or "Order X"
                  const isValidOrderName = orderName &&
                    orderName.trim() !== '' &&
                    (orderName.startsWith('#') || /^#?\d+$/.test(orderName.replace('#', '')));
                  const isNotPlaceholderName = !orderName.includes('Existing order') && !orderName.includes('Order ');

                  if (!alreadyContainsThisOrderNumber && isValidOrderName && isNotPlaceholderName) {
                    // Ensure orderName starts with "#"
                    const formattedOrderName = orderName.startsWith('#') ? orderName : `#${orderName}`;

                    // Remove "D_XXXX" pattern from title if present, then add order number
                    // Example: "D_6704 #2494" -> "#2494" (remove "D_6704", keep "#2494")
                    // Example: "D_6704" -> "#2494" (replace "D_6704" with "#2494")
                    let updatedTitle = currentTitle;

                    // Remove "D_XXXX" pattern (e.g., "D_6704")
                    updatedTitle = updatedTitle.replace(/D_\d+\s*/g, '').trim();

                    // Add order number
                    updatedTitle = `${updatedTitle} ${formattedOrderName}`.trim();

                    updateFields.TITLE = updatedTitle;

                                        logger.info('BITRIX_DEAL_TITLE_UPDATE_PLANNED', 'BITRIX_DEAL_TITLE_UPDATE_PLANNED', {requestId,
                      dealId,
                      currentTitle,
                      updatedTitle,
                      orderName: formattedOrderName,
                      shopifyOrderId: existingShopifyOrderId,
                      wasDuplicate: orderResult.wasDuplicate || false});
                  } else {
                    const skipReason = alreadyContainsThisOrderNumber
                      ? 'order_number_already_in_title'
                      : !isValidOrderName
                        ? 'invalid_order_name_format'
                        : !isNotPlaceholderName
                          ? 'placeholder_order_name'
                          : 'unknown';

                                        logger.info('BITRIX_DEAL_TITLE_UPDATE_SKIPPED', 'BITRIX_DEAL_TITLE_UPDATE_SKIPPED', {requestId,
                      dealId,
                      reason: skipReason,
                      currentTitle,
                      orderName,
                      shopifyOrderId: existingShopifyOrderId,
                      alreadyContainsThisOrderNumber,
                      isValidOrderName,
                      isNotPlaceholderName});
                  }

                  await callBitrix('/crm.deal.update.json', {
                    id: dealId,
                    fields: updateFields
                  });

                                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_SUCCESS', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SUCCESS', {requestId,
                    dealId,
                    eventType: 'CREATE',
                    shopifyOrderId: existingShopifyOrderId,
                    orderName: orderResult.orderName,
                    wasDuplicate: orderResult.wasDuplicate || false,
                    titleUpdated: !!updateFields.TITLE,
                    lineItemsCount: orderResult.lineItems?.length || 0,
                    tags: orderResult.tags || [],
                    note: orderResult.note || ''});

                  // Update stored event with shopifyOrderId
                  if (storedEvent) {
                    storedEvent.shopifyOrderId = existingShopifyOrderId;
                  }

                  // ✅ SYNC PAYMENT STATUS (Fix: Ensure status is synced immediately after creation)
                  try {
                    await syncShopifyPaymentStatusFromBitrix(dealData, existingShopifyOrderId, requestId, dealId);
                  } catch (paySyncErr) {
                    logger.error('payment_status_sync_after_create_error', 'Failed to sync payment status after order create', { dealId, shopifyOrderId: existingShopifyOrderId, error: paySyncErr?.message || String(paySyncErr) }, { entityType: 'deal', entityId: dealId });
                  }

                  return {
                    success: true,
                    triggerMatch: true,
                    shopifyOrderId: existingShopifyOrderId,
                    orderName: orderResult.orderName,
                    wasDuplicate: orderResult.wasDuplicate || false
                  };
                } catch (updateError) {
                  logger.error('deal_update_shopify_order_id_error', 'Error updating deal with shopifyOrderId after order create', { dealId, shopifyOrderId: existingShopifyOrderId, error: updateError?.message || String(updateError) }, { entityType: 'deal', entityId: dealId });
                  return {
                    success: true,
                    triggerMatch: true,
                    shopifyOrderId: existingShopifyOrderId || createdOrderId,
                    orderCreated: true,
                    dealUpdateFailed: true,
                    wasDuplicate: orderResult.wasDuplicate || false
                  };
                }
              }
            } else {
                            logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_ERROR', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ERROR', {requestId,
                dealId,
                eventType: 'CREATE',
                error: orderResult.error,
                message: orderResult.message});
              return {
                success: false,
                triggerMatch: false,
                skip_reason: 'order_create_failed',
                error: orderResult.error
              };
            }
          } else {
                        logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', {requestId,
              dealId,
              eventType: 'CREATE',
              skip_reason: 'no_valid_items',
              productRowsCount: productRowsResp.result.length});
          }
        } else {
                    logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', {requestId,
            dealId,
            eventType: 'CREATE',
            skip_reason: 'no_product_rows'});
        }
      } // End: if (orderType === 'REGULAR')

      // ═══════════════════════════════════════════════════════════════════════════
      // CATALOG ORDER CREATION (Category 4 with resolved items)
      // ═══════════════════════════════════════════════════════════════════════════
      if (orderType === 'CATALOG' && items.length > 0) {
                logger.info('CATALOG_ORDER_CREATE_ATTEMPT', 'CATALOG_ORDER_CREATE_ATTEMPT', {requestId,
          dealId,
          eventType: 'CREATE',
          itemsCount: items.length,
          items: items.map(i => ({ variantId: i.variantId, qty: i.qty }))});

        // Extract shipping address from deal
        let shippingAddress = null;
        const bitrixAddressField = dealData.UF_CRM_1742037435676 || dealData.uf_crm_1742037435676 || '';
        if (bitrixAddressField && typeof bitrixAddressField === 'string' && bitrixAddressField.trim() !== '') {
          const parsedAddress = parseBitrixAddressString(bitrixAddressField);
          if (parsedAddress && Object.keys(parsedAddress).length > 0) {
            try {
              const { callShopifyAdmin } = await import('../../../src/lib/shopify/adminClient.js');
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
              logger.warn('catalog_order_country_resolve_error', 'Failed to resolve country code for catalog order', { dealId, error: countryError.message }, { entityType: 'deal', entityId: dealId });
            }
            shippingAddress = parsedAddress;
          }
        }

        const shippingLines = [{ title: 'Standard Shipping', price: '0.00', code: 'Free' }];
        const correlationId = `bitrix:${dealId}:${requestId}`;
        const customerEmail = await resolveCustomerEmailFromDeal(dealData, requestId, dealId, 'ORDER_CREATE_CATALOG');

        const orderResult = await createOrderFromBitrix(items, dealId, correlationId, {
          shippingAddress,
          shippingLines,
          customerEmail,
          isStubOrder: false,
          stubReason: null
        });

        if (orderResult.success) {
          const createdOrderId = String(orderResult.orderId);

          try {
            const updateFields = {
              UF_CRM_1742556489: createdOrderId
            };

            if (orderResult.orderName && orderResult.orderName.startsWith('#')) {
              updateFields.TITLE = orderResult.orderName;
            }

            await callBitrix('/crm.deal.update.json', { id: dealId, fields: updateFields });

                        logger.info('CATALOG_ORDER_CREATE_SUCCESS', 'CATALOG_ORDER_CREATE_SUCCESS', {requestId,
              dealId,
              eventType: 'CREATE',
              shopifyOrderId: createdOrderId,
              orderName: orderResult.orderName});
            logger.info('order_created', 'Shopify order created from Bitrix deal (catalog mode)', {
              entity_id: String(dealId),
              shopify_order_id: createdOrderId,
              order_name: orderResult.orderName,
            });

            // Sync payment status
            try {
              await syncShopifyPaymentStatusFromBitrix(dealData, createdOrderId, requestId, dealId);
            } catch (paySyncErr) {
              logger.error('catalog_order_payment_status_sync_error', 'Failed to sync payment status after catalog order create', { dealId, shopifyOrderId: createdOrderId, error: paySyncErr?.message || String(paySyncErr) }, { entityType: 'order', entityId: createdOrderId });
            }

            return {
              success: true,
              triggerMatch: true,
              shopifyOrderId: createdOrderId,
              orderName: orderResult.orderName,
              orderType: 'CATALOG'
            };
          } catch (updateError) {
            logger.error('catalog_order_deal_update_error', 'Error updating deal after catalog order create', { dealId, shopifyOrderId: createdOrderId, error: updateError?.message || String(updateError) }, { entityType: 'deal', entityId: dealId });
            return {
              success: true,
              triggerMatch: true,
              shopifyOrderId: createdOrderId,
              orderCreated: true,
              dealUpdateFailed: true
            };
          }
        } else {
                    logger.info('CATALOG_ORDER_CREATE_ERROR', 'CATALOG_ORDER_CREATE_ERROR', {requestId,
            dealId,
            eventType: 'CREATE',
            error: orderResult.error,
            message: orderResult.message});
          return {
            success: false,
            triggerMatch: false,
            skip_reason: 'catalog_order_create_failed',
            error: orderResult.error
          };
        }
      }

    } catch (orderCreateError) {
            logger.error('BITRIX_TO_SHOPIFY_ORDER_CREATE_EXCEPTION', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_EXCEPTION', {requestId,
        dealId,
        eventType: 'CREATE',
        error: 'ORDER_CREATE_EXCEPTION',
        message: orderCreateError.message,
        stack: orderCreateError.stack});
      return {
        success: false,
        triggerMatch: false,
        skip_reason: 'order_create_exception',
        error: orderCreateError.message
      };
    }
  } else {
        logger.info('BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP', {requestId,
      dealId,
      eventType: 'CREATE',
      skip_reason: 'shopify_order_id_exists',
      shopifyOrderId});
  }

  // If no order creation was needed or attempted, return success
  return { success: true, triggerMatch: false, skip_reason: 'no_action_needed' };
}

/**
 * Main webhook handler
 */
export default async function handler(req, res) {
  const requestId = crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}`;
  const slog = createRequestLogger(requestId, 'webhook/bitrix');
  const startTime = Date.now();
  const contentType = req.headers['content-type'] || 'unknown';
  const body = req.body || {};
  const payloadKeys = getPayloadKeys(body);
  const authToken = extractAuthToken(body);
  const hasAuthToken = !!authToken;

  // ✅ Structured logging: [BITRIX_WEBHOOK_INCOMING]
    logger.info('BITRIX_WEBHOOK_INCOMING', 'BITRIX_WEBHOOK_INCOMING', {requestId,
    method: req.method,
    contentType,
    payloadKeys,
    hasAuthToken});
  slog.info('webhook_received', 'Bitrix webhook received', {
    method: req.method,
    content_type: contentType,
    has_auth_token: hasAuthToken,
  });

  if (req.method !== 'POST') {
        logger.info('BITRIX_WEBHOOK_METHOD_NOT_ALLOWED', 'BITRIX_WEBHOOK_METHOD_NOT_ALLOWED', {requestId,
      method: req.method});
    res.status(405).end('Method not allowed');
    return;
  }

  // Check authentication token (only if token is provided)
  if (hasAuthToken && authToken !== EXPECTED_AUTH_TOKEN) {
        logger.info('BITRIX_WEBHOOK_AUTH_FAIL', 'BITRIX_WEBHOOK_AUTH_FAIL', {requestId,
      hasAuthToken: true,
      tokenMatch: false,
      expectedToken: EXPECTED_AUTH_TOKEN.substring(0, 10) + '...',
      receivedToken: authToken.substring(0, 10) + '...'});
    res.status(401).json({ error: 'Invalid authentication token' });
    return;
  }

  // Extract deal ID from payload (supports JSON and form-urlencoded)
  const { dealId, extractionPath } = extractDealId(body);

  if (!dealId) {
    // ✅ Structured logging: [BITRIX_WEBHOOK_INVALID_FORMAT]
    logger.warn('BITRIX_WEBHOOK_INVALID_FORMAT', 'No deal ID found in payload', { requestId, error: 'No deal ID found in payload', payloadKeys, contentType });
    res.status(400).json({ error: 'Invalid event format: no deal ID found', payloadKeys, contentType });
    return;
  }

  logger.info('BITRIX_DEAL_ID_EXTRACTED', 'Deal ID extracted from webhook', { requestId, dealId, extractionPath });
  slog.info('webhook_received', 'Bitrix webhook deal extracted', {
    entity_id: String(dealId),
    extraction_path: extractionPath,
  });

  const event = body;
  const eventType = event.event || event.EVENT || event['event'] || 'unknown';

  // ✅ Log event type detection for debugging
    logger.info('BITRIX_WEBHOOK_EVENT_TYPE_DETECTED', 'BITRIX_WEBHOOK_EVENT_TYPE_DETECTED', {requestId,
    dealId,
    eventType,
    eventKeys: Object.keys(event),
    eventEvent: event.event,
    eventEVENT: event.EVENT});

  try {
    // Route based on event type
    let result = null;
    if (eventType === 'ONCRMDEALUPDATE' || eventType.includes('UPDATE')) {
            logger.info('BITRIX_WEBHOOK_ROUTING_TO_UPDATE', 'BITRIX_WEBHOOK_ROUTING_TO_UPDATE', {requestId,
        dealId,
        eventType});
      result = await handleDealUpdate(dealId, requestId);
    } else if (eventType === 'ONCRMDEALADD' || eventType.includes('ADD')) {
            logger.info('BITRIX_WEBHOOK_ROUTING_TO_CREATE', 'BITRIX_WEBHOOK_ROUTING_TO_CREATE', {requestId,
        dealId,
        eventType});
      result = await handleDealCreate(dealId, requestId);
    } else {
      // ✅ Structured logging: [BITRIX_WEBHOOK_UNHANDLED_EVENT]
            logger.info('BITRIX_WEBHOOK_UNHANDLED_EVENT', 'BITRIX_WEBHOOK_UNHANDLED_EVENT', {requestId,
        dealId,
        eventType});
      result = { success: true, triggerMatch: false, skip_reason: `unhandled_event_type:${eventType}` };
    }

    // ✅ Structured logging: [BITRIX_WEBHOOK_DONE]
        logger.info('BITRIX_WEBHOOK_DONE', 'BITRIX_WEBHOOK_DONE', {requestId,
      dealId,
      eventType,
      result});

    // Handle dryRun response
    if (result?.dryRun) {
      res.status(200).json({
        success: true,
        dryRun: true,
        action: result.action,
        payloadHash: result.payloadHash,
        correlationId: result.correlationId,
        requestId,
        dealId
      });
    } else {
      res.status(200).json({
        success: true,
        message: 'Event processed',
        requestId,
        dealId,
        triggerMatch: result?.triggerMatch || false,
        skip_reason: result?.skip_reason || null
      });
    }
    slog.info('webhook_completed', 'Bitrix webhook handler completed', {
      entity_id: String(dealId || ''),
      event_type: eventType,
      duration_ms: Date.now() - startTime,
    });
  } catch (e) {
    // ✅ Structured logging: [BITRIX_WEBHOOK_ERROR]
        logger.info('BITRIX_WEBHOOK_ERROR', 'BITRIX_WEBHOOK_ERROR', {requestId,
      dealId: dealId || 'unknown',
      error: e.message,
      stack: e.stack});
    slog.error('handler_error', 'Bitrix webhook handler error', {
      entity_id: String(dealId || ''),
      error_message: e.message,
      duration_ms: Date.now() - startTime,
    });

    res.status(500).json({
      error: 'Internal server error',
      message: e.message,
      requestId
    });
  }
}

