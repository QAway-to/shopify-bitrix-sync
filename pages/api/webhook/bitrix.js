// Bitrix24 Webhook endpoint - receives events from Bitrix and syncs to Shopify
// ⚠️ VERSION MARKER - Change this to verify deployed code version
const BITRIX_WEBHOOK_VERSION = 'v2026-01-08-A';
import '../../../src/lib/logging/consoleCapture.js';
import { callBitrix } from '../../../src/lib/bitrix/client.js';
import { bitrixAdapter } from '../../../src/lib/adapters/bitrix/index.js';
import { BITRIX_CONFIG } from '../../../src/lib/bitrix/config.js';
import { getFulfillmentOrders, getOrderForFulfillment, createFulfillment, getPostFulfillmentState } from '../../../src/lib/shopify/fulfillment.js';
import { setProvenanceMarker } from '../../../src/lib/shopify/metafields.js';
import { createHoldOrder } from '../../../src/lib/shopify/hold.js';
import { createRefund } from '../../../src/lib/shopify/refund.js';
import { updateShippingAddress } from '../../../src/lib/shopify/address.js';
import { createOrderFromBitrix, findExistingOrderByDealId, cancelOrderByDealId, cancelOrderById, addTagToOrder } from '../../../src/lib/shopify/order.js';
import { addPositionToOrder, incrementLineItemQuantity, decrementLineItemQuantity } from '../../../src/lib/shopify/orderEdit.js';
import { extractDealId, extractAuthToken, getPayloadKeys } from '../../../src/lib/bitrix/webhookParser.js';
import { payloadHash, cleanEmptyFields } from '../../../src/lib/utils/hash.js';
import { getBitrixExpectedAuthToken } from '../../../src/lib/bitrix/client.js';
import { findShopifyVariantByAttributes, createShopifyOrderForPreorder } from '../../../src/lib/shopify/adminClient.js';
import { syncProductVariantOptimized } from '../../../src/lib/bitrix/products.js';

// Expected auth token from Bitrix
const EXPECTED_AUTH_TOKEN = getBitrixExpectedAuthToken();
const BITRIX_FALLBACK_CUSTOMER_EMAIL = String(process.env.BITRIX_FALLBACK_CUSTOMER_EMAIL || 'hold@bfcshoes.local');

async function resolveCustomerEmailFromDeal(dealData, requestId, dealId, context) {
  const contactIdRaw = dealData?.CONTACT_ID || dealData?.contact_id || null;
  const contactId = contactIdRaw && String(contactIdRaw) !== '0' ? String(contactIdRaw) : null;

  if (!contactId) {
    console.log(JSON.stringify({
      event: 'BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED',
      requestId,
      dealId,
      context,
      source: 'fallback_no_contact_id',
      email: BITRIX_FALLBACK_CUSTOMER_EMAIL,
      timestamp: new Date().toISOString()
    }));
    return BITRIX_FALLBACK_CUSTOMER_EMAIL;
  }

  try {
    const contactResp = await callBitrix('/crm.contact.get.json', { id: contactId });
    const contact = contactResp?.result || null;

    const emailRaw = contact?.EMAIL;
    const emailValue = Array.isArray(emailRaw) ? emailRaw?.[0]?.VALUE : (emailRaw?.VALUE || emailRaw);
    const email = emailValue && String(emailValue).trim() !== '' ? String(emailValue).trim() : null;

    if (email) {
      console.log(JSON.stringify({
        event: 'BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED',
        requestId,
        dealId,
        context,
        source: 'contact',
        contactId,
        email,
        timestamp: new Date().toISOString()
      }));
      return email;
    }

    console.log(JSON.stringify({
      event: 'BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED',
      requestId,
      dealId,
      context,
      source: 'fallback_contact_has_no_email',
      contactId,
      email: BITRIX_FALLBACK_CUSTOMER_EMAIL,
      timestamp: new Date().toISOString()
    }));
    return BITRIX_FALLBACK_CUSTOMER_EMAIL;
  } catch (err) {
    console.log(JSON.stringify({
      event: 'BITRIX_TO_SHOPIFY_CUSTOMER_EMAIL_RESOLVED',
      requestId,
      dealId,
      context,
      source: 'fallback_contact_fetch_error',
      contactId,
      email: BITRIX_FALLBACK_CUSTOMER_EMAIL,
      error: err?.message || String(err),
      timestamp: new Date().toISOString()
    }));
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
    console.log(JSON.stringify({
      event: 'PAYMENT_STATUS_SYNC_SKIP',
      requestId,
      dealId,
      shopifyOrderId,
      reason: 'missing_or_unknown_payment_enum',
      paymentEnumId,
      timestamp: new Date().toISOString()
    }));
    return { success: true, skipped: true, reason: 'unknown_payment_enum' };
  }

  // ✅ Force pending status if deal is not in WON stage
  // ✅ Force pending status if deal is not in WON stage
  const stageId = dealData?.STAGE_ID || dealData?.stage_id || null;
  // Check for any stage ending in "WON" (e.g., "WON", "C4:WON", "C6:WON")
  const isWonStage = stageId && (stageId === 'WON' || stageId.endsWith(':WON'));

  if (!isWonStage) {
    if (desired !== 'pending') {
      console.log(JSON.stringify({
        event: 'PAYMENT_STATUS_SYNC_FORCE_PENDING',
        requestId,
        dealId,
        shopifyOrderId,
        stageId,
        originalDesired: desired,
        reason: 'deal_not_won',
        timestamp: new Date().toISOString()
      }));
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


    console.log(JSON.stringify({
      event: 'PAYMENT_STATUS_SYNC_CHECK',
      requestId,
      dealId,
      shopifyOrderId,
      bitrixPaymentEnumId: paymentEnumId,
      desiredFinancialStatus: finalDesired,
      originalDesired: desired,
      stageId,
      isWonStage,
      currentFinancialStatus: current,
      totalPrice,
      currency,
      timestamp: new Date().toISOString()
    }));

    // Logic:
    // 1. If desired is Pending and current is Paid -> Revert to Pending (via REST)
    // 2. If desired is Paid and current is Pending/PartiallyPaid -> Mark as Paid (via REST transaction)
    // Implementation: currently we only support reverting to pending (Unpaid -> Pending enforcement).

    // CASE 2: Pending -> Paid (GraphQL Mutation)
    console.log(`[PAYMENT DEBUG 777] Checking conditions: finalDesired='${finalDesired}', current='${current}', check=${finalDesired === 'paid' && current !== 'paid'}`);
    if (finalDesired === 'paid' && current !== 'paid') {
      console.log(JSON.stringify({
        event: 'PAYMENT_STATUS_SYNC_ATTEMPT_PAID',
        requestId,
        dealId,
        shopifyOrderId,
        current,
        totalPrice,
        method: 'GraphQL orderMarkAsPaid',
        timestamp: new Date().toISOString()
      }));

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
          console.error(`[PAYMENT SYNC] GraphQL Errors: ${transactionError}`);
        } else if (!payload?.order) {
          transactionError = "Unknown GraphQL error (missing order in response)";
        } else {
          // Success
          const orderData = payload.order;
          console.log(`[PAYMENT SYNC] SUCCESS! Order ${orderData?.name} (ID: ${orderData?.id}) is now ${orderData?.displayFinancialStatus}. Fully Paid: ${orderData?.fullyPaid}`);
        }

      } catch (err) {
        transactionError = err?.message || String(err);
        console.error(`[PAYMENT SYNC] Failed to execute orderMarkAsPaid for ${shopifyOrderId}:`, err);
      }

      // Re-fetch to verify
      const after = await getOrder(shopifyOrderId);
      const success = after?.financial_status === 'paid';

      console.log(JSON.stringify({
        event: 'PAYMENT_STATUS_SYNC_RESULT_PAID',
        requestId,
        dealId,
        shopifyOrderId,
        before: current,
        after: after?.financial_status,
        success,
        error: transactionError,
        timestamp: new Date().toISOString()
      }));

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

      console.log(JSON.stringify({
        event: 'PAYMENT_STATUS_SYNC_RESULT',
        requestId,
        dealId,
        shopifyOrderId,
        desiredFinancialStatus: finalDesired,
        beforeFinancialStatus: current,
        afterFinancialStatus: afterStatus,
        updateError,
        timestamp: new Date().toISOString()
      }));

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
    console.warn(`[PAYMENT STATUS SYNC] Failed: ${err?.message || String(err)}`);
    console.log(JSON.stringify({
      event: 'PAYMENT_STATUS_SYNC_ERROR',
      requestId,
      dealId,
      shopifyOrderId,
      error: err?.message || String(err),
      stack: err?.stack,
      timestamp: new Date().toISOString()
    }));
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
    console.warn(`[BITRIX ADDRESS PARSE] Failed to parse address string: ${error.message}`);
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
      console.log(JSON.stringify({
        event: 'ADDRESS_UPDATE_NORMALIZE',
        rawPayloadKeys: Object.keys(rawPayload),
        shippingAddressKeys: Object.keys(shippingAddress),
        cleanedAddressKeys: Object.keys(cleanedAddress),
        hasShippingLines: !!(rawPayload.shipping_lines),
        hasDeliveryTitle: !!(rawPayload.delivery_title),
        timestamp: new Date().toISOString()
      }));

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
    console.log(JSON.stringify({
      event: 'MW_ACTION_PARSE_ERROR',
      requestId,
      dealId,
      shopifyOrderId,
      error: parseError.message,
      rawValue: mwActionRaw.substring(0, 200), // Log first 200 chars
      timestamp: new Date().toISOString()
    }));
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
    console.log(JSON.stringify({
      event: 'MW_ACTION_PARSE_ERROR',
      requestId,
      dealId,
      shopifyOrderId,
      error: `Unsupported action: ${action}`,
      supportedActions,
      receivedAction: action,
      timestamp: new Date().toISOString()
    }));
    return { success: false, reason: 'unsupported_action', action };
  }

  console.log(JSON.stringify({
    event: 'MW_ACTION_PARSE_OK',
    requestId,
    dealId,
    shopifyOrderId,
    action,
    rawPayload: actionData,
    timestamp: new Date().toISOString()
  }));

  // Normalize payload
  const normalizedPayload = normalizePayload(action, actionData);

  if (!normalizedPayload) {
    console.log(JSON.stringify({
      event: 'MW_ACTION_PARSE_ERROR',
      requestId,
      dealId,
      shopifyOrderId,
      action,
      error: 'Failed to normalize payload',
      timestamp: new Date().toISOString()
    }));
    return { success: false, reason: 'normalization_failed' };
  }

  // Calculate payloadHash
  const hash = payloadHash(normalizedPayload);
  const correlationId = `${dealId}:${hash}`;

  console.log(JSON.stringify({
    event: 'MW_ACTION_HASH',
    requestId,
    dealId,
    shopifyOrderId,
    action,
    payloadHash: hash,
    correlationId,
    normalizedPayload,
    timestamp: new Date().toISOString()
  }));

  // Decision logging
  const decision = {
    hasAction: true,
    action,
    hasShopifyOrderId: !!shopifyOrderId,
    payloadHash: hash,
    correlationId
  };

  console.log(JSON.stringify({
    event: 'MW_ACTION_DECISION',
    requestId,
    dealId,
    shopifyOrderId,
    action,
    payloadHash: hash,
    correlationId,
    decision,
    timestamp: new Date().toISOString()
  }));

  // DRY-RUN done - no Shopify write
  console.log(JSON.stringify({
    event: 'MW_ACTION_DRYRUN_DONE',
    requestId,
    dealId,
    shopifyOrderId,
    action,
    payloadHash: hash,
    correlationId,
    timestamp: new Date().toISOString()
  }));

  // ✅ Write operation for hold_create
  if (action === 'hold_create' && normalizedPayload.items && normalizedPayload.items.length > 0) {
    try {
      console.log(JSON.stringify({
        event: 'HOLD_CREATE_ATTEMPT',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        itemsCount: normalizedPayload.items.length,
        items: normalizedPayload.items.map(i => ({ sku: i.sku, qty: i.qty })),
        timestamp: new Date().toISOString()
      }));

      // Create hold order in Shopify
      const holdResult = await createHoldOrder(normalizedPayload.items, correlationId, hash);

      if (holdResult.success) {
        // Set provenance marker with payloadHash (use orderId from created order)
        const createdOrderId = String(holdResult.orderId);
        const provenanceResult = await setProvenanceMarker(createdOrderId, correlationId, 'hold_create', hash);

        if (provenanceResult.success) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_PROVENANCE_SET',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId: holdResult.orderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus,
            timestamp: new Date().toISOString()
          }));
        }

        console.log(JSON.stringify({
          event: 'HOLD_CREATE_SUCCESS',
          requestId,
          dealId,
          shopifyOrderId: holdResult.orderId,
          orderName: holdResult.orderName,
          correlationId,
          payloadHash: hash,
          lineItemsCount: holdResult.lineItems?.length || 0,
          timestamp: new Date().toISOString()
        }));

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          holdOrderId: holdResult.orderId,
          holdOrderName: holdResult.orderName
        };
      } else {
        console.log(JSON.stringify({
          event: 'HOLD_CREATE_ERROR',
          requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: holdResult.error,
          message: holdResult.message,
          timestamp: new Date().toISOString()
        }));

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
      console.log(JSON.stringify({
        event: 'HOLD_CREATE_ERROR',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'HOLD_CREATE_EXCEPTION',
        message: holdError.message,
        stack: holdError.stack,
        timestamp: new Date().toISOString()
      }));

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
      console.log(JSON.stringify({
        event: 'REFUND_CREATE_ATTEMPT',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        mode: normalizedPayload.mode,
        itemsCount: normalizedPayload.items?.length || 0,
        refundShippingFull: normalizedPayload.refund_shipping_full,
        timestamp: new Date().toISOString()
      }));

      // Create refund in Shopify
      const refundResult = await createRefund(shopifyOrderId, normalizedPayload, correlationId, hash);

      if (refundResult.success) {
        // Set provenance marker with payloadHash
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'refund_create', hash);

        if (provenanceResult.success) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_PROVENANCE_SET',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus,
            timestamp: new Date().toISOString()
          }));
        }

        // Add BitrixUpdated tag to prevent webhook loop
        try {
          const { addTagToOrder } = await import('../../../src/lib/shopify/order.js');
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
            console.log(JSON.stringify({
              event: 'BITRIX_UPDATED_TAG_ADDED',
              requestId,
              dealId,
              shopifyOrderId,
              action: 'refund_create',
              timestamp: new Date().toISOString()
            }));
          } else {
            console.warn(JSON.stringify({
              event: 'BITRIX_UPDATED_TAG_ADD_ERROR',
              requestId,
              dealId,
              shopifyOrderId,
              error: tagResult.message,
              timestamp: new Date().toISOString()
            }));
          }
        } catch (tagError) {
          console.warn(JSON.stringify({
            event: 'BITRIX_UPDATED_TAG_ADD_EXCEPTION',
            requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message,
            timestamp: new Date().toISOString()
          }));
        }

        console.log(JSON.stringify({
          event: 'REFUND_CREATE_SUCCESS',
          requestId,
          dealId,
          shopifyOrderId,
          refundId: refundResult.refundId,
          refundAmount: refundResult.refundAmount,
          refundLineItemsCount: refundResult.refundLineItemsCount,
          correlationId,
          payloadHash: hash,
          timestamp: new Date().toISOString()
        }));

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          refundId: refundResult.refundId,
          refundAmount: refundResult.refundAmount
        };
      } else {
        console.log(JSON.stringify({
          event: 'REFUND_CREATE_ERROR',
          requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: refundResult.error,
          message: refundResult.message,
          httpStatus: refundResult.httpStatus,
          timestamp: new Date().toISOString()
        }));

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
      console.log(JSON.stringify({
        event: 'REFUND_CREATE_ERROR',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'REFUND_CREATE_EXCEPTION',
        message: refundError.message,
        stack: refundError.stack,
        timestamp: new Date().toISOString()
      }));

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
      console.log(JSON.stringify({
        event: 'ADDRESS_UPDATE_ATTEMPT',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        addressFields: Object.keys(normalizedPayload.shipping_address || {}),
        timestamp: new Date().toISOString()
      }));

      // Update shipping address in Shopify
      const addressResult = await updateShippingAddress(shopifyOrderId, normalizedPayload, correlationId, hash);

      if (addressResult.success) {
        // Set provenance marker with payloadHash
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'address_update', hash);

        if (provenanceResult.success) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_PROVENANCE_SET',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus,
            timestamp: new Date().toISOString()
          }));
        }

        console.log(JSON.stringify({
          event: 'ADDRESS_UPDATE_SUCCESS',
          requestId,
          dealId,
          shopifyOrderId,
          orderName: addressResult.orderName,
          correlationId,
          payloadHash: hash,
          timestamp: new Date().toISOString()
        }));

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          orderName: addressResult.orderName
        };
      } else {
        console.log(JSON.stringify({
          event: 'ADDRESS_UPDATE_ERROR',
          requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: addressResult.error,
          message: addressResult.message,
          httpStatus: addressResult.httpStatus,
          timestamp: new Date().toISOString()
        }));

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
      console.log(JSON.stringify({
        event: 'ADDRESS_UPDATE_ERROR',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ADDRESS_UPDATE_EXCEPTION',
        message: addressError.message,
        stack: addressError.stack,
        timestamp: new Date().toISOString()
      }));

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
      console.log(JSON.stringify({
        event: 'ORDER_CANCEL_ATTEMPT',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        refund: normalizedPayload.refund,
        timestamp: new Date().toISOString()
      }));

      const cancelResult = await cancelOrderById(shopifyOrderId, normalizedPayload.refund);

      if (cancelResult.success) {
        // Set provenance marker
        const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId, 'order_cancel', hash);

        if (provenanceResult.success) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_PROVENANCE_SET',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus,
            timestamp: new Date().toISOString()
          }));
        }

        // Add BitrixUpdated tag
        try {
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
            console.log(JSON.stringify({
              event: 'BITRIX_UPDATED_TAG_ADDED',
              requestId,
              dealId,
              shopifyOrderId,
              action: 'order_cancel',
              timestamp: new Date().toISOString()
            }));
          }
        } catch (tagError) {
          console.warn(JSON.stringify({
            event: 'BITRIX_UPDATED_TAG_ADD_EXCEPTION',
            requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message,
            timestamp: new Date().toISOString()
          }));
        }

        console.log(JSON.stringify({
          event: 'ORDER_CANCEL_SUCCESS',
          requestId,
          dealId,
          shopifyOrderId,
          jobId: cancelResult.jobId,
          refunded: cancelResult.refunded,
          correlationId,
          payloadHash: hash,
          timestamp: new Date().toISOString()
        }));

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          jobId: cancelResult.jobId,
          refunded: cancelResult.refunded
        };
      } else {
        console.log(JSON.stringify({
          event: 'ORDER_CANCEL_ERROR',
          requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: cancelResult.error,
          message: cancelResult.message,
          timestamp: new Date().toISOString()
        }));

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
      console.log(JSON.stringify({
        event: 'ORDER_CANCEL_ERROR',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ORDER_CANCEL_EXCEPTION',
        message: cancelError.message,
        stack: cancelError.stack,
        timestamp: new Date().toISOString()
      }));

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
      console.log(JSON.stringify({
        event: 'ORDER_POSITION_ADD_ATTEMPT',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        variantId: normalizedPayload.variant_id,
        sku: normalizedPayload.sku,
        quantity: normalizedPayload.quantity,
        timestamp: new Date().toISOString()
      }));

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
          console.log(JSON.stringify({
            event: 'SHOPIFY_PROVENANCE_SET',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus,
            timestamp: new Date().toISOString()
          }));
        }

        // Add BitrixUpdated tag
        try {
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
            console.log(JSON.stringify({
              event: 'BITRIX_UPDATED_TAG_ADDED',
              requestId,
              dealId,
              shopifyOrderId,
              action: 'order_position_add',
              timestamp: new Date().toISOString()
            }));
          }
        } catch (tagError) {
          console.warn(JSON.stringify({
            event: 'BITRIX_UPDATED_TAG_ADD_EXCEPTION',
            requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message,
            timestamp: new Date().toISOString()
          }));
        }

        console.log(JSON.stringify({
          event: 'ORDER_POSITION_ADD_SUCCESS',
          requestId,
          dealId,
          shopifyOrderId,
          orderName: addResult.orderName,
          totalPrice: addResult.totalPrice,
          correlationId,
          payloadHash: hash,
          timestamp: new Date().toISOString()
        }));

        return {
          success: true,
          action,
          payloadHash: hash,
          correlationId,
          orderName: addResult.orderName,
          totalPrice: addResult.totalPrice
        };
      } else {
        console.log(JSON.stringify({
          event: 'ORDER_POSITION_ADD_ERROR',
          requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: addResult.error,
          message: addResult.message,
          timestamp: new Date().toISOString()
        }));

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
      console.log(JSON.stringify({
        event: 'ORDER_POSITION_ADD_ERROR',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ORDER_POSITION_ADD_EXCEPTION',
        message: addError.message,
        stack: addError.stack,
        timestamp: new Date().toISOString()
      }));

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
      console.log(JSON.stringify({
        event: 'ORDER_POSITION_INCREMENT_ATTEMPT',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        sku: normalizedPayload.sku,
        quantity: normalizedPayload.quantity,
        timestamp: new Date().toISOString()
      }));

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
          console.log(JSON.stringify({
            event: 'SHOPIFY_PROVENANCE_SET',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus,
            timestamp: new Date().toISOString()
          }));
        }

        // Add BitrixUpdated tag
        try {
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
            console.log(JSON.stringify({
              event: 'BITRIX_UPDATED_TAG_ADDED',
              requestId,
              dealId,
              shopifyOrderId,
              action: 'order_position_increment',
              timestamp: new Date().toISOString()
            }));
          }
        } catch (tagError) {
          console.warn(JSON.stringify({
            event: 'BITRIX_UPDATED_TAG_ADD_EXCEPTION',
            requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message,
            timestamp: new Date().toISOString()
          }));
        }

        console.log(JSON.stringify({
          event: 'ORDER_POSITION_INCREMENT_SUCCESS',
          requestId,
          dealId,
          shopifyOrderId,
          sku: normalizedPayload.sku,
          previousQuantity: incrementResult.previousQuantity,
          newQuantity: incrementResult.newQuantity,
          totalPrice: incrementResult.totalPrice,
          correlationId,
          payloadHash: hash,
          timestamp: new Date().toISOString()
        }));

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
        console.log(JSON.stringify({
          event: 'ORDER_POSITION_INCREMENT_ERROR',
          requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: incrementResult.error,
          message: incrementResult.message,
          timestamp: new Date().toISOString()
        }));

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
      console.log(JSON.stringify({
        event: 'ORDER_POSITION_INCREMENT_ERROR',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ORDER_POSITION_INCREMENT_EXCEPTION',
        message: incrementError.message,
        stack: incrementError.stack,
        timestamp: new Date().toISOString()
      }));

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
      console.log(JSON.stringify({
        event: 'ORDER_POSITION_DECREMENT_ATTEMPT',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        sku: normalizedPayload.sku,
        newQuantity: normalizedPayload.new_quantity,
        timestamp: new Date().toISOString()
      }));

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
          console.log(JSON.stringify({
            event: 'SHOPIFY_PROVENANCE_SET',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            payloadHash: hash,
            httpStatus: provenanceResult.httpStatus,
            timestamp: new Date().toISOString()
          }));
        }

        // Add BitrixUpdated tag
        try {
          const tagResult = await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
          if (tagResult.success) {
            console.log(JSON.stringify({
              event: 'BITRIX_UPDATED_TAG_ADDED',
              requestId,
              dealId,
              shopifyOrderId,
              action: 'order_position_decrement',
              timestamp: new Date().toISOString()
            }));
          }
        } catch (tagError) {
          console.warn(JSON.stringify({
            event: 'BITRIX_UPDATED_TAG_ADD_EXCEPTION',
            requestId,
            dealId,
            shopifyOrderId,
            error: tagError.message,
            timestamp: new Date().toISOString()
          }));
        }

        console.log(JSON.stringify({
          event: 'ORDER_POSITION_DECREMENT_SUCCESS',
          requestId,
          dealId,
          shopifyOrderId,
          sku: normalizedPayload.sku,
          previousQuantity: decrementResult.previousQuantity,
          newQuantity: decrementResult.newQuantity,
          totalPrice: decrementResult.totalPrice,
          totalReceived: decrementResult.totalReceived,
          correlationId,
          payloadHash: hash,
          timestamp: new Date().toISOString()
        }));

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
        console.log(JSON.stringify({
          event: 'ORDER_POSITION_DECREMENT_ERROR',
          requestId,
          dealId,
          shopifyOrderId,
          correlationId,
          payloadHash: hash,
          error: decrementResult.error,
          message: decrementResult.message,
          timestamp: new Date().toISOString()
        }));

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
      console.log(JSON.stringify({
        event: 'ORDER_POSITION_DECREMENT_ERROR',
        requestId,
        dealId,
        shopifyOrderId,
        correlationId,
        payloadHash: hash,
        error: 'ORDER_POSITION_DECREMENT_EXCEPTION',
        message: decrementError.message,
        stack: decrementError.stack,
        timestamp: new Date().toISOString()
      }));

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
  console.log(JSON.stringify({
    event: 'BITRIX_WEBHOOK_RECEIVED',
    requestId,
    dealId,
    eventType: 'UPDATE',
    timestamp: new Date().toISOString()
  }));

  // Get full deal data from Bitrix REST API
  let dealData = null;
  try {
    const dealResp = await callBitrix('/crm.deal.get.json', {
      id: dealId,
    });

    if (!dealResp.result) {
      const error = {
        event: 'DEAL_GET_FAILED',
        requestId,
        dealId,
        error: 'Deal not found or failed to fetch',
        response: dealResp,
        timestamp: new Date().toISOString()
      };
      console.log(JSON.stringify(error));
      return { success: false, reason: 'deal_not_found' };
    }

    dealData = dealResp.result;
  } catch (error) {
    const errorLog = {
      event: 'DEAL_GET_ERROR',
      requestId,
      dealId,
      error: error.message,
      timestamp: new Date().toISOString()
    };
    console.log(JSON.stringify(errorLog));
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
        console.log(JSON.stringify({
          event: 'SHOPIFY_ORDER_ID_RECOVERED',
          requestId,
          dealId,
          recoveredOrderId: shopifyOrderId,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (lookupError) {
      console.warn(`[BITRIX WEBHOOK] Failed to look up existing order: ${lookupError.message}`);
    }
  }

  // ✅ PRE-ORDER LOGIC: Automatic Reservation for Category 8
  // Triggered when Brand, Model, Color, and Size are present
  if (String(categoryId) === '8') {
    const brand = dealData.UF_CRM_1768251890190 || dealData.uf_crm_1768251890190; // Brand
    const model = dealData.UF_CRM_1739793668182 || dealData.uf_crm_1739793668182; // Model
    const color = dealData.UF_CRM_1739793651654 || dealData.uf_crm_1739793651654; // Color
    const size = dealData.UF_CRM_1739793720585 || dealData.uf_crm_1739793720585;   // Size

    console.log(JSON.stringify({
      event: 'PRE_ORDER_FIELD_CHECK',
      requestId,
      dealId,
      fields: { brand, model, color, size },
      availableUFKeys: Object.keys(dealData).filter(k => k.startsWith('UF_')), // Debug: See what IDs are actually present
      hasAllFields: !!(brand && model && color && size),
      shopifyOrderId,
      timestamp: new Date().toISOString()
    }));

    // Check if we already have a linked order to avoid duplicates (unless we want to update?)
    // If shopifyOrderId exists, we assume reservation is done.
    // NOTE: User script relies on Brand, Model, Size. Color is often empty or implied.
    // We relax the check to require Brand, Model, Size.
    if (brand && model && size && (!shopifyOrderId || shopifyOrderId.trim() === '')) {
      console.log(`[PRE-ORDER] checking availability for: ${brand} ${model} ${size} (Color: ${color || 'N/A'})`);

      try {
        const result = await findShopifyVariantByAttributes({ brand, model, color, size });

        if (result && result.variant) {
          const { variant, productTitle, imageUrl } = result;
          console.log(`[PRE-ORDER] 🎯 Found matching variant: ${productTitle} - ${variant.title} (ID: ${variant.id})`);

          // 1. Create Pending Order in Shopify
          const order = await createShopifyOrderForPreorder(variant.id, {
            dealId: dealId,
            // optional: customer email from deal
          });

          if (order && order.id) {
            const newOrderId = String(order.id);
            const orderName = order.name; // e.g. "#1024"
            console.log(`[PRE-ORDER] ✅ Created pending order: ${newOrderId} (${orderName})`);

            // Update shopifyOrderId in local scope and Bitrix
            shopifyOrderId = newOrderId;

            await callBitrix('crm.deal.update', {
              id: dealId,
              fields: {
                UF_CRM_1742556489: newOrderId,
                TITLE: orderName // Set Deal Title to Order Name (e.g. #2500)
              }
            });

            // 2. Ensure Product exists in Bitrix (On-Demand)
            // We need to sync/map it so we can add it to the deal row.
            // Map variant data to sync format
            const syncData = {
              variant_id: variant.id.split('/').pop(), // ensure numeric/string ID
              sku: variant.sku,
              product_title: productTitle,
              variant_title: variant.title,
              price: variant.price || 0,
              qty: variant.inventoryQuantity,
              image_url: imageUrl // Pass image URL
            };

            const syncResult = await syncProductVariantOptimized(syncData, true);

            if (syncResult.productId) {
              // 3. Add Product Row to Deal
              // We need to fetch existing rows first to append? Or just set?
              // 'crm.deal.productrows.set' replaces all rows.
              // 'crm.deal.productrows.add' doesn't exist? usually it's set.
              // Safer to get and push.
              const rowsResp = await callBitrix('crm.deal.productrows.get', { id: dealId });
              const rows = rowsResp.result || [];

              rows.push({
                PRODUCT_ID: syncResult.productId,
                QUANTITY: 1,
                PRICE: variant.price || 0,
                PRODUCT_NAME: syncResult.productName || `${productTitle} - ${variant.title}`
              });

              await callBitrix('crm.deal.productrows.set', { id: dealId, rows });
              console.log(`[PRE-ORDER] ✅ Added product ${syncResult.productId} to deal ${dealId}`);
            }
          }
        } else {
          console.log(`[PRE-ORDER] ⚠️ No matching variant found for ${brand} ${model} ${color} ${size}`);
          // Optional: Log to deal comments?
        }
      } catch (err) {
        console.error(`[PRE-ORDER] ❌ Error in reservation flow: ${err.message}`);
      }
    }
  }

  // ✅ KILL & RECREATE: Logic for upgrading Stub -> Regular
  // If we have an existing order that is a STUB, and now we have real content,
  // we must DELETE (Cancel) the stub and let the create flow make a fresh REST order.
  if (shopifyOrderId) {
    try {
      const { getOrder, callShopifyGraphQL } = await import('../../../src/lib/shopify/adminClient.js');
      const existingOrder = await getOrder(shopifyOrderId);

      if (existingOrder) {
        const tagsStr = existingOrder.tags || '';
        const tags = tagsStr.split(',').map(t => t.trim());

        if (tags.includes('BITRIX_STUB')) {
          // Check if we now have real products via Bitrix API
          const rowsResp = await callBitrix('crm.deal.productrows.get', { id: dealId });
          const rows = rowsResp?.result || [];

          // If we have real rows (and presumed valid products), kill the stub
          if (rows.length > 0) {
            console.log(JSON.stringify({
              event: 'STUB_ORDER_UPGRADE_TRIGGERED',
              requestId,
              dealId,
              shopifyOrderId,
              reason: 'Real products added to stub',
              timestamp: new Date().toISOString()
            }));

            // Cancel the stub via GraphQL to release inventory immediately
            const cancelMutation = `
                        mutation orderCancel($orderId: ID!) {
                          orderCancel(orderId: $orderId) {
                            job {
                              id
                            }
                            userErrors {
                              field
                              message
                            }
                          }
                        }
                     `;

            try {
              await callShopifyGraphQL(cancelMutation, { orderId: `gid://shopify/Order/${shopifyOrderId}` });
              console.log(`[STUB UPGRADE] Cancelled stub order ${shopifyOrderId}`);
            } catch (cancelErr) {
              console.error(`[STUB UPGRADE] Failed to cancel stub ${shopifyOrderId}:`, cancelErr);
              // Convert to non-blocking warning? If cancel fails, recreating might duplicate.
              // But we proceed anyway to ensure the new valid order exists.
            }

            // Force creation of new order logic
            shopifyOrderId = null;
          }
        }
      }
    } catch (stubError) {
      console.warn(`[STUB CHECK FAILED] Could not check/cancel stub order: ${stubError.message}`);
    }
  }

  // ✅ Structured logging: [DEAL_DATA_RECEIVED]
  console.log(JSON.stringify({
    event: 'DEAL_DATA_RECEIVED',
    requestId,
    dealId,
    categoryId,
    stageId,
    shopifyOrderId,
    timestamp: new Date().toISOString()
  }));

  // ✅ STEP A: Check if deal is cancelled (LOSE stage) and cancel order in Shopify
  // Check if stage ends with :LOSE or is exactly LOSE (handles both C6:LOSE and LOSE formats)
  const isLoseStage = stageId === 'LOSE' ||
    stageId === BITRIX_CONFIG.STAGES.CANCELLED ||
    stageId === BITRIX_CONFIG.STAGES.REFUNDED ||
    (typeof stageId === 'string' && stageId.endsWith(':LOSE'));

  if (isLoseStage) {
    console.log(JSON.stringify({
      event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_CHECK',
      requestId,
      dealId,
      stageId,
      shopifyOrderId: shopifyOrderId || 'not_set',
      timestamp: new Date().toISOString()
    }));

    try {
      // ✅ STEP A1: Cancel regular order (from Shopify) if shopifyOrderId exists
      if (shopifyOrderId && shopifyOrderId.trim() !== '') {
        const { callShopifyGraphQL, getOrder } = await import('../../../src/lib/shopify/adminClient.js');
        const { addTagToOrder } = await import('../../../src/lib/shopify/order.js');

        try {
          // Check if order is created from Bitrix (has BITRIX:{dealId} tag)
          const shopifyOrder = await getOrder(shopifyOrderId);
          if (shopifyOrder) {
            const orderTags = Array.isArray(shopifyOrder.tags)
              ? shopifyOrder.tags
              : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
            const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));

            // Cancel both technical and regular orders
            const orderGid = `gid://shopify/Order/${shopifyOrderId}`;
            const mutation = `
              mutation orderCancel($orderId: ID!) {
                orderCancel(
                  orderId: $orderId,
                  reason: OTHER,
                  restock: true,
                  refund: false
                ) {
                  userErrors {
                    field
                    message
                  }
                  job {
                    id
                  }
                }
              }
            `;

            const cancelData = await callShopifyGraphQL(mutation, { orderId: orderGid });

            if (cancelData?.orderCancel?.userErrors && cancelData.orderCancel.userErrors.length > 0) {
              const errorMessages = cancelData.orderCancel.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
              throw new Error(`Shopify orderCancel userErrors: ${errorMessages}`);
            }

            // Add BitrixUpdated tag to prevent webhook loop (for regular orders, not created from Bitrix)
            if (!isBitrixOrder) {
              await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
            }

            console.log(JSON.stringify({
              event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_SUCCESS',
              requestId,
              dealId,
              stageId,
              shopifyOrderId,
              orderName: shopifyOrder.name,
              isBitrixOrder,
              jobId: cancelData?.orderCancel?.job?.id,
              timestamp: new Date().toISOString()
            }));

            // Return success - cancellation was handled
            return {
              success: true,
              triggerMatch: true,
              action: 'order_cancelled',
              shopifyOrderId
            };
          }
        } catch (regularCancelError) {
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_ERROR',
            requestId,
            dealId,
            stageId,
            shopifyOrderId,
            error: regularCancelError.message,
            timestamp: new Date().toISOString()
          }));
          // Continue to try technical order cancellation as fallback
        }
      }

      // ✅ STEP A2: Cancel technical order if exists (fallback for orders without shopifyOrderId in deal)
      // This handles cases where technical order exists but shopifyOrderId is not set in deal
      try {
        const cancelResult = await cancelOrderByDealId(dealId);

        if (cancelResult.success) {
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_TECHNICAL_ORDER_CANCEL_SUCCESS',
            requestId,
            dealId,
            stageId,
            shopifyOrderId: cancelResult.orderId,
            orderName: cancelResult.orderName,
            timestamp: new Date().toISOString()
          }));

          return {
            success: true,
            triggerMatch: true,
            action: 'technical_order_cancelled',
            shopifyOrderId: cancelResult.orderId
          };
        } else if (cancelResult.error === 'ORDER_NOT_FOUND') {
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_SKIP',
            requestId,
            dealId,
            stageId,
            skip_reason: 'no_order_found',
            timestamp: new Date().toISOString()
          }));
          // Continue with normal flow - no order to cancel
        } else {
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_ERROR',
            requestId,
            dealId,
            stageId,
            error: cancelResult.error,
            message: cancelResult.message,
            timestamp: new Date().toISOString()
          }));
          // Continue with normal flow even if cancellation failed
        }
      } catch (techCancelError) {
        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_TECHNICAL_ORDER_CANCEL_ERROR',
          requestId,
          dealId,
          stageId,
          error: techCancelError.message,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (cancelError) {
      console.error(`[BITRIX TO SHOPIFY] Error cancelling order for deal ${dealId}:`, cancelError);
      console.log(JSON.stringify({
        event: 'BITRIX_TO_SHOPIFY_ORDER_CANCEL_EXCEPTION',
        requestId,
        dealId,
        stageId,
        error: cancelError.message,
        timestamp: new Date().toISOString()
      }));
      // Continue with normal flow even if cancellation failed
    }
  }

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
    console.error(`[BITRIX WEBHOOK] Failed to store event (non-blocking):`, storeError);
  }

  // ✅ STEP C: Check for MW action first (UF_MW_SHOPIFY_ACTION)
  const mwActionResult = await handleMWAction(dealId, requestId, dealData, shopifyOrderId);
  if (mwActionResult !== null) {
    // MW action was processed (either success or error)
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
                console.warn(`[BITRIX ADDRESS] Failed to resolve country code: ${countryError.message}`);
              }
            }

            // Compare with current Shopify address
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

            console.log(JSON.stringify({
              event: 'AUTO_ADDRESS_CHECK',
              requestId,
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
              deliveryPriceChanged: deliveryPriceChanged,
              timestamp: new Date().toISOString()
            }));

            // Always update if address is provided (even if comparison says no change)
            // This ensures address is synced even if comparison logic has issues
            const shouldUpdateAddress = addressChanged || (parsedAddress && Object.keys(parsedAddress).length > 0);

            if (shouldUpdateAddress || deliveryPriceChanged) {
              console.log(JSON.stringify({
                event: 'AUTO_ADDRESS_UPDATE_DETECTED',
                requestId,
                dealId,
                shopifyOrderId,
                bitrixAddress: bitrixAddressField,
                parsedAddress,
                currentShopifyAddress: {
                  address1: currentAddress.address1,
                  city: currentAddress.city,
                  zip: currentAddress.zip,
                  country: currentAddress.country
                },
                addressChanged: addressChanged,
                deliveryPriceChanged: deliveryPriceChanged,
                newDeliveryPrice: deliveryPrice,
                currentDeliveryPrice: currentShippingPrice,
                timestamp: new Date().toISOString()
              }));

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
                  console.warn(`[BITRIX ADDRESS] Failed to enrich shipping_address from contact: ${contactError.message}`);
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
              console.log(JSON.stringify({
                event: 'AUTO_ADDRESS_UPDATE_PAYLOAD',
                requestId,
                dealId,
                shopifyOrderId,
                updatePayloadKeys: Object.keys(updatePayload),
                hasShippingAddress: !!(updatePayload.shipping_address),
                hasShippingLines: !!(updatePayload.shipping_lines),
                shippingAddressFields: updatePayload.shipping_address ? Object.keys(updatePayload.shipping_address) : [],
                shippingLinesCount: updatePayload.shipping_lines ? updatePayload.shipping_lines.length : 0,
                timestamp: new Date().toISOString()
              }));

              // Update address and shipping in Shopify
              const { updateShippingAddress } = await import('../../../src/lib/shopify/address.js');
              const correlationId = `${dealId}:${Date.now()}`;
              addressUpdateAttempted = true;
              const addressResult = await updateShippingAddress(shopifyOrderId, updatePayload, correlationId, null);

              if (addressResult.success) {
                console.log(JSON.stringify({
                  event: 'AUTO_ADDRESS_UPDATE_SUCCESS',
                  requestId,
                  dealId,
                  shopifyOrderId,
                  timestamp: new Date().toISOString()
                }));
              } else {
                console.log(JSON.stringify({
                  event: 'AUTO_ADDRESS_UPDATE_ERROR',
                  requestId,
                  dealId,
                  shopifyOrderId,
                  error: addressResult.error,
                  message: addressResult.message,
                  timestamp: new Date().toISOString()
                }));
              }
            } else {
              console.log(JSON.stringify({
                event: 'AUTO_ADDRESS_NO_CHANGE',
                requestId,
                dealId,
                shopifyOrderId,
                timestamp: new Date().toISOString()
              }));
            }
          } else {
            console.log(JSON.stringify({
              event: 'AUTO_ADDRESS_PARSE_FAILED',
              requestId,
              dealId,
              shopifyOrderId,
              bitrixAddress: bitrixAddressField,
              timestamp: new Date().toISOString()
            }));
          }
        }

        // Check if delivery price needs to be updated (only if address wasn't updated above)
        // If address was updated, shipping_lines were already included in that update
        const wasAddressUpdated = addressUpdateAttempted;

        if (deliveryPriceChanged && !wasAddressUpdated) {
          console.log(JSON.stringify({
            event: 'AUTO_DELIVERY_PRICE_UPDATE_DETECTED',
            requestId,
            dealId,
            shopifyOrderId,
            newDeliveryPrice: deliveryPrice,
            currentDeliveryPrice: currentShippingPrice,
            timestamp: new Date().toISOString()
          }));

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
            console.log(JSON.stringify({
              event: 'AUTO_DELIVERY_PRICE_UPDATE_SUCCESS',
              requestId,
              dealId,
              shopifyOrderId,
              newDeliveryPrice: deliveryPrice,
              timestamp: new Date().toISOString()
            }));
          } else {
            console.log(JSON.stringify({
              event: 'AUTO_DELIVERY_PRICE_UPDATE_ERROR',
              requestId,
              dealId,
              shopifyOrderId,
              error: addressResult.error,
              message: addressResult.message,
              timestamp: new Date().toISOString()
            }));
          }
        }
      }
    } catch (orderCheckError) {
      // Non-blocking: if we can't check order, continue with normal flow
      console.warn(`[BITRIX TO SHOPIFY] Could not check order ${shopifyOrderId} for address update:`, orderCheckError.message);
    }
  }

  // ✅ STEP C2: Sync product quantities from Bitrix to Shopify (if order exists)
  // NOTE: This only runs if shopifyOrderId exists, so it won't block order creation
  if (shopifyOrderId && shopifyOrderId.trim() !== '') {
    try {
      console.log(JSON.stringify({
        event: 'QUANTITY_SYNC_START',
        requestId,
        dealId,
        shopifyOrderId,
        timestamp: new Date().toISOString()
      }));
      const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
      const shopifyOrder = await getOrder(shopifyOrderId);

      if (shopifyOrder) {
        // Check if order is created from Bitrix (has BITRIX:{dealId} tag) - should sync quantities
        const orderTags = Array.isArray(shopifyOrder.tags)
          ? shopifyOrder.tags
          : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
        const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));

        if (isBitrixOrder) {
          // Get product rows from Bitrix
          const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', {
            id: dealId
          });

          const bitrixRows = Array.isArray(productRowsResp?.result) ? productRowsResp.result : [];
          console.log(JSON.stringify({
            event: 'QUANTITY_SYNC_BITRIX_ROWS',
            requestId,
            dealId,
            shopifyOrderId,
            rowsCount: bitrixRows.length,
            timestamp: new Date().toISOString()
          }));

          // Get line items from Shopify
          const shopifyLineItems = shopifyOrder.line_items || [];

          // Build map of SKU -> quantity from Bitrix
          const bitrixQuantities = new Map();
          for (const row of bitrixRows) {
            const productId = row.PRODUCT_ID;
            if (productId) {
              try {
                const productResp = await callBitrix('/crm.product.get.json', { id: productId });
                if (productResp.result) {
                  // In Bitrix, SKU is stored in CODE field, not SKU field
                  const sku = productResp.result.CODE || productResp.result.code || productResp.result.SKU || productResp.result.sku;
                  if (sku && sku.trim() !== '') {
                    const quantity = parseFloat(row.QUANTITY || row.quantity || 0);
                    bitrixQuantities.set(sku.trim(), quantity);
                  }
                }
              } catch (productError) {
                console.warn(`[SYNC QUANTITIES] Failed to get product ${productId}: ${productError.message}`);
              }
            }
          }

          // Compare with Shopify and find differences.
          // IMPORTANT: If Bitrix rows are empty, we still must decrement all Shopify SKU-backed line items to 0.
          const quantityChanges = [];
          for (const lineItem of shopifyLineItems) {
            const rawSku = lineItem.sku;
            if (!rawSku || String(rawSku).trim() === '') continue;

            const sku = String(rawSku).trim();
            const bitrixQty = bitrixQuantities.has(sku) ? bitrixQuantities.get(sku) : 0;
            const shopifyQty = parseFloat(lineItem.quantity || 0);

            if (Math.abs(bitrixQty - shopifyQty) > 0.01) { // Allow small floating point differences
              quantityChanges.push({
                sku,
                bitrixQty,
                shopifyQty,
                newQty: bitrixQty
              });
            }
          }

          // Also check for new items in Bitrix that don't exist in Shopify
          for (const [sku, bitrixQty] of bitrixQuantities.entries()) {
            const existsInShopify = shopifyLineItems.some(li => String(li?.sku || '').trim() === sku);
            if (!existsInShopify && bitrixQty > 0) {
              quantityChanges.push({
                sku,
                bitrixQty,
                shopifyQty: 0,
                newQty: bitrixQty,
                isNew: true
              });
            }
          }

          if (quantityChanges.length > 0) {
            console.log(JSON.stringify({
              event: 'QUANTITY_SYNC_DETECTED',
              requestId,
              dealId,
              shopifyOrderId,
              changesCount: quantityChanges.length,
              changes: quantityChanges,
              timestamp: new Date().toISOString()
            }));

            // Apply changes using orderEdit API
            const { incrementLineItemQuantity, decrementLineItemQuantity, addPositionToOrder } = await import('../../../src/lib/shopify/orderEdit.js');
            const { addTagToOrder } = await import('../../../src/lib/shopify/order.js');

            let hasChanges = false;

            for (const change of quantityChanges) {
              try {
                if (change.isNew) {
                  // Add new position
                  const addResult = await addPositionToOrder(shopifyOrderId, change.sku, change.newQty);
                  if (addResult.success) {
                    hasChanges = true;
                    console.log(JSON.stringify({
                      event: 'QUANTITY_SYNC_ADD_SUCCESS',
                      requestId,
                      dealId,
                      shopifyOrderId,
                      sku: change.sku,
                      quantity: change.newQty,
                      timestamp: new Date().toISOString()
                    }));
                  } else {
                    console.log(JSON.stringify({
                      event: 'QUANTITY_SYNC_ADD_ERROR',
                      requestId,
                      dealId,
                      shopifyOrderId,
                      sku: change.sku,
                      quantity: change.newQty,
                      error: addResult.error,
                      message: addResult.message,
                      timestamp: new Date().toISOString()
                    }));
                  }
                } else if (change.newQty > change.shopifyQty) {
                  // Increment quantity
                  const incrementQty = change.newQty - change.shopifyQty;
                  const incrementResult = await incrementLineItemQuantity(shopifyOrderId, change.sku, incrementQty);
                  if (incrementResult.success) {
                    hasChanges = true;
                    console.log(JSON.stringify({
                      event: 'QUANTITY_SYNC_INCREMENT_SUCCESS',
                      requestId,
                      dealId,
                      shopifyOrderId,
                      sku: change.sku,
                      previousQty: change.shopifyQty,
                      newQty: incrementResult.newQuantity,
                      timestamp: new Date().toISOString()
                    }));
                  } else {
                    console.log(JSON.stringify({
                      event: 'QUANTITY_SYNC_INCREMENT_ERROR',
                      requestId,
                      dealId,
                      shopifyOrderId,
                      sku: change.sku,
                      incrementQty,
                      error: incrementResult.error,
                      message: incrementResult.message,
                      timestamp: new Date().toISOString()
                    }));
                  }
                } else if (change.newQty < change.shopifyQty) {
                  // Decrement quantity
                  const decrementResult = await decrementLineItemQuantity(shopifyOrderId, change.sku, change.newQty);
                  if (decrementResult.success) {
                    hasChanges = true;
                    console.log(JSON.stringify({
                      event: 'QUANTITY_SYNC_DECREMENT_SUCCESS',
                      requestId,
                      dealId,
                      shopifyOrderId,
                      sku: change.sku,
                      previousQty: change.shopifyQty,
                      newQty: decrementResult.newQuantity,
                      timestamp: new Date().toISOString()
                    }));
                  } else {
                    console.log(JSON.stringify({
                      event: 'QUANTITY_SYNC_DECREMENT_ERROR',
                      requestId,
                      dealId,
                      shopifyOrderId,
                      sku: change.sku,
                      newQty: change.newQty,
                      error: decrementResult.error,
                      message: decrementResult.message,
                      timestamp: new Date().toISOString()
                    }));
                  }
                }
              } catch (changeError) {
                console.log(JSON.stringify({
                  event: 'QUANTITY_SYNC_CHANGE_ERROR',
                  requestId,
                  dealId,
                  shopifyOrderId,
                  sku: change.sku,
                  error: changeError.message,
                  timestamp: new Date().toISOString()
                }));
              }
            }

            // ✅ STEP C2.1: Clean up stub order if real products were added
            // If order was a stub (has BITRIX_STUB tag) and now has real products, remove stub marker
            const hasStubTag = orderTags.includes('BITRIX_STUB');
            const hasRealProducts = bitrixQuantities.size > 0;

            if (hasStubTag && hasRealProducts) {
              console.log(JSON.stringify({
                event: 'STUB_ORDER_CLEANUP_START',
                requestId,
                dealId,
                shopifyOrderId,
                bitrixProductsCount: bitrixQuantities.size,
                timestamp: new Date().toISOString()
              }));

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
                        console.log(JSON.stringify({
                          event: 'STUB_ORDER_DEFAULT_VARIANT_REMOVED',
                          requestId,
                          dealId,
                          shopifyOrderId,
                          defaultVariantId,
                          timestamp: new Date().toISOString()
                        }));
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
                      console.log(JSON.stringify({
                        event: 'STUB_ORDER_TAG_REMOVED',
                        requestId,
                        dealId,
                        shopifyOrderId,
                        removedTag: 'BITRIX_STUB',
                        timestamp: new Date().toISOString()
                      }));
                    }

                    if (shouldUpdateNote) {
                      console.log(JSON.stringify({
                        event: 'STUB_ORDER_NOTE_UPDATED',
                        requestId,
                        dealId,
                        shopifyOrderId,
                        oldNote: currentNote.substring(0, 100),
                        newNote: updatedNote,
                        timestamp: new Date().toISOString()
                      }));
                    }
                  }
                }

                console.log(JSON.stringify({
                  event: 'STUB_ORDER_CLEANUP_SUCCESS',
                  requestId,
                  dealId,
                  shopifyOrderId,
                  timestamp: new Date().toISOString()
                }));
              } catch (stubCleanupError) {
                console.warn(`[STUB CLEANUP] Failed to clean up stub order: ${stubCleanupError.message}`);
                console.log(JSON.stringify({
                  event: 'STUB_ORDER_CLEANUP_ERROR',
                  requestId,
                  dealId,
                  shopifyOrderId,
                  error: stubCleanupError.message,
                  stack: stubCleanupError.stack,
                  timestamp: new Date().toISOString()
                }));
              }
            }

            // Add BitrixUpdated tag if any changes were made
            if (hasChanges) {
              try {
                await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
                console.log(JSON.stringify({
                  event: 'QUANTITY_SYNC_TAG_ADDED',
                  requestId,
                  dealId,
                  shopifyOrderId,
                  timestamp: new Date().toISOString()
                }));
              } catch (tagError) {
                console.warn(`[QUANTITY SYNC] Failed to add BitrixUpdated tag: ${tagError.message}`);
              }
            }
          } else {
            console.log(JSON.stringify({
              event: 'QUANTITY_SYNC_NO_CHANGES',
              requestId,
              dealId,
              shopifyOrderId,
              bitrixItemsCount: bitrixQuantities.size,
              shopifyItemsCount: shopifyLineItems.length,
              timestamp: new Date().toISOString()
            }));
          }
        }
      }
    } catch (quantitySyncError) {
      // Non-blocking: if we can't sync quantities, continue with normal flow
      console.warn(`[QUANTITY SYNC] Could not sync quantities: ${quantitySyncError.message}`);
      console.log(JSON.stringify({
        event: 'QUANTITY_SYNC_ERROR',
        requestId,
        dealId,
        shopifyOrderId,
        error: quantitySyncError.message,
        stack: quantitySyncError.stack,
        timestamp: new Date().toISOString()
      }));
      // Continue with normal flow - don't block order creation
    }
  } else {
    console.log(JSON.stringify({
      event: 'QUANTITY_SYNC_SKIP',
      requestId,
      dealId,
      shopifyOrderId: shopifyOrderId || 'empty',
      reason: 'no_shopify_order_id',
      timestamp: new Date().toISOString()
    }));
  }

  // ✅ STEP C3: Sync payment status from Bitrix to Shopify (best-effort)
  // Bitrix field UF_CRM_1739183959976: 56=Paid, 58=Unpaid, 60=prepayment
  if (shopifyOrderId && shopifyOrderId.trim() !== '') {
    await syncShopifyPaymentStatusFromBitrix(dealData, shopifyOrderId, requestId, dealId);
  }

  // ✅ STEP D: Check if we need to create order in Shopify from Bitrix deal
  // Condition: No shopifyOrderId but deal has product rows
  console.log(JSON.stringify({
    event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRE_CHECK',
    requestId,
    dealId,
    eventType: 'UPDATE',
    shopifyOrderId: shopifyOrderId || 'empty',
    shopifyOrderIdExists: !!(shopifyOrderId && shopifyOrderId.trim() !== ''),
    timestamp: new Date().toISOString()
  }));

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
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK',
            requestId,
            dealId,
            eventType: 'UPDATE',
            message: 'Found shopifyOrderId on recheck (race condition prevented)',
            shopifyOrderId: recheckShopifyOrderId,
            timestamp: new Date().toISOString()
          }));
          shouldCreateOrder = false;
          existingShopifyOrderId = recheckShopifyOrderId;
        }
      }
    } catch (recheckError) {
      console.warn(`[BITRIX TO SHOPIFY] Error rechecking deal for shopifyOrderId:`, recheckError);
    }

    // If still should create, check Shopify for existing order by tag
    if (shouldCreateOrder) {
      const existingOrderId = await findExistingOrderByDealId(dealId);

      if (existingOrderId) {
        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK',
          requestId,
          dealId,
          eventType: 'UPDATE',
          message: 'Found existing order in Shopify by BITRIX tag (duplicate prevented)',
          existingShopifyOrderId: existingOrderId,
          timestamp: new Date().toISOString()
        }));
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
          console.log(`[BITRIX TO SHOPIFY] Updated deal ${dealId} with found shopifyOrderId ${existingOrderId}`);
        } catch (updateError) {
          console.warn(`[BITRIX TO SHOPIFY] Failed to update deal with found shopifyOrderId:`, updateError);
        }
      }
    }
  }

  if (shouldCreateOrder) {
    try {
      // Get product rows from deal
      const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', {
        id: dealId
      });

      console.log(JSON.stringify({
        event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRODUCT_ROWS_RESPONSE',
        requestId,
        dealId,
        eventType: 'UPDATE',
        productRowsExists: !!(productRowsResp && productRowsResp.result),
        productRowsIsArray: Array.isArray(productRowsResp?.result),
        productRowsCount: productRowsResp?.result?.length || 0,
        timestamp: new Date().toISOString()
      }));

      if (productRowsResp.result && Array.isArray(productRowsResp.result)) {
        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_CHECK',
          requestId,
          dealId,
          eventType: 'UPDATE',
          productRowsCount: productRowsResp.result.length,
          timestamp: new Date().toISOString()
        }));

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
                console.log(`[BITRIX TO SHOPIFY] Product ${productId}: Using CODE as SKU: ${code.trim()}`);
              } else if (xmlId && xmlId.toString().trim() !== '') {
                // Use XML_ID directly as variant_id (no SKU lookup needed)
                items.push({
                  variantId: xmlId.toString().trim(),
                  qty: row.QUANTITY || 1
                });
                console.log(`[BITRIX TO SHOPIFY] Product ${productId}: Using XML_ID as variantId directly: ${xmlId}`);
              } else {
                console.warn(`[BITRIX TO SHOPIFY] Product ${productId} has no CODE (SKU) or XML_ID (variant_id), skipping`);
              }
            }
          } catch (productError) {
            console.error(`[BITRIX TO SHOPIFY] Error getting product ${productId}:`, productError);
          }
        }

        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ITEMS_COLLECTED',
          requestId,
          dealId,
          eventType: 'UPDATE',
          itemsCount: items.length,
          items: items.map(i => ({ sku: i.sku, qty: i.qty })),
          timestamp: new Date().toISOString()
        }));

        // ✅ If Bitrix sent empty product rows (0 items), optionally add default product
        if (items.length === 0 && productRowsResp.result.length === 0 && BITRIX_ALLOW_EMPTY_PRODUCT_LINES) {
          items.push({
            variantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
            qty: BITRIX_EMPTY_ORDER_DEFAULT_QTY
          });
          isStubOrder = true;
          stubReason = 'empty_product_rows';
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED',
            requestId,
            dealId,
            eventType: 'UPDATE',
            defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
            defaultQty: BITRIX_EMPTY_ORDER_DEFAULT_QTY,
            reason: 'empty_product_rows',
            timestamp: new Date().toISOString()
          }));
        }

        // ✅ If product rows exist but we couldn't map any valid items, optionally add default product
        if (items.length === 0 && productRowsResp.result.length > 0 && BITRIX_ALLOW_EMPTY_PRODUCT_LINES) {
          items.push({
            variantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
            qty: BITRIX_EMPTY_ORDER_DEFAULT_QTY
          });
          isStubOrder = true;
          stubReason = 'no_mappable_items';
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED',
            requestId,
            dealId,
            eventType: 'UPDATE',
            defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
            defaultQty: BITRIX_EMPTY_ORDER_DEFAULT_QTY,
            reason: 'no_mappable_items',
            timestamp: new Date().toISOString()
          }));
        }

        if (items.length > 0) {
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ATTEMPT',
            requestId,
            dealId,
            eventType: 'UPDATE',
            itemsCount: items.length,
            items: items.map(i => ({ sku: i.sku, qty: i.qty })),
            timestamp: new Date().toISOString()
          }));

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
                  console.warn(`[BITRIX TO SHOPIFY] Failed to resolve country code: ${countryError.message}`);
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
          const customerEmail = await resolveCustomerEmailFromDeal(dealData, requestId, dealId, 'ORDER_CREATE_UPDATE');
          const orderResult = await createOrderFromBitrix(items, dealId, correlationId, {
            shippingAddress,
            shippingLines,
            customerEmail,
            isStubOrder,
            stubReason,
            stubDefaultVariantId: null // ⚠️ DISABLED: Was BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID - no fallback to stub for missing SKUs
          });

          if (orderResult.success) {
            // Save shopifyOrderId back to Bitrix deal
            const createdOrderId = String(orderResult.orderId);
            let orderName = orderResult.orderName; // e.g., "#2491" or "Existing order 1234"

            // If order was duplicate, try to get real order name from Shopify
            if (orderResult.wasDuplicate && orderName && !orderName.startsWith('#')) {
              try {
                const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
                const existingOrder = await getOrder(createdOrderId);
                if (existingOrder && existingOrder.name) {
                  orderName = existingOrder.name; // Get real order name like "#2491"
                  console.log(JSON.stringify({
                    event: 'BITRIX_ORDER_NAME_FETCHED',
                    requestId,
                    dealId,
                    shopifyOrderId: createdOrderId,
                    fetchedOrderName: orderName,
                    timestamp: new Date().toISOString()
                  }));
                }
              } catch (fetchError) {
                console.warn(`[BITRIX TO SHOPIFY] Failed to fetch order name: ${fetchError.message}`);
              }
            }

            try {
              // Get current deal title to check if order number is already added
              const currentTitle = dealData.TITLE || '';

              // Check if title already contains THIS specific order number (prevent duplicate updates)
              // Check for both formats: "#2491" and just "2491"
              const orderNumberFromName = orderName ? orderName.replace('#', '') : null;
              const orderNumberPattern = orderNumberFromName ? new RegExp(`#?${orderNumberFromName}\\b`) : /#\d+/;
              const alreadyContainsThisOrderNumber = orderNumberFromName && orderNumberPattern.test(currentTitle);

              // Prepare update fields
              const updateFields = {
                UF_CRM_1742556489: createdOrderId // Shopify Order ID field
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

                // Replace TITLE completely with order number (not append)
                // Example: "D_6704" -> "#2494" (not "D_6704 #2494")
                const updatedTitle = formattedOrderName;
                updateFields.TITLE = updatedTitle;

                console.log(JSON.stringify({
                  event: 'BITRIX_DEAL_TITLE_UPDATE_PLANNED',
                  requestId,
                  dealId,
                  currentTitle,
                  updatedTitle,
                  orderName: formattedOrderName,
                  shopifyOrderId: createdOrderId,
                  wasDuplicate: orderResult.wasDuplicate || false,
                  timestamp: new Date().toISOString()
                }));
              } else {
                const skipReason = alreadyContainsThisOrderNumber
                  ? 'order_number_already_in_title'
                  : !isValidOrderName
                    ? 'invalid_order_name_format'
                    : !isNotPlaceholderName
                      ? 'placeholder_order_name'
                      : 'unknown';

                console.log(JSON.stringify({
                  event: 'BITRIX_DEAL_TITLE_UPDATE_SKIPPED',
                  requestId,
                  dealId,
                  reason: skipReason,
                  currentTitle,
                  orderName,
                  shopifyOrderId: createdOrderId,
                  alreadyContainsThisOrderNumber,
                  isValidOrderName,
                  isNotPlaceholderName,
                  timestamp: new Date().toISOString()
                }));
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
                tags: orderResult.tags || [],
                note: orderResult.note || '',
                timestamp: new Date().toISOString()
              }));

              // Update shopifyOrderId for subsequent processing
              shopifyOrderId = createdOrderId;
            } catch (updateError) {
              console.error(`[BITRIX TO SHOPIFY] Error updating deal with shopifyOrderId:`, updateError);
              console.log(JSON.stringify({
                event: 'BITRIX_DEAL_UPDATE_ERROR',
                requestId,
                dealId,
                shopifyOrderId: createdOrderId,
                error: updateError.message,
                timestamp: new Date().toISOString()
              }));
            }
          } else {
            console.log(JSON.stringify({
              event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ERROR',
              requestId,
              dealId,
              error: orderResult.error,
              message: orderResult.message,
              timestamp: new Date().toISOString()
            }));
          }
        }
      }
    } catch (orderCreateError) {
      console.error(`[BITRIX TO SHOPIFY] Error checking/creating order:`, orderCreateError);
    }
  }

  // No MW action found, continue with DELIVERY_EXECUTING trigger (existing logic)
  // Check Delivery trigger conditions (C2:EXECUTING = "Delivery" stage)
  // Unified fulfillment logic: check existence first, then update or create
  const correlationId = `${dealId}:${shopifyOrderId || 'no-shopify-id'}`;
  const expectedExecutingStage = BITRIX_CONFIG?.STAGES_CAT_2?.EXECUTING;
  const decision = {
    categoryMatch: String(categoryId) === String(BITRIX_CONFIG.CATEGORY_STOCK) || String(categoryId) === '2',
    stageMatch: (expectedExecutingStage ? String(stageId) === String(expectedExecutingStage) : false) || String(stageId) === 'C2:EXECUTING',
    shopifyOrderIdPresent: shopifyOrderId && shopifyOrderId.trim() !== '',
  };

  // ✅ Structured logging: [DELIVERY_TRIGGER_CHECK]
  console.log(JSON.stringify({
    event: 'DELIVERY_TRIGGER_CHECK',
    requestId,
    dealId,
    correlationId,
    categoryId,
    stageId,
    shopifyOrderId,
    decision,
    expectedCategoryId: BITRIX_CONFIG.CATEGORY_STOCK,
    expectedStageId: expectedExecutingStage || 'C2:EXECUTING',
    timestamp: new Date().toISOString()
  }));

  // Check if all conditions are met
  if (decision.categoryMatch && decision.stageMatch && decision.shopifyOrderIdPresent) {
    // ✅ DELIVERY TRIGGER MATCHED
    console.log(JSON.stringify({
      event: 'DELIVERY_TRIGGER_MATCH',
      requestId,
      dealId,
      correlationId,
      categoryId,
      stageId,
      shopifyOrderId,
      timestamp: new Date().toISOString()
    }));

    // ✅ UNIFIED FULFILLMENT LOGIC: Check existence first, then update or create
    try {
      // Step 1: Check if order is technical order
      const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
      const shopifyOrder = await getOrder(shopifyOrderId);

      if (!shopifyOrder) {
        console.log(JSON.stringify({
          event: 'DELIVERY_ORDER_NOT_FOUND',
          requestId,
          dealId,
          shopifyOrderId,
          timestamp: new Date().toISOString()
        }));
        return { success: true, triggerMatch: true, correlationId };
      }

      const orderTags = Array.isArray(shopifyOrder.tags)
        ? shopifyOrder.tags
        : (shopifyOrder.tags ? String(shopifyOrder.tags).split(',').map(t => t.trim()) : []);
      const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));

      // Only process fulfillment for orders NOT created from Bitrix
      if (isBitrixOrder) {
        console.log(JSON.stringify({
          event: 'DELIVERY_SKIP_BITRIX_ORDER',
          requestId,
          dealId,
          shopifyOrderId,
          timestamp: new Date().toISOString()
        }));
        return { success: true, triggerMatch: true, correlationId };
      }

      // Step 2: Set provenance marker first
      const provenanceResult = await setProvenanceMarker(shopifyOrderId, correlationId);

      if (provenanceResult.success) {
        console.log(JSON.stringify({
          event: 'SHOPIFY_PROVENANCE_SET',
          requestId,
          dealId,
          correlationId,
          shopifyOrderId,
          httpStatus: provenanceResult.httpStatus,
          timestamp: new Date().toISOString()
        }));
      } else {
        console.log(JSON.stringify({
          event: 'SHOPIFY_PROVENANCE_SET_ERROR',
          requestId,
          dealId,
          correlationId,
          shopifyOrderId,
          httpStatus: provenanceResult.httpStatus,
          error: provenanceResult.error,
          message: provenanceResult.message,
          timestamp: new Date().toISOString()
        }));
      }

      // Step 3: Check if tracking info is provided in deal fields
      const trackingNumber = dealData.UF_CRM_TRACKING_NUMBER || dealData.uf_crm_tracking_number ||
        dealData.UF_CRM_1742556489_TRACKING || dealData.uf_crm_1742556489_tracking || null;
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

        console.log(JSON.stringify({
          event: 'DELIVERY_ORDER_NOTE_UPDATED',
          requestId,
          dealId,
          shopifyOrderId,
          stageId,
          noteUpdated: true,
          timestamp: new Date().toISOString()
        }));
      } catch (noteError) {
        console.warn(`[BITRIX TO SHOPIFY] Failed to update order note: ${noteError.message}`);
      }

      // Step 6: Update existing fulfillment OR create new one
      let fulfillmentResult = null;

      if (hasFulfillment) {
        // Update existing fulfillment with tracking
        console.log(JSON.stringify({
          event: 'DELIVERY_FULFILLMENT_UPDATE_ATTEMPT',
          requestId,
          dealId,
          shopifyOrderId,
          trackingNumber,
          timestamp: new Date().toISOString()
        }));

        fulfillmentResult = await updateOrderFulfillmentForDelivery(shopifyOrderId, {
          notify_customer: true,
          tracking_number: trackingNumber,
          tracking_urls: trackingUrls.length > 0 ? trackingUrls : undefined
        });

        if (fulfillmentResult && fulfillmentResult.success) {
          console.log(JSON.stringify({
            event: 'DELIVERY_FULFILLMENT_UPDATE_SUCCESS',
            requestId,
            dealId,
            shopifyOrderId,
            stageId,
            fulfillmentId: fulfillmentResult.fulfillmentId,
            timestamp: new Date().toISOString()
          }));
        } else if (fulfillmentResult && !fulfillmentResult.success) {
          console.log(JSON.stringify({
            event: 'DELIVERY_FULFILLMENT_UPDATE_ERROR',
            requestId,
            dealId,
            shopifyOrderId,
            stageId,
            error: fulfillmentResult.error,
            message: fulfillmentResult.message,
            timestamp: new Date().toISOString()
          }));
        }
      } else {
        // Fulfillment doesn't exist - check if we need to create it
        const orderData = await getOrderForFulfillment(shopifyOrderId);

        if (!orderData.success) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_FULFILLMENT_CREATE_SKIP',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            skip_reason: 'order_fetch_error',
            error: orderData.error,
            message: orderData.message,
            timestamp: new Date().toISOString()
          }));
          // Add tags even if fulfillment creation skipped
          try {
            await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
            await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');
          } catch (tagError) {
            console.warn(`[BITRIX TO SHOPIFY] Failed to add tags: ${tagError.message}`);
          }
          return { success: true, triggerMatch: true, correlationId };
        }

        // Check if already fulfilled
        if (orderData.isFullyFulfilled) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_FULFILLMENT_ALREADY_FULFILLED',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            message: 'Order is already fulfilled - no action needed',
            timestamp: new Date().toISOString()
          }));
          // Add tags
          try {
            await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
            await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');
          } catch (tagError) {
            console.warn(`[BITRIX TO SHOPIFY] Failed to add tags: ${tagError.message}`);
          }
          return { success: true, triggerMatch: true, correlationId };
        }

        // Check if fulfillment is needed
        if (!orderData.needsFulfillment) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_FULFILLMENT_CREATE_SKIP',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            skip_reason: 'nothing_to_fulfill',
            totalFulfillableQuantity: orderData.totalFulfillableQuantity,
            timestamp: new Date().toISOString()
          }));
          // Add tags even if fulfillment creation skipped
          try {
            await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
            await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');
          } catch (tagError) {
            console.warn(`[BITRIX TO SHOPIFY] Failed to add tags: ${tagError.message}`);
          }
          return { success: true, triggerMatch: true, correlationId };
        }

        // Create fulfillment
        console.log(JSON.stringify({
          event: 'SHOPIFY_FULFILLMENT_CREATE_ATTEMPT',
          requestId,
          dealId,
          correlationId,
          shopifyOrderId,
          totalFulfillableQuantity: orderData.totalFulfillableQuantity,
          itemsToFulfill: orderData.itemsToFulfill.length,
          timestamp: new Date().toISOString()
        }));

        const { createFulfillment } = await import('../../../src/lib/shopify/fulfillment.js');
        fulfillmentResult = await createFulfillment(shopifyOrderId, orderData.itemsToFulfill, {
          notify_customer: true
        });

        if (fulfillmentResult.success) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_FULFILLMENT_CREATE_SUCCESS',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            fulfillmentId: fulfillmentResult.fulfillmentId,
            fulfillmentIds: fulfillmentResult.fulfillmentIds,
            httpStatus: fulfillmentResult.httpStatus,
            timestamp: new Date().toISOString()
          }));

          // ✅ A3.1: Get post-fulfillment state for verification
          try {
            const postState = await getPostFulfillmentState(shopifyOrderId);

            console.log(JSON.stringify({
              event: 'SHOPIFY_POST_FULFILLMENT_STATE',
              requestId,
              dealId,
              correlationId,
              shopifyOrderId: postState.shopifyOrderId,
              fulfillmentIds: postState.fulfillmentIds,
              fulfillmentStatuses: postState.fulfillmentStatuses,
              orderFulfillmentStatus: postState.orderFulfillmentStatus,
              lineItemsSummary: postState.lineItemsSummary,
              timestamp: new Date().toISOString()
            }));

            // Update stored event with fulfillment state for UI
            if (storedEvent) {
              storedEvent.fulfillmentState = postState.orderFulfillmentStatus;
            }
          } catch (postStateError) {
            console.log(JSON.stringify({
              event: 'SHOPIFY_POST_FULFILLMENT_STATE_ERROR',
              requestId,
              dealId,
              correlationId,
              shopifyOrderId,
              error: postStateError.message,
              timestamp: new Date().toISOString()
            }));
          }
        } else if (fulfillmentResult && fulfillmentResult.error === 'SHOPIFY_FULFILLMENT_CREATE_SKIP') {
          console.log(JSON.stringify({
            event: 'SHOPIFY_FULFILLMENT_CREATE_SKIP',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            skip_reason: fulfillmentResult.skip_reason,
            message: fulfillmentResult.message,
            timestamp: new Date().toISOString()
          }));
        } else if (fulfillmentResult && !fulfillmentResult.success) {
          console.log(JSON.stringify({
            event: 'SHOPIFY_FULFILLMENT_CREATE_ERROR',
            requestId,
            dealId,
            correlationId,
            shopifyOrderId,
            error: fulfillmentResult.error,
            httpStatus: fulfillmentResult.httpStatus,
            message: fulfillmentResult.message,
            responseSnippet: fulfillmentResult.responseSnippet,
            timestamp: new Date().toISOString()
          }));
        }
      } // Close else block for fulfillment creation

      // Step 7: Add tags to prevent webhook loop and mark as in delivery (for both update and create)
      try {
        await addTagToOrder(shopifyOrderId, 'BitrixUpdated');
        await addTagToOrder(shopifyOrderId, 'IN_DELIVERY');
      } catch (tagError) {
        console.warn(`[BITRIX TO SHOPIFY] Failed to add tags: ${tagError.message}`);
      }
    } catch (error) {
      // Log any unexpected errors during fulfillment creation
      console.log(JSON.stringify({
        event: 'SHOPIFY_FULFILLMENT_CREATE_ERROR',
        requestId,
        dealId,
        correlationId,
        shopifyOrderId,
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      }));
    }

    return { success: true, triggerMatch: true, correlationId };
  } else {
    // Conditions not met - log skip reason
    const skipReasons = [];
    if (!decision.categoryMatch) {
      skipReasons.push(`categoryId=${categoryId} != ${BITRIX_CONFIG.CATEGORY_STOCK}`);
    }
    if (!decision.stageMatch) {
      skipReasons.push(`stageId=${stageId} != ${(expectedExecutingStage || 'C2:EXECUTING')}`);
    }
    if (!decision.shopifyOrderIdPresent) {
      skipReasons.push('shopifyOrderId is missing or empty');
    }

    const skipReason = skipReasons.join('; ');

    // ✅ Structured logging: [DELIVERY_TRIGGER_SKIP]
    console.log(JSON.stringify({
      event: 'DELIVERY_TRIGGER_SKIP',
      requestId,
      dealId,
      correlationId,
      categoryId,
      stageId,
      shopifyOrderId,
      skip_reason: skipReason,
      decision,
      timestamp: new Date().toISOString()
    }));

    return { success: true, triggerMatch: false, skip_reason: skipReason };
  }
}

/**
 * Handle deal creation event from Bitrix
 * Creates Shopify order if deal has products but no shopifyOrderId
 */
async function handleDealCreate(dealId, requestId) {
  // ✅ Structured logging: [BITRIX_WEBHOOK_RECEIVED] (CREATE)
  console.log(JSON.stringify({
    event: 'BITRIX_WEBHOOK_RECEIVED',
    requestId,
    dealId,
    eventType: 'CREATE',
    timestamp: new Date().toISOString()
  }));

  // Get full deal data from Bitrix REST API
  let dealData = null;
  try {
    const dealResp = await callBitrix('/crm.deal.get.json', {
      id: dealId,
    });

    if (!dealResp.result) {
      const error = {
        event: 'DEAL_GET_FAILED',
        requestId,
        dealId,
        error: 'Deal not found or failed to fetch',
        response: dealResp,
        timestamp: new Date().toISOString()
      };
      console.log(JSON.stringify(error));
      return { success: false, reason: 'deal_not_found' };
    }

    dealData = dealResp.result;
  } catch (error) {
    const errorLog = {
      event: 'DEAL_GET_ERROR',
      requestId,
      dealId,
      error: error.message,
      timestamp: new Date().toISOString()
    };
    console.log(JSON.stringify(errorLog));
    return { success: false, reason: 'deal_get_error', error: error.message };
  }

  // Extract required fields
  const categoryId = dealData.CATEGORY_ID;
  const stageId = dealData.STAGE_ID;
  let shopifyOrderId = dealData.UF_CRM_1742556489 || dealData.uf_crm_1742556489;
  const comments = dealData.COMMENTS || '';

  // ✅ Structured logging: [DEAL_DATA_RECEIVED] (CREATE)
  console.log(JSON.stringify({
    event: 'DEAL_DATA_RECEIVED',
    requestId,
    dealId,
    eventType: 'CREATE',
    categoryId,
    stageId,
    shopifyOrderId,
    timestamp: new Date().toISOString()
  }));

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
    console.error(`[BITRIX WEBHOOK] Failed to store event (non-blocking):`, storeError);
  }

  // ✅ Check for MW action first (UF_MW_SHOPIFY_ACTION)
  const mwActionResult = await handleMWAction(dealId, requestId, dealData, shopifyOrderId);
  if (mwActionResult !== null) {
    // MW action was processed (either success or error)
    return mwActionResult;
  }

  // ✅ ON-DEMAND SKU CREATION moved to orderMapper.js (Shopify-triggered flow)
  // Products are now auto-created when Shopify order arrives with unknown variant_id

  // ✅ Check if we need to create order in Shopify from Bitrix deal
  // Condition: No shopifyOrderId but deal has product rows
  console.log(JSON.stringify({
    event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRE_CHECK',
    requestId,
    dealId,
    eventType: 'CREATE',
    shopifyOrderId: shopifyOrderId || 'empty',
    shopifyOrderIdExists: !!(shopifyOrderId && shopifyOrderId.trim() !== ''),
    timestamp: new Date().toISOString()
  }));

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
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK',
            requestId,
            dealId,
            eventType: 'CREATE',
            message: 'Found shopifyOrderId on recheck (race condition prevented)',
            shopifyOrderId: recheckShopifyOrderId,
            timestamp: new Date().toISOString()
          }));
          shouldCreateOrder = false;
          existingShopifyOrderId = recheckShopifyOrderId;
        }
      }
    } catch (recheckError) {
      console.warn(`[BITRIX TO SHOPIFY] Error rechecking deal for shopifyOrderId:`, recheckError);
    }

    // If still should create, check Shopify for existing order by tag
    if (shouldCreateOrder) {
      const existingOrderId = await findExistingOrderByDealId(dealId);

      if (existingOrderId) {
        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_CHECK',
          requestId,
          dealId,
          eventType: 'CREATE',
          message: 'Found existing order in Shopify by BITRIX tag (duplicate prevented)',
          existingShopifyOrderId: existingOrderId,
          timestamp: new Date().toISOString()
        }));
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
          console.log(`[BITRIX TO SHOPIFY] Updated deal ${dealId} with found shopifyOrderId ${existingOrderId}`);
        } catch (updateError) {
          console.warn(`[BITRIX TO SHOPIFY] Failed to update deal with found shopifyOrderId:`, updateError);
        }
      }
    }
  }

  if (shouldCreateOrder) {
    try {
      // Get product rows from deal
      const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', {
        id: dealId
      });

      console.log(JSON.stringify({
        event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_PRODUCT_ROWS_RESPONSE',
        requestId,
        dealId,
        eventType: 'CREATE',
        productRowsExists: !!(productRowsResp && productRowsResp.result),
        productRowsIsArray: Array.isArray(productRowsResp?.result),
        productRowsCount: productRowsResp?.result?.length || 0,
        productRowsRespKeys: productRowsResp ? Object.keys(productRowsResp) : [],
        timestamp: new Date().toISOString()
      }));

      if (!productRowsResp || !productRowsResp.result) {
        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP',
          requestId,
          dealId,
          eventType: 'CREATE',
          skip_reason: 'no_product_rows_response',
          productRowsRespExists: !!productRowsResp,
          timestamp: new Date().toISOString()
        }));
      } else if (!Array.isArray(productRowsResp.result)) {
        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP',
          requestId,
          dealId,
          eventType: 'CREATE',
          skip_reason: 'product_rows_not_array',
          productRowsType: typeof productRowsResp.result,
          timestamp: new Date().toISOString()
        }));
      } else if (productRowsResp.result && Array.isArray(productRowsResp.result)) {
        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_CHECK',
          requestId,
          dealId,
          eventType: 'CREATE',
          productRowsCount: productRowsResp.result.length,
          timestamp: new Date().toISOString()
        }));

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
                console.log(`[BITRIX TO SHOPIFY] Product ${productId}: Using CODE as SKU: ${code.trim()}`);
              } else if (xmlId && xmlId.toString().trim() !== '') {
                // Use XML_ID directly as variant_id (no SKU lookup needed)
                items.push({
                  variantId: xmlId.toString().trim(),
                  qty: row.QUANTITY || 1
                });
                console.log(`[BITRIX TO SHOPIFY] Product ${productId}: Using XML_ID as variantId directly: ${xmlId}`);
              } else {
                console.warn(`[BITRIX TO SHOPIFY] Product ${productId} has no CODE (SKU) or XML_ID (variant_id), skipping`);
              }
            }
          } catch (productError) {
            console.error(`[BITRIX TO SHOPIFY] Error getting product ${productId}:`, productError);
          }
        }

        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ITEMS_COLLECTED',
          requestId,
          dealId,
          eventType: 'CREATE',
          itemsCount: items.length,
          items: items.map(i => ({
            sku: i.sku || null,
            variantId: i.variantId || null,
            qty: i.qty
          })),
          itemsWithSku: items.filter(i => i.sku).length,
          itemsWithVariantId: items.filter(i => i.variantId).length,
          timestamp: new Date().toISOString()
        }));

        // ✅ If Bitrix sent empty product rows (0 items), optionally add default product
        if (items.length === 0 && productRowsResp.result.length === 0 && BITRIX_ALLOW_EMPTY_PRODUCT_LINES) {
          items.push({
            variantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
            qty: BITRIX_EMPTY_ORDER_DEFAULT_QTY
          });
          isStubOrder = true;
          stubReason = 'empty_product_rows';
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED',
            requestId,
            dealId,
            eventType: 'CREATE',
            defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
            defaultQty: BITRIX_EMPTY_ORDER_DEFAULT_QTY,
            reason: 'empty_product_rows',
            timestamp: new Date().toISOString()
          }));
        }

        // ✅ If product rows exist but we couldn't map any valid items, optionally add default product
        if (items.length === 0 && productRowsResp.result.length > 0 && BITRIX_ALLOW_EMPTY_PRODUCT_LINES) {
          items.push({
            variantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
            qty: BITRIX_EMPTY_ORDER_DEFAULT_QTY
          });
          isStubOrder = true;
          stubReason = 'no_mappable_items';
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED',
            requestId,
            dealId,
            eventType: 'CREATE',
            defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
            defaultQty: BITRIX_EMPTY_ORDER_DEFAULT_QTY,
            reason: 'no_mappable_items',
            timestamp: new Date().toISOString()
          }));
        }

        if (items.length > 0) {
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ATTEMPT',
            requestId,
            dealId,
            eventType: 'CREATE',
            itemsCount: items.length,
            items: items.map(i => ({ sku: i.sku, qty: i.qty })),
            timestamp: new Date().toISOString()
          }));

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
                  console.warn(`[BITRIX TO SHOPIFY] Failed to resolve country code: ${countryError.message}`);
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
              console.log(JSON.stringify({
                event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE',
                requestId,
                dealId,
                eventType: 'CREATE',
                message: 'Order creation prevented - duplicate found',
                existingShopifyOrderId: orderResult.orderId,
                timestamp: new Date().toISOString()
              }));
              // Use existing order ID
              existingShopifyOrderId = String(orderResult.orderId);
            } else {
              // Save shopifyOrderId back to Bitrix deal
              const createdOrderId = String(orderResult.orderId);

              // ✅ CRITICAL: Re-check for duplicate immediately after creation (race condition protection)
              await new Promise(resolve => setTimeout(resolve, 100));
              const postCreateCheck = await findExistingOrderByDealId(dealId);
              if (postCreateCheck && postCreateCheck !== createdOrderId) {
                console.log(JSON.stringify({
                  event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE_AFTER_CREATE',
                  requestId,
                  dealId,
                  eventType: 'CREATE',
                  message: 'Duplicate detected immediately after creation',
                  createdOrderId: createdOrderId,
                  foundOrderId: postCreateCheck,
                  timestamp: new Date().toISOString()
                }));
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
                      console.log(JSON.stringify({
                        event: 'BITRIX_ORDER_NAME_FETCHED',
                        requestId,
                        dealId,
                        shopifyOrderId: existingShopifyOrderId,
                        fetchedOrderName: orderName,
                        reason: 'duplicate_order_real_name_fetch',
                        timestamp: new Date().toISOString()
                      }));
                    }
                  } catch (fetchError) {
                    console.warn(`[BITRIX TO SHOPIFY] Failed to fetch order name for duplicate: ${fetchError.message}`);
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

                  console.log(JSON.stringify({
                    event: 'BITRIX_DEAL_TITLE_UPDATE_PLANNED',
                    requestId,
                    dealId,
                    currentTitle,
                    updatedTitle,
                    orderName: formattedOrderName,
                    shopifyOrderId: existingShopifyOrderId,
                    wasDuplicate: orderResult.wasDuplicate || false,
                    timestamp: new Date().toISOString()
                  }));
                } else {
                  const skipReason = alreadyContainsThisOrderNumber
                    ? 'order_number_already_in_title'
                    : !isValidOrderName
                      ? 'invalid_order_name_format'
                      : !isNotPlaceholderName
                        ? 'placeholder_order_name'
                        : 'unknown';

                  console.log(JSON.stringify({
                    event: 'BITRIX_DEAL_TITLE_UPDATE_SKIPPED',
                    requestId,
                    dealId,
                    reason: skipReason,
                    currentTitle,
                    orderName,
                    shopifyOrderId: existingShopifyOrderId,
                    alreadyContainsThisOrderNumber,
                    isValidOrderName,
                    isNotPlaceholderName,
                    timestamp: new Date().toISOString()
                  }));
                }

                await callBitrix('/crm.deal.update.json', {
                  id: dealId,
                  fields: updateFields
                });

                console.log(JSON.stringify({
                  event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SUCCESS',
                  requestId,
                  dealId,
                  eventType: 'CREATE',
                  shopifyOrderId: existingShopifyOrderId,
                  orderName: orderResult.orderName,
                  wasDuplicate: orderResult.wasDuplicate || false,
                  titleUpdated: !!updateFields.TITLE,
                  lineItemsCount: orderResult.lineItems?.length || 0,
                  tags: orderResult.tags || [],
                  note: orderResult.note || '',
                  timestamp: new Date().toISOString()
                }));

                // Update stored event with shopifyOrderId
                if (storedEvent) {
                  storedEvent.shopifyOrderId = existingShopifyOrderId;
                }

                return {
                  success: true,
                  triggerMatch: true,
                  shopifyOrderId: existingShopifyOrderId,
                  orderName: orderResult.orderName,
                  wasDuplicate: orderResult.wasDuplicate || false
                };
              } catch (updateError) {
                console.error(`[BITRIX TO SHOPIFY] Error updating deal with shopifyOrderId:`, updateError);
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
            console.log(JSON.stringify({
              event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_ERROR',
              requestId,
              dealId,
              eventType: 'CREATE',
              error: orderResult.error,
              message: orderResult.message,
              timestamp: new Date().toISOString()
            }));
            return {
              success: false,
              triggerMatch: false,
              skip_reason: 'order_create_failed',
              error: orderResult.error
            };
          }
        } else {
          console.log(JSON.stringify({
            event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP',
            requestId,
            dealId,
            eventType: 'CREATE',
            skip_reason: 'no_valid_items',
            productRowsCount: productRowsResp.result.length,
            timestamp: new Date().toISOString()
          }));
        }
      } else {
        console.log(JSON.stringify({
          event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP',
          requestId,
          dealId,
          eventType: 'CREATE',
          skip_reason: 'no_product_rows',
          timestamp: new Date().toISOString()
        }));
      }
    } catch (orderCreateError) {
      console.error(JSON.stringify({
        event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_EXCEPTION',
        requestId,
        dealId,
        eventType: 'CREATE',
        error: 'ORDER_CREATE_EXCEPTION',
        message: orderCreateError.message,
        stack: orderCreateError.stack,
        timestamp: new Date().toISOString()
      }));
      return {
        success: false,
        triggerMatch: false,
        skip_reason: 'order_create_exception',
        error: orderCreateError.message
      };
    }
  } else {
    console.log(JSON.stringify({
      event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SKIP',
      requestId,
      dealId,
      eventType: 'CREATE',
      skip_reason: 'shopify_order_id_exists',
      shopifyOrderId,
      timestamp: new Date().toISOString()
    }));
  }

  // If no order creation was needed or attempted, return success
  return { success: true, triggerMatch: false, skip_reason: 'no_action_needed' };
}

/**
 * Main webhook handler
 */
export default async function handler(req, res) {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const contentType = req.headers['content-type'] || 'unknown';
  const body = req.body || {};
  const payloadKeys = getPayloadKeys(body);
  const authToken = extractAuthToken(body);
  const hasAuthToken = !!authToken;

  // ✅ Structured logging: [BITRIX_WEBHOOK_INCOMING]
  console.log(`[BITRIX WEBHOOK] 🔖 CODE VERSION: ${BITRIX_WEBHOOK_VERSION}`);
  console.log(JSON.stringify({
    event: 'BITRIX_WEBHOOK_INCOMING',
    requestId,
    method: req.method,
    contentType,
    payloadKeys,
    hasAuthToken,
    timestamp: new Date().toISOString()
  }));

  if (req.method !== 'POST') {
    console.log(JSON.stringify({
      event: 'BITRIX_WEBHOOK_METHOD_NOT_ALLOWED',
      requestId,
      method: req.method,
      timestamp: new Date().toISOString()
    }));
    res.status(405).end('Method not allowed');
    return;
  }

  // Check authentication token (only if token is provided)
  if (hasAuthToken && authToken !== EXPECTED_AUTH_TOKEN) {
    console.log(JSON.stringify({
      event: 'BITRIX_WEBHOOK_AUTH_FAIL',
      requestId,
      hasAuthToken: true,
      tokenMatch: false,
      expectedToken: EXPECTED_AUTH_TOKEN.substring(0, 10) + '...',
      receivedToken: authToken.substring(0, 10) + '...',
      timestamp: new Date().toISOString()
    }));
    res.status(401).json({ error: 'Invalid authentication token' });
    return;
  }

  // Extract deal ID from payload (supports JSON and form-urlencoded)
  const { dealId, extractionPath } = extractDealId(body);

  if (!dealId) {
    // ✅ Structured logging: [BITRIX_WEBHOOK_INVALID_FORMAT]
    const errorLog = {
      event: 'BITRIX_WEBHOOK_INVALID_FORMAT',
      requestId,
      error: 'No deal ID found in payload',
      payloadKeys,
      contentType,
      timestamp: new Date().toISOString()
    };
    console.log(JSON.stringify(errorLog));
    res.status(400).json({ error: 'Invalid event format: no deal ID found', payloadKeys, contentType });
    return;
  }

  // ✅ Structured logging: [BITRIX_DEAL_ID_EXTRACTED]
  console.log(JSON.stringify({
    event: 'BITRIX_DEAL_ID_EXTRACTED',
    requestId,
    dealId,
    extractionPath,
    timestamp: new Date().toISOString()
  }));

  const event = body;
  const eventType = event.event || event.EVENT || event['event'] || 'unknown';

  // ✅ Log event type detection for debugging
  console.log(JSON.stringify({
    event: 'BITRIX_WEBHOOK_EVENT_TYPE_DETECTED',
    requestId,
    dealId,
    eventType,
    eventKeys: Object.keys(event),
    eventEvent: event.event,
    eventEVENT: event.EVENT,
    timestamp: new Date().toISOString()
  }));

  try {
    // Route based on event type
    let result = null;
    if (eventType === 'ONCRMDEALUPDATE' || eventType.includes('UPDATE')) {
      console.log(JSON.stringify({
        event: 'BITRIX_WEBHOOK_ROUTING_TO_UPDATE',
        requestId,
        dealId,
        eventType,
        timestamp: new Date().toISOString()
      }));
      result = await handleDealUpdate(dealId, requestId);
    } else if (eventType === 'ONCRMDEALADD' || eventType.includes('ADD')) {
      console.log(JSON.stringify({
        event: 'BITRIX_WEBHOOK_ROUTING_TO_CREATE',
        requestId,
        dealId,
        eventType,
        timestamp: new Date().toISOString()
      }));
      result = await handleDealCreate(dealId, requestId);
    } else {
      // ✅ Structured logging: [BITRIX_WEBHOOK_UNHANDLED_EVENT]
      console.log(JSON.stringify({
        event: 'BITRIX_WEBHOOK_UNHANDLED_EVENT',
        requestId,
        dealId,
        eventType,
        timestamp: new Date().toISOString()
      }));
      result = { success: true, triggerMatch: false, skip_reason: `unhandled_event_type:${eventType}` };
    }

    // ✅ Structured logging: [BITRIX_WEBHOOK_DONE]
    console.log(JSON.stringify({
      event: 'BITRIX_WEBHOOK_DONE',
      requestId,
      dealId,
      eventType,
      result,
      timestamp: new Date().toISOString()
    }));

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
  } catch (e) {
    // ✅ Structured logging: [BITRIX_WEBHOOK_ERROR]
    console.log(JSON.stringify({
      event: 'BITRIX_WEBHOOK_ERROR',
      requestId,
      dealId: dealId || 'unknown',
      error: e.message,
      stack: e.stack,
      timestamp: new Date().toISOString()
    }));

    res.status(500).json({
      error: 'Internal server error',
      message: e.message,
      requestId
    });
  }
}

