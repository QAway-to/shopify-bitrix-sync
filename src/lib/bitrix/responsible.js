import mapping from './responsibleMapping.json' assert { type: 'json' };
import { callBitrix } from './client.js';

/**
 * Find the current shift manager by looking for user with internal phone "100".
 * This replaces the weekday-based schedule.
 * @returns {Promise<number|null>} Manager ID or null if not found
 */
async function findShiftManagerByPhone100() {
  try {
    // Query all active users with phone fields
    const response = await callBitrix('/user.get.json', {
      FILTER: { ACTIVE: 'Y' },
      SELECT: ['ID', 'NAME', 'LAST_NAME', 'UF_PHONE_INNER', 'WORK_PHONE']
    });

    const users = response?.result || [];

    for (const user of users) {
      const innerPhone = user.UF_PHONE_INNER;
      const workPhone = user.WORK_PHONE;

      if (innerPhone === '100' || workPhone === '100') {
        const managerId = Number(user.ID);
        console.log(`[RESPONSIBLE] ✅ Shift manager found via phone 100: ${user.NAME} ${user.LAST_NAME} (ID: ${managerId})`);
        return managerId;
      }
    }

    console.warn(`[RESPONSIBLE] ⚠️ No user with phone 100 found. Active users with phones:`);
    for (const u of users) {
      if (u.UF_PHONE_INNER || u.WORK_PHONE) {
        console.log(`  - ${u.NAME} ${u.LAST_NAME}: inner=${u.UF_PHONE_INNER || 'N/A'}, work=${u.WORK_PHONE || 'N/A'}`);
      }
    }

    return null;
  } catch (error) {
    console.error(`[RESPONSIBLE] ❌ Error querying Bitrix for phone 100:`, error?.message || error);
    return null;
  }
}

/**
 * Resolve Bitrix responsible (ASSIGNED_BY_ID) based on Shopify order.
 * Priority: Phone 100 (shift manager) -> byTag -> byCountryCode -> bySource -> default.
 * Logs warning if matched by default.
 */
export async function resolveResponsibleId(order) {
  const {
    default: defaultId = null,
    byTag = {},
    byCountryCode = {},
    bySource = {},
  } = mapping;

  // 0) Find current shift manager by phone 100 (highest priority)
  const shiftManagerId = await findShiftManagerByPhone100();
  if (shiftManagerId) {
    return shiftManagerId;
  }

  console.warn(`[RESPONSIBLE] ⚠️ Phone 100 lookup failed, falling back to static rules`);

  // 1) By tag
  const tags = (order?.tags || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  for (const tag of tags) {
    if (byTag[tag]) {
      console.log(`[RESPONSIBLE] Matched by tag: ${tag} → ID: ${byTag[tag]}`);
      return byTag[tag];
    }
  }

  // 2) By country code (shipping or billing)
  const countryCode =
    order?.shipping_address?.country_code ||
    order?.billing_address?.country_code ||
    null;
  if (countryCode && byCountryCode[countryCode]) {
    console.log(`[RESPONSIBLE] Matched by country: ${countryCode} → ID: ${byCountryCode[countryCode]}`);
    return byCountryCode[countryCode];
  }

  // 3) By source
  const source = order?.source_name || '';
  if (source && bySource[source]) {
    console.log(`[RESPONSIBLE] Matched by source: ${source} → ID: ${bySource[source]}`);
    return bySource[source];
  }

  // 4) Default - always return defaultId if available
  if (defaultId) {
    console.warn(`[RESPONSIBLE] ⚠️ Matched by default for order ${order?.id} → ID: ${defaultId}`);
    return defaultId;
  }

  console.error(`[RESPONSIBLE] ❌ CRITICAL: No default manager ID configured! Order ${order?.id} will have no responsible.`);
  return null;
}
