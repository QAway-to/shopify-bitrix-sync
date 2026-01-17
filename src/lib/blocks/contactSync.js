/**
 * Contact Sync Block Handler
 * Syncs contact data (email, phone, name) from Bitrix deal to Shopify order
 * 
 * Trigger: ONCRMDEALUPDATE when shopifyOrderId exists and contact changed
 * 
 * Flow:
 * 1. Get contact from Bitrix deal
 * 2. Get current Shopify order
 * 3. Compare email/phone/name
 * 4. Update Shopify order if different
 */

import { getOrder, updateOrder } from '../shopify/adminClient.js';
import { callBitrix } from '../bitrix/client.js';

const BITRIX_FALLBACK_EMAIL = 'hold@bfcshoes.local';

/**
 * Extract contact data from Bitrix deal
 * @param {Object} dealData - Deal data from Bitrix
 * @returns {Promise<{email: string|null, phone: string|null, firstName: string|null, lastName: string|null, contactId: string|null}>}
 */
export async function getBitrixContactData(dealData) {
    const contactIdRaw = dealData?.CONTACT_ID || dealData?.contact_id || null;
    const contactId = contactIdRaw && String(contactIdRaw) !== '0' ? String(contactIdRaw) : null;

    if (!contactId) {
        return { email: null, phone: null, firstName: null, lastName: null, contactId: null };
    }

    try {
        const contactResp = await callBitrix('/crm.contact.get.json', { id: contactId });
        const contact = contactResp?.result || null;

        if (!contact) {
            return { email: null, phone: null, firstName: null, lastName: null, contactId };
        }

        // Extract email
        const emailRaw = contact.EMAIL;
        const emailValue = Array.isArray(emailRaw) ? emailRaw?.[0]?.VALUE : (emailRaw?.VALUE || emailRaw);
        const email = emailValue && String(emailValue).trim() !== '' ? String(emailValue).trim() : null;

        // Extract phone
        const phoneRaw = contact.PHONE;
        const phoneValue = Array.isArray(phoneRaw) ? phoneRaw?.[0]?.VALUE : (phoneRaw?.VALUE || phoneRaw);
        const phone = phoneValue && String(phoneValue).trim() !== '' ? String(phoneValue).trim() : null;

        // Extract name
        const firstName = contact.NAME ? String(contact.NAME).trim() : null;
        const lastName = contact.LAST_NAME ? String(contact.LAST_NAME).trim() : null;

        return { email, phone, firstName, lastName, contactId };
    } catch (err) {
        console.warn(`[CONTACT SYNC] Failed to get contact ${contactId}: ${err.message}`);
        return { email: null, phone: null, firstName: null, lastName: null, contactId };
    }
}

/**
 * Check if contact data needs update
 * @param {Object} bitrixContact - Contact data from Bitrix
 * @param {Object} shopifyOrder - Order data from Shopify
 * @returns {{needsUpdate: boolean, changes: Object}}
 */
export function checkContactChanges(bitrixContact, shopifyOrder) {
    const changes = {};
    let needsUpdate = false;

    const currentEmail = (shopifyOrder.email || '').toLowerCase().trim();
    const bitrixEmail = (bitrixContact.email || '').toLowerCase().trim();

    // Update email if Bitrix has a real email and Shopify has fallback or different email
    if (bitrixEmail && bitrixEmail !== BITRIX_FALLBACK_EMAIL.toLowerCase()) {
        if (currentEmail !== bitrixEmail) {
            changes.email = bitrixContact.email;
            needsUpdate = true;
        }
    }

    // Update phone if Bitrix has phone and Shopify is different
    const currentPhone = (shopifyOrder.phone || '').replace(/\s/g, '');
    const bitrixPhone = (bitrixContact.phone || '').replace(/\s/g, '');
    if (bitrixPhone && currentPhone !== bitrixPhone) {
        changes.phone = bitrixContact.phone;
        needsUpdate = true;
    }

    // Check customer name changes
    const customer = shopifyOrder.customer || {};
    const currentFirstName = (customer.first_name || '').trim();
    const currentLastName = (customer.last_name || '').trim();

    if (bitrixContact.firstName || bitrixContact.lastName) {
        const nameChanged =
            (bitrixContact.firstName && currentFirstName !== bitrixContact.firstName) ||
            (bitrixContact.lastName && currentLastName !== bitrixContact.lastName);

        if (nameChanged) {
            changes.customer = {
                first_name: bitrixContact.firstName || currentFirstName,
                last_name: bitrixContact.lastName || currentLastName,
                email: changes.email || shopifyOrder.email,
                phone: changes.phone || shopifyOrder.phone
            };
            needsUpdate = true;
        }
    }

    return { needsUpdate, changes };
}

/**
 * Sync contact data from Bitrix deal to Shopify order
 * @param {string} shopifyOrderId - Shopify order ID
 * @param {Object} dealData - Deal data from Bitrix
 * @param {string} requestId - Request correlation ID
 * @param {string} dealId - Bitrix deal ID
 * @returns {Promise<{synced: boolean, changes?: Object, error?: string}>}
 */
export async function syncContactToShopify(shopifyOrderId, dealData, requestId, dealId) {
    if (!shopifyOrderId || String(shopifyOrderId).trim() === '') {
        return { synced: false, reason: 'no_order_id' };
    }

    try {
        // Get Bitrix contact data
        const bitrixContact = await getBitrixContactData(dealData);

        if (!bitrixContact.contactId) {
            console.log(JSON.stringify({
                event: 'CONTACT_SYNC_SKIP',
                requestId,
                dealId,
                shopifyOrderId,
                reason: 'no_contact_id',
                timestamp: new Date().toISOString()
            }));
            return { synced: false, reason: 'no_contact_id' };
        }

        // Get current Shopify order
        const shopifyOrder = await getOrder(shopifyOrderId);
        if (!shopifyOrder) {
            return { synced: false, reason: 'order_not_found' };
        }

        // Check what needs updating
        const { needsUpdate, changes } = checkContactChanges(bitrixContact, shopifyOrder);

        if (!needsUpdate) {
            console.log(JSON.stringify({
                event: 'CONTACT_SYNC_NO_CHANGES',
                requestId,
                dealId,
                shopifyOrderId,
                contactId: bitrixContact.contactId,
                currentEmail: shopifyOrder.email,
                bitrixEmail: bitrixContact.email,
                timestamp: new Date().toISOString()
            }));
            return { synced: false, reason: 'no_changes' };
        }

        console.log(JSON.stringify({
            event: 'CONTACT_SYNC_UPDATING',
            requestId,
            dealId,
            shopifyOrderId,
            contactId: bitrixContact.contactId,
            changes: Object.keys(changes),
            timestamp: new Date().toISOString()
        }));

        // Update Shopify order
        const updatePayload = { id: shopifyOrderId, ...changes };
        await updateOrder(shopifyOrderId, updatePayload);

        console.log(JSON.stringify({
            event: 'CONTACT_SYNC_SUCCESS',
            requestId,
            dealId,
            shopifyOrderId,
            contactId: bitrixContact.contactId,
            updatedFields: Object.keys(changes),
            timestamp: new Date().toISOString()
        }));

        return { synced: true, changes };

    } catch (err) {
        console.error(JSON.stringify({
            event: 'CONTACT_SYNC_ERROR',
            requestId,
            dealId,
            shopifyOrderId,
            error: err.message,
            timestamp: new Date().toISOString()
        }));
        return { synced: false, error: err.message };
    }
}

export default { syncContactToShopify, getBitrixContactData, checkContactChanges };
