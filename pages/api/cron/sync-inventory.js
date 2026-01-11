/**
 * Inventory Sync API Endpoint
 * - GET: Return current sync status
 * - POST: Start sync (manual trigger with optional section selection)
 * 
 * Auto-runs every 4 hours via setInterval
 * Server-side lock prevents concurrent syncs
 * Retry logic: if busy, auto-sync retries every 10 minutes
 */

import { runInventorySync, SECTION_NAMES } from '../../../src/lib/sync/inventorySyncCore.js';
import { syncProgressAdapter } from '../../../src/lib/adapters/sync/progressAdapter.js';

// Sync configuration
const ALL_SECTIONS = [36, 38, 40, 42];
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes retry if busy

// Server-side lock - persists across requests
let isSyncRunning = false;
let currentSyncRequestId = null;

/**
 * Run inventory sync with progress tracking
 * @param {string} source - 'manual' or 'scheduled'
 * @param {number[]} sectionIds - Sections to sync (defaults to ALL)
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
                // Log to console
                if (update.type === 'section_start') {
                    console.log(`[INVENTORY SYNC] ${update.message}`);
                } else if (update.type === 'section_complete') {
                    console.log(`[INVENTORY SYNC] ✅ Section ${update.sectionName} complete`);
                    syncProgressAdapter.completeSection(update.sectionId, update.result);
                } else if (update.type === 'sync_complete') {
                    console.log(`[INVENTORY SYNC] 🏁 ${update.message}`);
                } else if (update.type === 'sync_error') {
                    console.error(`[INVENTORY SYNC] ❌ ${update.message}`);
                }

                // Update progress adapter
                syncProgressAdapter.updateProgress({
                    type: update.type,
                    sectionId: update.sectionId,
                    message: update.message
                });
            }
        });

        syncProgressAdapter.endRun(results);

        console.log(`[INVENTORY SYNC] ✅ Sync complete. Created: ${results.totals.created}, Updated: ${results.totals.updated}, Errors: ${results.totals.errors}`);

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
let lastScheduledSyncTime = null; // Track when last scheduled sync started

function tryScheduledSync() {
    lastScheduledSyncTime = Date.now(); // Track this sync attempt

    if (isSyncRunning) {
        console.log('[INVENTORY SYNC SCHEDULER] ⏳ Sync busy, will retry in 10 minutes...');
        // Schedule retry
        if (retryTimeoutId) clearTimeout(retryTimeoutId);
        retryTimeoutId = setTimeout(() => {
            console.log('[INVENTORY SYNC SCHEDULER] 🔄 Retry after busy...');
            tryScheduledSync();
        }, RETRY_INTERVAL_MS);
        return;
    }

    // Clear any pending retry
    if (retryTimeoutId) {
        clearTimeout(retryTimeoutId);
        retryTimeoutId = null;
    }

    // Execute full sync (all sections)
    executeSync('scheduled', ALL_SECTIONS).catch(err => {
        console.error('[INVENTORY SYNC SCHEDULER] Scheduled sync failed:', err);
    });
}

function startScheduler() {
    if (schedulerStarted) return;
    schedulerStarted = true;
    lastScheduledSyncTime = Date.now(); // Initialize with start time

    console.log(`[INVENTORY SYNC SCHEDULER] ✅ Starting auto-sync every ${SYNC_INTERVAL_MS / 3600000} hours`);

    // Schedule recurring sync
    setInterval(() => {
        console.log('[INVENTORY SYNC SCHEDULER] ⏰ Triggered scheduled sync');
        tryScheduledSync();
    }, SYNC_INTERVAL_MS);
}

// Start scheduler on module load
startScheduler();

// Calculate next sync time
function getNextSyncInfo() {
    if (!schedulerStarted || !lastScheduledSyncTime) {
        return { nextSyncAt: null, nextSyncIn: null };
    }
    const nextSyncAt = new Date(lastScheduledSyncTime + SYNC_INTERVAL_MS);
    const msUntilNext = nextSyncAt.getTime() - Date.now();
    const hoursUntil = Math.floor(msUntilNext / 3600000);
    const minutesUntil = Math.floor((msUntilNext % 3600000) / 60000);
    return {
        nextSyncAt: nextSyncAt.toISOString(),
        nextSyncIn: msUntilNext > 0 ? `${hoursUntil}h ${minutesUntil}m` : 'Soon'
    };
}

// ============ API HANDLER ============
export default async function handler(req, res) {
    if (req.method === 'GET') {
        // Return current status (for UI polling)
        const status = syncProgressAdapter.getStatus();
        const nextSync = getNextSyncInfo();
        return res.status(200).json({
            success: true,
            isRunning: isSyncRunning,
            currentRequest: currentSyncRequestId,
            lastRun: status.lastRun,
            schedulerActive: schedulerStarted,
            nextSyncAt: nextSync.nextSyncAt,
            nextSyncIn: nextSync.nextSyncIn
        });
    }

    if (req.method === 'POST') {
        // Start sync (non-blocking)
        if (isSyncRunning) {
            return res.status(409).json({
                success: false,
                error: 'Синхронизация уже выполняется',
                isRunning: true,
                currentRequest: currentSyncRequestId
            });
        }

        // Parse section IDs from body (optional)
        let sectionIds = ALL_SECTIONS;
        try {
            if (req.body?.sectionIds && Array.isArray(req.body.sectionIds)) {
                sectionIds = req.body.sectionIds.map(id => parseInt(id)).filter(id => ALL_SECTIONS.includes(id));
                if (sectionIds.length === 0) sectionIds = ALL_SECTIONS;
            }
        } catch (e) {
            // Ignore parse errors, use default
        }

        const requestId = `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Start sync in background (don't await)
        executeSync('manual', sectionIds).catch(err => {
            console.error('[INVENTORY SYNC] Manual sync failed:', err);
        });

        return res.status(202).json({
            success: true,
            message: 'Синхронизация запущена',
            requestId,
            sectionIds,
            sections: sectionIds.map(id => ({ id, name: SECTION_NAMES[id] }))
        });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
