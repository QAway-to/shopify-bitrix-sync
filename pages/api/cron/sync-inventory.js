/**
 * Inventory Sync API Endpoint
 * - GET: Return current sync status + next scheduled sync time
 * - POST: Start sync (manual trigger with optional section selection)
 * 
 * Fixed schedule: syncs at 08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00, 22:00, 00:00 Cyprus time
 * Server-side lock prevents concurrent syncs
 * Retry logic: if busy, auto-sync retries every 10 minutes
 */

import { runInventorySync, SECTION_NAMES } from '../../../src/lib/sync/inventorySyncCore.js';
import { syncProgressAdapter } from '../../../src/lib/adapters/sync/progressAdapter.js';
import { runImageSync } from '../../../src/lib/sync/imageSyncCore.js';
import { imageProgressAdapter } from '../../../src/lib/adapters/sync/imageProgressAdapter.js';
import { runDealStockSync } from '../../../src/lib/sync/dealStockSyncCore.js';

// Sync configuration
const ALL_SECTIONS = [36, 38, 40, 42];
const RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes retry if busy
const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

// Cyprus timezone (UTC+2 in winter, UTC+3 in summer - using EET)
const CYPRUS_TZ = 'Europe/Nicosia';

// Fixed schedule hours (Cyprus time): 8am to midnight, every 2 hours
const SCHEDULE_HOURS = [8, 10, 12, 14, 16, 18, 20, 22, 0];

// Server-side lock - persists across requests
let isSyncRunning = false;
let currentSyncRequestId = null;
let lastScheduledHour = null; // Track last executed schedule to avoid duplicates

/**
 * Get current hour in Cyprus timezone
 */
function getCyprusHour() {
    const now = new Date();
    const cyprusTime = new Date(now.toLocaleString('en-US', { timeZone: CYPRUS_TZ }));
    return cyprusTime.getHours();
}

/**
 * Get current minute in Cyprus timezone
 */
function getCyprusMinute() {
    const now = new Date();
    const cyprusTime = new Date(now.toLocaleString('en-US', { timeZone: CYPRUS_TZ }));
    return cyprusTime.getMinutes();
}

/**
 * Get next scheduled sync time
 * Returns { nextSyncAt: ISO string, nextSyncIn: "Xh Ym" }
 */
function getNextScheduledSync() {
    const now = new Date();
    const cyprusNow = new Date(now.toLocaleString('en-US', { timeZone: CYPRUS_TZ }));
    const currentHour = cyprusNow.getHours();
    const currentMinute = cyprusNow.getMinutes();

    // Find next schedule hour
    let nextHour = null;
    let daysToAdd = 0;

    for (const hour of SCHEDULE_HOURS) {
        if (hour > currentHour || (hour === currentHour && currentMinute < 5)) {
            nextHour = hour;
            break;
        }
    }

    // If no schedule found today, next is first schedule tomorrow
    if (nextHour === null) {
        nextHour = SCHEDULE_HOURS[0]; // 8:00
        daysToAdd = 1;
    }

    // Handle midnight (0) - if current hour is past 22, next 0 is today
    if (nextHour === 0 && currentHour >= 22) {
        daysToAdd = 0;
    } else if (nextHour === 0 && currentHour < 22) {
        // 0 means midnight, which is after all other hours today
        // If we're before 22, and nextHour is 0, it means we passed 22 check
        // Actually 0 should only be selected if currentHour > 22, so this is tomorrow
        if (currentHour < 8) {
            // Before 8am, next is 8am today
            nextHour = 8;
            daysToAdd = 0;
        }
    }

    // Build next sync date in Cyprus timezone
    const nextDate = new Date(cyprusNow);
    nextDate.setDate(nextDate.getDate() + daysToAdd);
    nextDate.setHours(nextHour, 0, 0, 0);

    // Calculate time until next sync
    const msUntilNext = nextDate.getTime() - cyprusNow.getTime();
    const hoursUntil = Math.floor(msUntilNext / 3600000);
    const minutesUntil = Math.floor((msUntilNext % 3600000) / 60000);

    // Format for display
    const nextSyncIn = msUntilNext > 0
        ? `${hoursUntil}h ${minutesUntil}m`
        : 'Now';

    // Convert back to UTC for ISO string
    const nextSyncAtUTC = new Date(now.getTime() + msUntilNext);

    return {
        nextSyncAt: nextSyncAtUTC.toISOString(),
        nextSyncIn,
        nextHourCyprus: `${String(nextHour).padStart(2, '0')}:00 Cyprus`
    };
}

/**
 * Run inventory sync with progress tracking
 */
async function executeSync(source = 'manual', sectionIds = ALL_SECTIONS) {
    if (isSyncRunning) {
        console.log('[INVENTORY SYNC] ⏳ Sync already in progress, skipping...');
        return { success: false, reason: 'already_running', currentRequest: currentSyncRequestId };
    }

    isSyncRunning = true;
    const requestId = `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    currentSyncRequestId = requestId;

    console.log(`[INVENTORY SYNC] 🚀 Starting sync (${source}), requestId: ${requestId}, sections: ${sectionIds.join(', ')}`);

    try {
        syncProgressAdapter.startRun(requestId, sectionIds);

        const results = await runInventorySync({
            sectionIds,
            progressCallback: (update) => {
                if (update.type === 'section_start') {
                    console.log(`[INVENTORY SYNC] ${update.message}`);
                    syncProgressAdapter.updateProgress({
                        type: update.type,
                        sectionId: update.sectionId,
                        message: update.message
                    });
                } else if (update.type === 'section_complete') {
                    console.log(`[INVENTORY SYNC] ✅ Section ${update.sectionName} complete`);
                    // completeSection already calls updateProgress internally
                    syncProgressAdapter.completeSection(update.sectionId, update.result);
                } else if (update.type === 'sync_complete') {
                    console.log(`[INVENTORY SYNC] 🏁 ${update.message}`);
                    syncProgressAdapter.updateProgress({
                        type: update.type,
                        sectionId: update.sectionId,
                        message: update.message
                    });
                } else if (update.type === 'sync_error') {
                    console.error(`[INVENTORY SYNC] ❌ ${update.message}`);
                    syncProgressAdapter.updateProgress({
                        type: update.type,
                        sectionId: update.sectionId,
                        message: update.message
                    });
                }
            }
        });

        syncProgressAdapter.endRun(results);

        console.log(`[INVENTORY SYNC] ✅ Sync complete. Created: ${results.totals.created}, Updated: ${results.totals.updated}, Errors: ${results.totals.errors}`);

        // ============ AUTO-TRIGGER IMAGE SYNC ============
        console.log('[INVENTORY SYNC] 🔗 Auto-triggering Image Sync...');
        try {
            const imageRequestId = `auto-img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            console.log(`[IMAGE SYNC] 🚀 Starting auto-sync, requestId: ${imageRequestId}`);

            imageProgressAdapter.startRun(imageRequestId);

            const imgResults = await runImageSync({
                progressCallback: (update) => {
                    if (update.type === 'info') {
                        console.log(`[IMAGE SYNC] ℹ️ ${update.message}`);
                    } else if (update.type === 'batch_complete') {
                        console.log(`[IMAGE SYNC] 📊 Progress: ${update.processed}/${update.total} (Uploaded: ${update.uploaded})`);
                        imageProgressAdapter.updateProgress(update);
                    } else if (update.type === 'complete') {
                        console.log(`[IMAGE SYNC] 🏁 ${update.message}`);
                    } else if (update.type === 'error') {
                        console.error(`[IMAGE SYNC] ❌ ${update.message}`);
                        imageProgressAdapter.updateProgress(update);
                    }
                }
            });

            imageProgressAdapter.endRun(imgResults);
            console.log(`[IMAGE SYNC] ✅ Auto-sync complete. Uploaded: ${imgResults.totals.uploaded}, Skipped: ${imgResults.totals.skipped}`);

            // Merge results for return (optional, but good for debug)
            results.imageSync = imgResults;

        } catch (imgError) {
            console.error('[IMAGE SYNC] ❌ Auto-sync failed:', imgError);
            imageProgressAdapter.endRun({ success: false, error: imgError.message, totals: {} });
        }

        // ============ AUTO-TRIGGER DEAL STOCK SYNC ============
        console.log('[INVENTORY SYNC] 🔗 Auto-triggering Deal Stock Sync...');
        try {
            const dealStockResults = await runDealStockSync({
                progressCallback: (update) => {
                    if (update.type === 'info' || update.type === 'complete') {
                        console.log(`[DEAL STOCK SYNC] ${update.message}`);
                    } else if (update.type === 'stock_added') {
                        console.log(`[DEAL STOCK SYNC] 📦 ${update.message}`);
                    } else if (update.type === 'error') {
                        console.error(`[DEAL STOCK SYNC] ❌ ${update.message}`);
                    }
                }
            });

            console.log(`[DEAL STOCK SYNC] ✅ Complete. OK: ${dealStockResults.stockOk}, Added: ${dealStockResults.stockAdded}, Failed: ${dealStockResults.stockFailed}`);
            results.dealStockSync = dealStockResults;

        } catch (dealStockError) {
            console.error('[DEAL STOCK SYNC] ❌ Auto-sync failed:', dealStockError);
        }

        return { success: true, requestId, results };

    } catch (error) {
        console.error('[INVENTORY SYNC] ❌ Sync failed:', error);
        syncProgressAdapter.endRun({ success: false, error: error.message, sections: {}, totals: {} });
        return { success: false, requestId, error: error.message };

    } finally {
        isSyncRunning = false;
        currentSyncRequestId = null;
    }
}

// ============ SCHEDULER ============
let schedulerStarted = false;
let retryTimeoutId = null;

function checkSchedule() {
    const currentHour = getCyprusHour();
    const currentMinute = getCyprusMinute();

    // Only trigger at the start of scheduled hours (minute 0-4)
    if (currentMinute > 4) return;

    // Check if current hour is in schedule
    if (!SCHEDULE_HOURS.includes(currentHour)) return;

    // Avoid duplicate runs in same hour
    if (lastScheduledHour === currentHour) return;

    console.log(`[INVENTORY SYNC SCHEDULER] ⏰ Schedule triggered: ${currentHour}:00 Cyprus time`);
    lastScheduledHour = currentHour;

    // Try to run sync
    if (isSyncRunning) {
        console.log('[INVENTORY SYNC SCHEDULER] ⏳ Sync busy, will retry in 10 minutes...');
        if (retryTimeoutId) clearTimeout(retryTimeoutId);
        retryTimeoutId = setTimeout(() => {
            console.log('[INVENTORY SYNC SCHEDULER] 🔄 Retry after busy...');
            executeSync('scheduled', ALL_SECTIONS).catch(err => {
                console.error('[INVENTORY SYNC SCHEDULER] Retry failed:', err);
            });
        }, RETRY_INTERVAL_MS);
        return;
    }

    // Clear any pending retry
    if (retryTimeoutId) {
        clearTimeout(retryTimeoutId);
        retryTimeoutId = null;
    }

    // Execute full sync
    executeSync('scheduled', ALL_SECTIONS).catch(err => {
        console.error('[INVENTORY SYNC SCHEDULER] Scheduled sync failed:', err);
    });
}

function startScheduler() {
    if (schedulerStarted) return;
    schedulerStarted = true;

    const scheduleStr = SCHEDULE_HOURS.map(h => `${String(h).padStart(2, '0')}:00`).join(', ');
    console.log(`[INVENTORY SYNC SCHEDULER] ✅ Started. Schedule (Cyprus): ${scheduleStr}`);

    // Check schedule every minute
    setInterval(checkSchedule, CHECK_INTERVAL_MS);

    // Also check immediately on start
    checkSchedule();
}

// Start scheduler on module load
startScheduler();

// ============ API HANDLER ============
export default async function handler(req, res) {
    if (req.method === 'GET') {
        const status = syncProgressAdapter.getStatus();
        const nextSync = getNextScheduledSync();

        return res.status(200).json({
            success: true,
            isRunning: isSyncRunning,
            currentRequest: currentSyncRequestId,
            lastRun: status.lastRun,
            schedulerActive: schedulerStarted,
            schedule: SCHEDULE_HOURS.map(h => `${String(h).padStart(2, '0')}:00`),
            nextSyncAt: nextSync.nextSyncAt,
            nextSyncIn: nextSync.nextSyncIn,
            nextSyncCyprus: nextSync.nextHourCyprus
        });
    }

    if (req.method === 'POST') {
        if (isSyncRunning) {
            return res.status(409).json({
                success: false,
                error: 'Sync already running',
                isRunning: true,
                currentRequest: currentSyncRequestId
            });
        }

        // Parse section IDs from body
        let sectionIds = ALL_SECTIONS;
        try {
            if (req.body?.sectionIds && Array.isArray(req.body.sectionIds)) {
                sectionIds = req.body.sectionIds.map(id => parseInt(id)).filter(id => ALL_SECTIONS.includes(id));
                if (sectionIds.length === 0) sectionIds = ALL_SECTIONS;
            }
        } catch (e) {
            // Ignore parse errors
        }

        const requestId = `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Start sync in background
        executeSync('manual', sectionIds).catch(err => {
            console.error('[INVENTORY SYNC] Manual sync failed:', err);
        });

        return res.status(202).json({
            success: true,
            message: 'Sync started',
            requestId,
            sectionIds,
            sections: sectionIds.map(id => ({ id, name: SECTION_NAMES[id] }))
        });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
