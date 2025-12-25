import crypto from 'crypto';

/**
 * Recursively sort object keys and arrays for stable JSON serialization
 */
function stableSort(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => stableSort(item)).sort((a, b) => {
      // For arrays of objects, sort by a stable key if available
      if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
        // For items with sku, sort by sku
        if (a.sku && b.sku) {
          return a.sku.localeCompare(b.sku);
        }
        // For items with line_item_id, sort by line_item_id
        if (a.line_item_id && b.line_item_id) {
          return String(a.line_item_id).localeCompare(String(b.line_item_id));
        }
        // Otherwise, sort by first available key
        const aKeys = Object.keys(a).sort();
        const bKeys = Object.keys(b).sort();
        const firstKey = aKeys[0] || bKeys[0];
        if (firstKey && a[firstKey] !== undefined && b[firstKey] !== undefined) {
          return String(a[firstKey]).localeCompare(String(b[firstKey]));
        }
      }
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });
  }

  if (typeof obj === 'object') {
    const sorted = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      const value = stableSort(obj[key]);
      // Skip undefined values to ensure stable hash
      if (value !== undefined) {
        sorted[key] = value;
      }
    }
    return sorted;
  }

  return obj;
}

/**
 * Remove empty/null/undefined fields from object recursively
 */
function removeEmptyFields(obj) {
  if (obj === null || obj === undefined) {
    return undefined;
  }

  if (Array.isArray(obj)) {
    const filtered = obj.map(item => removeEmptyFields(item)).filter(item => item !== undefined);
    return filtered.length > 0 ? filtered : undefined;
  }

  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = removeEmptyFields(value);
      if (cleanedValue !== undefined && cleanedValue !== null && cleanedValue !== '') {
        cleaned[key] = cleanedValue;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  return obj;
}

/**
 * Create stable JSON string from object (sorted keys, sorted arrays)
 */
export function stableJson(obj) {
  const sorted = stableSort(obj);
  return JSON.stringify(sorted);
}

/**
 * Create SHA256 hash of stable JSON string
 */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Create payload hash from normalized payload object
 */
export function payloadHash(payload) {
  const stable = stableJson(payload);
  return sha256(stable);
}

/**
 * Remove empty fields from object (for address_update normalization)
 */
export function cleanEmptyFields(obj) {
  return removeEmptyFields(obj);
}

/**
 * Normalize payload based on action type
 */
export function normalizePayload(action, rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return null;
  }

  switch (action) {
    case 'hold_create': {
      // Normalize: {action, items:[{sku,qty}...]} - items сортировать по sku
      const items = Array.isArray(rawPayload.items) ? rawPayload.items : [];
      const normalizedItems = items
        .map(item => ({
          sku: String(item.sku || '').trim(),
          qty: Number(item.qty || 0)
        }))
        .filter(item => item.sku && item.qty > 0)
        .sort((a, b) => a.sku.localeCompare(b.sku));
      
      return {
        action: 'hold_create',
        items: normalizedItems
      };
    }
    
    case 'hold_release': {
      // Normalize: {action, items:[{sku,qty}...]} - items сортировать по sku
      const items = Array.isArray(rawPayload.items) ? rawPayload.items : [];
      const normalizedItems = items
        .map(item => ({
          sku: String(item.sku || '').trim(),
          qty: Number(item.qty || 0)
        }))
        .filter(item => item.sku && item.qty > 0)
        .sort((a, b) => a.sku.localeCompare(b.sku));
      
      return {
        action: 'hold_release',
        items: normalizedItems
      };
    }
    
    case 'refund_create': {
      // Normalize: {action, refund_type, items:[{sku,qty,reason}...], note}
      const items = Array.isArray(rawPayload.items) ? rawPayload.items : [];
      const normalizedItems = items
        .map(item => ({
          sku: String(item.sku || '').trim(),
          qty: Number(item.qty || 0),
          reason: String(item.reason || '').trim()
        }))
        .filter(item => item.sku && item.qty > 0)
        .sort((a, b) => a.sku.localeCompare(b.sku));
      
      return {
        action: 'refund_create',
        refund_type: String(rawPayload.refund_type || 'partial').trim(),
        items: normalizedItems,
        note: String(rawPayload.note || '').trim()
      };
    }
    
    case 'address_update': {
      // Normalize: {action, address:{...}} - удалить пустые поля
      const address = rawPayload.address || {};
      const cleanedAddress = removeEmptyFields(address);
      
      if (!cleanedAddress || Object.keys(cleanedAddress).length === 0) {
        return null;
      }
      
      return {
        action: 'address_update',
        address: cleanedAddress
      };
    }
    
    default:
      return null;
  }
}

