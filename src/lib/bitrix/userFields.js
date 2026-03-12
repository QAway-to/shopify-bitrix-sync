/**
 * Bitrix User Fields Utility
 * Provides helper functions for resolving user field metadata and list values
 */

import { callBitrix } from './client.js';

/**
 * Resolves a Select List value ID to its actual String label
 * Directly queries Bitrix crm.deal.userfield.list on every call as requested.
 * 
 * @param {string} fieldName - The UF field name (e.g. 'UF_CRM_1741642513658')
 * @param {string|number|Array} valueId - The ID or array of IDs to resolve
 * @returns {Promise<string|null>} The first matched value string or null
 */
export async function resolveUserFieldListValue(fieldName, valueId) {
    if (!valueId) return null;
    
    // Normalize valueId: if it's an array, take the first element (assuming single selection logic)
    const idToFind = Array.isArray(valueId) ? valueId[0] : valueId;
    if (!idToFind) return null;

    console.log(`[USER FIELDS] Resolving value ID ${idToFind} for field ${fieldName}...`);

    try {
        const response = await callBitrix('/crm.deal.userfield.list.json', {
            filter: { "FIELD_NAME": fieldName }
        });

        if (response.result && response.result.length > 0) {
            const fieldInfo = response.result[0];
            if (fieldInfo.LIST && Array.isArray(fieldInfo.LIST)) {
                const match = fieldInfo.LIST.find(item => String(item.ID) === String(idToFind));
                if (match) {
                    console.log(`[USER FIELDS] ✅ Resolved ID ${idToFind} -> "${match.VALUE}"`);
                    return match.VALUE;
                }
            }
        }
        
        console.warn(`[USER FIELDS] ⚠️ Could not find value ID ${idToFind} in list for field ${fieldName}`);
        return null;
    } catch (error) {
        console.error(`[USER FIELDS] ❌ Error resolving field ${fieldName}:`, error);
        return null; // Return null so caller can decide on fallback
    }
}
