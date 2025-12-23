import { refreshBitrixMappingsFromCatalog } from '../../../src/lib/bitrix/products.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const result = await refreshBitrixMappingsFromCatalog();
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[BITRIX REFRESH MAPPING] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to refresh mappings',
      message: error.message
    });
  }
}

