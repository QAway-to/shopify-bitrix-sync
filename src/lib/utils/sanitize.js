/**
 * Sanitize sensitive data for guest mode display
 * Replaces sensitive fields with masked values
 */

export function sanitizeData(data, isGuestMode = false) {
  if (!isGuestMode || !data) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => sanitizeData(item, isGuestMode));
  }

  const sanitized = { ...data };

  // List of sensitive field patterns to mask
  const sensitiveFields = [
    'email',
    'phone',
    'address',
    'shipping_address',
    'billing_address',
    'customer',
    'first_name',
    'last_name',
    'name',
    'note',
    'comments',
    'token',
    'password',
    'secret',
    'api_key',
    'access_token'
  ];

  for (const key in sanitized) {
    const lowerKey = key.toLowerCase();

    // Check if field name matches sensitive patterns
    const isSensitive = sensitiveFields.some(field =>
      lowerKey.includes(field.toLowerCase())
    );

    if (isSensitive) {
      if (typeof sanitized[key] === 'string' && sanitized[key].length > 0) {
        // ✅ Use smart masking for email and phone
        if (lowerKey === 'email' || lowerKey.endsWith('_email')) {
          sanitized[key] = maskEmail(sanitized[key]);
        } else if (lowerKey === 'phone' || lowerKey.endsWith('_phone')) {
          sanitized[key] = maskPhone(sanitized[key]);
        } else {
          sanitized[key] = '***';
        }
      } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = sanitizeData(sanitized[key], isGuestMode);
      }
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null && !Array.isArray(sanitized[key])) {
      // Recursively sanitize nested objects
      sanitized[key] = sanitizeData(sanitized[key], isGuestMode);
    } else if (Array.isArray(sanitized[key])) {
      // Recursively sanitize arrays
      sanitized[key] = sanitized[key].map(item =>
        typeof item === 'object' ? sanitizeData(item, isGuestMode) : item
      );
    }
  }

  return sanitized;
}

// Internal helper for email masking (used by sanitizeData)
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '***';
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***';
  const [local, domain] = parts;
  const maskedLocal = local.length > 1 ? local[0] + '***' : '***';
  const domainParts = domain.split('.');
  const maskedDomain = domainParts.length >= 2
    ? domainParts[0][0] + '***.' + domainParts.slice(-1)[0].slice(-2)
    : '***';
  return `${maskedLocal}@${maskedDomain}`;
}

// Internal helper for phone masking (used by sanitizeData)
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '***';
  const cleaned = phone.replace(/\s+/g, '');
  if (cleaned.length <= 4) return '***';
  return `${cleaned.slice(0, 4)}***${cleaned.slice(-4)}`;
}

/**
 * Sanitize email specifically (show partial email for better UX)
 * Example: test@example.com → t***@e***le.com
 */
export function sanitizeEmail(email, isGuestMode = false) {
  if (!isGuestMode || !email || typeof email !== 'string') {
    return email;
  }

  const parts = email.split('@');
  if (parts.length !== 2) return '***@***.***';

  const [local, domain] = parts;
  const domainParts = domain.split('.');

  const maskedLocal = local.length > 1
    ? local[0] + '***'
    : '***';

  const maskedDomain = domainParts.length >= 2
    ? domainParts[0][0] + '***' + domainParts.slice(-1)[0].slice(-2)
    : '***';

  return `${maskedLocal}@${maskedDomain}`;
}

/**
 * Sanitize phone number (show last 4 digits)
 * Example: +35712345678 → +357***5678
 */
export function sanitizePhone(phone, isGuestMode = false) {
  if (!isGuestMode || !phone || typeof phone !== 'string') {
    return phone;
  }

  // Keep country code prefix and last 4 digits
  const cleaned = phone.replace(/\s+/g, '');
  if (cleaned.length <= 4) return '***';

  // Find prefix (first 3-4 chars for country code)
  const prefix = cleaned.slice(0, 4);
  const suffix = cleaned.slice(-4);

  return `${prefix}***${suffix}`;
}



