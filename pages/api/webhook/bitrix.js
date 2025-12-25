// Bitrix24 Webhook endpoint - receives events from Bitrix and syncs to Shopify
import { callBitrix } from '../../../src/lib/bitrix/client.js';
import { bitrixAdapter } from '../../../src/lib/adapters/bitrix/index.js';
import { BITRIX_CONFIG } from '../../../src/lib/bitrix/config.js';
import { getFulfillmentOrders, getOrderForFulfillment, createFulfillment, getPostFulfillmentState } from '../../../src/lib/shopify/fulfillment.js';
import { setProvenanceMarker } from '../../../src/lib/shopify/metafields.js';
import { createHoldOrder } from '../../../src/lib/shopify/hold.js';
import { createRefund } from '../../../src/lib/shopify/refund.js';
import { updateShippingAddress } from '../../../src/lib/shopify/address.js';
import { createOrderFromBitrix, findExistingOrderByDealId } from '../../../src/lib/shopify/order.js';
import { extractDealId, extractAuthToken, getPayloadKeys } from '../../../src/lib/bitrix/webhookParser.js';
import { payloadHash, cleanEmptyFields } from '../../../src/lib/utils/hash.js';

// Expected auth token from Bitrix
const EXPECTED_AUTH_TOKEN = process.env.BITRIX_AUTH_TOKEN || '9gxukpkc7i1y4gms906jvm0t51npv0vb';

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
      
      return {
        action: 'address_update',
        shipping_address: cleanedAddress || {}
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
  const supportedActions = ['hold_create', 'refund_create', 'address_update'];
  
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

      if (productRowsResp.result && Array.isArray(productRowsResp.result) && productRowsResp.result.length > 0) {
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

          // Create order in Shopify
          const correlationId = `${dealId}:${Date.now()}`;
          const orderResult = await createOrderFromBitrix(items, dealId, correlationId);

          if (orderResult.success) {
            // Save shopifyOrderId back to Bitrix deal
            const createdOrderId = String(orderResult.orderId);
            try {
              await callBitrix('/crm.deal.update.json', {
                id: dealId,
                fields: {
                  UF_CRM_1742556489: createdOrderId // Shopify Order ID field
                }
              });

              console.log(JSON.stringify({
                event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SUCCESS',
                requestId,
                dealId,
                shopifyOrderId: createdOrderId,
                orderName: orderResult.orderName,
                lineItemsCount: orderResult.lineItems?.length || 0,
                tags: orderResult.tags || [],
                note: orderResult.note || '',
                timestamp: new Date().toISOString()
              }));

              // Update shopifyOrderId for subsequent processing
              shopifyOrderId = createdOrderId;
            } catch (updateError) {
              console.error(`[BITRIX TO SHOPIFY] Error updating deal with shopifyOrderId:`, updateError);
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
  // Check Delivery trigger conditions
  const correlationId = `${dealId}:${shopifyOrderId || 'no-shopify-id'}`;
  const decision = {
    categoryMatch: String(categoryId) === String(BITRIX_CONFIG.CATEGORY_STOCK) || String(categoryId) === '2',
    stageMatch: String(stageId) === BITRIX_CONFIG.STAGES_CAT_2.EXECUTING || String(stageId) === 'C2:EXECUTING',
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
    expectedStageId: BITRIX_CONFIG.STAGES_CAT_2.EXECUTING,
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

    // ✅ MICROSTEP A2.1: Create fulfillment + set provenance marker
    try {
      // Step 1: Set provenance marker first
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

      // Step 2: Check if fulfillment is needed
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
        return { success: true, triggerMatch: true, correlationId };
      }

      // Check if already fulfilled
      if (orderData.isFullyFulfilled || !orderData.needsFulfillment) {
        const skipReason = orderData.isFullyFulfilled ? 'already_fulfilled' : 'nothing_to_fulfill';
        console.log(JSON.stringify({
          event: 'SHOPIFY_FULFILLMENT_CREATE_SKIP',
          requestId,
          dealId,
          correlationId,
          shopifyOrderId,
          skip_reason: skipReason,
          totalFulfillableQuantity: orderData.totalFulfillableQuantity,
          isFullyFulfilled: orderData.isFullyFulfilled,
          timestamp: new Date().toISOString()
        }));
        return { success: true, triggerMatch: true, correlationId };
      }

      // Step 3: Create fulfillment
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

      const fulfillmentResult = await createFulfillment(shopifyOrderId, orderData.itemsToFulfill, {
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
      } else if (fulfillmentResult.error === 'SHOPIFY_FULFILLMENT_CREATE_SKIP') {
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
      } else {
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
      skipReasons.push(`stageId=${stageId} != ${BITRIX_CONFIG.STAGES_CAT_2.EXECUTING}`);
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
        timestamp: new Date().toISOString()
      }));

      if (productRowsResp.result && Array.isArray(productRowsResp.result) && productRowsResp.result.length > 0) {
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

          // Create order in Shopify
          const correlationId = `${dealId}:${Date.now()}`;
          const orderResult = await createOrderFromBitrix(items, dealId, correlationId);

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
                await callBitrix('/crm.deal.update.json', {
                  id: dealId,
                  fields: {
                    UF_CRM_1742556489: existingShopifyOrderId // Shopify Order ID field
                  }
                });

                console.log(JSON.stringify({
                  event: 'BITRIX_TO_SHOPIFY_ORDER_CREATE_SUCCESS',
                  requestId,
                  dealId,
                  eventType: 'CREATE',
                  shopifyOrderId: existingShopifyOrderId,
                  orderName: orderResult.orderName,
                  wasDuplicate: orderResult.wasDuplicate || false,
                  lineItemsCount: orderResult.lineItems?.length || 0,
                  tags: orderResult.tags || [],
                  note: orderResult.note || '',
                  timestamp: new Date().toISOString()
                }));

              // Update stored event with shopifyOrderId
              if (storedEvent) {
                storedEvent.shopifyOrderId = createdOrderId;
              }

              return { 
                success: true, 
                triggerMatch: true, 
                shopifyOrderId: createdOrderId,
                orderName: orderResult.orderName
              };
            } catch (updateError) {
              console.error(`[BITRIX TO SHOPIFY] Error updating deal with shopifyOrderId:`, updateError);
              return { 
                success: true, 
                triggerMatch: true, 
                shopifyOrderId: createdOrderId,
                orderCreated: true,
                dealUpdateFailed: true
              };
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
      console.error(`[BITRIX TO SHOPIFY] Error checking/creating order:`, orderCreateError);
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

  try {
    // Route based on event type
    let result = null;
    if (eventType === 'ONCRMDEALUPDATE' || eventType.includes('UPDATE')) {
      result = await handleDealUpdate(dealId, requestId);
    } else if (eventType === 'ONCRMDEALADD' || eventType.includes('ADD')) {
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

