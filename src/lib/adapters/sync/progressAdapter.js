/**
 * Sync Progress Adapter
 * Tracks and logs inventory sync progress for UI display
 */

import fs from 'fs';
import path from 'path';

const STORAGE_DIR = path.join(process.cwd(), '.data');
const PROGRESS_FILE = path.join(STORAGE_DIR, 'sync-progress.json');
const MAX_LOG_ENTRIES = 200;

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
        console.error('[SYNC PROGRESS] Error loading:', e.message);
    }
    return { currentRun: null, logs: [], lastRun: null };
}

function saveProgress(data) {
    try {
        ensureStorageDir();
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[SYNC PROGRESS] Error saving:', e.message);
    }
}

class SyncProgressAdapter {
    constructor() {
        this.data = loadProgress();
        this.lastLogTime = 0;
        this.LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Start a new sync run
     */
    startRun(requestId, sectionIds) {
        this.data.currentRun = {
            requestId,
            startTime: new Date().toISOString(),
            sectionIds,
            status: 'running',
            progress: {
                currentSection: null,
                processed: 0,
                total: 0,
                stats: { created: 0, updated: 0, skipped: 0, errors: 0 }
            }
        };
        this.lastLogTime = Date.now();

        this.addLog({
            type: 'start',
            message: `Starting sync for sections: ${sectionIds.join(', ')}`,
            sectionIds
        });

        saveProgress(this.data);
    }

    /**
     * Update progress (logs only every 5 minutes)
     */
    updateProgress(update) {
        if (!this.data.currentRun) return;

        // Update current state
        if (update.sectionId) {
            this.data.currentRun.progress.currentSection = update.sectionId;
        }
        if (update.processed !== undefined) {
            this.data.currentRun.progress.processed = update.processed;
        }
        if (update.total !== undefined) {
            this.data.currentRun.progress.total = update.total;
        }
        if (update.stats) {
            Object.assign(this.data.currentRun.progress.stats, update.stats);
        }

        // Log only every 5 minutes OR if it's a significant event
        const now = Date.now();
        const isSignificant = ['section_complete', 'sync_error'].includes(update.type);

        if (isSignificant || (now - this.lastLogTime >= this.LOG_INTERVAL_MS)) {
            const progress = this.data.currentRun.progress;
            const elapsed = Math.round((now - new Date(this.data.currentRun.startTime).getTime()) / 60000);

            this.addLog({
                type: update.type || 'progress',
                sectionId: progress.currentSection,
                processed: progress.processed,
                total: progress.total,
                stats: { ...progress.stats },
                elapsedMinutes: elapsed,
                message: update.message
            });

            this.lastLogTime = now;
            saveProgress(this.data);
        }
    }

    /**
     * Complete a section
     */
    completeSection(sectionId, result) {
        this.updateProgress({
            type: 'section_complete',
            sectionId,
            message: `Section ${result.sectionName} complete: ${result.total} items`,
            stats: {
                created: result.created,
                updated: result.updated,
                skipped: result.skipped,
                errors: result.errors
            }
        });
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
            sections: results.sections,
            totals: results.totals
        };

        this.addLog({
            type: 'complete',
            message: `Sync complete in ${Math.round(duration / 60000)} minutes`,
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

        // Trim old logs
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
     * Get logs for download
     */
    getLogs() {
        return this.data.logs;
    }

    /**
     * Get formatted log text for download
     */
    getFormattedLogs() {
        const lines = [];

        lines.push('================================================================================');
        lines.push('INVENTORY SYNC PROGRESS');
        lines.push('================================================================================');
        lines.push('');

        // Last run summary
        if (this.data.lastRun) {
            const lr = this.data.lastRun;
            lines.push(`Last Sync Run: ${lr.startTime}`);
            lines.push(`Status: ${lr.success ? 'Completed' : 'Failed'}`);
            lines.push(`Duration: ${lr.durationMinutes} minutes`);
            lines.push('');

            // Section summaries with detailed samples
            if (lr.sections) {
                for (const [sectionId, result] of Object.entries(lr.sections)) {
                    lines.push(`Section ${result.sectionName} (${sectionId}): ${result.total} items`);
                    lines.push(`  Created: ${result.created}, Updated: ${result.updated}, Skipped: ${result.skipped}, Errors: ${result.errors}`);

                    // Updated samples
                    if (result.updatedSamples && result.updatedSamples.length > 0) {
                        lines.push(`  Updated samples (first ${result.updatedSamples.length}):`);
                        result.updatedSamples.forEach(s => {
                            lines.push(`    • ${s.sku} (ID:${s.pid}): ${s.changes}`);
                        });
                    }

                    // Created samples
                    if (result.createdSamples && result.createdSamples.length > 0) {
                        lines.push(`  Created samples (first ${result.createdSamples.length}):`);
                        result.createdSamples.forEach(s => {
                            lines.push(`    • ${s.sku} (ID:${s.pid}): ${s.name}`);
                        });
                    }

                    // Stock changes
                    if (result.stockChanges && result.stockChanges.length > 0) {
                        lines.push(`  Stock changes (first ${result.stockChanges.length}):`);
                        result.stockChanges.forEach(s => {
                            lines.push(`    • PID:${s.pid} ${s.type}: ${s.amount}`);
                        });
                    }

                    // Skipped samples
                    if (result.skippedSamples && result.skippedSamples.length > 0) {
                        lines.push(`  Skipped samples (first ${result.skippedSamples.length}):`);
                        result.skippedSamples.forEach(s => {
                            lines.push(`    • ${s.sku}${s.pid ? ` (ID:${s.pid})` : ''}: ${s.reason}`);
                        });
                    }

                    // Error samples
                    if (result.errorSamples && result.errorSamples.length > 0) {
                        lines.push(`  ERROR samples (first ${result.errorSamples.length}):`);
                        result.errorSamples.forEach(s => {
                            lines.push(`    ❌ ${s.sku}: ${s.error}`);
                        });
                    }

                    lines.push('');  // Blank line between sections
                }

                // Totals
                if (lr.totals) {
                    lines.push('Totals:');
                    lines.push(`  Created: ${lr.totals.created}`);
                    lines.push(`  Updated: ${lr.totals.updated}`);
                    lines.push(`  Price Updated: ${lr.totals.priceUpdated}`);
                    lines.push(`  Description Updated: ${lr.totals.descUpdated}`);
                    lines.push(`  Stock Adjusted: ${lr.totals.stockAdjusted}`);
                    lines.push(`  Skipped: ${lr.totals.skipped}`);
                    lines.push(`  Errors: ${lr.totals.errors}`);
                }
            }
            lines.push('');
        } else {
            lines.push('No previous sync run recorded.');
            lines.push('');
        }

        // Current run status
        if (this.data.currentRun) {
            lines.push('--- CURRENT RUN (In Progress) ---');
            lines.push(`Started: ${this.data.currentRun.startTime}`);
            lines.push(`Current Section: ${this.data.currentRun.progress.currentSection}`);
            lines.push(`Progress: ${this.data.currentRun.progress.processed}/${this.data.currentRun.progress.total}`);
            lines.push('');
        }

        // Progress logs
        lines.push('--- Progress Log (every 5 min) ---');
        for (const log of this.data.logs.slice(-50)) {
            const time = log.timestamp ? log.timestamp.split('T')[1].split('.')[0] : '??:??:??';
            let line = `[${time}] `;

            if (log.type === 'start') {
                line += `🚀 ${log.message}`;
            } else if (log.type === 'progress') {
                line += `📊 Section ${log.sectionId}: ${log.processed}/${log.total} (${log.elapsedMinutes} min)`;
            } else if (log.type === 'section_complete') {
                line += `✅ ${log.message}`;
            } else if (log.type === 'complete') {
                line += `🏁 ${log.message}`;
            } else if (log.type === 'sync_error') {
                line += `❌ Error: ${log.message}`;
            } else {
                line += log.message || JSON.stringify(log);
            }

            lines.push(line);
        }

        lines.push('');
        return lines.join('\n');
    }
}

export const syncProgressAdapter = new SyncProgressAdapter();

export default syncProgressAdapter;
