// API endpoint for syncing certificates from Shopify to Bitrix
import { getCertificatesData } from '../../../src/lib/shopify/inventory.js';
import { syncCertificateVariant } from '../../../src/lib/bitrix/products.js';

// Handle mapping for certificates (from handleMapping.json)
const CERTIFICATE_HANDLES = {
  'e-certificate': 3162,
  'gift-certificate-fbfc': 3408,
  'printed-gift-certificate': 3160
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log(JSON.stringify({
    event: 'SYNC_CERTIFICATES_START',
    requestId,
    timestamp: new Date().toISOString()
  }));

  try {
    // 1. Get certificates data from Shopify
    console.log(`[SYNC CERTIFICATES] Fetching certificates data from Shopify...`);
    const certificatesData = await getCertificatesData();

    const results = {
      success: true,
      requestId,
      certificates: {},
      summary: {
        total: 0,
        created: 0,
        updated: 0,
        errors: 0
      }
    };

    // 2. Sync each certificate
    for (const [handle, variants] of Object.entries(certificatesData)) {
      if (!variants || variants.length === 0) {
        console.warn(`[SYNC CERTIFICATES] No variants found for handle: ${handle}`);
        results.certificates[handle] = {
          success: false,
          error: 'No variants found',
          variants: []
        };
        continue;
      }

      console.log(`[SYNC CERTIFICATES] Syncing ${variants.length} variants for handle: ${handle}`);

      const handleResults = {
        handle: handle,
        variants: [],
        success: true,
        errors: []
      };

      // Sync each variant
      for (const variant of variants) {
        try {
          const syncResult = await syncCertificateVariant(
            variant,
            handle,
            CERTIFICATE_HANDLES
          );

          handleResults.variants.push(syncResult);
          results.summary.total++;

          if (syncResult.success) {
            if (syncResult.documentId) {
              results.summary.created++;
            } else {
              results.summary.updated++;
            }
          } else {
            results.summary.errors++;
            handleResults.errors.push({
              sku: syncResult.sku,
              error: syncResult.error
            });
          }

          // Rate limiting between variants
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`[SYNC CERTIFICATES] Error syncing variant:`, error);
          results.summary.errors++;
          handleResults.errors.push({
            variant_title: variant.variant_title,
            error: error.message
          });
        }
      }

      if (handleResults.errors.length > 0) {
        handleResults.success = false;
      }

      results.certificates[handle] = handleResults;
    }

    console.log(JSON.stringify({
      event: 'SYNC_CERTIFICATES_SUCCESS',
      requestId,
      summary: results.summary,
      timestamp: new Date().toISOString()
    }));

    return res.status(200).json(results);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'SYNC_CERTIFICATES_ERROR',
      requestId,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }));

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      requestId
    });
  }
}

