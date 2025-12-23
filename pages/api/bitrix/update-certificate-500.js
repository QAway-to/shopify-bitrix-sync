import { getCertificatesData } from '../../../src/lib/shopify/inventory.js';
import { updateBitrixProductFields } from '../../../src/lib/bitrix/products.js';

// Hardcoded target product in Bitrix for E-Certificate 500$
const TARGET_PRODUCT_ID = 4284;
const TARGET_HANDLE = 'e-certificate';
const TARGET_VARIANT_MATCH = '500'; // match in variant title or price

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    // 1. Fetch certificates data from Shopify
    const certificates = await getCertificatesData();
    const variants = certificates[TARGET_HANDLE] || [];

    if (!variants.length) {
      return res.status(404).json({ success: false, error: 'No variants found for e-certificate' });
    }

    // 2. Find variant that corresponds to 500
    const variant = variants.find(v => {
      const title = (v.variant_title || '').toLowerCase();
      const price = Number(v.price || 0);
      return title.includes(TARGET_VARIANT_MATCH) || price === 500 || title.includes('500$') || title.includes('500€');
    });

    if (!variant) {
      return res.status(404).json({ success: false, error: 'Variant 500 not found in Shopify' });
    }

    // 3. Prepare fields for Bitrix update
    const skuFromVariant = variant.sku && variant.sku.trim();
    const fallbackSku = `${variant.product_handle || TARGET_HANDLE}-${(variant.variant_title || '500').toString().trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/gi, '')}`;
    const sku = skuFromVariant || fallbackSku;

    const fields = {
      NAME: `${variant.product_title} - ${variant.variant_title || '500'}`,
      PRICE: Number(variant.price || 0),
      CURRENCY_ID: 'EUR', // store currency (adjust if needed)
      CODE: sku,
      XML_ID: sku,
      ACTIVE: 'Y',
      VAT_INCLUDED: 'N',
      MEASURE: 1
    };

    // 4. Update product in Bitrix
    const updated = await updateBitrixProductFields(TARGET_PRODUCT_ID, fields);

    if (!updated) {
      return res.status(500).json({ success: false, error: 'Bitrix update returned false' });
    }

    return res.status(200).json({
      success: true,
      productId: TARGET_PRODUCT_ID,
      fields,
      variant
    });
  } catch (error) {
    console.error('[UPDATE CERTIFICATE 500] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update certificate product',
      message: error.message
    });
  }
}

