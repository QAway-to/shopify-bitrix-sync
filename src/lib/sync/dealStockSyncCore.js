/**
 * Deal Stock Sync Core Module
 * 
 * Ensures all active deals have required product quantities in stock.
 * Runs after inventory sync to guarantee deals can be closed.
 * 
 * Logic:
 * 1. Get all active deals (not LOSE, not WON)
 * 2. For each deal → get product rows (PRODUCT_ID, QUANTITY)
 * 3. Check current stock in Bitrix
 * 4. If stock < required → create incoming document to add difference
 */

import { BITRIX_CONFIG } from '../bitrix/config.js';

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK_BASE || "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/";
const STORE_ID = 2;

// Shipping ("ACS delivery") rides along as an ordinary Bitrix product row, but it is a
// service product type. A store document that references it cannot be conducted — Bitrix
// rejects it with "Inventory object refers to incorrect product type ID" — so the document
// is left in status 'N' forever and never adds stock. It must be skipped here, exactly as
// the quantity-sync paths skip it.
const SHIPPING_PRODUCT_ID = BITRIX_CONFIG.SHIPPING_PRODUCT_ID;

// Rate limiting: delay between API calls (ms)
const API_DELAY_MS = 600; // Bitrix allows ~2 requests/second

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Call Bitrix API with retry on rate limit
 */
async function callBitrix(method, params = {}, retries = 3) {
    const url = `${BITRIX_WEBHOOK}${method.replace(/^\//, '')}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        const data = await response.json();

        // Rate limit hit - wait and retry
        if (data.error === 'QUERY_LIMIT_EXCEEDED') {
            if (attempt < retries) {
                await sleep(2000 * attempt); // Exponential backoff
                continue;
            }
        }

        return data;
    }
}

// Active stages to check (not LOSE, not WON)
const ACTIVE_STAGE_PREFIXES = ['NEW', 'C', 'PREPAYMENT', 'UC_']; // NEW, C1/C2/C3/C4/C5, PREPAYMENT, custom stages
const SKIP_STAGES = ['WON', 'LOSE', 'APOLOGY'];

/**
 * Check if stage is active (deal that needs stock)
 */
function isActiveStage(stageId) {
    if (!stageId) return false;

    // Skip known closed stages
    for (const skip of SKIP_STAGES) {
        if (stageId.includes(skip)) return false;
    }

    // Check if starts with active prefix
    for (const prefix of ACTIVE_STAGE_PREFIXES) {
        if (stageId.startsWith(prefix)) return true;
    }

    // Default: treat as active (safer)
    return true;
}

/**
 * Get all active deals with their product rows
 */
async function getActiveDealsWithProducts(progressCallback) {
    progressCallback?.({ type: 'info', message: 'Fetching active deals...' });

    const allDeals = [];
    let start = 0;

    while (true) {
        const resp = await callBitrix('crm.deal.list', {
            select: ['ID', 'TITLE', 'STAGE_ID'],
            filter: {},
            // Newest deals first: this job is long and can be cut short by a restart, so the
            // deals managers are actively trying to close today must be served before old ones.
            order: { ID: 'DESC' },
            start
        });

        await sleep(API_DELAY_MS);

        if (resp.result && resp.result.length > 0) {
            const activeDeals = resp.result.filter(d => isActiveStage(d.STAGE_ID));
            allDeals.push(...activeDeals);
        }

        if (resp.next) {
            start = resp.next;
        } else {
            break;
        }
    }

    progressCallback?.({ type: 'info', message: `Found ${allDeals.length} active deals` });

    // Fetch product rows for each deal
    const dealsWithProducts = [];

    for (const deal of allDeals) {
        const rowsResp = await callBitrix('crm.deal.productrows.get', { id: deal.ID });
        await sleep(API_DELAY_MS);

        const rows = rowsResp.result || [];

        // Filter valid product rows (PRODUCT_ID > 0)
        const validRows = rows.filter(r => parseInt(r.PRODUCT_ID) > 0);

        if (validRows.length > 0) {
            dealsWithProducts.push({
                ...deal,
                productRows: validRows
            });
        }
    }

    progressCallback?.({ type: 'info', message: `${dealsWithProducts.length} deals have valid products` });

    return dealsWithProducts;
}

/**
 * Get current stock for a product at STORE_ID.
 * Returns both physical amount and the quantity reserved by deals. Bitrix blocks closing a
 * deal on `available = amount - reserved`, not on `amount` alone, so the caller needs both.
 * @returns {Promise<{ amount: number, reserved: number }>}
 */
async function getCurrentStock(productId) {
    const resp = await callBitrix('catalog.storeproduct.list', {
        filter: { productId: productId, storeId: STORE_ID },
        select: ['amount', 'quantityReserved']
    });
    await sleep(API_DELAY_MS);
    const row = resp.result?.storeProducts?.[0];
    return {
        amount: parseFloat(row?.amount ?? row?.AMOUNT ?? 0),
        // Tolerate either field casing, mirroring inventorySyncCore's getCurrentStocks.
        reserved: parseFloat(row?.quantityReserved ?? row?.QUANTITY_RESERVED ?? 0)
    };
}

/**
 * Create incoming document to add stock
 */
async function createIncomingDocument(productId, amount, dealId) {
    const docNumber = `DEAL-${dealId}-${Date.now()}`;

    // 1. Create document
    const docResp = await callBitrix('catalog.document.add', {
        fields: {
            docType: 'S',
            title: `Обеспечение сделки ${dealId} (Product ${productId})`,
            docNumber: docNumber,
            currency: 'EUR',
            status: 'N',
            responsibleId: 52
        }
    });
    await sleep(API_DELAY_MS);

    const docId = docResp.result?.document?.id || docResp.result;
    if (!docId) {
        throw new Error('Failed to create document: ' + JSON.stringify(docResp));
    }

    // 2. Add product
    const elemResp = await callBitrix('catalog.document.element.add', {
        fields: {
            docId: docId,
            DOC_ID: docId,
            productId: productId,
            elementId: productId,
            ELEMENT_ID: productId,
            amount: amount,
            AMOUNT: amount,
            purchasingPrice: 0,
            PURCHASING_PRICE: 0,
            storeId: STORE_ID,
            storeTo: STORE_ID,
            STORE_TO: STORE_ID
        }
    });
    await sleep(API_DELAY_MS);

    if (!elemResp.result) {
        throw new Error('Failed to add product: ' + JSON.stringify(elemResp));
    }

    // 3. Conduct
    const conductResp = await callBitrix('catalog.document.conduct', { id: docId });
    await sleep(API_DELAY_MS);

    if (conductResp.result === true) {
        return { docId, docNumber };
    } else {
        throw new Error('Failed to conduct: ' + JSON.stringify(conductResp));
    }
}

/**
 * Run deal stock sync
 * @param {Object} options
 * @param {Function} options.progressCallback - Progress callback
 * @returns {Object} Sync results
 */
export async function runDealStockSync(options = {}) {
    const { progressCallback } = options;

    const startTime = Date.now();
    const results = {
        success: true,
        dealsChecked: 0,
        productsChecked: 0,
        stockOk: 0,
        stockAdded: 0,
        stockFailed: 0,
        skipped: 0,
        shippingSkipped: 0,
        documents: [],
        errors: []
    };

    try {
        progressCallback?.({ type: 'start', message: 'Starting Deal Stock Sync...' });

        // Get active deals with products
        const deals = await getActiveDealsWithProducts(progressCallback);
        results.dealsChecked = deals.length;

        // Process each deal
        for (const deal of deals) {
            for (const row of deal.productRows) {
                results.productsChecked++;

                const productId = parseInt(row.PRODUCT_ID);
                const requiredQty = parseFloat(row.QUANTITY);
                const productName = row.PRODUCT_NAME || `Product ${productId}`;

                // Skip invalid product IDs
                if (!productId || productId <= 0) {
                    results.skipped++;
                    continue;
                }

                // Skip the shipping line — it is a service product and cannot be stocked.
                if (productId === SHIPPING_PRODUCT_ID) {
                    results.shippingSkipped++;
                    continue;
                }

                try {
                    const { amount, reserved } = await getCurrentStock(productId);

                    // The deal reserves `requiredQty`; Bitrix lets it close only when
                    // available (amount - reserved) >= 0. Top up just enough to reach that,
                    // guarding the case where the reservation has not been counted yet.
                    const target = Math.max(reserved, requiredQty);
                    const deficit = target - amount;

                    if (deficit <= 0) {
                        results.stockOk++;
                    } else {
                        try {
                            const doc = await createIncomingDocument(productId, deficit, deal.ID);
                            results.stockAdded++;
                            results.documents.push({
                                dealId: deal.ID,
                                productId,
                                productName,
                                deficit,
                                docNumber: doc.docNumber
                            });

                            progressCallback?.({
                                type: 'stock_added',
                                dealId: deal.ID,
                                productName,
                                deficit,
                                message: `Added ${deficit} x ${productName} for Deal ${deal.ID}`
                            });
                        } catch (docError) {
                            results.stockFailed++;
                            results.errors.push({
                                dealId: deal.ID,
                                productId,
                                productName,
                                error: docError.message
                            });
                        }
                    }
                } catch (error) {
                    results.stockFailed++;
                    results.errors.push({
                        dealId: deal.ID,
                        productId,
                        productName,
                        error: error.message
                    });
                }
            }
        }

        results.durationMs = Date.now() - startTime;

        progressCallback?.({
            type: 'complete',
            message: `Deal Stock Sync complete: ${results.stockOk} OK, ${results.stockAdded} added, ${results.stockFailed} failed`
        });

    } catch (error) {
        results.success = false;
        results.error = error.message;
        progressCallback?.({ type: 'error', message: error.message });
    }

    return results;
}

export default { runDealStockSync };
