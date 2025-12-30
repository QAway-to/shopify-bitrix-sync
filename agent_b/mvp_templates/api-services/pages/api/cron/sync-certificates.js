// Server-side cron endpoint for automatic certificate synchronization
// Should be called every hour via external cron service (e.g., cron-job.org, EasyCron)
// Or via Render/Vercel cron configuration

import { getCertificatesData } from '../../../src/lib/shopify/inventory.js';
import { syncCertificateVariant } from '../../../src/lib/bitrix/products.js';

// Handle mapping for certificates (from handleMapping.json)
const CERTIFICATE_HANDLES = {
  'e-certificate': 3162,
  'gift-certificate-fbfc': 3408,
  'printed-gift-certificate': 3160
};

export default async function handler(req, res) {
  // Verify cron secret (optional but recommended)
  const cronSecret = req.headers['x-cron-secret'] || req.query.secret;
  const expectedSecret = process.env.CRON_SECRET;
  
  if (expectedSecret && cronSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log(JSON.stringify({
    event: 'CRON_SYNC_CERTIFICATES_START',
    requestId,
    timestamp: new Date().toISOString(),
    source: 'cron'
  }));

  try {
    // 1. Get certificates data from Shopify
    console.log(`[CRON SYNC] Fetching certificates data from Shopify...`);
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

    // 2. Sync each certificate (only update quantities, don't create new products)
    for (const [handle, variants] of Object.entries(certificatesData)) {
      if (!variants || variants.length === 0) {
        console.warn(`[CRON SYNC] No variants found for handle: ${handle}`);
        results.certificates[handle] = {
          success: false,
          error: 'No variants found',
          variants: []
        };
        continue;
      }

      console.log(`[CRON SYNC] Syncing ${variants.length} variants for handle: ${handle}`);

      const handleResults = {
        handle: handle,
        variants: [],
        success: true,
        errors: []
      };

      // Sync each variant (only update quantities)
      for (const variant of variants) {
        try {
          // For cron sync, we only update quantities (create incoming documents)
          // Products should already exist from manual "Create" action
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
          console.error(`[CRON SYNC] Error syncing variant:`, error);
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
      event: 'CRON_SYNC_CERTIFICATES_SUCCESS',
      requestId,
      summary: results.summary,
      timestamp: new Date().toISOString()
    }));

    return res.status(200).json(results);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'CRON_SYNC_CERTIFICATES_ERROR',
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

