const DEFAULT_MAPPING = {
  name: ['name', 'fullName', 'full_name'],
  email: ['email', 'mail', 'e-mail'],
  phone: ['phone', 'telephone', 'tel'],
  company: ['company', 'org', 'organisation'],
  quote_text: ['text', 'quote', 'quote_text'],
  quote_author: ['author', 'writer'],
  quote_tags: ['tags', 'labels', 'topics']
};

export function detectMapping(sample) {
  const mapping = {};
  const headers = Object.keys(sample || {});

  Object.entries(DEFAULT_MAPPING).forEach(([target, variants]) => {
    const match = headers.find((header) => variants.includes(header.toLowerCase()));
    if (match) {
      mapping[target] = match;
    }
  });

  return mapping;
}

export function applyRules(record, mapping) {
  const result = {};
  Object.entries(mapping).forEach(([target, source]) => {
    const value = record[source] ?? '';
    switch (target) {
      case 'email':
        result[target] = String(value).trim().toLowerCase();
        break;
      case 'name':
        result[target] = titleCase(String(value).trim());
        break;
      case 'phone':
        result[target] = digitsOnly(String(value));
        break;
      case 'quote_text':
        result[target] = String(value).trim();
        break;
      case 'quote_author':
        result[target] = titleCase(String(value).trim());
        break;
      case 'quote_tags':
        if (Array.isArray(value)) {
          result[target] = value.map((item) => String(item).trim()).join(', ');
        } else {
          result[target] = String(value).trim();
        }
        break;
      default:
        result[target] = value;
    }
  });
  return result;
}

export function normalizeDataset(dataset, mapping) {
  return dataset.map((record) => applyRules(record, mapping));
}

function digitsOnly(value) {
  const digits = value.replace(/\D+/g, '');
  if (!digits.length) return '';
  if (digits.startsWith('8') && digits.length === 11) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.startsWith('7') && digits.length === 11) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+7${digits}`;
  }
  return `+${digits}`;
}

function titleCase(value) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((chunk) => chunk[0].toUpperCase() + chunk.slice(1))
    .join(' ');
}

