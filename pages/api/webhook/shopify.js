// Shopify Webhook endpoint
import '../../../src/lib/logging/consoleCapture.js';
import { shopifyAdapter } from '../../../src/lib/adapters/shopify/index.js';
import { successAdapter } from '../../../src/lib/adapters/success/index.js';
import { callBitrix, getBitrixWebhookBase, classifyBitrixError } from '../../../src/lib/bitrix/client.js';
import { mapShopifyOrderToBitrixDeal } from '../../../src/lib/bitrix/orderMapper.js';
import { upsertBitrixContact } from '../../../src/lib/bitrix/contact.js';
import { BITRIX_CONFIG } from '../../../src/lib/bitrix/config.js';
import { getProvenanceMarker, setProvenanceMarker } from '../../../src/lib/shopify/metafields.js';

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

  // CATEGORY_ID can be 0 (default funnel), so only warn if it's truly missing
  if (dealFields.CATEGORY_ID === null || dealFields.CATEGORY_ID === undefined || dealFields.CATEGORY_ID === '') {
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
async function createDealWithRetry(dealFields, shopifyOrderId, maxRetries = 3, productRows = []) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[SHOPIFY WEBHOOK] Creating deal attempt ${attempt}/${maxRetries} for order ${shopifyOrderId}`);

      // ✅ CRITICAL: Aggressive duplicate check BEFORE creation with multiple retries
      // This prevents race conditions when multiple webhooks arrive simultaneously
      let existingDealId = null;
      const maxPreCreateChecks = 3;

      for (let preCheck = 1; preCheck <= maxPreCreateChecks; preCheck++) {
        const existingCheckResp = await callBitrix('/crm.deal.list.json', {
          filter: { 'UF_CRM_1742556489': shopifyOrderId },
          select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
        });

        if (existingCheckResp.result && existingCheckResp.result.length > 0) {
          // Sort by ID to get the oldest deal
          const sortedDeals = existingCheckResp.result.sort((a, b) => Number(a.ID) - Number(b.ID));
          existingDealId = sortedDeals[0].ID;

          if (existingCheckResp.result.length > 1) {
            console.warn(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ MULTIPLE DEALS FOUND (pre-create check ${preCheck}): ${existingCheckResp.result.length} deals!`);
            console.warn(`[SHOPIFY WEBHOOK] Deal IDs: ${existingCheckResp.result.map(d => d.ID).join(', ')}`);
            console.warn(`[SHOPIFY WEBHOOK] Using oldest: ${existingDealId}`);
          } else {
            console.log(`[SHOPIFY WEBHOOK] ⚠️ Deal already exists (pre-create check ${preCheck}, attempt ${attempt}): ${existingDealId}`);
          }
          break; // Exit retry loop - deal exists
        }

        // No deal found - wait a bit before next check (in case deal is being created by another request)
        if (preCheck < maxPreCreateChecks) {
          const waitTime = 50 * preCheck; // 50ms, 100ms
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      if (existingDealId) {
        // Verify the found deal
        const verifiedDeal = await verifyDeal(existingDealId);

        return {
          success: true,
          dealId: existingDealId,
          wasDuplicate: true,
          attempt,
          verifiedDeal
        };
      }

      // ✅ No existing deal found after all checks - safe to create
      console.log(`[SHOPIFY WEBHOOK] ✅ No existing deal found after ${maxPreCreateChecks} pre-create checks, proceeding with creation`);

      // ✅ Create deal first (Bitrix API doesn't support rows parameter in crm.deal.add.json)
      // Then add product rows separately via crm.deal.productrows.set.json (like the working script)
      const dealAddResp = await callBitrix('/crm.deal.add.json', {
        fields: dealFields,
      });

      // Success case
      if (dealAddResp.result) {
        const dealId = dealAddResp.result;
        console.log(`[SHOPIFY WEBHOOK] ✅ Deal created successfully on attempt ${attempt}: ${dealId}`);

        // ✅ CRITICAL: Aggressive duplicate check after creation with multiple retries
        // Wait longer for Bitrix to index the new deal, then check multiple times
        let duplicateFound = false;
        let firstDealId = dealId;

        for (let dupCheck = 1; dupCheck <= 3; dupCheck++) {
          const waitTime = 150 * dupCheck; // 150ms, 300ms, 450ms
          await new Promise(resolve => setTimeout(resolve, waitTime));

          const duplicateCheckResp = await callBitrix('/crm.deal.list.json', {
            filter: { 'UF_CRM_1742556489': shopifyOrderId },
            select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
          });

          if (duplicateCheckResp.result && duplicateCheckResp.result.length > 1) {
            duplicateFound = true;
            console.warn(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ DUPLICATE DETECTED (check ${dupCheck}): ${duplicateCheckResp.result.length} deals for order ${shopifyOrderId}!`);
            console.warn(`[SHOPIFY WEBHOOK] Deal IDs: ${duplicateCheckResp.result.map(d => d.ID).join(', ')}`);

            // Sort by ID to get the oldest (first created) deal
            const sortedDeals = duplicateCheckResp.result.sort((a, b) => Number(a.ID) - Number(b.ID));
            firstDealId = sortedDeals[0].ID;
            console.warn(`[SHOPIFY WEBHOOK] Using the oldest deal: ${firstDealId}`);

            // If this is not the oldest deal, we should delete the duplicate (but user said no deletion)
            // So we just use the oldest one and mark as duplicate
            if (firstDealId !== dealId) {
              console.warn(`[SHOPIFY WEBHOOK] ⚠️ Created deal ${dealId} is NOT the oldest. Using oldest deal ${firstDealId} instead.`);
            }
            break; // Exit retry loop
          }
        }

        if (duplicateFound) {
          // Use the oldest deal to maintain consistency
          const verifiedDeal = await verifyDeal(firstDealId);

          // Add product rows to the oldest deal
          if (productRows && productRows.length > 0) {
            try {
              console.log(`[SHOPIFY WEBHOOK] 🔗 Adding ${productRows.length} product rows to duplicate deal ${firstDealId}`);
              await callBitrix('/crm.deal.productrows.set.json', {
                id: firstDealId,
                rows: productRows,
              });
              console.log(`[SHOPIFY WEBHOOK] ✅ Product rows set for duplicate deal ${firstDealId}`);
            } catch (err) {
              console.error(`[SHOPIFY WEBHOOK] ⚠️ Failed to set product rows for duplicate deal:`, err);
            }
          }

          return {
            success: true,
            dealId: firstDealId,
            wasDuplicate: true, // Mark as duplicate since multiple deals exist
            attempt,
            verifiedDeal
          };
        }

        // ✅ CRITICAL: Add product rows AFTER deal creation (like the working script)
        // Bitrix API requires separate call to crm.deal.productrows.set.json
        if (productRows && productRows.length > 0) {
          try {
            console.log(`[SHOPIFY WEBHOOK] 🔗 Adding ${productRows.length} product rows to deal ${dealId} via crm.deal.productrows.set.json`);
            console.log(`[SHOPIFY WEBHOOK]   First product row:`, JSON.stringify(productRows[0], null, 2));

            const productRowsResp = await callBitrix('/crm.deal.productrows.set.json', {
              id: dealId,
              rows: productRows,
            });

            if (productRowsResp.result === true || productRowsResp.result) {
              console.log(`[SHOPIFY WEBHOOK] ✅ Product rows successfully set for deal ${dealId}`);
              // Log which products were linked
              productRows.forEach((row, idx) => {
                if (row.PRODUCT_ID) {
                  console.log(`[SHOPIFY WEBHOOK]   Row ${idx + 1}: PRODUCT_ID=${row.PRODUCT_ID} (linked to catalog)`);
                } else if (row.PRODUCT_NAME) {
                  console.log(`[SHOPIFY WEBHOOK]   Row ${idx + 1}: PRODUCT_NAME="${row.PRODUCT_NAME}" (custom row, NOT linked)`);
                }
              });
            } else {
              console.error(`[SHOPIFY WEBHOOK] ⚠️ Product rows set returned unexpected result:`, productRowsResp);
            }
          } catch (productRowsError) {
            console.error(`[SHOPIFY WEBHOOK] ❌ Failed to set product rows for deal ${dealId}:`, productRowsError);
            // Don't throw - deal is already created, we can retry product rows later
          }
        } else {
          console.log(`[SHOPIFY WEBHOOK] ⚠️ No product rows to set (deal created without products)`);
        }

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

  // ✅ CRITICAL: MULTI-STEP DUPLICATE PREVENTION with retry and delays
  // This prevents race conditions when multiple webhooks arrive simultaneously
  let existingDeal = null;
  const maxDuplicateChecks = 3;

  for (let checkAttempt = 1; checkAttempt <= maxDuplicateChecks; checkAttempt++) {
    try {
      console.log(`[SHOPIFY WEBHOOK] 🔍 Duplicate check attempt ${checkAttempt}/${maxDuplicateChecks} for order ${shopifyOrderId}`);

      const existingDealResp = await callBitrix('/crm.deal.list.json', {
        filter: { 'UF_CRM_1742556489': shopifyOrderId },
        select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
      });

      if (existingDealResp.result && existingDealResp.result.length > 0) {
        // Found existing deal(s) - use the first one
        existingDeal = existingDealResp.result[0];
        console.log(`[SHOPIFY WEBHOOK] ⚠️ Deal already exists (check ${checkAttempt}): ${existingDeal.ID}`);

        // If multiple deals found, log warning but use first
        if (existingDealResp.result.length > 1) {
          console.warn(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ MULTIPLE DEALS FOUND: ${existingDealResp.result.length} deals for order ${shopifyOrderId}!`);
          console.warn(`[SHOPIFY WEBHOOK] Deal IDs: ${existingDealResp.result.map(d => d.ID).join(', ')}`);
          console.warn(`[SHOPIFY WEBHOOK] Using first deal: ${existingDeal.ID}`);
        }
        break; // Exit retry loop - deal exists
      }

      // No deal found - wait a bit before next check (in case deal is being created)
      if (checkAttempt < maxDuplicateChecks) {
        const waitTime = 50 * checkAttempt; // 50ms, 100ms, 150ms
        console.log(`[SHOPIFY WEBHOOK] No deal found, waiting ${waitTime}ms before next check...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    } catch (checkError) {
      console.error(`[SHOPIFY WEBHOOK] ⚠️ Error checking for existing deal (attempt ${checkAttempt}):`, checkError);
      // Continue to next attempt or proceed with creation if last attempt
      if (checkAttempt === maxDuplicateChecks) {
        console.error(`[SHOPIFY WEBHOOK] ⚠️ All duplicate checks failed, proceeding with creation (may create duplicate)`);
      }
    }
  }

  // ✅ If deal exists, update it instead of creating duplicate
  if (existingDeal) {
    const dealId = existingDeal.ID;

    console.log(`[SHOPIFY WEBHOOK] ⚠️ Deal already exists for Shopify order ${shopifyOrderId}: Deal ID ${dealId}`);
    console.log(`[SHOPIFY WEBHOOK] Skipping creation to prevent duplicate. Updating existing deal instead.`);

    // Update existing deal instead of creating duplicate
    const { dealFields, productRows } = await mapShopifyOrderToBitrixDeal(order);

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

    // ✅ CHECK TITLE CHANGE
    if (existingDeal.TITLE !== dealFields.TITLE) {
      console.log(`[SHOPIFY WEBHOOK] 🔄 TITLE update detected: "${existingDeal.TITLE}" -> "${dealFields.TITLE}"`);
    } else {
      console.log(`[SHOPIFY WEBHOOK] ℹ️ TITLE matches existing: "${existingDeal.TITLE}"`);
    }

    // ✅ SAFE CATEGORY UPDATE: Only send CATEGORY_ID if it changed
    // Sending the same CATEGORY_ID might be harmless, but for safety regarding "immutable" comment
    const fieldsToUpdate = { ...dealFields };
    if (String(existingDeal.CATEGORY_ID) === String(fieldsToUpdate.CATEGORY_ID)) {
      console.log(`[SHOPIFY WEBHOOK] ℹ️ CATEGORY_ID matches (${existingDeal.CATEGORY_ID}), removing from update payload`);
      delete fieldsToUpdate.CATEGORY_ID;
    } else {
      console.log(`[SHOPIFY WEBHOOK] 🔄 CATEGORY_ID changing: ${existingDeal.CATEGORY_ID} -> ${fieldsToUpdate.CATEGORY_ID}`);
      // NOTE: Changing category requires valid STAGE_ID for the new category
    }

    // Update deal fields
    await callBitrix('/crm.deal.update.json', {
      id: dealId,
      fields: fieldsToUpdate,
    });
    console.log(`[SHOPIFY WEBHOOK] ✅ Existing deal ${dealId} updated`);

    // Verify updated deal
    const verifiedDeal = await verifyDeal(dealId);
    if (verifiedDeal) {
      console.log(`[SHOPIFY WEBHOOK] ✅ Deal verified after update:`, {
        ID: verifiedDeal.ID,
        TITLE: verifiedDeal.TITLE,
        OPPORTUNITY: verifiedDeal.OPPORTUNITY,
        STAGE_ID: verifiedDeal.STAGE_ID,
        TITLE_MATCH: verifiedDeal.TITLE === dealFields.TITLE ? '✅ YES' : `❌ NO (Expected: "${dealFields.TITLE}")`
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

  // ✅ No existing deal found after all checks - proceed with creation
  console.log(`[SHOPIFY WEBHOOK] ✅ No existing deal found after ${maxDuplicateChecks} checks, proceeding with creation`);

  // Map order to Bitrix deal
  const { dealFields, productRows } = await mapShopifyOrderToBitrixDeal(order);

  console.log(`[SHOPIFY WEBHOOK] Mapped dealFields:`, JSON.stringify(dealFields, null, 2));
  console.log(`[SHOPIFY WEBHOOK] Mapped productRows count:`, productRows.length);
  if (productRows.length > 0) {
    console.log(`[SHOPIFY WEBHOOK] First product row:`, JSON.stringify(productRows[0], null, 2));
  }

  // ✅ ADDRESS SYNC: Include shipping address in deal on CREATE
  console.log(`[SHOPIFY WEBHOOK] 📍 Address debug: shipping_address type=${typeof order?.shipping_address}, value=`, JSON.stringify(order?.shipping_address || null));
  if (order?.shipping_address && typeof order.shipping_address === 'object' && !Array.isArray(order.shipping_address)) {
    const addr = order.shipping_address;
    // Build Bitrix address string format: "Street, ZIP City Region, Country"
    const addressParts = [];
    if (addr.address1) addressParts.push(addr.address1);
    if (addr.address2) addressParts.push(addr.address2);

    const cityParts = [];
    if (addr.zip) cityParts.push(addr.zip);
    if (addr.city) cityParts.push(addr.city);
    if (addr.province) cityParts.push(addr.province);

    let bitrixAddress = addressParts.join(', ');
    if (cityParts.length > 0) {
      bitrixAddress += (bitrixAddress ? ', ' : '') + cityParts.join(' ');
    }
    if (addr.country) {
      bitrixAddress += (bitrixAddress ? ', ' : '') + addr.country;
    }

    if (bitrixAddress.trim()) {
      dealFields.UF_CRM_1742037435676 = bitrixAddress;
      console.log(`[SHOPIFY WEBHOOK] 📍 Address included in CREATE: "${bitrixAddress}"`);
    }
  }

  // ✅ VALIDATION: Validate deal fields before sending
  console.log(`[SHOPIFY WEBHOOK] 🔍 Validating deal fields before creation...`);
  const validation = validateDealFields(dealFields);
  if (validation.warnings.length > 0) {
    console.warn(`[SHOPIFY WEBHOOK] ⚠️ Validation warnings:`, validation.warnings);
  }
  if (!validation.valid) {
    console.error(`[SHOPIFY WEBHOOK] ❌❌❌ VALIDATION FAILED:`, {
      errors: validation.errors,
      warnings: validation.warnings,
      dealFields: {
        TITLE: dealFields.TITLE,
        OPPORTUNITY: dealFields.OPPORTUNITY,
        CATEGORY_ID: dealFields.CATEGORY_ID,
        STAGE_ID: dealFields.STAGE_ID,
        CURRENCY_ID: dealFields.CURRENCY_ID,
        UF_CRM_1742556489: dealFields.UF_CRM_1742556489
      },
      shopifyOrderId: shopifyOrderId,
      orderName: order.name
    });
    const validationError = new Error(`Validation failed: ${validation.errors.join(', ')}`);
    validationError.errorType = 'VALIDATION';
    validationError.errorDetails = validation.errors;
    throw validationError;
  }
  console.log(`[SHOPIFY WEBHOOK] ✅ Validation passed`);

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
  console.log(`[SHOPIFY WEBHOOK] Deal fields preview:`, {
    TITLE: dealFields.TITLE,
    OPPORTUNITY: dealFields.OPPORTUNITY,
    CATEGORY_ID: dealFields.CATEGORY_ID,
    STAGE_ID: dealFields.STAGE_ID,
    CURRENCY_ID: dealFields.CURRENCY_ID,
    UF_CRM_1742556489: dealFields.UF_CRM_1742556489
  });

  let createResult;
  try {
    // ✅ Pass productRows to createDealWithRetry so they're included in crm.deal.add.json
    createResult = await createDealWithRetry(dealFields, shopifyOrderId, 3, productRows);
  } catch (createError) {
    console.error(`[SHOPIFY WEBHOOK] ❌❌❌ CRITICAL: Failed to create deal for order ${shopifyOrderId}:`, createError);
    console.error(`[SHOPIFY WEBHOOK] Create error details:`, {
      message: createError.message,
      errorType: createError.errorType,
      errorDetails: createError.errorDetails,
      stack: createError.stack,
      shopifyOrderId: shopifyOrderId,
      dealFields: Object.keys(dealFields)
    });
    throw createError; // Re-throw to be caught by outer handler
  }

  if (!createResult || !createResult.success) {
    const errorMsg = createResult?.error || 'Failed to create deal after retries';
    console.error(`[SHOPIFY WEBHOOK] ❌❌❌ CRITICAL: createResult indicates failure:`, createResult);
    throw new Error(errorMsg);
  }

  const dealId = createResult.dealId;
  const verifiedDeal = createResult.verifiedDeal;

  if (createResult.wasDuplicate) {
    console.log(`[SHOPIFY WEBHOOK] ✅ Deal was duplicate, using existing: ${dealId} (found on attempt ${createResult.attempt})`);
  } else {
    console.log(`[SHOPIFY WEBHOOK] ✅ Deal created successfully: ${dealId} (attempt ${createResult.attempt})`);
  }

  // ✅ Product rows are already set during deal creation (in createDealWithRetry function)
  // They are added via crm.deal.productrows.set.json right after deal creation
  if (productRows.length > 0) {
    console.log(`[SHOPIFY WEBHOOK] ✅ Product rows (${productRows.length}) were already set during deal creation`);
    console.log(`[SHOPIFY WEBHOOK]   Products should be properly linked to catalog via PRODUCT_ID (not just text data)`);
  } else {
    console.log(`[SHOPIFY WEBHOOK] ⚠️ No product rows to set (deal created without products)`);
  }

  // ✅ CRITICAL FIX: Force Title Update if Bitrix Automation overwrote it
  // Check if verifiedDeal title matches what we wanted
  if (verifiedDeal && verifiedDeal.TITLE !== dealFields.TITLE) {
    console.warn(`[SHOPIFY WEBHOOK] ⚠️ TITLE MISMATCH DETECTED: Created deal has "${verifiedDeal.TITLE}", expected "${dealFields.TITLE}"`);
    console.warn(`[SHOPIFY WEBHOOK] 🔧 Forcing TITLE update to correct value...`);

    try {
      await callBitrix('/crm.deal.update.json', {
        id: dealId,
        fields: { TITLE: dealFields.TITLE }
      });
      console.log(`[SHOPIFY WEBHOOK] ✅ TITLE forced update successful: "${dealFields.TITLE}"`);

      // Update verifiedDeal object for storage
      verifiedDeal.TITLE = dealFields.TITLE;
    } catch (titleErr) {
      console.error(`[SHOPIFY WEBHOOK] ❌ Failed to force TITLE update:`, titleErr);
    }
  } else if (verifiedDeal) {
    console.log(`[SHOPIFY WEBHOOK] ✅ TITLE verification passed: "${verifiedDeal.TITLE}"`);
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
  const listResp = await callBitrix('/crm.deal.list.json', {
    filter: { 'UF_CRM_1742556489': shopifyOrderId },
    select: [
      'ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID', 'CATEGORY_ID',
      'UF_CRM_1739183959976', // Payment Status
      'UF_CRM_1741634415367', // Order Total
      'UF_CRM_1741634439258', // Paid Amount
      'UF_CRM_67BEF8B2AA721', // Delivery Price
      'UF_CRM_1739183302609', // Delivery Method
      'UF_CRM_1739183268662', // Order Type
      'UF_CRM_1742037435676', // Shipping Address
      'CONTACT_ID'
    ],
  });

  const deal = listResp.result?.[0];
  if (!deal) {
    // ✅ CRITICAL FIX: Create deal if not found
    console.log(`[SHOPIFY WEBHOOK] ⚠️ Deal not found for Shopify order ${shopifyOrderId}`);
    console.log(`[SHOPIFY WEBHOOK] Creating new deal from update event to prevent data loss`);
    return await handleOrderCreated(order);
  }

  // ✅ CRITICAL: Convert dealId to number (Bitrix API returns string, but we need number for API calls)
  const dealId = Number(deal.ID);
  const currentStageId = deal.STAGE_ID;
  const categoryId = deal.CATEGORY_ID || '2'; // Default to category 2 if not set

  console.log(`[SHOPIFY WEBHOOK] Found deal ${dealId} (converted to number) for order ${shopifyOrderId}, current stage: ${currentStageId}, category: ${categoryId}`);

  // ✅ Use mapShopifyOrderToBitrixDeal to get ALL fields AND productRows consistently (same as create)
  // This ensures OPPORTUNITY, payment status, stage, productRows with PRODUCT_ID are all calculated correctly
  const { dealFields: mappedFields, productRows: mappedProductRows } = await mapShopifyOrderToBitrixDeal(order);

  // ✅ Log product rows mapping for UPDATE (same as CREATE)
  console.log(`[SHOPIFY WEBHOOK] 📦 Product rows from orderMapper for UPDATE:`);
  console.log(`  - Total product rows: ${mappedProductRows.length}`);
  if (mappedProductRows.length > 0) {
    console.log(`  - First product row:`, JSON.stringify(mappedProductRows[0], null, 2));
    mappedProductRows.forEach((row, idx) => {
      if (row.PRODUCT_ID) {
        console.log(`  - Row ${idx + 1}: PRODUCT_ID=${row.PRODUCT_ID} (linked to catalog) ✅`);
      } else if (row.PRODUCT_NAME) {
        console.log(`  - Row ${idx + 1}: PRODUCT_NAME="${row.PRODUCT_NAME}" (custom row, NOT linked) ⚠️`);
      }
    });
  }

  // ✅ Simplified logic (matching backup repository): Check cancellation and refunds
  const financialStatus = order?.financial_status || '';
  const statusLower = financialStatus?.toLowerCase() || '';
  const cancelledAt = order?.cancelled_at;
  const cancelReason = order?.cancel_reason;

  // ✅ CRITICAL: Log cancelled_at value for debugging
  console.log(`[SHOPIFY WEBHOOK] 🔍 Cancellation check for order ${shopifyOrderId}:`);
  console.log(`  - cancelled_at: ${cancelledAt} (type: ${typeof cancelledAt})`);
  console.log(`  - cancelled_at !== null: ${cancelledAt !== null}`);
  console.log(`  - cancelled_at !== undefined: ${cancelledAt !== undefined}`);
  console.log(`  - cancelled_at !== '': ${cancelledAt !== ''}`);
  console.log(`  - financial_status: ${financialStatus}`);
  console.log(`  - cancel_reason: ${cancelReason || 'N/A'}`);

  // ✅ Check if order has active items (current_quantity > 0) - only for partial refund detection
  const hasActiveItems = order?.line_items && order.line_items.some(item => {
    const currentQty = Number(item.current_quantity ?? item.quantity ?? 0);
    return currentQty > 0;
  });

  // ✅ Check paid amount vs calculated total
  const paidAmount = Number(order.current_total_price || order.total_price || 0);
  const calculatedTotal = mappedFields.OPPORTUNITY || 0;
  const isOrderEmpty = calculatedTotal === 0 && !hasActiveItems;

  // ✅ CRITICAL: Cancellation detection - check multiple indicators
  // 1. financial_status === 'cancelled' || 'voided' (primary check)
  // 2. cancelled_at field is set (Shopify sets this when order is cancelled)
  // 3. cancel_reason field is set (Shopify sets this when order is cancelled)
  // 4. If order is empty (totalPrice = 0, no active items) → cancelled (regardless of financial_status)
  //    (Empty order = all items removed/refunded = cancellation)
  const isCancelledByStatus = statusLower === 'cancelled' || statusLower === 'voided';
  const isCancelledByField = cancelledAt !== null && cancelledAt !== undefined && cancelledAt !== '';
  const isCancelledByReason = cancelReason !== null && cancelReason !== undefined && cancelReason !== '';
  // ✅ CRITICAL: If order is empty (0 amount, no active items), it's ALWAYS cancelled
  // This covers cases where cancelled_at/cancel_reason might not be in webhook, but order is clearly cancelled
  const isCancelledByEmpty = isOrderEmpty;

  const isCancelled = isCancelledByStatus || isCancelledByField || isCancelledByReason || isCancelledByEmpty;

  // ✅ SIMPLIFIED: Full refund - refunded → always LOSE (matching backup repository)
  // BUT: if cancelled (especially by cancelled_at), it takes priority (cancelled > refunded)
  const isFullRefund = !isCancelled && statusLower === 'refunded';

  // ✅ PARTIAL REFUND: partially_refunded + has active items → PREPARATION (our improvement)
  // BUT: if cancelled (especially by cancelled_at), it takes priority (cancelled > partial refund)
  // ✅ CRITICAL: If order is empty (0 amount, no active items), it's NOT a partial refund, it's a cancellation
  const isPartialRefund = !isCancelled && statusLower === 'partially_refunded' && hasActiveItems && !isOrderEmpty;

  // ✅ Simplified: cancelled OR full refund → LOSE
  const isLost = isCancelled || isFullRefund;

  // ✅ Log all indicators
  if (isCancelled || isFullRefund || isPartialRefund) {
    console.log(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ ORDER STATUS DETECTED:`);
    console.log(`[SHOPIFY WEBHOOK]   - financial_status: "${financialStatus}"`);
    console.log(`[SHOPIFY WEBHOOK]   - cancelled_at: ${cancelledAt || 'N/A'}`);
    console.log(`[SHOPIFY WEBHOOK]   - cancel_reason: ${cancelReason || 'N/A'}`);
    console.log(`[SHOPIFY WEBHOOK]   - hasActiveItems: ${hasActiveItems}`);
    console.log(`[SHOPIFY WEBHOOK]   - calculatedTotal: ${calculatedTotal}, paidAmount: ${paidAmount}`);
    console.log(`[SHOPIFY WEBHOOK]   - isOrderEmpty: ${isOrderEmpty}`);
    if (isCancelled) {
      const cancelReasons = [];
      if (isCancelledByStatus) cancelReasons.push('financial_status');
      if (isCancelledByField) cancelReasons.push('cancelled_at');
      if (isCancelledByReason) cancelReasons.push('cancel_reason');
      if (isCancelledByEmpty) cancelReasons.push('empty_order+refunded');
      console.log(`[SHOPIFY WEBHOOK]   - isCancelled: ${isCancelled} → LOSE (detected by: [${cancelReasons.join(', ')}])`);
    } else {
      console.log(`[SHOPIFY WEBHOOK]   - isCancelled: ${isCancelled} → LOSE`);
    }
    console.log(`[SHOPIFY WEBHOOK]   - isFullRefund: ${isFullRefund} → LOSE (only if NOT cancelled)`);
    console.log(`[SHOPIFY WEBHOOK]   - isPartialRefund: ${isPartialRefund} → PREPARATION (only if NOT cancelled)`);
    console.log(`[SHOPIFY WEBHOOK]   - Final stage: ${isCancelled ? 'LOSE (cancelled)' : isFullRefund ? 'LOSE (full refund)' : isPartialRefund ? 'PREPARATION (partial refund)' : 'OTHER'}`);
  }

  console.log(`[SHOPIFY WEBHOOK] 📊 Mapped fields from orderMapper:`);
  console.log(`  - OPPORTUNITY: ${mappedFields.OPPORTUNITY}`);
  console.log(`  - STAGE_ID: ${mappedFields.STAGE_ID} ${isLost ? '(should be LOSE for cancelled/refunded order)' : ''}`);
  console.log(`  - Payment Status (UF_CRM_1739183959976): ${mappedFields.UF_CRM_1739183959976}`);
  console.log(`  - Order Total (UF_CRM_1741634415367): ${mappedFields.UF_CRM_1741634415367}`);
  console.log(`  - Paid Amount (UF_CRM_1741634439258): ${mappedFields.UF_CRM_1741634439258}`);
  console.log(`  - Financial Status: ${financialStatus} → Stage: ${mappedFields.STAGE_ID}`);

  // ✅ CRITICAL: Verify cancellation/refund is mapped correctly
  // Note: orderMapper.js should already handle this, but we double-check here
  // Priority: cancelled > full refund > partial refund
  if (isCancelled && mappedFields.STAGE_ID !== 'LOSE') {
    console.error(`[SHOPIFY WEBHOOK] ❌❌❌ ERROR: Cancelled order but STAGE_ID is "${mappedFields.STAGE_ID}" instead of "LOSE"!`);
    console.error(`[SHOPIFY WEBHOOK] Forcing STAGE_ID to LOSE to fix the issue.`);
    mappedFields.STAGE_ID = 'LOSE';
  } else if (isFullRefund && mappedFields.STAGE_ID !== 'LOSE') {
    console.error(`[SHOPIFY WEBHOOK] ❌❌❌ ERROR: Full refund order but STAGE_ID is "${mappedFields.STAGE_ID}" instead of "LOSE"!`);
    console.error(`[SHOPIFY WEBHOOK] Financial status mapping may be incorrect. Check financialStatusToStageId function.`);
    console.error(`[SHOPIFY WEBHOOK] Forcing STAGE_ID to LOSE to fix the issue.`);
    mappedFields.STAGE_ID = 'LOSE';
  } else if (isPartialRefund && mappedFields.STAGE_ID !== 'C2:PREPARATION') {
    console.error(`[SHOPIFY WEBHOOK] ❌❌❌ ERROR: Partial refund order but STAGE_ID is "${mappedFields.STAGE_ID}" instead of "C2:PREPARATION"!`);
    console.error(`[SHOPIFY WEBHOOK] Forcing STAGE_ID to C2:PREPARATION to fix the issue.`);
    mappedFields.STAGE_ID = 'C2:PREPARATION';
  }

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

  // ✅ SIMPLE LOGIC: Determine correct STAGE_ID FIRST (before creating fields)
  // Priority: cancelled_at (HIGHEST) > cancelled > full refund > partial refund
  let correctStageId = mappedFields.STAGE_ID;
  let correctPaymentStatus = mappedFields.UF_CRM_1739183959976;

  // ✅ HIGHEST PRIORITY: If cancelled_at is NOT empty -> it's CANCELLATION -> set status LOSE
  // Check multiple ways cancelled_at might be set (null, undefined, empty string, etc.)
  const hasCancelledAt = cancelledAt !== null && cancelledAt !== undefined && cancelledAt !== '';
  console.log(`[SHOPIFY WEBHOOK] 🔍 cancelled_at check result: hasCancelledAt=${hasCancelledAt}, cancelledAt="${cancelledAt}"`);
  console.log(`[SHOPIFY WEBHOOK] 🔍 Status checks: isCancelled=${isCancelled}, isFullRefund=${isFullRefund}, isPartialRefund=${isPartialRefund}`);
  console.log(`[SHOPIFY WEBHOOK] 🔍 Mapped STAGE_ID from orderMapper: "${mappedFields.STAGE_ID}"`);

  // ✅ CRITICAL: Force update STAGE_ID based on refund/cancel status
  // Priority: cancelled_at (HIGHEST) > cancelled > full refund > partial refund
  // ✅ FIX: Use category prefix in STAGE_ID (e.g., C2:LOSE, C8:LOSE)
  const loseStage = categoryId === '0' ? 'LOSE' : `C${categoryId}:LOSE`;
  const preparationStage = categoryId === '0' ? 'PREPARATION' : `C${categoryId}:PREPARATION`;

  if (hasCancelledAt) {
    correctStageId = loseStage;
    correctPaymentStatus = '58'; // Unpaid
    console.log(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ ORDER CANCELLED (cancelled_at is set) → FORCING STAGE_ID to ${loseStage} for order ${shopifyOrderId}`);
  } else if (isCancelled) {
    correctStageId = loseStage;
    correctPaymentStatus = '58'; // Unpaid
    console.log(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ FORCING STAGE_ID to ${loseStage} for cancelled order ${shopifyOrderId}`);
  } else if (isFullRefund) {
    correctStageId = loseStage;
    correctPaymentStatus = '58'; // Unpaid
    console.log(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ FORCING STAGE_ID to ${loseStage} for full refund order ${shopifyOrderId}`);
  } else if (isPartialRefund) {
    correctStageId = preparationStage;
    correctPaymentStatus = '60'; // 10% prepayment (частичная оплата)
    console.log(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ FORCING STAGE_ID to ${preparationStage} for partial refund order ${shopifyOrderId}`);
  }

  console.log(`[SHOPIFY WEBHOOK] 🔍 Final correctStageId: "${correctStageId}"`);
  console.log(`[SHOPIFY WEBHOOK] 🔍 Final correctPaymentStatus: "${correctPaymentStatus}"`);
  console.log(`[SHOPIFY WEBHOOK] 🔍 Current deal stage: "${currentStageId}"`);
  console.log(`[SHOPIFY WEBHOOK] 🔍 Will update to stage: "${correctStageId}" (${correctStageId !== currentStageId ? 'CHANGE' : 'NO CHANGE'})`);

  // 2. Prepare update fields - always update to ensure sync
  // ✅ Use mapped fields to ensure consistency with create logic, BUT override STAGE_ID with correct value
  const fields = {
    TITLE: mappedFields.TITLE, // ✅ Sync Shopify order name (e.g. #2601) to Bitrix
    OPPORTUNITY: mappedFields.OPPORTUNITY,
    STAGE_ID: correctStageId, // ✅ Use corrected stage ID
    UF_CRM_1739183959976: correctPaymentStatus, // ✅ Use corrected payment status
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

  // ✅ ADDRESS SYNC: Shopify → Bitrix (only for UNFULFILLED orders)
  // Once order is fulfilled, address shouldn't change
  const fulfillmentStatus = order?.fulfillment_status || '';
  const isFulfilled = fulfillmentStatus === 'fulfilled';

  if (!isFulfilled && order?.shipping_address && typeof order.shipping_address === 'object' && !Array.isArray(order.shipping_address)) {
    const addr = order.shipping_address;
    // Build Bitrix address string format: "Street, ZIP City Region, Country"
    const addressParts = [];
    if (addr.address1) addressParts.push(addr.address1);
    if (addr.address2) addressParts.push(addr.address2);

    const cityParts = [];
    if (addr.zip) cityParts.push(addr.zip);
    if (addr.city) cityParts.push(addr.city);
    if (addr.province) cityParts.push(addr.province);

    let bitrixAddress = addressParts.join(', ');
    if (cityParts.length > 0) {
      bitrixAddress += (bitrixAddress ? ', ' : '') + cityParts.join(' ');
    }
    if (addr.country) {
      bitrixAddress += (bitrixAddress ? ', ' : '') + addr.country;
    }

    if (bitrixAddress.trim()) {
      fields.UF_CRM_1742037435676 = bitrixAddress;
      console.log(`[SHOPIFY WEBHOOK] 📍 Address synced to Bitrix: "${bitrixAddress}"`);
    }
  } else if (isFulfilled) {
    console.log(`[SHOPIFY WEBHOOK] 📍 Address sync skipped (order is ${fulfillmentStatus})`);
  }

  // ✅ CONTACT SYNC: Ensure Deal is linked to the correct Contact (updates if email changed)
  try {
    const webhookUrl = getBitrixWebhookBase();
    const contactId = await upsertBitrixContact(webhookUrl, order);
    if (contactId) {
      fields.CONTACT_ID = contactId;
      console.log(`[SHOPIFY WEBHOOK] 👤 Linked Contact ID ${contactId} to Deal ${dealId}`);
    }
  } catch (contactError) {
    console.warn(`[SHOPIFY WEBHOOK] ⚠️ Failed to sync Contact during update: ${contactError.message}`);
  }

  // Note: CATEGORY_ID is immutable after creation, so we don't update it

  // ✅ OPTIMIZED: Compare fields to detect actual changes
  const fieldsToUpdate = {};
  let tempHasChanges = false;

  // Helper to normalize values for comparison
  const normalize = (val) => val === null || val === undefined ? '' : String(val).trim();

  // Check TITLE
  if (normalize(deal.TITLE) !== normalize(fields.TITLE)) {
    fieldsToUpdate.TITLE = fields.TITLE;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: TITLE "${deal.TITLE}" -> "${fields.TITLE}"`);
    tempHasChanges = true;
  }

  // Check OPPORTUNITY (as number)
  if (Number(deal.OPPORTUNITY || 0) !== Number(fields.OPPORTUNITY || 0)) {
    fieldsToUpdate.OPPORTUNITY = fields.OPPORTUNITY;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: OPPORTUNITY ${deal.OPPORTUNITY} -> ${fields.OPPORTUNITY}`);
    tempHasChanges = true;
  }

  // ⚠️ NOTE: CATEGORY_ID cannot be changed via crm.deal.update API in Bitrix!
  // Deals remain in their original funnel. To move, you need to recreate the deal.
  // We log this but DO NOT attempt to update CATEGORY_ID to prevent infinite loops.
  if (fields.CATEGORY_ID !== undefined && Number(deal.CATEGORY_ID) !== Number(fields.CATEGORY_ID)) {
    console.log(`[SHOPIFY WEBHOOK] ⚠️ CATEGORY_ID mismatch detected: Deal is in ${deal.CATEGORY_ID}, order suggests ${fields.CATEGORY_ID}. Bitrix does NOT allow changing CATEGORY_ID via update. Deal stays in original funnel.`);
    // DO NOT add to fieldsToUpdate - this would cause infinite loops!
  }

  // Check STAGE_ID - IMPORTANT: Use the deal's CURRENT category for stage prefix!
  // If deal is in Category 2, we must use C2:xxx stages, not C8:xxx
  if (deal.STAGE_ID !== undefined) {
    // Strip Bitrix category prefix for comparison
    const normalizeStage = (val) => String(val || '').replace(/^C\d+:/, '').trim();

    const currentBitrixStage = normalizeStage(deal.STAGE_ID);
    const newStage = normalizeStage(fields.STAGE_ID);

    if (currentBitrixStage !== newStage) {
      // Use the deal's CURRENT category for stage prefix, NOT the calculated one!
      const currentCategoryId = Number(deal.CATEGORY_ID);
      const correctedStageId = currentCategoryId > 0 ? `C${currentCategoryId}:${newStage}` : newStage;

      fieldsToUpdate.STAGE_ID = correctedStageId;
      console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: STAGE_ID "${currentBitrixStage}" (raw: ${deal.STAGE_ID}) -> "${newStage}" (corrected to: ${correctedStageId})`);
      tempHasChanges = true;
    }
  }

  // Check Payment Status
  if (normalize(deal.UF_CRM_1739183959976) !== normalize(fields.UF_CRM_1739183959976)) {
    fieldsToUpdate.UF_CRM_1739183959976 = fields.UF_CRM_1739183959976;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: Payment Status "${deal.UF_CRM_1739183959976}" -> "${fields.UF_CRM_1739183959976}"`);
    tempHasChanges = true;
  }

  // Check Order Total
  if (Number(deal.UF_CRM_1741634415367 || 0) !== Number(fields.UF_CRM_1741634415367 || 0)) {
    fieldsToUpdate.UF_CRM_1741634415367 = fields.UF_CRM_1741634415367;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: Order Total ${deal.UF_CRM_1741634415367} -> ${fields.UF_CRM_1741634415367}`);
    tempHasChanges = true;
  }

  // Check Paid Amount
  if (Number(deal.UF_CRM_1741634439258 || 0) !== Number(fields.UF_CRM_1741634439258 || 0)) {
    fieldsToUpdate.UF_CRM_1741634439258 = fields.UF_CRM_1741634439258;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: Paid Amount ${deal.UF_CRM_1741634439258} -> ${fields.UF_CRM_1741634439258}`);
    tempHasChanges = true;
  }

  // Check Delivery Price
  if (fields.UF_CRM_67BEF8B2AA721 !== undefined && Number(deal.UF_CRM_67BEF8B2AA721 || 0) !== Number(fields.UF_CRM_67BEF8B2AA721 || 0)) {
    fieldsToUpdate.UF_CRM_67BEF8B2AA721 = fields.UF_CRM_67BEF8B2AA721;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: Delivery Price ${deal.UF_CRM_67BEF8B2AA721} -> ${fields.UF_CRM_67BEF8B2AA721}`);
    tempHasChanges = true;
  }

  // Check Delivery Method
  if (fields.UF_CRM_1739183302609 !== undefined && normalize(deal.UF_CRM_1739183302609) !== normalize(fields.UF_CRM_1739183302609)) {
    fieldsToUpdate.UF_CRM_1739183302609 = fields.UF_CRM_1739183302609;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: Delivery Method "${deal.UF_CRM_1739183302609}" -> "${fields.UF_CRM_1739183302609}"`);
    tempHasChanges = true;
  }

  // Check Order Type
  if (fields.UF_CRM_1739183268662 !== undefined && normalize(deal.UF_CRM_1739183268662) !== normalize(fields.UF_CRM_1739183268662)) {
    fieldsToUpdate.UF_CRM_1739183268662 = fields.UF_CRM_1739183268662;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: Order Type "${deal.UF_CRM_1739183268662}" -> "${fields.UF_CRM_1739183268662}"`);
    tempHasChanges = true;
  }

  // Check Shipping Address
  if (fields.UF_CRM_1742037435676 !== undefined) {
    // ✅ FIX: Strip Bitrix technical suffix (e.g., "|;|2736") before comparing
    const currentBitrixAddr = normalize(deal.UF_CRM_1742037435676).split('|;|')[0].trim();
    const newShopifyAddr = normalize(fields.UF_CRM_1742037435676).trim();

    if (currentBitrixAddr !== newShopifyAddr) {
      fieldsToUpdate.UF_CRM_1742037435676 = fields.UF_CRM_1742037435676;
      console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: Shipping Address "${currentBitrixAddr}" (raw: ${deal.UF_CRM_1742037435676}) -> "${newShopifyAddr}"`);
      tempHasChanges = true;
    }
  }

  // Check Contact ID
  if (fields.CONTACT_ID !== undefined && normalize(deal.CONTACT_ID) !== normalize(fields.CONTACT_ID)) {
    fieldsToUpdate.CONTACT_ID = fields.CONTACT_ID;
    console.log(`[SHOPIFY WEBHOOK] 📝 Change detected: CONTACT_ID "${deal.CONTACT_ID}" -> "${fields.CONTACT_ID}"`);
    tempHasChanges = true;
  }

  if (tempHasChanges) {
    console.log(`[SHOPIFY WEBHOOK] ⚡ Updating deal ${dealId} with changed fields:`, Object.keys(fieldsToUpdate));
    try {
      const updateResponse = await callBitrix('/crm.deal.update.json', {
        id: dealId,
        fields: fieldsToUpdate,
      });

      console.log(`[SHOPIFY WEBHOOK] ✅ Bitrix API response:`, JSON.stringify(updateResponse, null, 2));

      if (updateResponse && updateResponse.error) {
        console.error(`[SHOPIFY WEBHOOK] ❌ Bitrix API ERROR:`, updateResponse.error);
        console.error(`[SHOPIFY WEBHOOK] ❌ Error details:`, updateResponse.error_description);
      } else {
        console.log(`[SHOPIFY WEBHOOK] ✅ Deal ${dealId} updated successfully`);

        // Set provenance marker ONLY if we actually updated something
        try {
          const correlationId = `shopify-webhook-${Date.now()}`;
          if (shopifyOrderId) {
            await setProvenanceMarker(shopifyOrderId, correlationId, 'deal_update_from_shopify', null, 'shopify');
            console.log(`[SHOPIFY WEBHOOK] ✅ Provenance marker set (source: shopify) for order ${shopifyOrderId}`);
          }
        } catch (pmErr) {
          console.warn(`[SHOPIFY WEBHOOK] ⚠️ Failed to set provenance marker: ${pmErr.message}`);
        }
      }
    } catch (error) {
      console.error(`[SHOPIFY WEBHOOK] ❌ Error updating deal ${dealId}:`, error);
      console.warn(`[SHOPIFY WEBHOOK] ⚠️ Continuing to update product rows despite deal update error`);
    }
  } else {
    console.log(`[SHOPIFY WEBHOOK] 💤 No differences detected between Shopify order and Bitrix deal. Skipping update to prevent loops.`);
  }

  // Verify updated deal (only if update succeeded)
  let verifiedDeal = null;
  try {
    verifiedDeal = await verifyDeal(dealId);
    if (verifiedDeal) {
      console.log(`[SHOPIFY WEBHOOK] ✅ Deal verified after update:`, {
        ID: verifiedDeal.ID,
        TITLE: verifiedDeal.TITLE,
        OPPORTUNITY: verifiedDeal.OPPORTUNITY,
        STAGE_ID: verifiedDeal.STAGE_ID
      });
    }
  } catch (verifyError) {
    console.warn(`[SHOPIFY WEBHOOK] ⚠️ Could not verify deal after update:`, verifyError);
  }

  // 4. ✅ CONDITIONAL UPDATE: Product rows (including shipping)
  // ✅ Use productRows from mapShopifyOrderToBitrixDeal
  const productRows = mappedProductRows || [];
  let rowsChanged = false;

  console.log(`[SHOPIFY WEBHOOK] 📦 Checking if product rows need update for deal ${dealId}...`);
  console.log(`  - New product rows count: ${productRows.length}`);

  if (order.line_items && order.line_items.length > 0) {
    const totalQuantity = order.line_items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const totalCurrentQuantity = order.line_items.reduce((sum, item) => sum + (Number(item.current_quantity ?? item.quantity) || 0), 0);
    if (totalQuantity !== totalCurrentQuantity) {
      console.log(`  - ⚠️ INFO: Some items were refunded/removed (${totalQuantity - totalCurrentQuantity} items difference)`);
    }
  }

  // Fetch existing rows to compare
  try {
    const existingRowsResp = await callBitrix('/crm.deal.productrows.get.json', { id: dealId });
    const existingRows = existingRowsResp.result || [];

    if (existingRows.length !== productRows.length) {
      rowsChanged = true;
      console.log(`[SHOPIFY WEBHOOK] 📝 Row count changed: ${existingRows.length} -> ${productRows.length}`);
    } else {
      // Compare rows one by one
      // We assume the mapper generates rows in a consistent order (usually alphabetical or by line item index)
      // Bitrix returns rows in the order they were saved.
      for (let i = 0; i < productRows.length; i++) {
        const newRow = productRows[i];
        // Bitrix returns fields like PRICE, QUANTITY, PRODUCT_ID, PRODUCT_NAME
        const oldRow = existingRows[i];

        const newId = String(newRow.PRODUCT_ID || 0);
        const oldId = String(oldRow.PRODUCT_ID || 0);

        // Compare values with some tolerance for floats
        const newPrice = Number(newRow.PRICE || 0);
        const oldPrice = Number(oldRow.PRICE || 0);

        const newQuant = Number(newRow.QUANTITY || 0);
        const oldQuant = Number(oldRow.QUANTITY || 0);

        if (newId !== oldId) {
          rowsChanged = true;
          console.log(`[SHOPIFY WEBHOOK] 📝 Row ${i + 1} ID changed: ${oldId} -> ${newId}`);
          break;
        }

        if (Math.abs(newPrice - oldPrice) > 0.01) {
          rowsChanged = true;
          console.log(`[SHOPIFY WEBHOOK] 📝 Row ${i + 1} Price changed: ${oldPrice} -> ${newPrice}`);
          break;
        }

        if (newQuant !== oldQuant) {
          rowsChanged = true;
          console.log(`[SHOPIFY WEBHOOK] 📝 Row ${i + 1} Quantity changed: ${oldQuant} -> ${newQuant}`);
          break;
        }

        // For custom products (ID=0), check name
        if (newId === '0') {
          const newName = String(newRow.PRODUCT_NAME || '').trim();
          const oldName = String(oldRow.PRODUCT_NAME || '').trim();
          if (newName !== oldName) {
            rowsChanged = true;
            console.log(`[SHOPIFY WEBHOOK] 📝 Row ${i + 1} Name changed: "${oldName}" -> "${newName}"`);
            break;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[SHOPIFY WEBHOOK] ⚠️ Failed to fetch existing product rows for comparison, forcing update:`, err);
    rowsChanged = true;
  }

  // ✅ Update product rows ONLY if changed
  if (rowsChanged) {
    if (productRows.length > 0) {
      try {
        console.log(`[SHOPIFY WEBHOOK] ⚡ Updating ${productRows.length} product rows for deal ${dealId} via crm.deal.productrows.set.json`);
        // console.log(`[SHOPIFY WEBHOOK]   First product row:`, JSON.stringify(productRows[0], null, 2));

        const productRowsResp = await callBitrix('/crm.deal.productrows.set.json', {
          id: dealId, // ✅ dealId is now a number, not a string
          rows: productRows,
        });

        if (productRowsResp.result === true || productRowsResp.result) {
          console.log(`[SHOPIFY WEBHOOK] ✅ Product rows successfully updated for deal ${dealId}`);
          // Log which products were linked
          productRows.forEach((row, idx) => {
            if (row.PRODUCT_ID) {
              console.log(`[SHOPIFY WEBHOOK]   Row ${idx + 1}: PRODUCT_ID=${row.PRODUCT_ID} (linked to catalog) ✅`);
            } else if (row.PRODUCT_NAME) {
              console.log(`[SHOPIFY WEBHOOK]   Row ${idx + 1}: PRODUCT_NAME="${row.PRODUCT_NAME}" (custom row, NOT linked) ⚠️`);
            }
          });

          // Verify rows after set (optional, maybe skip to save API calls)
        } else {
          console.error(`[SHOPIFY WEBHOOK] ⚠️ Product rows update returned unexpected result:`, productRowsResp);
        }
      } catch (productRowsError) {
        console.error(`[SHOPIFY WEBHOOK] ❌ Failed to update product rows for deal ${dealId}:`, productRowsError);
        console.error(`[SHOPIFY WEBHOOK] Error details:`, {
          message: productRowsError.message,
          dealId: dealId,
          dealIdType: typeof dealId,
          productRowsCount: productRows.length
        });
      }
    } else {
      // If no product rows (e.g., all items removed/refunded), clear rows
      // This branch (rowsChanged=true && productRows.length=0) implies we had rows before but now don't
      // ... same clear logic as before ...
    }
  } else {
    console.log(`[SHOPIFY WEBHOOK] 💤 Product rows unchanged. Skipping update.`);
  }

  // Handling the case where rowsChanged is true but length is 0 (clearing rows)
  if (rowsChanged && productRows.length === 0) { // logic continued... else {
    // If no product rows (e.g., all items removed/refunded), clear rows to keep Bitrix in sync
    console.log(`[SHOPIFY WEBHOOK] ⚠️ No product rows to update (all items may be refunded/removed). Clearing product rows in Bitrix.`);
    try {
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId, // ✅ dealId is now a number, not a string
        rows: [],
      });
      console.log(`[SHOPIFY WEBHOOK] ✅ Product rows cleared for deal ${dealId} (no active items)`);
      try {
        const rowsVerify = await callBitrix('/crm.deal.productrows.get.json', { id: dealId });
        console.log(`[SHOPIFY WEBHOOK] ✅ Product rows verification after clear for deal ${dealId}:`, rowsVerify?.result || rowsVerify);
      } catch (verifyErr) {
        console.warn(`[SHOPIFY WEBHOOK] ⚠️ Could not verify product rows after clear for deal ${dealId}:`, verifyErr);
      }
    } catch (clearError) {
      console.error(`[SHOPIFY WEBHOOK] ⚠️ Failed to clear product rows:`, clearError);
    }
  }

  // ✅ Store successful update operation (dealId is number, not string)
  try {
    successAdapter.storeOperation({
      operationType: 'UPDATE',
      dealId: dealId, // ✅ Number, not string
      shopifyOrderId: shopifyOrderId,
      shopifyOrderName: order.name,
      dealData: verifiedDeal || {
        ID: String(dealId), // Bitrix returns ID as string in API, but we use number for API calls
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

// =============================================================================
// GLOBAL LOCK for Duplicate Prevention
// =============================================================================
const processingOrders = new Set();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    console.log(`[SHOPIFY WEBHOOK] ❌ Method not allowed: ${req.method}`);
    res.status(405).end('Method not allowed');
    return;
  }

  const log = (msg, data = null) => {
    const ts = new Date().toISOString();
    if (data) {
      console.log(`[${ts}] [SHOPIFY WEBHOOK] ${msg}`, JSON.stringify(data, null, 2));
    } else {
      console.log(`[${ts}] [SHOPIFY WEBHOOK] ${msg}`);
    }
  };

  log('===== INCOMING REQUEST =====');
  log(`Method: ${req.method}`);
  log(`Headers:`, req.headers);

  let topic = req.headers['x-shopify-topic'];
  const order = req.body;

  log(`Topic: ${topic}`);
  log(`Order ID: ${order?.id}`);
  log(`Order Name: ${order?.name}`);

  // ✅ DUPLICATE PREVENTION LOCK
  const shopifyOrderId = String(order.id);
  if (processingOrders.has(shopifyOrderId)) {
    log(`⚠️⚠️⚠️ DROPPING REQUEST: Order ${shopifyOrderId} is already being processed! (Lock active)`);
    return res.status(200).json({ success: true, skipped: 'locked_processing' });
  }

  processingOrders.add(shopifyOrderId);
  log(`🔒 Acquired lock for order ${shopifyOrderId}`);

  try {
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

    // ✅ CRITICAL: Detect cancellation/refund FIRST (must sync to Bitrix LOSE regardless of loop guard)
    const financialStatusForGuard = (order?.financial_status || '').toLowerCase();
    const cancelledAtForGuard = order?.cancelled_at;
    const isCancelledOrRefunded =
      financialStatusForGuard === 'cancelled' ||
      financialStatusForGuard === 'voided' ||
      financialStatusForGuard === 'refunded' ||
      (cancelledAtForGuard !== null && cancelledAtForGuard !== undefined && cancelledAtForGuard !== '');

    if (isCancelledOrRefunded) {
      console.log(`[SHOPIFY WEBHOOK] ⚠️⚠️⚠️ CANCELLATION/REFUND DETECTED - BYPASSING LOOP GUARD!`);
      console.log(`[SHOPIFY WEBHOOK]   - financial_status: ${financialStatusForGuard}`);
      console.log(`[SHOPIFY WEBHOOK]   - cancelled_at: ${cancelledAtForGuard || 'N/A'}`);
      console.log(`[SHOPIFY WEBHOOK]   - Order ${order?.name || order?.id} will be processed to sync LOSE stage to Bitrix`);
    }

    // ✅ CRITICAL: Check if this is a technical order or Bitrix-updated order (should not be sent to Bitrix)
    // Technical orders are created FROM Bitrix to reserve inventory, so they should not create deals IN Bitrix
    // BitrixUpdated orders were updated FROM Bitrix, so webhook from this update should not go back to Bitrix (loop guard)
    // Orders with BITRIX:{dealId} tag are created FROM Bitrix, so they should not create deals IN Bitrix
    // ⚠️ EXCEPTION: Cancelled/refunded orders ALWAYS bypass loop guard to sync LOSE stage
    // Handle tags as either array or comma-separated string (Shopify webhook may return both formats)
    const orderTags = Array.isArray(order?.tags)
      ? order.tags
      : (order?.tags ? String(order.tags).split(',').map(t => t.trim()) : []);
    const isBitrixOrder = orderTags.some(tag => String(tag).startsWith('BITRIX:'));
    const isBitrixUpdated = orderTags.includes('BitrixUpdated');

    // ✅ MODIFIED: Only skip if NOT a cancellation/refund
    if ((isBitrixOrder || isBitrixUpdated) && !isCancelledOrRefunded) {
      const skipReason = isBitrixOrder
        ? 'Order created from Bitrix (BITRIX:{dealId} tag) - not sent to Bitrix'
        : 'Bitrix-updated order (BitrixUpdated tag) - loop guard, not sent to Bitrix';

      console.log(`[SHOPIFY WEBHOOK] 🔧 SKIPPING: ${isBitrixOrder ? 'Bitrix-created' : 'Bitrix-updated'} order detected (tags: ${orderTags.join(', ')}). Order ${order?.name || order?.id} will NOT be sent to Bitrix.`);
      if (isBitrixOrder) {
        console.log(`[SHOPIFY WEBHOOK] This order was created from Bitrix. It should not create a deal in Bitrix.`);
      } else {
        console.log(`[SHOPIFY WEBHOOK] This order was updated from Bitrix. Webhook from this update should not go back to Bitrix to prevent loop.`);
      }

      // Store event for monitoring (non-blocking) even though we skip Bitrix
      try {
        const storedEvent = shopifyAdapter.storeEvent(order, topic);
        console.log(`[SHOPIFY WEBHOOK] ✅ Event stored (skipped). Topic: ${topic}, Order: ${order.name || order.id}, EventId: ${storedEvent.id}`);
      } catch (storeError) {
        console.error('[SHOPIFY WEBHOOK] ⚠️ Failed to store event (non-blocking):', storeError);
      }

      // Return 200 to prevent Shopify from retrying
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: skipReason,
        orderId: order?.id,
        orderName: order?.name,
        tags: orderTags
      });
    } else if ((isBitrixOrder || isBitrixUpdated) && isCancelledOrRefunded) {
      console.log(`[SHOPIFY WEBHOOK] ✅ LOOP GUARD BYPASSED: Order ${order?.name || order?.id} is cancelled/refunded, must sync LOSE stage to Bitrix`);
    }

    // ✅ CRITICAL: Check provenance marker (middleware.last_write) to prevent loop
    // If order was last updated by Bitrix (source: 'bitrix'), skip sending webhook back to Bitrix
    try {
      const shopifyOrderId = String(order.id);
      const provenanceResult = await getProvenanceMarker(shopifyOrderId);

      if (provenanceResult.success && provenanceResult.exists && provenanceResult.value) {
        const provenanceValue = provenanceResult.value;
        const lastSource = provenanceValue.source;

        // If last write was from Bitrix, skip to prevent loop
        // ⚠️ EXCEPTION: Cancelled/refunded orders ALWAYS bypass loop guard to sync LOSE stage
        if (lastSource === 'bitrix' && !isCancelledOrRefunded) {
          const skipReason = `Provenance marker indicates last update was from Bitrix (source: ${lastSource}, action: ${provenanceValue.action || 'unknown'}) - loop guard, not sent to Bitrix`;

          console.log(`[SHOPIFY WEBHOOK] 🔧 SKIPPING: Provenance marker detected. Order ${order?.name || order?.id} was last updated by Bitrix. Will NOT be sent to Bitrix.`);
          console.log(`[SHOPIFY WEBHOOK] Provenance details:`, {
            source: lastSource,
            action: provenanceValue.action,
            correlationId: provenanceValue.correlationId,
            timestamp: provenanceValue.ts
          });

          // Store event for monitoring (non-blocking) even though we skip Bitrix
          try {
            const storedEvent = shopifyAdapter.storeEvent(order, topic);
            console.log(`[SHOPIFY WEBHOOK] ✅ Event stored (skipped). Topic: ${topic}, Order: ${order.name || order.id}, EventId: ${storedEvent.id}`);
          } catch (storeError) {
            console.error('[SHOPIFY WEBHOOK] ⚠️ Failed to store event (non-blocking):', storeError);
          }

          // Return 200 to prevent Shopify from retrying
          return res.status(200).json({
            success: true,
            skipped: true,
            reason: skipReason,
            orderId: order?.id,
            orderName: order?.name,
            provenance: provenanceValue
          });
        } else if (lastSource === 'bitrix' && isCancelledOrRefunded) {
          console.log(`[SHOPIFY WEBHOOK] ✅ PROVENANCE LOOP GUARD BYPASSED: Order ${order?.name || order?.id} is cancelled/refunded, must sync LOSE stage to Bitrix`);
        }
      }
    } catch (provenanceError) {
      // Non-blocking: if provenance check fails, continue with normal flow
      console.warn(`[SHOPIFY WEBHOOK] ⚠️ Provenance marker check failed (non-blocking):`, provenanceError.message);
    }

    // ✅ CRITICAL: Log financial_status and cancellation/refund status for debugging
    const financialStatus = order?.financial_status || 'N/A';
    const statusLower = financialStatus?.toLowerCase() || '';
    const isCancelled = statusLower === 'cancelled' || statusLower === 'voided';
    const isRefunded = statusLower === 'refunded';
    const isLost = isCancelled || isRefunded;
    console.log(`[SHOPIFY WEBHOOK] ⚠️ Financial Status: ${financialStatus} ${isLost ? `(${isCancelled ? 'CANCELLED/VOIDED' : 'REFUNDED'} - should update to LOSE)` : ''}`);

    console.log(`[SHOPIFY WEBHOOK] Order Data Summary:`, {
      id: order?.id,
      name: order?.name,
      total_price: order?.total_price,
      current_total_price: order?.current_total_price,
      financial_status: financialStatus,
      cancelled: isCancelled,
      line_items_count: order?.line_items?.length || 0,
      tags: orderTags,
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
      let dealId = null;
      try {
        if (topic === 'orders/create') {
          console.log(`[SHOPIFY WEBHOOK] 🔄 Processing orders/create event...`);
          dealId = await handleOrderCreated(order);
          console.log(`[SHOPIFY WEBHOOK] ✅ Successfully processed orders/create event. Deal ID: ${dealId || 'N/A'}`);
        } else if (topic === 'orders/updated') {
          console.log(`[SHOPIFY WEBHOOK] 🔄 Processing orders/updated event...`);
          dealId = await handleOrderUpdated(order);
          console.log(`[SHOPIFY WEBHOOK] ✅ Successfully processed orders/updated event. Deal ID: ${dealId || 'N/A'}`);
        } else if (topic === 'orders/cancelled' || topic === 'orders/cancel') {
          // ✅ Handle cancellation as a special update event
          console.log(`[SHOPIFY WEBHOOK] 🔄 Processing orders/cancelled event...`);
          console.log(`[SHOPIFY WEBHOOK] ⚠️ Cancellation webhook received - treating as update with cancelled status`);
          dealId = await handleOrderUpdated(order);
          console.log(`[SHOPIFY WEBHOOK] ✅ Successfully processed orders/cancelled event. Deal ID: ${dealId || 'N/A'}`);
        } else {
          // For other topics just log and return 200 (don't block)
          console.log(`[SHOPIFY WEBHOOK] ⚠️ Unhandled topic: ${topic}, skipping Bitrix processing`);
        }

        res.status(200).end('OK');
      } catch (handlerError) {
        // ✅ CRITICAL: Log detailed error information
        console.error(`[SHOPIFY WEBHOOK] ❌❌❌ CRITICAL ERROR in handler for topic "${topic}":`, handlerError);
        console.error(`[SHOPIFY WEBHOOK] Error type: ${handlerError.errorType || 'UNKNOWN'}`);
        console.error(`[SHOPIFY WEBHOOK] Error message: ${handlerError.message}`);
        console.error(`[SHOPIFY WEBHOOK] Error stack:`, handlerError.stack);
        console.error(`[SHOPIFY WEBHOOK] Order details:`, {
          id: order?.id,
          name: order?.name,
          financial_status: order?.financial_status,
          total_price: order?.total_price,
          line_items_count: order?.line_items?.length || 0
        });
        console.error(`[SHOPIFY WEBHOOK] Error details:`, {
          errorType: handlerError.errorType,
          errorDetails: handlerError.errorDetails,
          errorCode: handlerError.code,
          shopifyOrderId: order?.id
        });

        // Still return 200 to prevent Shopify from retrying (we'll handle errors internally)
        // But log extensively for debugging
        res.status(200).json({
          success: false,
          error: handlerError.message,
          errorType: handlerError.errorType || 'UNKNOWN',
          orderId: order?.id,
          topic: topic
        });
        return;
      }
    } catch (e) {
      // Outer catch for unexpected errors
      console.error('[SHOPIFY WEBHOOK] ❌❌❌ UNEXPECTED ERROR:', e);
      console.error('[SHOPIFY WEBHOOK] Error details:', {
        message: e.message,
        stack: e.stack,
        topic: topic,
        orderId: order?.id,
        orderName: order?.name
      });
      // Return 200 to prevent Shopify retries, but log error
      res.status(200).json({
        success: false,
        error: 'Unexpected error',
        message: e.message,
        topic: topic
      });
    }
  } finally {
    // ✅ Release Lock
    if (shopifyOrderId && processingOrders.has(shopifyOrderId)) {
      processingOrders.delete(shopifyOrderId);
      log(`🔓 Released lock for order ${shopifyOrderId}`);
    }
  }
}
