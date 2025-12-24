// API endpoint to upload shopify_all_and_qty_not_zero.json file
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb', // Allow large JSON files
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { products } = req.body;

    if (!products || !Array.isArray(products)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid data',
        message: 'Products array is required'
      });
    }

    // Ensure .data directory exists
    const dataDir = join(process.cwd(), '.data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Save file
    const filePath = join(dataDir, 'shopify_all_and_qty_not_zero.json');
    writeFileSync(filePath, JSON.stringify(products, null, 2), 'utf-8');

    console.log(`[DATA UPLOAD] Saved ${products.length} products to ${filePath}`);

    return res.status(200).json({
      success: true,
      message: `Successfully uploaded ${products.length} products`,
      filePath: filePath,
      count: products.length
    });
  } catch (error) {
    console.error('[DATA UPLOAD] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Upload failed',
      message: error.message
    });
  }
}

