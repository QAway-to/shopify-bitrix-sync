import mapping from './responsibleMapping.json' assert { type: 'json' };

/**
 * Resolve Bitrix responsible (ASSIGNED_BY_ID) based on Shopify order.
 * Priority: byTag -> byCountryCode -> bySource -> default.
 * Logs warning if matched by default.
 */
export function resolveResponsibleId(order) {
  const {
    default: defaultId = null,
    byTag = {},
    byCountryCode = {},
    bySource = {},
  } = mapping;

  // 1) By tag
  const tags = (order.tags || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  for (const tag of tags) {
    if (byTag[tag]) {
      return byTag[tag];
    }
  }

  // 2) By country code (shipping or billing)
  const countryCode =
    order.shipping_address?.country_code ||
    order.billing_address?.country_code ||
    null;
  if (countryCode && byCountryCode[countryCode]) {
    return byCountryCode[countryCode];
  }

  // 3) By source
  const source = order.source_name || '';
  if (source && bySource[source]) {
    return bySource[source];
  }

  // 4) Default
  if (defaultId) {
    console.warn(`Responsible matched by default for order ${order.id}`);
    return defaultId;
  }

  console.warn(`Responsible not resolved for order ${order.id}`);
  return null;
}

