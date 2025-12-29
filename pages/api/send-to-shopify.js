import { bitrixAdapter } from '../../src/lib/adapters/bitrix/index.js';
import { getFulfillmentOrders } from '../../src/lib/shopify/fulfillment.js';
import { createRefund } from '../../src/lib/shopify/refund.js';
import { updateShippingAddress } from '../../src/lib/shopify/address.js';
import { normalizePayload, payloadHash } from '../../src/lib/utils/hash.js';
import { setProvenanceMarker } from '../../src/lib/shopify/metafields.js';
import { createOrderFromBitrix } from '../../src/lib/shopify/order.js';
import { callBitrix } from '../../src/lib/bitrix/client.js';

// ✅ Optional: allow creating Shopify order even when Bitrix deal has 0 product rows
const BITRIX_ALLOW_EMPTY_PRODUCT_LINES = String(process.env.BITRIX_ALLOW_EMPTY_PRODUCT_LINES || 'true').toLowerCase() === 'true';
const BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID = String(process.env.BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID || '53051786756360');
const BITRIX_EMPTY_ORDER_DEFAULT_QTY = Number(process.env.BITRIX_EMPTY_ORDER_DEFAULT_QTY || 1) || 1;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { selectedEvents } = req.body;

  if (!selectedEvents || !Array.isArray(selectedEvents) || selectedEvents.length === 0) {
    return res.status(400).json({ 
      error: 'No selected events provided',
      details: 'Please select at least one event to send'
    });
  }

  const results = [];
  const errors = [];

  for (let i = 0; i < selectedEvents.length; i++) {
    const event = selectedEvents[i];
    let shopifyOrderId = event.shopifyOrderId || event.shopify_order_id;
    const dealId = event.dealId || event.deal_id;
    const rawDealData = event.rawDealData || {};
    
    // Check for MW action (refund_create, address_update)
    const mwActionRaw = rawDealData.UF_MW_SHOPIFY_ACTION || rawDealData.uf_mw_shopify_action || '';
    
    if (mwActionRaw && typeof mwActionRaw === 'string' && mwActionRaw.trim() !== '') {
      // Handle MW action (refund_create, address_update)
      try {
        let actionData = null;
        try {
          actionData = JSON.parse(mwActionRaw);
        } catch (parseError) {
          errors.push({
            eventId: event.id,
            success: false,
            error: 'MW_ACTION_PARSE_ERROR',
            details: `Failed to parse UF_MW_SHOPIFY_ACTION: ${parseError.message}`,
            type: 'ParseError',
            dealId
          });
          continue;
        }

        const action = actionData.action;
        const normalizedPayload = normalizePayload(action, actionData);
        
        if (!normalizedPayload) {
          errors.push({
            eventId: event.id,
            success: false,
            error: 'MW_ACTION_NORMALIZATION_FAILED',
            details: 'Failed to normalize payload',
            type: 'NormalizationError',
            dealId
          });
          continue;
        }

        const hash = payloadHash(normalizedPayload);
        const correlationId = `${dealId}:${hash}`;

        // Handle refund_create
        if (action === 'refund_create' && shopifyOrderId) {
          console.log(JSON.stringify({
            event: 'UI_REFUND_CREATE_ATTEMPT',
            dealId,
            shopifyOrderId,
            correlationId,
            payloadHash: hash,
            mode: normalizedPayload.mode,
            timestamp: new Date().toISOString()
          }));

          const refundResult = await createRefund(shopifyOrderId, normalizedPayload, correlationId, hash);

          if (refundResult.success) {
            // Set provenance marker
            await setProvenanceMarker(shopifyOrderId, correlationId, 'refund_create', hash);

            results.push({
              eventId: event.id,
              success: true,
              message: `Refund created: ${refundResult.refundId}`,
              refundId: refundResult.refundId,
              refundAmount: refundResult.refundAmount,
              shopifyOrderId,
              dealId,
              correlationId,
              payloadHash: hash
            });
          } else {
            errors.push({
              eventId: event.id,
              success: false,
              error: refundResult.error || 'REFUND_CREATE_ERROR',
              details: refundResult.message,
              type: 'RefundCreateError',
              dealId,
              shopifyOrderId,
              correlationId
            });
          }
          continue;
        }

        // Handle address_update
        if (action === 'address_update' && shopifyOrderId) {
          console.log(JSON.stringify({
            event: 'UI_ADDRESS_UPDATE_ATTEMPT',
            dealId,
            shopifyOrderId,
            correlationId,
            payloadHash: hash,
            timestamp: new Date().toISOString()
          }));

          const addressResult = await updateShippingAddress(shopifyOrderId, normalizedPayload, correlationId, hash);

          if (addressResult.success) {
            // Set provenance marker
            await setProvenanceMarker(shopifyOrderId, correlationId, 'address_update', hash);

            results.push({
              eventId: event.id,
              success: true,
              message: `Address updated for order ${addressResult.orderName}`,
              orderName: addressResult.orderName,
              shopifyOrderId,
              dealId,
              correlationId,
              payloadHash: hash
            });
          } else {
            errors.push({
              eventId: event.id,
              success: false,
              error: addressResult.error || 'ADDRESS_UPDATE_ERROR',
              details: addressResult.message,
              type: 'AddressUpdateError',
              dealId,
              shopifyOrderId,
              correlationId
            });
          }
          continue;
        }

        // Unsupported MW action
        errors.push({
          eventId: event.id,
          success: false,
          error: 'UNSUPPORTED_MW_ACTION',
          details: `MW action "${action}" is not supported for manual send or requires shopifyOrderId`,
          type: 'UnsupportedAction',
          dealId
        });
        continue;
      } catch (mwError) {
        errors.push({
          eventId: event.id,
          success: false,
          error: 'MW_ACTION_EXCEPTION',
          details: mwError.message,
          type: 'Exception',
          dealId
        });
        continue;
      }
    }
    
    // Handle fulfillment (DELIVERY_EXECUTING) - requires shopifyOrderId
    // If shopifyOrderId is missing, try to create order from Bitrix deal
    if (!shopifyOrderId) {
      // Try to create order in Shopify from Bitrix deal
      try {
        // Get product rows from deal
        const productRowsResp = await callBitrix('/crm.deal.productrows.get.json', {
          id: dealId
        });

        if (productRowsResp.result && Array.isArray(productRowsResp.result)) {
          console.log(JSON.stringify({
            event: 'UI_BITRIX_TO_SHOPIFY_ORDER_CREATE_CHECK',
            eventId: event.id,
            dealId,
            productRowsCount: productRowsResp.result.length,
            timestamp: new Date().toISOString()
          }));

          // Convert Bitrix product rows to Shopify items
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
                const sku = product.CODE || product.XML_ID; // SKU is usually in CODE or XML_ID
                
                if (sku && sku.trim() !== '') {
                  items.push({
                    sku: sku.trim(),
                    qty: row.QUANTITY || 1
                  });
                } else {
                  console.warn(`[UI BITRIX TO SHOPIFY] Product ${productId} has no SKU (CODE/XML_ID), skipping`);
                }
              }
            } catch (productError) {
              console.error(`[UI BITRIX TO SHOPIFY] Error getting product ${productId}:`, productError);
            }
          }

          // ✅ If Bitrix sent empty product rows (0 items), optionally add default product
          if (items.length === 0 && productRowsResp.result.length === 0 && BITRIX_ALLOW_EMPTY_PRODUCT_LINES) {
            items.push({
              variantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
              qty: BITRIX_EMPTY_ORDER_DEFAULT_QTY
            });
            console.log(JSON.stringify({
              event: 'UI_BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED',
              eventId: event.id,
              dealId,
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
            console.log(JSON.stringify({
              event: 'UI_BITRIX_TO_SHOPIFY_EMPTY_PRODUCT_LINES_DEFAULT_USED',
              eventId: event.id,
              dealId,
              defaultVariantId: BITRIX_EMPTY_ORDER_DEFAULT_VARIANT_ID,
              defaultQty: BITRIX_EMPTY_ORDER_DEFAULT_QTY,
              reason: 'no_mappable_items',
              timestamp: new Date().toISOString()
            }));
          }

          if (items.length > 0) {
            console.log(JSON.stringify({
              event: 'UI_BITRIX_TO_SHOPIFY_ORDER_CREATE_ATTEMPT',
              eventId: event.id,
              dealId,
              itemsCount: items.length,
              items: items.map(i => ({ sku: i.sku, qty: i.qty })),
              timestamp: new Date().toISOString()
            }));

            // Create order in Shopify
            const correlationId = `ui-bitrix:${dealId}:${event.id}`;
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
                  event: 'UI_BITRIX_TO_SHOPIFY_ORDER_CREATE_SUCCESS',
                  eventId: event.id,
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

                // Continue with fulfillment check below
              } catch (updateError) {
                console.error(`[UI BITRIX TO SHOPIFY] Error updating deal with shopifyOrderId:`, updateError);
                // Still continue with created order
                shopifyOrderId = createdOrderId;
              }
            } else {
              errors.push({
                eventId: event.id,
                success: false,
                error: 'ORDER_CREATE_ERROR',
                details: orderResult.message || 'Failed to create order in Shopify',
                type: 'OrderCreateError',
                dealId
              });
              continue;
            }
          } else {
            // No valid items found
            errors.push({
              eventId: event.id,
              success: false,
              error: 'Missing Shopify Order ID',
              details: 'Event does not contain shopifyOrderId field, no MW action found, and no valid items to create order',
              type: 'ValidationError'
            });
            continue;
          }
        } else {
          // No product rows found
          errors.push({
            eventId: event.id,
            success: false,
            error: 'Missing Shopify Order ID',
            details: 'Event does not contain shopifyOrderId field, no MW action found, and deal has no product rows',
            type: 'ValidationError'
          });
          continue;
        }
      } catch (orderCreateError) {
        console.error(`[UI BITRIX TO SHOPIFY] Error checking/creating order:`, orderCreateError);
        errors.push({
          eventId: event.id,
          success: false,
          error: 'ORDER_CREATE_EXCEPTION',
          details: orderCreateError.message || 'Failed to create order from Bitrix deal',
          type: 'Exception',
          dealId
        });
        continue;
      }
    }

    // Now we have shopifyOrderId (either from event or just created)
    if (!shopifyOrderId) {
      errors.push({
        eventId: event.id,
        success: false,
        error: 'Missing Shopify Order ID',
        details: 'Could not get or create shopifyOrderId',
        type: 'ValidationError'
      });
      continue;
    }

    try {
      // Read fulfillments from Shopify (DRY-RUN, no writes)
      const fulfillmentResult = await getFulfillmentOrders(shopifyOrderId);
      
      // Log the operation
      console.log(JSON.stringify({
        event: 'SHOPIFY_FULFILLMENT_CHECK',
        dealId,
        shopifyOrderId,
        resultSummary: {
          success: fulfillmentResult.success,
          count: fulfillmentResult.count,
          fulfillmentIds: fulfillmentResult.fulfillmentIds,
          hasFulfillments: fulfillmentResult.count > 0
        },
        httpStatus: fulfillmentResult.httpStatus,
        timestamp: new Date().toISOString()
      }));

      // Handle authentication errors
      if (fulfillmentResult.error === 'SHOPIFY_ADMIN_AUTH_ERROR') {
        console.log(JSON.stringify({
          event: 'SHOPIFY_ADMIN_AUTH_ERROR',
          dealId,
          shopifyOrderId,
          httpStatus: fulfillmentResult.httpStatus,
          message: fulfillmentResult.message,
          timestamp: new Date().toISOString()
        }));

        errors.push({
          eventId: event.id,
          success: false,
          status: fulfillmentResult.httpStatus,
          error: 'Shopify Admin API Authentication Error',
          details: fulfillmentResult.message,
          type: 'AuthError',
          shopifyOrderId,
          dealId
        });
        continue;
      }

      // Success - fulfillment data retrieved
      if (fulfillmentResult.success) {
        results.push({
          eventId: event.id,
          success: true,
          status: fulfillmentResult.httpStatus,
          message: `Fulfillment data retrieved for order ${shopifyOrderId}`,
          fulfillmentCount: fulfillmentResult.count,
          fulfillmentIds: fulfillmentResult.fulfillmentIds,
          shopifyOrderId,
          dealId,
          fulfillmentData: fulfillmentResult.fulfillments
        });
      } else {
        // Other errors (network, 404, 500, etc.)
        errors.push({
          eventId: event.id,
          success: false,
          status: fulfillmentResult.httpStatus,
          error: fulfillmentResult.error || 'Unknown error',
          details: fulfillmentResult.message,
          type: 'FulfillmentFetchError',
          shopifyOrderId,
          dealId
        });
      }
    } catch (fetchError) {
      let errorMessage = 'Unknown error';
      let errorDetails = null;

      if (fetchError.message) {
        errorMessage = fetchError.message;
        errorDetails = fetchError.message;
      }

      errors.push({
        eventId: event.id,
        success: false,
        error: errorMessage,
        details: errorDetails,
        type: fetchError.name || 'NetworkError',
        shopifyOrderId,
        dealId
      });
    }
  }

  const successful = results.length;
  const failed = errors.length;
  const total = selectedEvents.length;

  // Combine results and errors
  const allResults = [...results, ...errors];

  // Return appropriate status code
  if (failed === 0) {
    // All successful
    res.status(200).json({
      success: true,
      message: `Все ${successful} событий успешно обработаны`,
      total,
      successful,
      failed,
      results: allResults
    });
  } else if (successful === 0) {
    // All failed
    res.status(500).json({
      success: false,
      message: `Не удалось обработать события`,
      total,
      successful,
      failed,
      errors: errors,
      results: allResults
    });
  } else {
    // Partial success
    res.status(207).json({
      success: false,
      message: `Обработано ${successful} из ${total} событий. ${failed} событий не удалось обработать`,
      total,
      successful,
      failed,
      errors: errors,
      results: allResults
    });
  }
}


