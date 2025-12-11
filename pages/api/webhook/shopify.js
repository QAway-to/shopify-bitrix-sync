// Shopify Webhook endpoint
import { shopifyAdapter } from '../../../src/lib/adapters/shopify/index.js';
import { callBitrix, getBitrixWebhookBase } from '../../../src/lib/bitrix/client.js';
import { mapShopifyOrderToBitrixDeal } from '../../../src/lib/bitrix/orderMapper.js';
import { upsertBitrixContact } from '../../../src/lib/bitrix/contact.js';

// Configure body parser to accept raw JSON
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

/**
 * Handle order created event - create deal in Bitrix
 */
async function handleOrderCreated(order) {
  console.log(`[SHOPIFY WEBHOOK] Handling order created: ${order.name || order.id}`);

  // Map order to Bitrix deal
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

  // 1. Create deal
  const dealAddResp = await callBitrix('/crm.deal.add.json', {
    fields: dealFields,
  });

  if (!dealAddResp.result) {
    throw new Error(`Failed to create deal: ${JSON.stringify(dealAddResp)}`);
  }

  const dealId = dealAddResp.result;
  console.log(`[SHOPIFY WEBHOOK] Deal created: ${dealId}`);

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

  // 1. Find deal by UF_SHOPIFY_ORDER_ID
  const listResp = await callBitrix('/crm.deal.list.json', {
    filter: { 'UF_SHOPIFY_ORDER_ID': shopifyOrderId },
    select: ['ID', 'OPPORTUNITY', 'STAGE_ID'],
  });

  const deal = listResp.result?.[0];
  if (!deal) {
    console.log(`[SHOPIFY WEBHOOK] Deal not found for Shopify order ${shopifyOrderId}`);
    return;
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
  if (req.method !== 'POST') {
    res.status(405).end('Method not allowed');
    return;
  }

  const topic = req.headers['x-shopify-topic'];
  const order = req.body;

  try {
    // Store event for monitoring (non-blocking)
    try {
      const storedEvent = shopifyAdapter.storeEvent(order);
      console.log(`[SHOPIFY WEBHOOK] Event stored. Topic: ${topic}, Order: ${order.name || order.id}`);
    } catch (storeError) {
      console.error('[SHOPIFY WEBHOOK] Failed to store event:', storeError);
    }

    if (topic === 'orders/create') {
      await handleOrderCreated(order);
    } else if (topic === 'orders/updated') {
      await handleOrderUpdated(order);
    } else {
      // For other topics just log and return 200
      console.log(`[SHOPIFY WEBHOOK] Unhandled topic: ${topic}`);
    }

    res.status(200).end('OK');
  } catch (e) {
    console.error('[SHOPIFY WEBHOOK] Error:', e);
    res.status(500).end('ERROR');
  }
}

