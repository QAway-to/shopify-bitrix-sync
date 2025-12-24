// API endpoint to get catalog sections from Bitrix
import { callBitrix } from '../../../src/lib/bitrix/client.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Get catalog ID from query (default: 14)
    const catalogId = req.query.catalogId ? parseInt(req.query.catalogId) : 14;

    console.log(`[GET SECTIONS] Fetching sections for catalog ${catalogId}...`);

    // Get sections from Bitrix catalog
    const response = await callBitrix('catalog.section.list', {
      filter: {
        CATALOG_ID: catalogId
      },
      select: ['ID', 'NAME', 'CODE'],
      order: {
        SORT: 'ASC',
        NAME: 'ASC'
      }
    });

    if (response.result) {
      const sections = response.result.map(section => ({
        id: parseInt(section.ID),
        name: section.NAME || `Section ${section.ID}`,
        code: section.CODE || ''
      }));

      console.log(`[GET SECTIONS] Found ${sections.length} sections`);

      return res.status(200).json({
        success: true,
        catalogId: catalogId,
        sections: sections
      });
    } else {
      throw new Error('No result in Bitrix API response');
    }
  } catch (error) {
    console.error('[GET SECTIONS] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch sections',
      message: error.message
    });
  }
}

