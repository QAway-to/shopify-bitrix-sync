/**
 * Image Sync API Endpoint
 * - GET: Return current sync status
 * - POST: Start image sync manually
 * 
 * No scheduler - runs after AutoSync or manually
 */

import { runImageSync } from '../../../src/lib/sync/imageSyncCore.js';
import { imageProgressAdapter } from '../../../src/lib/adapters/sync/imageProgressAdapter.js';

// Server-side lock
let isSyncRunning = false;
let currentSyncRequestId = null;

/**
 * Run image sync with progress tracking
 */
async function executeSync() {
    if (isSyncRunning) {
        console.log('[IMAGE SYNC] ⏳ Sync already in progress, skipping...');
        return { success: false, reason: 'already_running', currentRequest: currentSyncRequestId };
    }

    isSyncRunning = true;
    const requestId = `img-sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    currentSyncRequestId = requestId;

    console.log(`[IMAGE SYNC] 🚀 Starting sync, requestId: ${requestId}`);

    try {
        imageProgressAdapter.startRun(requestId);

        const results = await runImageSync({
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

        imageProgressAdapter.endRun(results);

        console.log(`[IMAGE SYNC] ✅ Complete. Uploaded: ${results.totals.uploaded}, Skipped: ${results.totals.skipped}, Errors: ${results.totals.errors}`);

        return { success: true, requestId, results };

    } catch (error) {
        console.error('[IMAGE SYNC] ❌ Sync failed:', error);
        imageProgressAdapter.endRun({ success: false, error: error.message, totals: {} });
        return { success: false, requestId, error: error.message };

    } finally {
        isSyncRunning = false;
        currentSyncRequestId = null;
    }
}

// ============ API HANDLER ============
export default async function handler(req, res) {
    if (req.method === 'GET') {
        const status = imageProgressAdapter.getStatus();

        return res.status(200).json({
            success: true,
            isRunning: isSyncRunning,
            currentRequest: currentSyncRequestId,
            lastRun: status.lastRun
        });
    }

    if (req.method === 'POST') {
        if (isSyncRunning) {
            return res.status(409).json({
                success: false,
                error: 'Image sync already running',
                isRunning: true,
                currentRequest: currentSyncRequestId
            });
        }

        const requestId = `img-sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Start sync in background
        executeSync().catch(err => {
            console.error('[IMAGE SYNC] Manual sync failed:', err);
        });

        return res.status(202).json({
            success: true,
            message: 'Image sync started',
            requestId
        });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
