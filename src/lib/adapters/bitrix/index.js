// Bitrix24 Webhook Adapter
// Persistent storage for received events from Bitrix outbound webhooks
import fs from 'fs';
import path from 'path';

// Storage file path
const STORAGE_DIR = path.join(process.cwd(), '.data');
const STORAGE_FILE = path.join(STORAGE_DIR, 'bitrix-events.json');

// Ensure storage directory exists
function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    console.log(`[BITRIX ADAPTER] Created storage directory: ${STORAGE_DIR}`);
  }
}

// Load events from file
function loadEventsFromFile() {
  try {
    ensureStorageDir();
    if (fs.existsSync(STORAGE_FILE)) {
      const fileContent = fs.readFileSync(STORAGE_FILE, 'utf8');
      const events = JSON.parse(fileContent);
      console.log(`[BITRIX ADAPTER] ✅ Loaded ${events.length} events from persistent storage`);
      return events;
    }
  } catch (error) {
    console.error(`[BITRIX ADAPTER] ⚠️ Error loading events from file:`, error);
  }
  return [];
}

// Save events to file
function saveEventsToFile(events) {
  try {
    ensureStorageDir();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(events, null, 2), 'utf8');
    console.log(`[BITRIX ADAPTER] 💾 Saved ${events.length} events to persistent storage`);
  } catch (error) {
    console.error(`[BITRIX ADAPTER] ⚠️ Error saving events to file:`, error);
  }
}

// Initialize with persistent storage
let receivedEvents = loadEventsFromFile();

/**
 * Bitrix Webhook Adapter
 * Handles Bitrix webhook events storage and retrieval
 */
export class BitrixAdapter {
  constructor() {
    this.storage = receivedEvents; // Reference to in-memory array
    console.log(`[BITRIX ADAPTER] Initialized with ${this.storage.length} events from storage`);
  }

  getName() {
    return 'bitrix';
  }

  /**
   * Store webhook event
   * @param {Object} payload - Bitrix webhook event payload
   * @returns {Object} Stored event with timestamp
   */
  storeEvent(payload) {
    // Generate unique event ID (timestamp + random to ensure uniqueness)
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const event = {
      ...payload,
      received_at: payload.received_at || new Date().toISOString(),
      id: uniqueId, // Unique ID for each event
      eventId: uniqueId, // Also store as eventId for clarity
    };
    
    console.log(`[BITRIX ADAPTER] 📥 Storing event: dealId=${event.dealId}, eventId=${event.id}, received_at=${event.received_at}`);
    
    this.storage.push(event);
    
    // Save to persistent storage (sync, blocking to ensure data is saved)
    saveEventsToFile(this.storage);
    
    console.log(`[BITRIX ADAPTER] ✅ Event stored. Total events: ${this.storage.length}`);
    
    return event;
  }

  /**
   * Get all events (newest first)
   * @returns {Array<Object>} All stored events
   */
  getAllEvents() {
    // Return events in reverse order (newest first)
    const events = [...this.storage].reverse();
    console.log(`[BITRIX ADAPTER] 📊 Returning ${events.length} events (newest first)`);
    return events;
  }

  /**
   * Get latest event
   * @returns {Object|null} Latest event or null
   */
  getLatestEvent() {
    if (this.storage.length === 0) {
      return null;
    }
    return this.storage[this.storage.length - 1];
  }

  /**
   * Get events count
   * @returns {number} Number of stored events
   */
  getEventsCount() {
    return this.storage.length;
  }

  /**
   * Clear all events (for testing/reset)
   * @returns {number} Number of cleared events
   */
  clearEvents() {
    const count = this.storage.length;
    this.storage.length = 0;
    // Also clear persistent storage
    saveEventsToFile(this.storage);
    console.log(`[BITRIX ADAPTER] 🗑️ Cleared ${count} events from memory and persistent storage`);
    return count;
  }
}

// Export singleton instance
export const bitrixAdapter = new BitrixAdapter();







