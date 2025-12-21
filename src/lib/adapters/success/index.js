// Success Operations Adapter
// Persistent storage for successfully created/updated deals
import fs from 'fs';
import path from 'path';

// Storage file path
const STORAGE_DIR = path.join(process.cwd(), '.data');
const STORAGE_FILE = path.join(STORAGE_DIR, 'success-operations.json');

// Ensure storage directory exists
function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    console.log(`[SUCCESS ADAPTER] Created storage directory: ${STORAGE_DIR}`);
  }
}

// Load operations from file
function loadOperationsFromFile() {
  try {
    ensureStorageDir();
    if (fs.existsSync(STORAGE_FILE)) {
      const fileContent = fs.readFileSync(STORAGE_FILE, 'utf8');
      const operations = JSON.parse(fileContent);
      console.log(`[SUCCESS ADAPTER] ✅ Loaded ${operations.length} operations from persistent storage`);
      return operations;
    }
  } catch (error) {
    console.error(`[SUCCESS ADAPTER] ⚠️ Error loading operations from file:`, error);
  }
  return [];
}

// Save operations to file
function saveOperationsToFile(operations) {
  try {
    ensureStorageDir();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(operations, null, 2), 'utf8');
    console.log(`[SUCCESS ADAPTER] 💾 Saved ${operations.length} operations to persistent storage`);
  } catch (error) {
    console.error(`[SUCCESS ADAPTER] ⚠️ Error saving operations to file:`, error);
  }
}

// Initialize with persistent storage
let successOperations = loadOperationsFromFile();

/**
 * Success Operations Adapter
 * Handles storage and retrieval of successful deal operations
 */
export class SuccessAdapter {
  constructor() {
    this.storage = successOperations;
    console.log(`[SUCCESS ADAPTER] Initialized with ${this.storage.length} operations from storage`);
  }

  /**
   * Store successful operation
   * @param {Object} operation - Operation data (dealId, shopifyOrderId, operationType, dealData, etc.)
   * @returns {Object} Stored operation with timestamp
   */
  storeOperation(operation) {
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const operationData = {
      ...operation,
      id: uniqueId,
      operationId: uniqueId,
      timestamp: new Date().toISOString(),
      stored_at: new Date().toISOString()
    };
    
    console.log(`[SUCCESS ADAPTER] 📥 Storing operation: type=${operation.operationType}, dealId=${operation.dealId}, shopifyOrderId=${operation.shopifyOrderId}`);
    
    this.storage.push(operationData);
    
    // Keep only last 1000 operations
    if (this.storage.length > 1000) {
      this.storage = this.storage.slice(-1000);
    }
    
    // Save to persistent storage
    saveOperationsToFile(this.storage);
    
    console.log(`[SUCCESS ADAPTER] ✅ Operation stored. Total operations: ${this.storage.length}`);
    
    return operationData;
  }

  /**
   * Get all operations (newest first)
   * @returns {Array<Object>} All stored operations
   */
  getAllOperations() {
    const operations = [...this.storage].reverse();
    console.log(`[SUCCESS ADAPTER] 📊 Returning ${operations.length} operations (newest first)`);
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
   * Clear all operations (for testing/reset)
   * @returns {number} Number of cleared operations
   */
  clearOperations() {
    const count = this.storage.length;
    this.storage.length = 0;
    saveOperationsToFile(this.storage);
    console.log(`[SUCCESS ADAPTER] 🗑️ Cleared ${count} operations from memory and persistent storage`);
    return count;
  }
}

// Export singleton instance
export const successAdapter = new SuccessAdapter();

