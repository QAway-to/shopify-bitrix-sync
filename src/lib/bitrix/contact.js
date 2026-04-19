/**
 * Bitrix24 Contact Management
 * Handles contact upsert logic
 */

import { callBitrixAPI } from './client.js';
import { logger } from '../logging/logger.js';

/**
 * Find contact by email
 * @param {string} webhookUrl - Bitrix webhook URL
 * @param {string} email - Contact email
 * @returns {Promise<number|null>} Contact ID or null if not found
 */
export async function findContactByEmail(webhookUrl, email) {
  if (!email) {
    return null;
  }

  try {
    const result = await callBitrixAPI(webhookUrl, 'crm.contact.list', {
      filter: { EMAIL: email },
      select: ['ID', 'NAME', 'LAST_NAME', 'EMAIL']
    });

    if (result.result && result.result.length > 0) {
      return parseInt(result.result[0].ID);
    }

    return null;
  } catch (e) {
    console.error('[BITRIX CONTACT] Error finding contact by email:', e);
    logger.warn('contact_lookup_failed', 'Silent error in contact lookup', { error: e.message });
    return null;
  }
}

/**
 * Find contact by phone
 * @param {string} webhookUrl - Bitrix webhook URL
 * @param {string} phone - Contact phone
 * @returns {Promise<number|null>} Contact ID or null if not found
 */
export async function findContactByPhone(webhookUrl, phone) {
  if (!phone) {
    return null;
  }

  try {
    const result = await callBitrixAPI(webhookUrl, 'crm.contact.list', {
      filter: { PHONE: phone },
      select: ['ID', 'NAME', 'LAST_NAME', 'PHONE']
    });

    if (result.result && result.result.length > 0) {
      return parseInt(result.result[0].ID);
    }

    return null;
  } catch (e) {
    console.error('[BITRIX CONTACT] Error finding contact by phone:', e);
    logger.warn('contact_lookup_failed', 'Silent error in contact lookup', { error: e.message });
    return null;
  }
}

/**
 * Create contact in Bitrix24
 * @param {string} webhookUrl - Bitrix webhook URL
 * @param {Object} contactData - Contact data
 * @returns {Promise<number|null>} Created contact ID or null on error
 */
export async function createContact(webhookUrl, contactData) {
  try {
    // Match Python script structure
    const fields = {
      NAME: contactData.firstName || 'Shopify',
      LAST_NAME: contactData.lastName || 'Customer',
      OPENED: 'Y',
      TYPE_ID: 'CLIENT',
      SOURCE_ID: 'WEB', // Default source
      EMAIL: contactData.email ? [{ VALUE: contactData.email, VALUE_TYPE: 'WORK' }] : [],
    };

    // Add phone if available
    if (contactData.phone) {
      fields.PHONE = [{ VALUE: contactData.phone, VALUE_TYPE: 'WORK' }];
    }

    // Add address if available - must be a STRING, not object!
    if (contactData.address) {
      const addr = contactData.address;
      // Build address string: "Street, ZIP City Province, Country"
      const addressParts = [];
      if (addr.address1) addressParts.push(addr.address1);
      if (addr.address2) addressParts.push(addr.address2);

      const cityParts = [];
      if (addr.zip) cityParts.push(addr.zip);
      if (addr.city) cityParts.push(addr.city);
      if (addr.province) cityParts.push(addr.province);

      let addressString = addressParts.join(', ');
      if (cityParts.length > 0) {
        addressString += (addressString ? ', ' : '') + cityParts.join(' ');
      }
      if (addr.country) {
        addressString += (addressString ? ', ' : '') + addr.country;
      }

      if (addressString.trim()) {
        fields.ADDRESS = addressString;
      }
    }

    const result = await callBitrixAPI(webhookUrl, 'crm.contact.add', { fields });

    if (result.result) {
      const contactId = parseInt(result.result);
      logger.info('contact_created', 'Contact created in Bitrix', { contactId, email: contactData.email });
      return contactId;
    }

    return null;
  } catch (error) {
    console.error('[BITRIX CONTACT] Error creating contact:', error);
    return null;
  }
}

/**
 * Update contact address in Bitrix24
 * @param {string} webhookUrl - Bitrix webhook URL
 * @param {number} contactId - Contact ID to update
 * @param {Object} addressData - Address data object
 * @returns {Promise<boolean>} Success status
 */
export async function updateContactAddress(webhookUrl, contactId, addressData) {
  if (!contactId || !addressData) return false;

  try {
    // Build address string (same format as createContact)
    const addressParts = [];
    if (addressData.address1) addressParts.push(addressData.address1);
    if (addressData.address2) addressParts.push(addressData.address2);

    const cityParts = [];
    if (addressData.zip) cityParts.push(addressData.zip);
    if (addressData.city) cityParts.push(addressData.city);
    if (addressData.province) cityParts.push(addressData.province);

    let addressString = addressParts.join(', ');
    if (cityParts.length > 0) {
      addressString += (addressString ? ', ' : '') + cityParts.join(' ');
    }
    if (addressData.country) {
      addressString += (addressString ? ', ' : '') + addressData.country;
    }

    if (!addressString.trim()) {
      console.log(`[BITRIX CONTACT] No address to update for contact ${contactId}`);
      return false;
    }

    const result = await callBitrixAPI(webhookUrl, 'crm.contact.update', {
      id: contactId,
      fields: { ADDRESS: addressString }
    });

    if (result.result) {
      console.log(`[BITRIX CONTACT] ✅ Updated address for contact ${contactId}: "${addressString}"`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`[BITRIX CONTACT] Error updating contact address:`, error);
    return false;
  }
}

/**
 * Upsert contact - find by email or create new
 * @param {string} webhookUrl - Bitrix webhook URL
 * @param {Object} shopifyOrder - Shopify order object
 * @returns {Promise<number|null>} Contact ID or null
 */
export async function upsertBitrixContact(webhookUrl, shopifyOrder) {
  // Get email from order
  const email = shopifyOrder.customer?.email ||
    shopifyOrder.email ||
    shopifyOrder.billing_address?.email ||
    null;

  // Get phone from order (fallback identifier)
  const phone = shopifyOrder.customer?.phone ||
    shopifyOrder.billing_address?.phone ||
    shopifyOrder.shipping_address?.phone ||
    null;

  // Need at least one identifier
  if (!email && !phone) {
    console.log('[BITRIX CONTACT] No email or phone found in order, skipping contact creation');
    return null;
  }

  let contactId = null;

  // Prepare address data for potential update
  const billingAddress = shopifyOrder.billing_address || {};
  const shippingAddress = shopifyOrder.shipping_address || {};
  const addressData = shippingAddress.address1 ? shippingAddress : (billingAddress.address1 ? billingAddress : null);

  // Strategy 1: Try to find by email first (preferred)
  if (email) {
    contactId = await findContactByEmail(webhookUrl, email);
    if (contactId) {
      console.log(`[BITRIX CONTACT] Found existing contact by email: ${contactId}`);
      logger.info('contact_found', 'Existing contact found', { contactId, email });
      // Update address if available (fixes "Array" issue for old contacts)
      if (addressData) {
        await updateContactAddress(webhookUrl, contactId, addressData);
      }
      return contactId;
    }
  }

  // Strategy 2: Fallback to phone search
  if (!contactId && phone) {
    contactId = await findContactByPhone(webhookUrl, phone);
    if (contactId) {
      console.log(`[BITRIX CONTACT] Found existing contact by phone: ${contactId}`);
      logger.info('contact_found', 'Existing contact found', { contactId, email });
      // Update address if available
      if (addressData) {
        await updateContactAddress(webhookUrl, contactId, addressData);
      }
      return contactId;
    }
  }

  // Create new contact (with whatever data we have)
  const customer = shopifyOrder.customer || {};
  const address = shippingAddress.address1 ? shippingAddress : billingAddress;

  const contactData = {
    firstName: customer.first_name || billingAddress.first_name || shippingAddress.first_name || '',
    lastName: customer.last_name || billingAddress.last_name || shippingAddress.last_name || '',
    email: email, // May be null
    phone: phone, // May be null
    address: address.address1 ? {
      address1: address.address1,
      address2: address.address2,
      city: address.city,
      zip: address.zip,
      province: address.province,
      country: address.country
    } : null
  };

  console.log(`[BITRIX CONTACT] Creating new contact with: email=${email || 'N/A'}, phone=${phone || 'N/A'}`);
  contactId = await createContact(webhookUrl, contactData);

  if (contactId) {
    console.log(`[BITRIX CONTACT] Created new contact with ID: ${contactId}`);
  } else {
    console.error('[BITRIX CONTACT] Failed to create contact');
  }

  return contactId;
}

