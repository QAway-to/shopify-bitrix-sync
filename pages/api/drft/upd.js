// Draft Order Update Webhook endpoint (Pre-order changes)
import '../../../src/lib/logging/consoleCapture.js';
import { callBitrix } from '../../../src/lib/bitrix/client.js';
import { BITRIX_CONFIG } from '../../../src/lib/bitrix/config.js';
import { shopifyAdapter } from '../../../src/lib/adapters/shopify/index.js';
import { successAdapter } from '../../../src/lib/adapters/success/index.js';

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '1mb',
        },
    },
};

export default async function handler(req, res) {
    console.log(`[DRAFT UPD WEBHOOK] Received ${req.method} request`);

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const draftOrder = req.body;

        if (!draftOrder || !draftOrder.id) {
            console.error('[DRAFT UPD WEBHOOK] Invalid draft order data');
            return res.status(400).json({ error: 'Invalid draft order data' });
        }

        const draftOrderId = String(draftOrder.id);
        console.log(`[DRAFT UPD WEBHOOK] Processing Draft Order Update: ${draftOrder.name || draftOrderId}`);

        // ✅ Store event for UI monitoring
        shopifyAdapter.storeEvent(draftOrder, 'draft_orders/update');

        // Find existing deal by DRAFT_ID
        const existingDealResp = await callBitrix('/crm.deal.list.json', {
            filter: { 'UF_CRM_1742556489': `DRAFT_${draftOrderId}` },
            select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
        });

        if (!existingDealResp.result || existingDealResp.result.length === 0) {
            console.log(`[DRAFT UPD WEBHOOK] ⚠️ No deal found for Draft Order ${draftOrderId}. Creating new deal.`);

            // Forward to create handler logic (simplified - just create the deal)
            const dealFields = {
                TITLE: `Pre-order: ${draftOrder.name || `D#${draftOrder.id}`}`,
                STAGE_ID: BITRIX_CONFIG.DEFAULT_STAGE_ID || 'NEW',
                CATEGORY_ID: BITRIX_CONFIG.DEFAULT_CATEGORY_ID || 0,
                CURRENCY_ID: draftOrder.currency || 'EUR',
                OPPORTUNITY: parseFloat(draftOrder.total_price || 0),
                UF_CRM_1742556489: `DRAFT_${draftOrder.id}`,
                COMMENTS: `Pre-order from Shopify Draft Order (created from update)\nDraft ID: ${draftOrder.id}`,
            };

            const createResp = await callBitrix('/crm.deal.add.json', { fields: dealFields });
            if (createResp.result) {
                console.log(`[DRAFT UPD WEBHOOK] ✅ Created new deal: ${createResp.result}`);
                return res.status(200).json({
                    success: true,
                    message: 'Deal created from update event',
                    dealId: createResp.result,
                    wasNew: true
                });
            } else {
                console.error(`[DRAFT UPD WEBHOOK] ❌ Failed to create deal:`, createResp);
                return res.status(500).json({ success: false, error: 'Failed to create deal' });
            }
        }

        const existingDeal = existingDealResp.result[0];
        const dealId = existingDeal.ID;
        console.log(`[DRAFT UPD WEBHOOK] Found existing deal: ${dealId}`);

        // Build update fields
        const updateFields = {
            TITLE: `Pre-order: ${draftOrder.name || `D#${draftOrder.id}`}`,
            OPPORTUNITY: parseFloat(draftOrder.total_price || 0),
        };

        // Update deal
        const updateResp = await callBitrix('/crm.deal.update.json', {
            id: dealId,
            fields: updateFields,
        });

        if (!updateResp.result) {
            console.error(`[DRAFT UPD WEBHOOK] ❌ Failed to update deal:`, updateResp);
            return res.status(500).json({ success: false, error: 'Failed to update deal' });
        }

        console.log(`[DRAFT UPD WEBHOOK] ✅ Deal updated: ${dealId}`);

        // Update product rows
        if (draftOrder.line_items && draftOrder.line_items.length > 0) {
            const productRows = draftOrder.line_items.map(item => ({
                PRODUCT_NAME: item.title || item.name || 'Pre-order Item',
                PRICE: parseFloat(item.price || 0),
                QUANTITY: parseInt(item.quantity || 1),
            }));

            try {
                await callBitrix('/crm.deal.productrows.set.json', {
                    id: dealId,
                    rows: productRows,
                });
                console.log(`[DRAFT UPD WEBHOOK] ✅ Product rows updated: ${productRows.length} items`);
            } catch (productRowsError) {
                console.error(`[DRAFT UPD WEBHOOK] ⚠️ Failed to update product rows:`, productRowsError);
            }
        }

        // ✅ Store success operation for UI monitoring
        try {
            successAdapter.storeOperation({
                operationType: 'UPDATE',
                dealId: dealId,
                shopifyOrderId: `DRAFT_${draftOrderId}`,
                shopifyOrderName: draftOrder.name || `Draft #${draftOrderId}`,
                dealData: {
                    ID: dealId,
                    TITLE: updateFields.TITLE,
                    OPPORTUNITY: updateFields.OPPORTUNITY,
                    STAGE_ID: existingDeal.STAGE_ID
                },
                verified: true,
                productRowsCount: draftOrder.line_items?.length || 0
            });
            console.log(`[DRAFT UPD WEBHOOK] ✅ Success operation stored for deal ${dealId}`);
        } catch (storeError) {
            console.error(`[DRAFT UPD WEBHOOK] ⚠️ Failed to store success operation:`, storeError);
        }

        return res.status(200).json({
            success: true,
            message: 'Pre-order deal updated',
            dealId: dealId,
            draftOrderId: draftOrderId
        });

    } catch (error) {
        console.error(`[DRAFT UPD WEBHOOK] ❌ Error:`, error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}
