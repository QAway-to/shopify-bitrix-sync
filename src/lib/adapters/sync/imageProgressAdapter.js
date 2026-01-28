/**
 * Image Sync Progress Adapter
 * Tracks and logs image sync progress for UI display
 * Same pattern as progressAdapter.js for inventory sync
 */

import fs from 'fs';
import path from 'path';

const STORAGE_DIR = path.join(process.cwd(), '.data');
const PROGRESS_FILE = path.join(STORAGE_DIR, 'image-sync-progress.json');
const MAX_LOG_ENTRIES = 100;

function ensureStorageDir() {
    if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
}

function loadProgress() {
    try {
        ensureStorageDir();
        if (fs.existsSync(PROGRESS_FILE)) {
            return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[IMAGE SYNC PROGRESS] Error loading:', e.message);
    }
    return { currentRun: null, logs: [], lastRun: null };
}

function saveProgress(data) {
    try {
        ensureStorageDir();
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[IMAGE SYNC PROGRESS] Error saving:', e.message);
    }
}

class ImageProgressAdapter {
    constructor() {
        this.data = loadProgress();
        this.lastLogTime = 0;
        this.LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Start a new sync run
     */
    startRun(requestId) {
        this.data.currentRun = {
            requestId,
            startTime: new Date().toISOString(),
            status: 'running',
            progress: {
                processed: 0,
                total: 0,
                uploaded: 0,
                skipped: 0,
                errors: 0
            }
        };
        this.lastLogTime = Date.now();

        this.addLog({
            type: 'start',
            message: 'Starting image sync'
        });

        saveProgress(this.data);
    }

    /**
     * Update progress
     */
    updateProgress(update) {
        if (!this.data.currentRun) return;

        if (update.processed !== undefined) {
            this.data.currentRun.progress.processed = update.processed;
        }
        if (update.total !== undefined) {
            this.data.currentRun.progress.total = update.total;
        }
        if (update.uploaded !== undefined) {
            this.data.currentRun.progress.uploaded = update.uploaded;
        }
        if (update.skipped !== undefined) {
            this.data.currentRun.progress.skipped = update.skipped;
        }
        if (update.errors !== undefined) {
            this.data.currentRun.progress.errors = update.errors;
        }

        // Log periodically or for significant events
        const now = Date.now();
        const isSignificant = ['batch_complete', 'error'].includes(update.type);

        if (isSignificant || (now - this.lastLogTime >= this.LOG_INTERVAL_MS)) {
            const progress = this.data.currentRun.progress;
            const elapsed = Math.round((now - new Date(this.data.currentRun.startTime).getTime()) / 60000);

            this.addLog({
                type: update.type || 'progress',
                processed: progress.processed,
                total: progress.total,
                uploaded: progress.uploaded,
                skipped: progress.skipped,
                errors: progress.errors,
                elapsedMinutes: elapsed,
                message: update.message
            });

            this.lastLogTime = now;
            saveProgress(this.data);
        }
    }

    /**
     * End the sync run
     */
    endRun(results) {
        if (!this.data.currentRun) return;

        const endTime = new Date().toISOString();
        const duration = Date.now() - new Date(this.data.currentRun.startTime).getTime();

        this.data.lastRun = {
            requestId: this.data.currentRun.requestId,
            startTime: this.data.currentRun.startTime,
            endTime,
            durationMs: duration,
            durationMinutes: Math.round(duration / 60000),
            success: results.success,
            totals: results.totals,
            samples: results.samples || []
        };

        this.addLog({
            type: 'complete',
            message: `Image sync complete in ${Math.round(duration / 60000)} minutes`,
            success: results.success,
            totals: results.totals
        });

        this.data.currentRun = null;
        saveProgress(this.data);
    }

    /**
     * Add a log entry
     */
    addLog(entry) {
        entry.timestamp = new Date().toISOString();
        this.data.logs.push(entry);

        if (this.data.logs.length > MAX_LOG_ENTRIES) {
            this.data.logs = this.data.logs.slice(-MAX_LOG_ENTRIES);
        }
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            isRunning: this.data.currentRun !== null,
            currentRun: this.data.currentRun,
            lastRun: this.data.lastRun
        };
    }

    /**
     * Get formatted log text for download
     */
    getFormattedLogs() {
        const lines = [];

        lines.push('================================================================================');
        lines.push('IMAGE SYNC PROGRESS');
        lines.push('================================================================================');
        lines.push('');

        if (this.data.lastRun) {
            const lr = this.data.lastRun;
            lines.push(`Last Image Sync: ${lr.startTime}`);
            lines.push(`Status: ${lr.success ? 'Completed' : 'Failed'}`);
            lines.push(`Duration: ${lr.durationMinutes} minutes`);
            lines.push('');

            if (lr.totals) {
                lines.push('Results:');
                lines.push(`  Total products checked: ${lr.totals.total || 0}`);
                lines.push(`  Images uploaded: ${lr.totals.uploaded || 0}`);
                lines.push(`  Skipped (already have image): ${lr.totals.skipped || 0}`);
                lines.push(`  Errors: ${lr.totals.errors || 0}`);
            }

            if (lr.samples && lr.samples.length > 0) {
                lines.push('');
                lines.push('Sample uploads (first 10):');
                lr.samples.slice(0, 10).forEach(s => {
                    lines.push(`  📸 ${s.sku || s.productId}: ${s.status}`);
                });
            }
            lines.push('');
        } else {
            lines.push('No previous image sync recorded.');
            lines.push('');
        }

        if (this.data.currentRun) {
            lines.push('--- CURRENT RUN (In Progress) ---');
            lines.push(`Started: ${this.data.currentRun.startTime}`);
            const p = this.data.currentRun.progress;
            lines.push(`Progress: ${p.processed}/${p.total} (Uploaded: ${p.uploaded}, Skipped: ${p.skipped})`);
            lines.push('');
        }

        lines.push('--- Progress Log ---');
        for (const log of this.data.logs.slice(-20)) {
            const time = log.timestamp ? log.timestamp.split('T')[1].split('.')[0] : '??:??:??';
            let line = `[${time}] `;

            if (log.type === 'start') {
                line += `🚀 ${log.message}`;
            } else if (log.type === 'progress' || log.type === 'batch_complete') {
                line += `📊 ${log.processed}/${log.total} (Uploaded: ${log.uploaded}, Skipped: ${log.skipped})`;
            } else if (log.type === 'complete') {
                line += `🏁 ${log.message}`;
            } else if (log.type === 'error') {
                line += `❌ ${log.message}`;
            } else {
                line += log.message || JSON.stringify(log);
            }

            lines.push(line);
        }

        lines.push('');
        return lines.join('\n');
    }
}

export const imageProgressAdapter = new ImageProgressAdapter();
export default imageProgressAdapter;
