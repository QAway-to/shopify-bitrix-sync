/**
 * Inventory Sync Core Module
 * Ported from sync_inventory_batch.py
 * 
 * Features:
 * - Syncs products from Shopify to Bitrix by section (A-F, G-M, N-S, T-Z)
 * - Updates NAME, PRICE, DESCRIPTION, PROPERTIES (Size, Brand, Category, Color)
 * - Creates stock adjustment documents for quantity changes
 * - Logs progress every 5 minutes
 */

import { logger } from '../logging/logger.js';
import { getValidAccessToken } from '../shopify/adminClient.js';

// ============ SECTION MAPPING ============
export const SECTION_MAP = {
    'category-a-f': 36,
    'category-g-m': 38,
    'category-n-s': 40,
    'category-t-z': 42,
};

export const SECTION_NAMES = {
    36: 'A-F',
    38: 'G-M',
    40: 'N-S',
    42: 'T-Z',
};

// ============ PROPERTY MAPPING ============
export const PROPERTIES = {
    SIZE: 98,
    BRAND: 102,
    CATEGORY: 104,
    COLOR: 106,
};

// ============ SIZE ENUM MAPPING ============
const SIZE_ENUM_MAP = {
    "20": 154, "21": 156, "22": 158, "23": 160, "24": 162,
    "25": 164, "26": 166, "27": 168, "28": 170, "29": 172,
    "30": 174, "31": 176, "32": 178, "33": 320, "34": 322,
    "35": 324, "36": 326, "37": 328, "38": 330, "39": 332,
    "40": 334, "41": 336, "42": 338, "43": 340, "44": 342,
    "45": 344, "46": 346, "47": 348, "48": 350, "49": 352,
    "50": 354, "51": 356, "52": 358, "53": 360, "54": 362
};

// ============ CREDENTIALS ============
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "83bfa8-c4.myshopify.com";
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK_BASE;

// ============ UTILITIES ============
function getSizeEnumId(sizeText) {
    if (!sizeText) return null;
    const clean = String(sizeText).trim();
    return SIZE_ENUM_MAP[clean] || null;
}

function getCategoryBySku(sku) {
    if (!sku) return 'category-g-m';
    const firstChar = sku[0].toLowerCase();
    if (firstChar >= 'a' && firstChar <= 'f') return 'category-a-f';
    if (firstChar >= 'g' && firstChar <= 'm') return 'category-g-m';
    if (firstChar >= 'n' && firstChar <= 's') return 'category-n-s';
    if (firstChar >= 't' && firstChar <= 'z') return 'category-t-z';
    return 'category-g-m';
}

function getSectionIdBySku(sku) {
    return SECTION_MAP[getCategoryBySku(sku)] || 38;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ SHOPIFY API ============
async function fetchShopifyProducts(progressCallback) {
    const allVariants = [];
    let pageInfo = null;
    let hasNext = true;
    const startTime = Date.now();
    let productCount = 0;

    progressCallback?.({ type: 'shopify_start', message: 'Fetching products from Shopify...' });

    while (hasNext) {
        let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250`;
        if (pageInfo) url += `&page_info=${pageInfo}`;

        const response = await fetch(url, {
            headers: {
                'X-Shopify-Access-Token': await getValidAccessToken(),
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Shopify API error: ${response.status}`);
        }

        const data = await response.json();
        const products = data.products || [];
        productCount += products.length;

        // Process products to variants
        for (const product of products) {
            const productVendor = product.vendor || '';
            const productType = product.product_type || '';
            const bodyHtml = product.body_html || '';

            // Dynamic option mapping
            let sizeIndex = -1;
            let colorIndex = -1;

            for (let i = 0; i < (product.options || []).length; i++) {
                const name = (product.options[i].name || '').toLowerCase();
                if (name.includes('size') || name.includes('размер') || name.includes('eu size')) {
                    sizeIndex = i;
                } else if (name.includes('color') || name.includes('colour') || name.includes('цвет')) {
                    colorIndex = i;
                }
            }

            for (const variant of (product.variants || [])) {
                const vid = String(variant.id);
                const qty = variant.inventory_quantity || 0;

                let sizeVal = sizeIndex >= 0 ? variant[`option${sizeIndex + 1}`] : '';
                let colorVal = colorIndex >= 0 ? variant[`option${colorIndex + 1}`] : '';

                // Fallback: use variant title as size if not Default Title
                if (!sizeVal && variant.title && variant.title !== 'Default Title') {
                    sizeVal = variant.title;
                }

                allVariants.push({
                    product_id: product.id,
                    product_title: product.title,
                    variant_id: vid,
                    variant_title: variant.title || '',
                    sku: variant.sku || '',
                    price: parseFloat(variant.price || 0),
                    qty,
                    brand: productVendor,
                    category: productType,
                    color: colorVal,
                    size: sizeVal,
                    description: bodyHtml
                });
            }
        }

        // Parse pagination
        hasNext = false;
        pageInfo = null;
        const linkHeader = response.headers.get('Link') || '';

        if (linkHeader.includes('rel="next"')) {
            const links = linkHeader.split(',');
            for (const link of links) {
                if (link.includes('rel="next"') && link.includes('page_info=')) {
                    try {
                        pageInfo = link.split('page_info=')[1].split('>')[0];
                        hasNext = true;
                    } catch (e) {
                        logger.warn('pagination_restart', 'pageInfo parse failed, restarting pagination', { page: pageInfo });
                    }
                    break;
                }
            }
        }
    }

    progressCallback?.({
        type: 'shopify_done',
        message: `Fetched ${allVariants.length} variants from ${productCount} products`,
        variantsCount: allVariants.length,
        productCount
    });

    return allVariants;
}

// ============ BITRIX API ============
async function callBitrix(method, params = {}) {
    const url = `${BITRIX_WEBHOOK}${method}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    });
    return response.json();
}

async function callBatch(commands, haltOnError = false) {
    if (!commands || Object.keys(commands).length === 0) return {};
    const response = await fetch(`${BITRIX_WEBHOOK}batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ halt: haltOnError ? 1 : 0, cmd: commands })
    });
    return response.json();
}

async function executeBatches(commands, batchSize = 50) {
    const total = commands.length;
    for (let i = 0; i < total; i += batchSize) {
        const chunk = commands.slice(i, i + batchSize);
        const batchCmd = {};
        chunk.forEach((item, j) => {
            batchCmd[`cmd_${j}`] = item.cmd;
        });

        try {
            await callBatch(batchCmd);
        } catch (e) {
            console.error(`[BATCH] Error:`, e.message);
        }

        await sleep(500);
    }
}

async function fetchBitrixProducts(progressCallback) {
    const allProducts = {};
    let start = 0;

    progressCallback?.({ type: 'bitrix_start', message: 'Indexing Bitrix products...' });

    while (true) {
        const resp = await callBitrix('crm.product.list', {
            select: ['ID', 'PRICE', 'XML_ID', 'NAME', 'PROPERTY_98', 'PROPERTY_102', 'DETAIL_TEXT', 'SECTION_ID'],
            start
        });

        const items = resp.result || [];
        if (items.length === 0) break;

        for (const item of items) {
            if (item.XML_ID) {
                allProducts[item.XML_ID] = item;
            }
        }

        if (items.length < 50) break;
        start = resp.next;
        if (!start) break;
    }

    progressCallback?.({
        type: 'bitrix_done',
        message: `Indexed ${Object.keys(allProducts).length} Bitrix products`,
        count: Object.keys(allProducts).length
    });

    return allProducts;
}

async function getCurrentStocks(productIds, storeId = 2) {
    // Returns { pid: { amount, reserved } } for each product
    const stocks = {};
    const commands = productIds.map(pid => ({
        key: String(pid),
        cmd: `catalog.storeproduct.list?filter[productId]=${pid}`
    }));

    for (let i = 0; i < commands.length; i += 50) {
        const chunk = commands.slice(i, i + 50);
        const batchCmd = {};
        chunk.forEach(item => { batchCmd[item.key] = item.cmd; });

        const resp = await callBatch(batchCmd);
        const results = resp?.result?.result || {};

        for (const [key, data] of Object.entries(results)) {
            const pid = parseInt(key);
            let amount = 0;
            let reserved = 0;

            if (data?.storeProducts) {
                for (const sp of data.storeProducts) {
                    const sid = parseInt(sp.storeId || sp.STORE_ID || 0);
                    if (sid === storeId) {
                        amount = parseInt(sp.amount || sp.AMOUNT || 0);
                        reserved = parseInt(sp.quantityReserved || sp.QUANTITY_RESERVED || 0);
                        break;
                    }
                }
            }
            stocks[pid] = { amount, reserved };
        }
    }

    return stocks;
}

async function createStockDocument(items, docType, title) {
    if (!items || items.length === 0) return null;

    // Create document
    const docResp = await callBitrix('catalog.document.add', {
        fields: {
            docType,
            title,
            responsibleId: 52,
            currency: 'EUR'
        }
    });

    const docId = docResp?.result?.document?.id;
    if (!docId) {
        console.error('[STOCK] Failed to create document:', docResp);
        return null;
    }

    // Add elements
    const storeField = docType === 'D' ? 'storeFrom' : 'storeTo';
    const commands = items.map(item => ({
        cmd: `catalog.document.element.add?fields[docId]=${docId}&fields[elementId]=${item.id}&fields[amount]=${item.amount}&fields[purchasingPrice]=0&fields[${storeField}]=2`
    }));

    await executeBatches(commands);

    // Conduct document
    await callBitrix('catalog.document.conduct', { id: docId });

    return docId;
}

// ============ MAIN SYNC FUNCTION ============
/**
 * Run full inventory sync for specified sections
 * @param {Object} options 
 * @param {number[]} options.sectionIds - Section IDs to sync [36, 38, 40, 42]
 * @param {Function} options.progressCallback - Callback for progress updates
 * @returns {Object} Sync results
 */
export async function runInventorySync(options = {}) {
    const {
        sectionIds = [36, 38, 40, 42],
        progressCallback
    } = options;

    const startTime = Date.now();
    const results = {
        success: true,
        sections: {},
        totals: {
            created: 0,
            updated: 0,
            priceUpdated: 0,
            descUpdated: 0,
            stockAdjusted: 0,
            skipped: 0,
            errors: 0
        },
        duration: 0
    };

    try {
        progressCallback?.({
            type: 'sync_start',
            message: `Starting sync for sections: ${sectionIds.map(id => SECTION_NAMES[id]).join(', ')}`,
            sectionIds
        });
        logger.info('inventory_sync_started', 'Inventory sync started', { sectionId: sectionIds });

        // 1. Fetch all Shopify products
        const shopifyVariants = await fetchShopifyProducts(progressCallback);

        // 2. Fetch all Bitrix products
        const bitrixProducts = await fetchBitrixProducts(progressCallback);

        // 3. Process each section
        for (const sectionId of sectionIds) {
            const sectionName = SECTION_NAMES[sectionId] || String(sectionId);
            const sectionResult = await syncSection(sectionId, shopifyVariants, bitrixProducts, progressCallback);

            results.sections[sectionId] = sectionResult;

            // Aggregate totals
            results.totals.created += sectionResult.created;
            results.totals.updated += sectionResult.updated;
            results.totals.priceUpdated += sectionResult.priceUpdated;
            results.totals.descUpdated += sectionResult.descUpdated;
            results.totals.stockAdjusted += sectionResult.stockAdjusted;
            results.totals.skipped += sectionResult.skipped;
            results.totals.errors += sectionResult.errors;

            progressCallback?.({
                type: 'section_complete',
                sectionId,
                sectionName,
                result: sectionResult
            });
        }

        results.duration = Date.now() - startTime;

        progressCallback?.({
            type: 'sync_complete',
            message: `Sync complete in ${Math.round(results.duration / 1000)}s`,
            results
        });
        logger.info('inventory_sync_completed', 'Inventory sync done', { processed: results.totals, duration_ms: results.duration });

        return results;

    } catch (error) {
        results.success = false;
        results.error = error.message;
        results.duration = Date.now() - startTime;

        progressCallback?.({
            type: 'sync_error',
            message: error.message,
            error
        });
        logger.error('inventory_sync_failed', 'Inventory sync failed', { error: error.message, sectionId: sectionIds });

        return results;
    }
}

async function syncSection(sectionId, allVariants, bitrixProducts, progressCallback) {
    const sectionName = SECTION_NAMES[sectionId] || String(sectionId);
    const result = {
        sectionId,
        sectionName,
        total: 0,
        created: 0,
        updated: 0,
        priceUpdated: 0,
        descUpdated: 0,
        stockAdjusted: 0,
        skipped: 0,
        errors: 0,
        // Detailed logs (first 10 samples each)
        updatedSamples: [],
        skippedSamples: [],
        createdSamples: [],
        stockChanges: [],
        errorSamples: []
    };

    progressCallback?.({
        type: 'section_start',
        sectionId,
        sectionName,
        message: `Processing section ${sectionName}...`
    });

    // Filter variants for this section
    const sectionVariants = allVariants.filter(v => {
        const sku = v.sku || '';
        return getSectionIdBySku(sku) === sectionId;
    });

    result.total = sectionVariants.length;

    // Build variant map
    const variantMap = {};
    sectionVariants.forEach(v => { variantMap[v.variant_id] = v; });

    const updateCommands = [];
    const descriptionUpdates = [];
    const createPayloads = [];
    const ensureStockIds = [];

    // Plan updates
    for (const [vid, variant] of Object.entries(variantMap)) {
        const sPrice = variant.price;

        // Build properties
        const props = {};
        if (variant.size) {
            const enumId = getSizeEnumId(variant.size);
            if (enumId) props[`PROPERTY_${PROPERTIES.SIZE}`] = enumId;
        }
        if (variant.brand) props[`PROPERTY_${PROPERTIES.BRAND}`] = variant.brand;
        if (variant.category) props[`PROPERTY_${PROPERTIES.CATEGORY}`] = variant.category;
        if (variant.color) props[`PROPERTY_${PROPERTIES.COLOR}`] = variant.color;

        if (bitrixProducts[vid]) {
            // UPDATE existing product
            const bProd = bitrixProducts[vid];
            const pid = bProd.ID;
            const updates = [];

            // Name check
            let shopifyName = `${variant.product_title} - ${variant.variant_title}`;
            if (variant.variant_title === 'Default Title' || !variant.variant_title) {
                shopifyName = variant.product_title;
            }
            const bName = bProd.NAME || '';
            if (bName !== shopifyName) {
                updates.push(`fields[NAME]=${encodeURIComponent(shopifyName)}`);
            }

            // Description check
            const sDesc = (variant.description || '').trim();
            const bDesc = (bProd.DETAIL_TEXT || '').trim();
            if (sDesc !== bDesc) {
                descriptionUpdates.push({ id: pid, desc: sDesc });
                result.descUpdated++;
            }

            // Price check
            const bPrice = parseFloat(bProd.PRICE || 0);
            if (Math.abs(bPrice - sPrice) > 0.01) {
                updates.push(`fields[PRICE]=${sPrice}`);
                result.priceUpdated++;
            }

            // Properties (always update for targeted sections)
            for (const [pKey, pVal] of Object.entries(props)) {
                updates.push(`fields[${pKey}]=${encodeURIComponent(String(pVal))}`);
            }

            if (updates.length > 0) {
                updateCommands.push({
                    cmd: `crm.product.update?id=${pid}&${updates.join('&')}`
                });
                result.updated++;
                // Sample updated items
                if (result.updatedSamples.length < 10) {
                    const changes = [];
                    if (bName !== shopifyName) changes.push('NAME');
                    if (Math.abs(bPrice - sPrice) > 0.01) changes.push(`PRICE: ${bPrice}→${sPrice}`);
                    if (Object.keys(props).length > 0) changes.push('PROPS');
                    result.updatedSamples.push({ sku: variant.sku, pid, changes: changes.join(', ') });
                }
            } else {
                result.skipped++;
                // Sample skipped items (already in sync)
                if (result.skippedSamples.length < 10) {
                    result.skippedSamples.push({ sku: variant.sku, pid, reason: 'Already in sync' });
                }
            }

            ensureStockIds.push(parseInt(pid));

        } else {
            // CREATE new product (only if qty > 0)
            if (variant.qty <= 0) {
                result.skipped++;
                // Sample skipped: no stock
                if (result.skippedSamples.length < 10) {
                    result.skippedSamples.push({ sku: variant.sku, reason: 'qty=0, not in Bitrix' });
                }
                continue;
            }

            createPayloads.push({
                NAME: `${variant.product_title}${variant.variant_title && variant.variant_title !== 'Default Title' ? ' - ' + variant.variant_title : ''}`,
                PRICE: variant.price,
                CURRENCY_ID: 'EUR',
                CATALOG_ID: 14,
                SECTION_ID: sectionId,
                CODE: variant.sku,
                XML_ID: vid,
                ACTIVE: 'Y',
                DETAIL_TEXT: variant.description || '',
                DETAIL_TEXT_TYPE: 'html',
                ...props
            });
        }
    }

    // Execute product updates
    if (updateCommands.length > 0) {
        await executeBatches(updateCommands);
    }

    // Execute description updates
    if (descriptionUpdates.length > 0) {
        const descCmds = descriptionUpdates.map(item => ({
            cmd: `catalog.product.update?id=${item.id}&fields[detailText]=${encodeURIComponent(item.desc)}&fields[detailTextType]=html`
        }));
        await executeBatches(descCmds);
    }

    for (const fields of createPayloads) {
        try {
            const resp = await callBitrix('crm.product.add', { fields });
            if (resp.result) {
                ensureStockIds.push(parseInt(resp.result));
                result.created++;
                // Sample created
                if (result.createdSamples.length < 10) {
                    result.createdSamples.push({ sku: fields.CODE, pid: resp.result, name: fields.NAME });
                }
            } else {
                result.errors++;
                if (result.errorSamples.length < 10) {
                    result.errorSamples.push({ sku: fields.CODE, error: JSON.stringify(resp).slice(0, 100) });
                }
            }
        } catch (e) {
            result.errors++;
            if (result.errorSamples.length < 10) {
                result.errorSamples.push({ sku: fields.CODE, error: e.message });
            }
        }
    }

    // Stock sync - now handles reserved quantity to prevent negative available stock
    if (ensureStockIds.length > 0) {
        const currentStocks = await getCurrentStocks(ensureStockIds);

        const arrivalItems = [];
        const deductItems = [];

        for (const [pidStr, stockInfo] of Object.entries(currentStocks)) {
            const pid = parseInt(pidStr);
            const bxAmount = stockInfo.amount || 0;
            const bxReserved = stockInfo.reserved || 0;

            // Find variant for this product
            let targetQty = 0;
            for (const [vid, bProd] of Object.entries(bitrixProducts)) {
                if (parseInt(bProd.ID) === pid) {
                    const variant = variantMap[vid];
                    if (variant) targetQty = variant.qty;
                    break;
                }
            }

            // Calculate required amount:
            // - We need at least targetQty (from Shopify)
            // - BUT also need to cover any reservations to avoid negative available
            const minRequired = Math.max(targetQty, bxReserved);
            const diff = minRequired - bxAmount;

            if (diff > 0) {
                arrivalItems.push({ id: pid, amount: diff });
            } else if (targetQty < bxAmount && bxReserved === 0) {
                // Only deduct if no reservations exist (safe to reduce stock)
                deductItems.push({ id: pid, amount: bxAmount - targetQty });
            }
        }

        if (arrivalItems.length > 0) {
            await createStockDocument(arrivalItems, 'S', `Sync Arrival ${sectionName}`);
            result.stockAdjusted += arrivalItems.length;
            // Sample stock arrivals
            for (const item of arrivalItems.slice(0, 5)) {
                result.stockChanges.push({ pid: item.id, type: 'arrival', amount: `+${item.amount}` });
            }
        }

        if (deductItems.length > 0) {
            await createStockDocument(deductItems, 'D', `Sync Deduct ${sectionName}`);
            result.stockAdjusted += deductItems.length;
            // Sample stock deductions
            for (const item of deductItems.slice(0, 5)) {
                result.stockChanges.push({ pid: item.id, type: 'deduct', amount: `-${item.amount}` });
            }
        }
    }

    return result;
}

export default {
    runInventorySync,
    SECTION_MAP,
    SECTION_NAMES,
    PROPERTIES
};
