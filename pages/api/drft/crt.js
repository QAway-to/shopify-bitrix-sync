// Draft Order Create Webhook endpoint (Pre-orders)
import '../../../src/lib/logging/consoleCapture.js';
import { callBitrix } from '../../../src/lib/bitrix/client.js';
import { upsertBitrixContact, getBitrixWebhookBase } from '../../../src/lib/bitrix/contact.js';
import { BITRIX_CONFIG } from '../../../src/lib/bitrix/config.js';

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '1mb',
        },
    },
};

/**
 * Map Shopify Draft Order to Bitrix Deal (Pre-order Stage)
 */
async function mapDraftOrderToBitrixDeal(draftOrder) {
    const dealFields = {
        TITLE: `Pre-order: ${draftOrder.name || `D#${draftOrder.id}`}`,
        // Pre-order stage - typically "NEW" or a custom pre-order stage
        STAGE_ID: BITRIX_CONFIG.DEFAULT_STAGE_ID || 'NEW',
        CATEGORY_ID: BITRIX_CONFIG.DEFAULT_CATEGORY_ID || 0,
        CURRENCY_ID: draftOrder.currency || 'EUR',
        OPPORTUNITY: parseFloat(draftOrder.total_price || 0),
        // Store Shopify Draft Order ID
        UF_CRM_1742556489: `DRAFT_${draftOrder.id}`,
        // Comments
        COMMENTS: `Pre-order from Shopify Draft Order\nDraft ID: ${draftOrder.id}\nStatus: ${draftOrder.status || 'open'}`,
    };

    // Customer info
    if (draftOrder.customer) {
        const customer = draftOrder.customer;
        dealFields.COMMENTS += `\n\nCustomer: ${customer.first_name || ''} ${customer.last_name || ''}\nEmail: ${customer.email || ''}`;
    }

    // Line items summary
    if (draftOrder.line_items && draftOrder.line_items.length > 0) {
        dealFields.COMMENTS += '\n\nProducts:\n';
        for (const item of draftOrder.line_items) {
            dealFields.COMMENTS += `- ${item.title || item.name || 'Unknown'} x${item.quantity} = ${item.price}\n`;
        }
    }

    // Build product rows for deal (simple version - no catalog lookup for pre-orders)
    const productRows = [];
    if (draftOrder.line_items) {
        for (const item of draftOrder.line_items) {
            productRows.push({
                PRODUCT_NAME: item.title || item.name || 'Pre-order Item',
                PRICE: parseFloat(item.price || 0),
                QUANTITY: parseInt(item.quantity || 1),
            });
        }
    }

    return { dealFields, productRows };
}

export default async function handler(req, res) {
    console.log(`[DRAFT WEBHOOK] Received ${req.method} request`);

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const draftOrder = req.body;

        if (!draftOrder || !draftOrder.id) {
            console.error('[DRAFT WEBHOOK] Invalid draft order data');
            return res.status(400).json({ error: 'Invalid draft order data' });
        }

        const draftOrderId = String(draftOrder.id);
        console.log(`[DRAFT WEBHOOK] Processing Draft Order: ${draftOrder.name || draftOrderId}`);
        console.log(`[DRAFT WEBHOOK] Data:`, JSON.stringify({
            id: draftOrder.id,
            name: draftOrder.name,
            total_price: draftOrder.total_price,
            status: draftOrder.status,
            line_items_count: draftOrder.line_items?.length || 0,
            customer: draftOrder.customer ? {
                email: draftOrder.customer.email,
                name: `${draftOrder.customer.first_name || ''} ${draftOrder.customer.last_name || ''}`
            } : null
        }, null, 2));

        // Check for existing deal with this draft order ID
        const existingDealResp = await callBitrix('/crm.deal.list.json', {
            filter: { 'UF_CRM_1742556489': `DRAFT_${draftOrderId}` },
            select: ['ID', 'TITLE'],
        });

        if (existingDealResp.result && existingDealResp.result.length > 0) {
            const existingDealId = existingDealResp.result[0].ID;
            console.log(`[DRAFT WEBHOOK] ⚠️ Deal already exists for Draft Order ${draftOrderId}: Deal ID ${existingDealId}`);
            return res.status(200).json({
                success: true,
                message: 'Deal already exists',
                dealId: existingDealId,
                wasDuplicate: true
            });
        }

        // Map draft order to deal
        const { dealFields, productRows } = await mapDraftOrderToBitrixDeal(draftOrder);

        console.log(`[DRAFT WEBHOOK] Creating deal with fields:`, JSON.stringify(dealFields, null, 2));

        // Create deal
        const dealAddResp = await callBitrix('/crm.deal.add.json', {
            fields: dealFields,
        });

        if (!dealAddResp.result) {
            console.error(`[DRAFT WEBHOOK] ❌ Failed to create deal:`, dealAddResp);
            return res.status(500).json({
                success: false,
                error: 'Failed to create deal',
                details: dealAddResp
            });
        }

        const dealId = dealAddResp.result;
        console.log(`[DRAFT WEBHOOK] ✅ Deal created: ${dealId}`);

        // Add product rows if any
        if (productRows.length > 0) {
            try {
                await callBitrix('/crm.deal.productrows.set.json', {
                    id: dealId,
                    rows: productRows,
                });
                console.log(`[DRAFT WEBHOOK] ✅ Product rows set: ${productRows.length} items`);
            } catch (productRowsError) {
                console.error(`[DRAFT WEBHOOK] ⚠️ Failed to set product rows:`, productRowsError);
            }
        }

        // Try to create/link contact
        if (draftOrder.customer && draftOrder.customer.email) {
            try {
                const bitrixBase = getBitrixWebhookBase();
                const contactId = await upsertBitrixContact(bitrixBase, {
                    customer: draftOrder.customer,
                    email: draftOrder.customer.email,
                    billing_address: draftOrder.billing_address
                });
                if (contactId) {
                    await callBitrix('/crm.deal.update.json', {
                        id: dealId,
                        fields: { CONTACT_ID: contactId }
                    });
                    console.log(`[DRAFT WEBHOOK] ✅ Contact linked: ${contactId}`);
                }
            } catch (contactError) {
                console.error(`[DRAFT WEBHOOK] ⚠️ Contact upsert failed:`, contactError);
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Pre-order deal created',
            dealId: dealId,
            draftOrderId: draftOrderId,
            draftOrderName: draftOrder.name
        });

    } catch (error) {
        console.error(`[DRAFT WEBHOOK] ❌ Error:`, error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}
