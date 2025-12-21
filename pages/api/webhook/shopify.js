// Shopify Webhook endpoint
import { shopifyAdapter } from '../../../src/lib/adapters/shopify/index.js';
import { successAdapter } from '../../../src/lib/adapters/success/index.js';
import { callBitrix, getBitrixWebhookBase, classifyBitrixError } from '../../../src/lib/bitrix/client.js';
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
 * Verify deal exists in Bitrix and get full details
 * @param {string} dealId - Deal ID to verify
 * @returns {Promise<Object|null>} Deal data or null if not found
 */
async function verifyDeal(dealId) {
  try {
    const dealResp = await callBitrix('/crm.deal.get.json', {
      id: dealId,
    });

    if (dealResp.result) {
      console.log(`[SHOPIFY WEBHOOK] ✅ Deal verified: ID=${dealId}, TITLE=${dealResp.result.TITLE}, OPPORTUNITY=${dealResp.result.OPPORTUNITY}`);
      return dealResp.result;
    }
    
    console.warn(`[SHOPIFY WEBHOOK] ⚠️ Deal verification failed: Deal ${dealId} not found in Bitrix`);
    return null;
  } catch (error) {
    console.error(`[SHOPIFY WEBHOOK] ❌ Deal verification error for ${dealId}:`, error);
    return null;
  }
}

/**
 * Validate deal fields before sending to Bitrix
 * @param {Object} dealFields - Deal fields to validate
 * @returns {Object} { valid: boolean, errors: Array<string>, warnings: Array<string> }
 */
function validateDealFields(dealFields) {
  const errors = [];
  const warnings = [];

  // Check for zero or null amount
  const amount = Number(dealFields.OPPORTUNITY || 0);
  if (amount === 0 || isNaN(amount)) {
    warnings.push('Deal amount is 0 or invalid - may be deleted by Bitrix robots');
  }

  // Check for required fields (adjust based on your Bitrix configuration)
  if (!dealFields.TITLE || dealFields.TITLE.trim() === '') {
    errors.push('TITLE is required');
  }

  if (!dealFields.CATEGORY_ID) {
    warnings.push('CATEGORY_ID is missing - may use default category');
  }

  if (!dealFields.STAGE_ID) {
    warnings.push('STAGE_ID is missing - may use default stage');
  }

  // Check for Shopify Order ID
  if (!dealFields.UF_CRM_1742556489) {
    warnings.push('UF_CRM_1742556489 (Shopify Order ID) is missing');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Create deal with retry logic and duplicate handling (Optimistic Locking)
 * Uses Bitrix API as source of truth to handle race conditions
 * 
 * @param {Object} dealFields - Deal fields to create
 * @param {string} shopifyOrderId - Shopify order ID for duplicate detection
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @returns {Promise<Object>} { success: boolean, dealId: string, wasDuplicate: boolean, errorType?: string }
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
        const dealId = dealAddResp.result;
        console.log(`[SHOPIFY WEBHOOK] ✅ Deal created successfully on attempt ${attempt}: ${dealId}`);
        
        // Verify deal exists and get details
        const verifiedDeal = await verifyDeal(dealId);
        if (verifiedDeal) {
          console.log(`[SHOPIFY WEBHOOK] ✅ Deal verified after creation:`, {
            ID: verifiedDeal.ID,
            TITLE: verifiedDeal.TITLE,
            OPPORTUNITY: verifiedDeal.OPPORTUNITY,
            STAGE_ID: verifiedDeal.STAGE_ID,
            CATEGORY_ID: verifiedDeal.CATEGORY_ID,
            UF_CRM_1742556489: verifiedDeal.UF_CRM_1742556489
          });
        } else {
          console.warn(`[SHOPIFY WEBHOOK] ⚠️ Deal ${dealId} was created but verification failed - deal may have been deleted`);
        }
        
        return { 
          success: true, 
          dealId,
          wasDuplicate: false,
          attempt,
          verifiedDeal
        };
      }

      // Check for duplicate error in response
      if (dealAddResp.error) {
        const errorInfo = classifyBitrixError(dealAddResp);
        
        // Log error with classification
        console.error(`[SHOPIFY WEBHOOK] ❌ Bitrix API error (${errorInfo.type}): ${errorInfo.message}`, {
          errorCode: errorInfo.code,
          shopifyOrderId,
          attempt,
          dealFields: Object.keys(dealFields)
        });
        
        // Handle duplicate errors
        if (errorInfo.type === 'DUPLICATE') {
          console.log(`[SHOPIFY WEBHOOK] ⚠️ Duplicate detected on attempt ${attempt}, finding existing deal`);
          
          // Wait a bit for Bitrix to commit the transaction (exponential backoff)
          const waitTime = Math.min(100 * attempt, 500);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          // Find existing deal
          const existingDealResp = await callBitrix('/crm.deal.list.json', {
            filter: { 'UF_CRM_1742556489': shopifyOrderId },
            select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
          });

          if (existingDealResp.result && existingDealResp.result.length > 0) {
            const dealId = existingDealResp.result[0].ID;
            console.log(`[SHOPIFY WEBHOOK] ✅ Found existing deal ${dealId} after duplicate error (attempt ${attempt})`);
            
            // Verify the found deal
            const verifiedDeal = await verifyDeal(dealId);
            
            return { 
              success: true, 
              dealId, 
              wasDuplicate: true,
              attempt,
              verifiedDeal
            };
          }
          
          // Deal not found yet, might be in process - retry
          console.log(`[SHOPIFY WEBHOOK] Deal not found yet after duplicate error, will retry`);
        }
        
        // For validation errors, don't retry - log and throw
        if (errorInfo.type === 'VALIDATION') {
          console.error(`[SHOPIFY WEBHOOK] ❌ Validation error - stopping retries:`, {
            message: errorInfo.message,
            code: errorInfo.code,
            shopifyOrderId,
            missingFields: errorInfo.details
          });
          const error = new Error(`Validation error: ${errorInfo.message}`);
          error.errorType = 'VALIDATION';
          error.errorDetails = errorInfo.details;
          throw error;
        }
        
        // For permission errors, don't retry - log and throw
        if (errorInfo.type === 'PERMISSION') {
          console.error(`[SHOPIFY WEBHOOK] ❌ Permission error - stopping retries:`, {
            message: errorInfo.message,
            code: errorInfo.code,
            shopifyOrderId
          });
          const error = new Error(`Permission error: ${errorInfo.message}`);
          error.errorType = 'PERMISSION';
          error.errorDetails = errorInfo.details;
          throw error;
        }
      }

      // If not a duplicate error, throw to be handled by retry logic
      throw new Error(`Failed to create deal: ${JSON.stringify(dealAddResp)}`);
      
    } catch (error) {
      const errorType = error.errorType || 'UNKNOWN';
      const errorMsg = error.message.toLowerCase();
      
      // Don't retry validation or permission errors
      if (errorType === 'VALIDATION' || errorType === 'PERMISSION') {
        console.error(`[SHOPIFY WEBHOOK] ❌ ${errorType} error - not retrying:`, {
          message: error.message,
          errorDetails: error.errorDetails,
          shopifyOrderId,
          attempt
        });
        throw error;
      }
      
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
          select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
        });

        if (existingDealResp.result && existingDealResp.result.length > 0) {
          const dealId = existingDealResp.result[0].ID;
          console.log(`[SHOPIFY WEBHOOK] ✅ Found existing deal ${dealId} from error message (attempt ${attempt})`);
          
          // Verify the found deal
          const verifiedDeal = await verifyDeal(dealId);
          
          return { 
            success: true, 
            dealId, 
            wasDuplicate: true,
            attempt,
            verifiedDeal
          };
        }
      }

      // If last attempt, throw error with full context
      if (attempt === maxRetries) {
        console.error(`[SHOPIFY WEBHOOK] ❌ Failed to create deal after ${maxRetries} attempts:`, {
          error: error.message,
          errorType: errorType,
          errorDetails: error.errorDetails,
          shopifyOrderId,
          attempts: maxRetries
        });
        throw error;
      }

      // Exponential backoff for retry
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`[SHOPIFY WEBHOOK] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms delay (error type: ${errorType})`);
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

      // Validate before update
      const validation = validateDealFields(dealFields);
      if (validation.warnings.length > 0) {
        console.warn(`[SHOPIFY WEBHOOK] ⚠️ Validation warnings before update:`, validation.warnings);
      }

      // Update deal fields
      await callBitrix('/crm.deal.update.json', {
        id: dealId,
        fields: dealFields,
      });
      console.log(`[SHOPIFY WEBHOOK] ✅ Existing deal ${dealId} updated`);

      // Verify updated deal
      const verifiedDeal = await verifyDeal(dealId);
      if (verifiedDeal) {
        console.log(`[SHOPIFY WEBHOOK] ✅ Deal verified after update:`, {
          ID: verifiedDeal.ID,
          TITLE: verifiedDeal.TITLE,
          OPPORTUNITY: verifiedDeal.OPPORTUNITY,
          STAGE_ID: verifiedDeal.STAGE_ID
        });
      }

      // Store successful update operation
      try {
        successAdapter.storeOperation({
          operationType: 'UPDATE',
          dealId: dealId,
          shopifyOrderId: shopifyOrderId,
          shopifyOrderName: order.name,
          dealData: verifiedDeal || existingDeal,
          verified: !!verifiedDeal,
          productRowsCount: productRows.length
        });
      } catch (storeError) {
        console.error(`[SHOPIFY WEBHOOK] ⚠️ Failed to store success operation (non-blocking):`, storeError);
      }

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

  // ✅ VALIDATION: Validate deal fields before sending
  const validation = validateDealFields(dealFields);
  if (validation.warnings.length > 0) {
    console.warn(`[SHOPIFY WEBHOOK] ⚠️ Validation warnings:`, validation.warnings);
  }
  if (!validation.valid) {
    console.error(`[SHOPIFY WEBHOOK] ❌ Validation errors:`, validation.errors);
    throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
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
  const verifiedDeal = createResult.verifiedDeal;
  
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

  // ✅ Store successful operation
  try {
    successAdapter.storeOperation({
      operationType: createResult.wasDuplicate ? 'UPDATE' : 'CREATE',
      dealId: dealId,
      shopifyOrderId: shopifyOrderId,
      shopifyOrderName: order.name,
      dealData: verifiedDeal || {
        ID: dealId,
        TITLE: dealFields.TITLE,
        OPPORTUNITY: dealFields.OPPORTUNITY,
        STAGE_ID: dealFields.STAGE_ID,
        CATEGORY_ID: dealFields.CATEGORY_ID
      },
      attempt: createResult.attempt,
      wasDuplicate: createResult.wasDuplicate,
      verified: !!verifiedDeal,
      productRowsCount: productRows.length
    });
    console.log(`[SHOPIFY WEBHOOK] ✅ Success operation stored for deal ${dealId}`);
  } catch (storeError) {
    console.error(`[SHOPIFY WEBHOOK] ⚠️ Failed to store success operation (non-blocking):`, storeError);
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

  // ✅ Use mapShopifyOrderToBitrixDeal to get all fields consistently (same as create)
  // This ensures OPPORTUNITY, payment status, stage, and all other fields are calculated correctly
  const { dealFields: mappedFields } = mapShopifyOrderToBitrixDeal(order);
  
  console.log(`[SHOPIFY WEBHOOK] 📊 Mapped fields from orderMapper:`);
  console.log(`  - OPPORTUNITY: ${mappedFields.OPPORTUNITY}`);
  console.log(`  - STAGE_ID: ${mappedFields.STAGE_ID}`);
  console.log(`  - Payment Status (UF_CRM_1739183959976): ${mappedFields.UF_CRM_1739183959976}`);
  console.log(`  - Order Total (UF_CRM_1741634415367): ${mappedFields.UF_CRM_1741634415367}`);
  console.log(`  - Paid Amount (UF_CRM_1741634439258): ${mappedFields.UF_CRM_1741634439258}`);
  
  const currentAmount = Number(deal.OPPORTUNITY || 0);
  const newAmount = Number(mappedFields.OPPORTUNITY || 0);
  
  console.log(`[SHOPIFY WEBHOOK] 💰 Amount comparison:`);
  console.log(`  - Current in Bitrix: ${currentAmount}`);
  console.log(`  - New from mapper (sum of active items): ${newAmount}`);
  if (newAmount !== currentAmount) {
    console.log(`  - ✅ Amount changed: ${currentAmount} → ${newAmount} (delta: ${newAmount - currentAmount})`);
  } else {
    console.log(`  - ⚠️ Amount unchanged: ${newAmount} (updating anyway to ensure sync)`);
  }

  // 2. Prepare update fields - always update to ensure sync
  // ✅ Use mapped fields to ensure consistency with create logic
  const fields = {
    OPPORTUNITY: mappedFields.OPPORTUNITY,
    STAGE_ID: mappedFields.STAGE_ID,
    UF_CRM_1739183959976: mappedFields.UF_CRM_1739183959976, // Payment status
    UF_CRM_1741634415367: mappedFields.UF_CRM_1741634415367, // Order total
    UF_CRM_1741634439258: mappedFields.UF_CRM_1741634439258, // Paid amount
  };
  
  // Update shipping price if present
  if (mappedFields.UF_CRM_67BEF8B2AA721 !== undefined) {
    fields.UF_CRM_67BEF8B2AA721 = mappedFields.UF_CRM_67BEF8B2AA721; // Delivery price
  }
  
  // Update delivery method if present
  if (mappedFields.UF_CRM_1739183302609) {
    fields.UF_CRM_1739183302609 = mappedFields.UF_CRM_1739183302609; // Delivery method
  }
  
  // Update order type if present
  if (mappedFields.UF_CRM_1739183268662) {
    fields.UF_CRM_1739183268662 = mappedFields.UF_CRM_1739183268662; // Order type
  }
  
  // Note: CATEGORY_ID is immutable after creation, so we don't update it

  // ✅ ALWAYS update deal fields (even if values are the same, ensures sync and triggers update event)
  console.log(`[SHOPIFY WEBHOOK] Updating deal ${dealId} with fields:`, Object.keys(fields));
  await callBitrix('/crm.deal.update.json', {
    id: dealId,
    fields,
  });
  console.log(`[SHOPIFY WEBHOOK] ✅ Deal ${dealId} updated with fields:`, Object.keys(fields));

  // Verify updated deal
  const verifiedDeal = await verifyDeal(dealId);
  if (verifiedDeal) {
    console.log(`[SHOPIFY WEBHOOK] ✅ Deal verified after update:`, {
      ID: verifiedDeal.ID,
      TITLE: verifiedDeal.TITLE,
      OPPORTUNITY: verifiedDeal.OPPORTUNITY,
      STAGE_ID: verifiedDeal.STAGE_ID
    });
  }

  // 4. ✅ ALWAYS update product rows (including shipping) to reflect any changes
  let productRows = [];
  try {
    const mapped = mapShopifyOrderToBitrixDeal(order);
    productRows = mapped.productRows || [];
    
    console.log(`[SHOPIFY WEBHOOK] 📦 Product rows mapping result:`);
    console.log(`  - Total product rows: ${productRows.length}`);
    console.log(`  - Line items in order: ${order.line_items?.length || 0}`);
    if (order.line_items && order.line_items.length > 0) {
      const totalQuantity = order.line_items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      const totalCurrentQuantity = order.line_items.reduce((sum, item) => sum + (Number(item.current_quantity ?? item.quantity) || 0), 0);
      console.log(`  - Total quantity (original): ${totalQuantity}`);
      console.log(`  - Total quantity (current, after refunds): ${totalCurrentQuantity}`);
      if (totalQuantity !== totalCurrentQuantity) {
        console.log(`  - ⚠️ WARNING: Some items were refunded/removed (${totalQuantity - totalCurrentQuantity} items removed)`);
      }
    }
    
    if (productRows.length > 0) {
      console.log(`[SHOPIFY WEBHOOK] ✅ Updating product rows for deal ${dealId}: ${productRows.length} rows`);
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId,
        rows: productRows,
      });
      console.log(`[SHOPIFY WEBHOOK] ✅ Product rows updated for deal ${dealId}: ${productRows.length} rows`);
    } else {
      // If no product rows (e.g., all items removed/refunded), clear rows to keep Bitrix in sync
      console.log(`[SHOPIFY WEBHOOK] ⚠️ No product rows to update (all items may be refunded/removed). Clearing product rows in Bitrix.`);
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId,
        rows: [],
      });
      console.log(`[SHOPIFY WEBHOOK] ✅ Product rows cleared for deal ${dealId} (no active items)`);
    }
  } catch (productRowsError) {
    console.error(`[SHOPIFY WEBHOOK] ❌ Product rows update error (non-blocking):`, productRowsError);
    console.error(`[SHOPIFY WEBHOOK] Error details:`, {
      message: productRowsError.message,
      stack: productRowsError.stack
    });
    // Do not throw to keep the webhook handler resilient
  }

  // ✅ Store successful update operation (always, even if values didn't change - we still synced)
  try {
    successAdapter.storeOperation({
      operationType: 'UPDATE',
      dealId: dealId,
      shopifyOrderId: shopifyOrderId,
      shopifyOrderName: order.name,
      dealData: verifiedDeal || {
        ID: dealId,
        OPPORTUNITY: newAmount,
        STAGE_ID: deal.STAGE_ID
      },
      verified: !!verifiedDeal,
      updatedFields: Object.keys(fields),
      productRowsCount: productRows.length
    });
    console.log(`[SHOPIFY WEBHOOK] ✅ Success operation stored for deal ${dealId}`);
  } catch (storeError) {
    console.error(`[SHOPIFY WEBHOOK] ⚠️ Failed to store success operation (non-blocking):`, storeError);
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

  let topic = req.headers['x-shopify-topic'];
  const order = req.body;

  // ✅ FALLBACK: If topic header is missing, try to determine from order data
  if (!topic && order) {
    // Check if order was just created (no updated_at or created_at === updated_at)
    if (order.created_at && order.updated_at) {
      const created = new Date(order.created_at);
      const updated = new Date(order.updated_at);
      const timeDiff = Math.abs(updated - created);
      // If created and updated are within 2 seconds, it's likely a create event
      if (timeDiff < 2000) {
        topic = 'orders/create';
        console.log(`[SHOPIFY WEBHOOK] ⚠️ Topic header missing, determined as 'orders/create' from order timestamps (diff: ${timeDiff}ms)`);
      } else {
        topic = 'orders/updated';
        console.log(`[SHOPIFY WEBHOOK] ⚠️ Topic header missing, determined as 'orders/updated' from order timestamps (diff: ${timeDiff}ms)`);
      }
    } else {
      // Default to create if we can't determine (new orders often don't have updated_at initially)
      topic = 'orders/create';
      console.log(`[SHOPIFY WEBHOOK] ⚠️ Topic header missing, defaulting to 'orders/create'`);
    }
  }

  console.log(`[SHOPIFY WEBHOOK] Topic: ${topic || 'undefined'}`);
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

    // ✅ PROCESS: Handle order events (create or update)
    if (topic === 'orders/create') {
      console.log(`[SHOPIFY WEBHOOK] 🔄 Processing orders/create event...`);
      await handleOrderCreated(order);
    } else if (topic === 'orders/updated') {
      console.log(`[SHOPIFY WEBHOOK] 🔄 Processing orders/updated event...`);
      await handleOrderUpdated(order);
    } else {
      // For other topics just log and return 200 (don't block)
      console.log(`[SHOPIFY WEBHOOK] ⚠️ Unhandled topic: ${topic}, skipping Bitrix processing`);
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

