/**
 * Inventory Sync API Endpoint
 * - GET: Return current sync status
 * - POST: Start sync (manual or scheduled)
 * 
 * Auto-runs every 4 hours via setInterval (started in this module)
 */

import { runInventorySync, SECTION_NAMES } from '../../../src/lib/sync/inventorySyncCore.js';
import { syncProgressAdapter } from '../../../src/lib/adapters/sync/progressAdapter.js';

// Sync configuration
const ALL_SECTIONS = [36, 38, 40, 42];
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Track if sync is currently running
let isSyncRunning = false;

/**
 * Run inventory sync with progress tracking
 */
async function executeSync(source = 'manual') {
    if (isSyncRunning) {
        console.log('[INVENTORY SYNC] Sync already in progress, skipping...');
        return { success: false, reason: 'already_running' };
    }

    isSyncRunning = true;
    const requestId = `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    console.log(`[INVENTORY SYNC] Starting sync (${source}), requestId: ${requestId}`);

    try {
        syncProgressAdapter.startRun(requestId, ALL_SECTIONS);

        const results = await runInventorySync({
            sectionIds: ALL_SECTIONS,
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

        console.log(`[INVENTORY SYNC] Sync complete. Created: ${results.totals.created}, Updated: ${results.totals.updated}, Errors: ${results.totals.errors}`);

        return { success: true, requestId, results };

    } catch (error) {
        console.error('[INVENTORY SYNC] Sync failed:', error);
        syncProgressAdapter.endRun({ success: false, error: error.message, sections: {}, totals: {} });
        return { success: false, requestId, error: error.message };

    } finally {
        isSyncRunning = false;
    }
}

// ============ SCHEDULER ============
// Start 4-hour auto-sync interval
let schedulerStarted = false;

function startScheduler() {
    if (schedulerStarted) return;
    schedulerStarted = true;

    console.log(`[INVENTORY SYNC SCHEDULER] Starting auto-sync every ${SYNC_INTERVAL_MS / 3600000} hours`);

    // Schedule recurring sync
    setInterval(() => {
        console.log('[INVENTORY SYNC SCHEDULER] Triggered scheduled sync');
        executeSync('scheduled').catch(err => {
            console.error('[INVENTORY SYNC SCHEDULER] Scheduled sync failed:', err);
        });
    }, SYNC_INTERVAL_MS);

    console.log('[INVENTORY SYNC SCHEDULER] ✅ Scheduler active');
}

// Start scheduler on module load
startScheduler();

// ============ API HANDLER ============
export default async function handler(req, res) {
    if (req.method === 'GET') {
        // Return current status
        const status = syncProgressAdapter.getStatus();
        return res.status(200).json({
            success: true,
            ...status,
            schedulerActive: schedulerStarted,
            nextSyncIn: schedulerStarted ? `${Math.round(SYNC_INTERVAL_MS / 3600000)} hours` : null
        });
    }

    if (req.method === 'POST') {
        // Start sync (non-blocking)
        if (isSyncRunning) {
            return res.status(409).json({
                success: false,
                error: 'Sync already in progress',
                status: syncProgressAdapter.getStatus()
            });
        }

        const requestId = `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Start sync in background (don't await)
        executeSync('manual').catch(err => {
            console.error('[INVENTORY SYNC] Manual sync failed:', err);
        });

        return res.status(202).json({
            success: true,
            message: 'Sync started',
            requestId,
            sections: ALL_SECTIONS.map(id => ({ id, name: SECTION_NAMES[id] }))
        });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
