import { shopifyAdapter } from '../../src/lib/adapters/shopify';
import { mapShopifyOrderToBitrixDeal } from '../../src/lib/bitrix/orderMapper.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { selectedEvents, bitrixWebhookUrl } = req.body;

  if (!selectedEvents || !Array.isArray(selectedEvents) || selectedEvents.length === 0) {
    return res.status(400).json({ 
      error: 'No selected events provided',
      details: 'Please select at least one event to send'
    });
  }

  if (!bitrixWebhookUrl || typeof bitrixWebhookUrl !== 'string' || bitrixWebhookUrl.trim() === '') {
    return res.status(400).json({ 
      error: 'Bitrix webhook URL is required',
      details: 'Please provide a valid Bitrix webhook URL'
    });
  }

  // Validate URL format
  let validUrl;
  try {
    validUrl = new URL(bitrixWebhookUrl);
    if (!['http:', 'https:'].includes(validUrl.protocol)) {
      return res.status(400).json({ 
        error: 'Invalid URL protocol',
        details: 'Bitrix webhook URL must use http or https protocol'
      });
    }
  } catch (urlError) {
    return res.status(400).json({ 
      error: 'Invalid URL format',
      details: 'Please provide a valid URL for Bitrix webhook'
    });
  }

  const results = [];
  const errors = [];

  // Helper: call Bitrix with provided webhook base
  const callBitrix = async (method, payload) => {
    const baseUrl = bitrixWebhookUrl.endsWith('/') ? bitrixWebhookUrl : `${bitrixWebhookUrl}/`;
    const apiUrl = method.startsWith('/') ? `${baseUrl}${method.substring(1)}` : `${baseUrl}${method}`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const contentType = response.headers.get('content-type');
    const data = contentType && contentType.includes('application/json')
      ? await response.json()
      : { raw: await response.text() };
    return { ok: response.ok, status: response.status, data };
  };

  for (let i = 0; i < selectedEvents.length; i++) {
    const event = selectedEvents[i];
    
    // Transform Shopify order to Bitrix deal fields + product rows (with PRODUCT_ID)
    let dealFields;
    let productRows = [];
    let transformError = null;

    try {
      // Use full mapper to get fields AND productRows (with PRODUCT_ID enforced elsewhere)
      const { dealFields: mappedFields, productRows: mappedRows } = await mapShopifyOrderToBitrixDeal({
        ...event,
        id: event.orderId || event.id, // ensure stable id
        eventId: event.eventId || event.id
      });

      dealFields = mappedFields;

      // Enforce PRODUCT_ID-only rows, skip rows without PRODUCT_ID
      productRows = (mappedRows || []).filter(r => r.PRODUCT_ID);

      if (!productRows.length) {
        throw new Error('No product rows with PRODUCT_ID found; cannot send to Bitrix');
      }

      // Ensure Shopify order ID field is stable
      if (event.orderId || event.id) {
        dealFields.UF_CRM_1742556489 = String(event.orderId || event.id);
      }
    } catch (transformErr) {
      transformError = {
        eventId: event.id,
        success: false,
        error: 'Transformation error (fields/product rows)',
        details: transformErr.message,
        type: 'TransformationError'
      };
      errors.push(transformError);
      continue;
    }
    
    try {
      // 0. Try to find existing deal by UF_CRM_1742556489
      const findResp = await callBitrix('crm.deal.list.json', {
        filter: { 'UF_CRM_1742556489': dealFields.UF_CRM_1742556489 },
        select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID']
      });

      let dealId = null;
      let isCreate = false;

      if (findResp.ok && findResp.data.result && findResp.data.result.length > 0) {
        dealId = findResp.data.result[0].ID;
      }

      if (!dealId) {
        // 1. Create deal
        const addResp = await callBitrix('crm.deal.add.json', { fields: dealFields });
        if (!addResp.ok || !addResp.data.result) {
          throw new Error(`crm.deal.add failed: ${JSON.stringify(addResp.data)}`);
        }
        dealId = addResp.data.result;
        isCreate = true;
      } else {
        // 1b. Update deal fields
        const updResp = await callBitrix('crm.deal.update.json', { id: dealId, fields: dealFields });
        if (!updResp.ok) {
          throw new Error(`crm.deal.update failed: ${JSON.stringify(updResp.data)}`);
        }
      }

      // 2. Set product rows (always replace)
      const rowsResp = await callBitrix('crm.deal.productrows.set.json', {
        id: dealId,
        rows: productRows
      });
      if (!rowsResp.ok || rowsResp.data.result !== true) {
        throw new Error(`crm.deal.productrows.set failed: ${JSON.stringify(rowsResp.data)}`);
      }

      results.push({
        eventId: event.id,
        success: true,
        status: 200,
        response: { addOrUpdate: isCreate ? 'created' : 'updated', dealId, rowsSet: productRows.length },
        message: `Successfully ${isCreate ? 'created' : 'updated'} and set products`,
        shopifyData: event,
        bitrixData: { fields: dealFields, productRows }
      });
    } catch (fetchError) {
      errors.push({
        eventId: event.id,
        success: false,
        error: fetchError.message || 'Unknown error',
        details: fetchError.stack,
        type: fetchError.name || 'Error',
        shopifyData: event,
        bitrixData: { fields: dealFields, productRows }
      });
    }
  }

  const successful = results.length;
  const failed = errors.length;
  const total = selectedEvents.length;

  // Combine results and errors
  const allResults = [...results, ...errors];

  // Return appropriate status code
  if (failed === 0) {
    // All successful
    res.status(200).json({
      success: true,
      message: `Все ${successful} событий успешно отправлены в Bitrix`,
      total,
      successful,
      failed,
      results: allResults
    });
  } else if (successful === 0) {
    // All failed
    res.status(500).json({
      success: false,
      message: `Не удалось отправить события в Bitrix`,
      total,
      successful,
      failed,
      errors: errors,
      results: allResults
    });
  } else {
    // Partial success
    res.status(207).json({
      success: false,
      message: `Отправлено ${successful} из ${total} событий. ${failed} событий не удалось отправить`,
      total,
      successful,
      failed,
      errors: errors,
      results: allResults
    });
  }
}
