/**
 * Blocks Index
 * Central registry for all extracted block handlers
 * 
 * Each block is an isolated piece of handleDealUpdate logic
 * that can be tested and debugged independently.
 * 
 * Total: ~1370 lines extracted from 4409-line bitrix.js monolith
 */

// Block A: Pre-Order (Category 8 automation)
export { handlePreOrder } from './preOrder.js';

// Block B: Stub Upgrade (Kill stub when real products added)
export { handleStubUpgrade } from './stubUpgrade.js';

// Block C: Cancel (LOSE stage handling)
export { handleCancel, isLoseStage } from './cancel.js';

// Block E: Address Update (Sync address from Bitrix)
export { handleAddressUpdate, parseBitrixAddressString, hasAddressChanged } from './addressUpdate.js';

// Block F: Quantity Sync (Sync line item quantities)
export { handleQuantitySync } from './quantitySync.js';

// Block H: Order Create (Create Shopify order from deal)
export { handleOrderCreate } from './orderCreate.js';

// Note: Payment Sync (Block G) already exists as separate function in bitrix.js
// MW Action (Block D) already exists as handleMWAction in bitrix.js
