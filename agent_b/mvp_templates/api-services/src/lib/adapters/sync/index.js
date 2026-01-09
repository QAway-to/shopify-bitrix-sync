// Sync Operations Adapter
// Persistent storage for inventory sync operations
import fs from 'fs';
import path from 'path';

// Storage file path
const STORAGE_DIR = path.join(process.cwd(), '.data');
const STORAGE_FILE = path.join(STORAGE_DIR, 'sync-operations.json');

// Ensure storage directory exists
function ensureStorageDir() {
    if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
        console.log(`[SYNC ADAPTER] Created storage directory: ${STORAGE_DIR}`);
    }
}

// Load operations from file
function loadOperationsFromFile() {
    try {
        ensureStorageDir();
        if (fs.existsSync(STORAGE_FILE)) {
            const fileContent = fs.readFileSync(STORAGE_FILE, 'utf8');
            const operations = JSON.parse(fileContent);
            console.log(`[SYNC ADAPTER] ✅ Loaded ${operations.length} sync operations from persistent storage`);
            return operations;
        }
    } catch (error) {
        console.error(`[SYNC ADAPTER] ⚠️ Error loading sync operations from file:`, error);
    }
    return [];
}

// Save operations to file
function saveOperationsToFile(operations) {
    try {
        ensureStorageDir();
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(operations, null, 2), 'utf8');
        console.log(`[SYNC ADAPTER] 💾 Saved ${operations.length} sync operations to persistent storage`);
    } catch (error) {
        console.error(`[SYNC ADAPTER] ⚠️ Error saving sync operations to file:`, error);
    }
}

// Initialize with persistent storage
let syncOperations = loadOperationsFromFile();

/**
 * Sync Operations Adapter
 * Handles storage and retrieval of inventory sync operations
 */
export class SyncAdapter {
    constructor() {
        this.storage = syncOperations;
        console.log(`[SYNC ADAPTER] Initialized with ${this.storage.length} sync operations from storage`);
    }

    /**
     * Store sync operation result
     * @param {Object} operation - Sync operation data
     * @returns {Object} Stored operation with timestamp
     */
    storeOperation(operation) {
        const uniqueId = `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const operationData = {
            ...operation,
            id: uniqueId,
            timestamp: new Date().toISOString(),
        };

        console.log(`[SYNC ADAPTER] 📥 Storing sync operation: type=${operation.operationType || 'inventory_sync'}`);

        this.storage.push(operationData);

        // Keep only last 500 sync operations
        if (this.storage.length > 500) {
            this.storage = this.storage.slice(-500);
        }

        // Save to persistent storage
        saveOperationsToFile(this.storage);

        return operationData;
    }

    /**
     * Store full sync run result
     * @param {Object} result - Sync run result with summary
     */
    storeSyncRun(result) {
        return this.storeOperation({
            operationType: 'inventory_sync',
            summary: result.summary,
            errors: result.errors?.slice(0, 20) || [],
            duration: result.duration,
            success: result.success
        });
    }

    /**
     * Get all sync operations (newest first)
     * @returns {Array<Object>} All stored sync operations
     */
    getAllOperations() {
        const operations = [...this.storage].reverse();
        console.log(`[SYNC ADAPTER] 📊 Returning ${operations.length} sync operations (newest first)`);
        return operations;
    }

    /**
     * Get operations count
     * @returns {number} Number of stored operations
     */
    getOperationsCount() {
        return this.storage.length;
    }

    /**
     * Clear all operations
     * @returns {number} Number of cleared operations
     */
    clearOperations() {
        const count = this.storage.length;
        this.storage.length = 0;
        saveOperationsToFile(this.storage);
        console.log(`[SYNC ADAPTER] 🗑️ Cleared ${count} sync operations`);
        return count;
    }
}

// Export singleton instance
export const syncAdapter = new SyncAdapter();
