/**
 * API endpoint for transforming Shopify order to Bitrix deal
 * Server-side only - avoids client-side bundle issues
 */
import { shopifyAdapter } from '../../../src/lib/adapters/shopify/index.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { shopifyOrder } = req.body;

    if (!shopifyOrder) {
      return res.status(400).json({ error: 'shopifyOrder is required' });
    }

    // Transform on server side
    const bitrixData = await shopifyAdapter.transformToBitrix(shopifyOrder);

    return res.status(200).json({
      success: true,
      bitrixData: bitrixData
    });
  } catch (error) {
    console.error('[TRANSFORM API] Error transforming order:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to transform order',
      message: error.message
    });
  }
}

