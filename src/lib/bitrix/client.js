/**
 * Bitrix24 REST API Client
 * Handles all API calls to Bitrix24
 */

/**
 * Call Bitrix24 REST API method
 * @param {string} webhookUrl - Base webhook URL (e.g., https://domain.bitrix24.eu/rest/52/xxx/)
 * @param {string} method - API method (e.g., 'crm.deal.add')
 * @param {Object} params - Method parameters
 * @returns {Promise<Object>} API response
 */
export async function callBitrixAPI(webhookUrl, method, params = {}) {
  // Ensure webhook URL ends with / and method ends with .json
  const baseUrl = webhookUrl.endsWith('/') ? webhookUrl : `${webhookUrl}/`;
  const methodSuffix = method.endsWith('.json') ? method : `${method}.json`;
  const url = `${baseUrl}${methodSuffix}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(`Bitrix API error: ${JSON.stringify(result)}`);
    }

    if (result.error) {
      throw new Error(`Bitrix API error: ${result.error_description || result.error}`);
    }

    return result;
  } catch (error) {
    console.error(`[BITRIX API] Error calling ${method}:`, error);
    throw error;
  }
}

/**
 * Get Bitrix webhook base URL from environment or use default
 */
export function getBitrixWebhookBase() {
  // Get from environment variable
  if (process.env.BITRIX_WEBHOOK_BASE) {
    const base = process.env.BITRIX_WEBHOOK_BASE;
    return base.endsWith('/') ? base : `${base}/`;
  }
  
  // Fallback to old env variable
  if (process.env.BITRIX_WEBHOOK_URL) {
    const url = process.env.BITRIX_WEBHOOK_URL;
    return url.endsWith('/') ? url : `${url}/`;
  }
  
  // Hardcoded webhook base URL
  return 'https://bfcshoes.bitrix24.eu/rest/52/i6l05o71ywxb8j1l/';
}

/**
 * Classify Bitrix API error type
 * @param {Object} errorResponse - Error response from Bitrix API
 * @returns {Object} { type: string, message: string, details: Object }
 */
export function classifyBitrixError(errorResponse) {
  const errorCode = errorResponse.error || '';
  const errorDesc = (errorResponse.error_description || errorResponse.error || '').toLowerCase();
  const errorMsg = String(errorDesc);

  // Validation errors (mandatory fields)
  const validationKeywords = [
    'mandatory', 'required', 'обязательное', 'обязательное поле',
    'field is required', 'поле обязательно', 'must be filled',
    'invalid value', 'неверное значение', 'validation'
  ];
  const isValidationError = validationKeywords.some(keyword => errorMsg.includes(keyword));

  // Permission errors
  const permissionKeywords = [
    'permission', 'access denied', 'доступ запрещен', 'недостаточно прав',
    'forbidden', 'unauthorized', 'access denied', 'no permission'
  ];
  const isPermissionError = permissionKeywords.some(keyword => errorMsg.includes(keyword));

  // Duplicate errors
  const duplicateKeywords = [
    'duplicate', 'already exists', 'уже существует', 'уже есть',
    'duplicate entry', 'повтор'
  ];
  const isDuplicateError = duplicateKeywords.some(keyword => errorMsg.includes(keyword));

  // Network/timeout errors
  const networkKeywords = [
    'timeout', 'network', 'connection', 'econnrefused', 'enotfound',
    'etimedout', 'failed to fetch'
  ];
  const isNetworkError = networkKeywords.some(keyword => errorMsg.includes(keyword));

  let errorType = 'UNKNOWN';
  if (isValidationError) errorType = 'VALIDATION';
  else if (isPermissionError) errorType = 'PERMISSION';
  else if (isDuplicateError) errorType = 'DUPLICATE';
  else if (isNetworkError) errorType = 'NETWORK';
  else if (errorCode) errorType = errorCode;

  return {
    type: errorType,
    message: errorResponse.error_description || errorResponse.error || 'Unknown error',
    code: errorCode,
    details: errorResponse
  };
}

/**
 * Call Bitrix24 REST API method (simplified wrapper)
 * @param {string} method - API method (e.g., '/crm.deal.add.json')
 * @param {Object} payload - Method parameters
 * @returns {Promise<Object>} API response
 */
export async function callBitrix(method, payload = {}) {
  const baseUrl = getBitrixWebhookBase();
  const methodPath = method.startsWith('/') ? method : `/${method}`;
  const url = `${baseUrl}${methodPath}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      const errorInfo = classifyBitrixError(result);
      console.error(`[BITRIX API] HTTP Error ${response.status} calling ${method}:`, {
        type: errorInfo.type,
        message: errorInfo.message,
        code: errorInfo.code,
        payload: payload
      });
      const error = new Error(`Bitrix API error (${errorInfo.type}): ${errorInfo.message}`);
      error.errorType = errorInfo.type;
      error.errorDetails = errorInfo.details;
      throw error;
    }

    if (result.error) {
      const errorInfo = classifyBitrixError(result);
      console.error(`[BITRIX API] Error calling ${method}:`, {
        type: errorInfo.type,
        message: errorInfo.message,
        code: errorInfo.code,
        payload: payload
      });
      const error = new Error(`Bitrix API error (${errorInfo.type}): ${errorInfo.message}`);
      error.errorType = errorInfo.type;
      error.errorDetails = errorInfo.details;
      throw error;
    }

    return result;
  } catch (error) {
    // If error already has errorType, re-throw as is
    if (error.errorType) {
      throw error;
    }
    
    // Classify network/connection errors
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('fetch') || errorMsg.includes('network') || errorMsg.includes('timeout')) {
      error.errorType = 'NETWORK';
    } else {
      error.errorType = 'UNKNOWN';
    }
    
    console.error(`[BITRIX API] Error calling ${method}:`, {
      type: error.errorType,
      message: error.message,
      payload: payload
    });
    throw error;
  }
}

/**
 * Get Bitrix webhook URL from environment or use default (legacy support)
 */
export function getBitrixWebhookUrl() {
  return getBitrixWebhookBase();
}

