// API endpoint for syncing certificates from Shopify to Bitrix
import { getCertificatesData } from '../../../src/lib/shopify/inventory.js';
import { syncCertificateVariant, refreshBitrixMappingsFromCatalog } from '../../../src/lib/bitrix/products.js';

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

  // Check action: 'create' for creating new products, default is 'sync' (update quantities)
  const action = req.query.action || 'sync';
  const isCreateAction = action === 'create';

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
        updated: 0, // Only show updated quantities (no "created" - that's for "Create" button)
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
            CERTIFICATE_HANDLES,
            isCreateAction // createNew: true for "create", false for "sync"
          );

          handleResults.variants.push(syncResult);
          results.summary.total++;

          if (syncResult.success) {
            // Only count as "updated" if quantity was actually synced (documentId means quantity changed)
            // If documentId is null, quantities already matched - don't count as updated
            if (syncResult.documentId) {
              results.summary.updated++;
            }
            // If no documentId, quantities matched - don't count (silent success)
          } else {
            results.summary.errors++;
            handleResults.errors.push({
              sku: syncResult.sku,
              error: syncResult.error
            });
          }

          // Rate limiting between variants (optimized: reduced from 500ms to 100ms)
          await new Promise(resolve => setTimeout(resolve, 100));
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

    // If this was a create action, refresh mappings from Bitrix catalog after creation
    if (isCreateAction) {
      try {
        const mappingRefresh = await refreshBitrixMappingsFromCatalog();
        results.mappingRefresh = mappingRefresh;
        console.log(`[SYNC CERTIFICATES] ✅ Mapping refreshed after create:`, mappingRefresh);
      } catch (mapErr) {
        console.error(`[SYNC CERTIFICATES] ⚠️ Failed to refresh mappings after create:`, mapErr);
        results.mappingRefresh = { success: false, error: mapErr.message };
      }
    }

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

