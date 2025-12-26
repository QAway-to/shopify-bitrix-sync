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
        sanitized[key] = '***********';
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

/**
 * Sanitize email specifically (show partial email)
 */
export function sanitizeEmail(email, isGuestMode = false) {
  if (!isGuestMode || !email) {
    return email;
  }
  return '***********';
}

/**
 * Sanitize phone number
 */
export function sanitizePhone(phone, isGuestMode = false) {
  if (!isGuestMode || !phone) {
    return phone;
  }
  return '***********';
}



