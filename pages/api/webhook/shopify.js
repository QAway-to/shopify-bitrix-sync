// Shopify Webhook endpoint
import { shopifyAdapter } from '../../../src/lib/adapters/shopify/index.js';
import { callBitrix, getBitrixWebhookBase } from '../../../src/lib/bitrix/client.js';
import { mapShopifyOrderToBitrixDeal } from '../../../src/lib/bitrix/orderMapper.js';
import { upsertBitrixContact } from '../../../src/lib/bitrix/contact.js';
import { BITRIX_CONFIG } from '../../../src/lib/bitrix/config.js';

// Configure body parser to accept raw JSON
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

/**
 * Create deal with retry logic and duplicate handling (Optimistic Locking)
 * Uses Bitrix API as source of truth to handle race conditions
 * 
 * @param {Object} dealFields - Deal fields to create
 * @param {string} shopifyOrderId - Shopify order ID for duplicate detection
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @returns {Promise<Object>} { success: boolean, dealId: string, wasDuplicate: boolean }
 */
async function createDealWithRetry(dealFields, shopifyOrderId, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[SHOPIFY WEBHOOK] Creating deal attempt ${attempt}/${maxRetries} for order ${shopifyOrderId}`);
      
      // Try to create deal
      const dealAddResp = await callBitrix('/crm.deal.add.json', {
        fields: dealFields,
      });

      // Success case
      if (dealAddResp.result) {
        console.log(`[SHOPIFY WEBHOOK] ✅ Deal created successfully on attempt ${attempt}: ${dealAddResp.result}`);
        return { 
          success: true, 
          dealId: dealAddResp.result,
          wasDuplicate: false,
          attempt 
        };
      }

      // Check for duplicate error in response
      if (dealAddResp.error) {
        const errorDesc = (dealAddResp.error_description || dealAddResp.error || '').toLowerCase();
        
        // Detect duplicate indicators
        const isDuplicateError = 
          errorDesc.includes('duplicate') || 
          errorDesc.includes('already exists') ||
          errorDesc.includes('уже существует') ||
          errorDesc.includes('уже есть') ||
          dealAddResp.error === 'DUPLICATE' ||
          dealAddResp.error === 'ALREADY_EXISTS';
        
        if (isDuplicateError) {
          console.log(`[SHOPIFY WEBHOOK] ⚠️ Duplicate detected on attempt ${attempt}, finding existing deal`);
          
          // Wait a bit for Bitrix to commit the transaction (exponential backoff)
          const waitTime = Math.min(100 * attempt, 500);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          // Find existing deal
          const existingDealResp = await callBitrix('/crm.deal.list.json', {
            filter: { 'UF_CRM_1742556489': shopifyOrderId },
            select: ['ID', 'TITLE'],
          });

          if (existingDealResp.result && existingDealResp.result.length > 0) {
            const dealId = existingDealResp.result[0].ID;
            console.log(`[SHOPIFY WEBHOOK] ✅ Found existing deal ${dealId} after duplicate error (attempt ${attempt})`);
            return { 
              success: true, 
              dealId, 
              wasDuplicate: true,
              attempt 
            };
          }
          
          // Deal not found yet, might be in process - retry
          console.log(`[SHOPIFY WEBHOOK] Deal not found yet after duplicate error, will retry`);
        }
      }

      // If not a duplicate error, throw to be handled by retry logic
      throw new Error(`Failed to create deal: ${JSON.stringify(dealAddResp)}`);
      
    } catch (error) {
      const errorMsg = error.message.toLowerCase();
      
      // Check if error message indicates duplicate
      const isDuplicateInMessage = 
        errorMsg.includes('duplicate') || 
        errorMsg.includes('already exists') ||
        errorMsg.includes('уже существует');
      
      if (isDuplicateInMessage) {
        // Wait and retry finding existing deal
        const waitTime = Math.min(200 * attempt, 1000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        const existingDealResp = await callBitrix('/crm.deal.list.json', {
          filter: { 'UF_CRM_1742556489': shopifyOrderId },
          select: ['ID'],
        });

        if (existingDealResp.result && existingDealResp.result.length > 0) {
          const dealId = existingDealResp.result[0].ID;
          console.log(`[SHOPIFY WEBHOOK] ✅ Found existing deal ${dealId} from error message (attempt ${attempt})`);
          return { 
            success: true, 
            dealId, 
            wasDuplicate: true,
            attempt 
          };
        }
      }

      // If last attempt, throw error
      if (attempt === maxRetries) {
        console.error(`[SHOPIFY WEBHOOK] ❌ Failed to create deal after ${maxRetries} attempts:`, error);
        throw error;
      }

      // Exponential backoff for retry
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`[SHOPIFY WEBHOOK] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms delay`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // Should never reach here, but just in case
  throw new Error(`Failed to create deal after ${maxRetries} attempts`);
}

/**
 * Handle order created event - create deal in Bitrix
 * Includes duplicate prevention by checking for existing deal
 */
async function handleOrderCreated(order) {
  const shopifyOrderId = String(order.id);
  
  console.log(`[SHOPIFY WEBHOOK] Handling order created: ${order.name || order.id}`);
  console.log(`[SHOPIFY WEBHOOK] Order data:`, {
    id: order.id,
    name: order.name,
    total_price: order.total_price,
    current_total_price: order.current_total_price,
    financial_status: order.financial_status,
    line_items_count: order.line_items?.length || 0
  });

  // ✅ DUPLICATE PREVENTION: Check if deal already exists
  try {
    const existingDealResp = await callBitrix('/crm.deal.list.json', {
      filter: { 'UF_CRM_1742556489': shopifyOrderId },
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
    });

    if (existingDealResp.result && existingDealResp.result.length > 0) {
      const existingDeal = existingDealResp.result[0];
      const dealId = existingDeal.ID;
      
      console.log(`[SHOPIFY WEBHOOK] ⚠️ Deal already exists for Shopify order ${shopifyOrderId}: Deal ID ${dealId}`);
      console.log(`[SHOPIFY WEBHOOK] Skipping creation to prevent duplicate. Updating existing deal instead.`);
      
      // Update existing deal instead of creating duplicate
      const { dealFields, productRows } = mapShopifyOrderToBitrixDeal(order);
      
      // Upsert contact (non-blocking)
      let contactId = null;
      try {
        const bitrixBase = getBitrixWebhookBase();
        contactId = await upsertBitrixContact(bitrixBase, order);
        if (contactId) {
          dealFields.CONTACT_ID = contactId;
        }
      } catch (contactError) {
        console.error('[SHOPIFY WEBHOOK] Contact upsert failed (non-blocking):', contactError);
      }

      // Update deal fields
      await callBitrix('/crm.deal.update.json', {
        id: dealId,
        fields: dealFields,
      });
      console.log(`[SHOPIFY WEBHOOK] ✅ Existing deal ${dealId} updated`);

      // Update product rows
      if (productRows.length > 0) {
        try {
          await callBitrix('/crm.deal.productrows.set.json', {
            id: dealId,
            rows: productRows,
          });
          console.log(`[SHOPIFY WEBHOOK] Product rows updated for deal ${dealId}: ${productRows.length} rows`);
        } catch (productRowsError) {
          console.error(`[SHOPIFY WEBHOOK] Product rows update error (non-blocking):`, productRowsError);
        }
      }

      return dealId;
    }
  } catch (checkError) {
    console.error(`[SHOPIFY WEBHOOK] ⚠️ Error checking for existing deal (non-blocking, will attempt creation):`, checkError);
    // Continue with creation if check fails
  }

  // Map order to Bitrix deal
  const { dealFields, productRows } = mapShopifyOrderToBitrixDeal(order);
  
  console.log(`[SHOPIFY WEBHOOK] Mapped dealFields:`, JSON.stringify(dealFields, null, 2));
  console.log(`[SHOPIFY WEBHOOK] Mapped productRows count:`, productRows.length);
  if (productRows.length > 0) {
    console.log(`[SHOPIFY WEBHOOK] First product row:`, JSON.stringify(productRows[0], null, 2));
  }

  // Upsert contact (non-blocking)
  let contactId = null;
  try {
    const bitrixBase = getBitrixWebhookBase();
    contactId = await upsertBitrixContact(bitrixBase, order);
    if (contactId) {
      dealFields.CONTACT_ID = contactId;
    }
  } catch (contactError) {
    console.error('[SHOPIFY WEBHOOK] Contact upsert failed (non-blocking):', contactError);
  }

  // ✅ STEP 2: Create deal with retry logic and duplicate handling (Optimistic Locking)
  console.log(`[SHOPIFY WEBHOOK] Creating new deal in Bitrix with fields:`, Object.keys(dealFields));
  
  const createResult = await createDealWithRetry(dealFields, shopifyOrderId, 3);
  
  if (!createResult.success) {
    throw new Error('Failed to create deal after retries');
  }

  const dealId = createResult.dealId;
  
  if (createResult.wasDuplicate) {
    console.log(`[SHOPIFY WEBHOOK] ✅ Deal was duplicate, using existing: ${dealId} (found on attempt ${createResult.attempt})`);
  } else {
    console.log(`[SHOPIFY WEBHOOK] ✅ Deal created successfully: ${dealId} (attempt ${createResult.attempt})`);
  }

  // 2. Set product rows
  if (productRows.length > 0) {
    try {
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId,
        rows: productRows,
      });
      console.log(`[SHOPIFY WEBHOOK] Product rows set for deal ${dealId}: ${productRows.length} rows`);
    } catch (productRowsError) {
      console.error(`[SHOPIFY WEBHOOK] Product rows error (non-blocking):`, productRowsError);
      // Don't throw - deal is already created
    }
  }

  return dealId;
}

/**
 * Handle order updated event - update deal in Bitrix
 */
async function handleOrderUpdated(order) {
  console.log(`[SHOPIFY WEBHOOK] Handling order updated: ${order.name || order.id}`);

  const shopifyOrderId = String(order.id);

  // 1. Find deal by UF_CRM_1742556489 (Shopify Order ID field)
  // ✅ FIX: Use correct field name that matches orderMapper.js
  const listResp = await callBitrix('/crm.deal.list.json', {
    filter: { 'UF_CRM_1742556489': shopifyOrderId },
    select: ['ID', 'OPPORTUNITY', 'STAGE_ID'],
  });

  const deal = listResp.result?.[0];
  if (!deal) {
    // ✅ CRITICAL FIX: Create deal if not found
    // This handles case when orders/updated arrives before orders/create
    // or when deal was not created due to previous error
    console.log(`[SHOPIFY WEBHOOK] ⚠️ Deal not found for Shopify order ${shopifyOrderId}`);
    console.log(`[SHOPIFY WEBHOOK] Creating new deal from update event to prevent data loss`);
    return await handleOrderCreated(order);
  }

  const dealId = deal.ID;
  console.log(`[SHOPIFY WEBHOOK] Found deal ${dealId} for order ${shopifyOrderId}`);

  // 2. Prepare update fields
  const fields = {};

  // Update amount if changed
  const newAmount = Number(order.current_total_price || order.total_price || 0);
  if (newAmount !== Number(deal.OPPORTUNITY)) {
    fields.OPPORTUNITY = newAmount;
  }

  // Payment status synchronization
  const isPaid = order.financial_status === 'paid';
  // Update payment status field (adjust field name if needed)
  fields.UF_CRM_PAYMENT_STATUS = isPaid ? 'PAID' : 'NOT_PAID';

  // Optionally: move stage when order is paid
  if (isPaid) {
    fields.STAGE_ID = BITRIX_CONFIG.STAGES.PAID || 'WON'; // Use configured stage ID
  }

  // Update other fields if needed
  if (order.current_total_discounts !== undefined) {
    fields.UF_SHOPIFY_TOTAL_DISCOUNT = Number(order.current_total_discounts);
  }
  if (order.current_total_tax !== undefined) {
    fields.UF_SHOPIFY_TOTAL_TAX = Number(order.current_total_tax);
  }

  // 3. Update deal
  if (Object.keys(fields).length > 0) {
    await callBitrix('/crm.deal.update.json', {
      id: dealId,
      fields,
    });
    console.log(`[SHOPIFY WEBHOOK] Deal ${dealId} updated with fields:`, Object.keys(fields));
  } else {
    console.log(`[SHOPIFY WEBHOOK] No fields to update for deal ${dealId}`);
  }

  // 4. Update product rows (including shipping) to reflect any changes
  try {
    const { productRows } = mapShopifyOrderToBitrixDeal(order);
    if (productRows && productRows.length > 0) {
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId,
        rows: productRows,
      });
      console.log(`[SHOPIFY WEBHOOK] Product rows updated for deal ${dealId}: ${productRows.length} rows`);
    } else {
      // If no product rows (e.g., all items removed), clear rows to keep Bitrix in sync
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId,
        rows: [],
      });
      console.log(`[SHOPIFY WEBHOOK] Product rows cleared for deal ${dealId}`);
    }
  } catch (productRowsError) {
    console.error(`[SHOPIFY WEBHOOK] Product rows update error (non-blocking):`, productRowsError);
    // Do not throw to keep the webhook handler resilient
  }

  return dealId;
}

export default async function handler(req, res) {
  console.log(`[SHOPIFY WEBHOOK] ===== INCOMING REQUEST =====`);
  console.log(`[SHOPIFY WEBHOOK] Method: ${req.method}`);
  console.log(`[SHOPIFY WEBHOOK] Headers:`, {
    'x-shopify-topic': req.headers['x-shopify-topic'],
    'content-type': req.headers['content-type']
  });
  
  if (req.method !== 'POST') {
    console.log(`[SHOPIFY WEBHOOK] ❌ Method not allowed: ${req.method}`);
    res.status(405).end('Method not allowed');
    return;
  }

  const topic = req.headers['x-shopify-topic'];
  const order = req.body;

  console.log(`[SHOPIFY WEBHOOK] Topic: ${topic}`);
  console.log(`[SHOPIFY WEBHOOK] Order ID: ${order?.id || 'N/A'}`);
  console.log(`[SHOPIFY WEBHOOK] Order Name: ${order?.name || 'N/A'}`);
  console.log(`[SHOPIFY WEBHOOK] Order Data Summary:`, {
    id: order?.id,
    name: order?.name,
    total_price: order?.total_price,
    current_total_price: order?.current_total_price,
    financial_status: order?.financial_status,
    line_items_count: order?.line_items?.length || 0,
    created_at: order?.created_at,
    updated_at: order?.updated_at
  });

  try {
    // Store event for monitoring (non-blocking)
    try {
      const storedEvent = shopifyAdapter.storeEvent(order, topic);
      console.log(`[SHOPIFY WEBHOOK] ✅ Event stored. Topic: ${topic}, Order: ${order.name || order.id}, EventId: ${storedEvent.id}`);
      console.log(`[SHOPIFY WEBHOOK] 📊 Storage stats: Total events: ${shopifyAdapter.getEventsCount()}`);
    } catch (storeError) {
      console.error('[SHOPIFY WEBHOOK] ⚠️ Failed to store event:', storeError);
      console.error('[SHOPIFY WEBHOOK] Error details:', {
        message: storeError.message,
        stack: storeError.stack,
        topic: topic,
        orderId: order?.id
      });
    }

    if (topic === 'orders/create') {
      console.log(`[SHOPIFY WEBHOOK] 🔄 Processing orders/create event...`);
      await handleOrderCreated(order);
    } else if (topic === 'orders/updated') {
      console.log(`[SHOPIFY WEBHOOK] 🔄 Processing orders/updated event...`);
      await handleOrderUpdated(order);
    } else {
      // For other topics just log and return 200
      console.log(`[SHOPIFY WEBHOOK] ⚠️ Unhandled topic: ${topic}`);
    }

    res.status(200).end('OK');
  } catch (e) {
    console.error('[SHOPIFY WEBHOOK] ❌ Error:', e);
    console.error('[SHOPIFY WEBHOOK] Error details:', {
      message: e.message,
      stack: e.stack,
      topic: topic,
      orderId: order?.id
    });
    res.status(500).end('ERROR');
  }
}

