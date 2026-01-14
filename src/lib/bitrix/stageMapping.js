/**
 * Bitrix Deal Stage Mappings
 * Maps stage IDs to semantic meanings across all categories
 */

// Delivery stages - when order is handed to courier/shipping
export const DELIVERY_STAGES = [
    'C2:EXECUTING',   // Cat 2 (Stock site) - Delivery
    'C4:2',           // Cat 4 (Pre-order shop) - Delivery
    'C8:2',           // Cat 8 (Pre-order site) - Delivery
];

// WON stages - deal successfully completed
export const WON_STAGES = [
    'C2:WON',         // Cat 2 (Stock site)
    'C4:WON',         // Cat 4 (Pre-order shop)
    'C6:WON',         // Cat 6 (Notifications?)
    'C8:WON',         // Cat 8 (Pre-order site)
    'WON',            // Default pipeline
];

// LOSE stages - deal lost/cancelled
export const LOSE_STAGES = [
    'C2:LOSE',        // Cat 2 (Stock site)
    'C4:LOSE',        // Cat 4 (Pre-order shop)
    'C6:LOSE',        // Cat 6 (Notifications?)
    'C8:LOSE',        // Cat 8 (Pre-order site)
    'LOSE',           // Default pipeline
];

// Waiting list stages - customer on waitlist
export const WAITING_LIST_STAGES = [
    'C4:UC_BDP1UE',   // Cat 4 (Pre-order shop) - Waiting list
    'C8:UC_7M1KC5',   // Cat 8 (Pre-order site) - Waiting list
];

// NEW stages - new order created
export const NEW_STAGES = [
    'C2:NEW',         // Cat 2 (Stock site)
    'C4:NEW',         // Cat 4 (Pre-order shop)
    'C6:NEW',         // Cat 6 (Notifications)
    'C8:NEW',         // Cat 8 (Pre-order site)
    'NEW',            // Default pipeline
];

/**
 * Check if a stage is a Delivery stage
 * @param {string} stageId - Stage ID from Bitrix (e.g., 'C4:2')
 * @returns {boolean}
 */
export function isDeliveryStage(stageId) {
    return DELIVERY_STAGES.includes(stageId);
}

/**
 * Check if a stage is a WON (success) stage
 * @param {string} stageId - Stage ID from Bitrix
 * @returns {boolean}
 */
export function isWonStage(stageId) {
    return WON_STAGES.includes(stageId) || (stageId && stageId.endsWith(':WON'));
}

/**
 * Check if a stage is a LOSE stage
 * @param {string} stageId - Stage ID from Bitrix
 * @returns {boolean}
 */
export function isLoseStage(stageId) {
    return LOSE_STAGES.includes(stageId) || (stageId && stageId.endsWith(':LOSE'));
}

/**
 * Check if a stage is a NEW stage
 * @param {string} stageId - Stage ID from Bitrix
 * @returns {boolean}
 */
export function isNewStage(stageId) {
    return NEW_STAGES.includes(stageId) || (stageId && stageId.endsWith(':NEW'));
}

/**
 * Full stage mapping for reference
 * Key: Category ID, Value: Array of {id, name} objects
 */
export const STAGE_MAPPINGS = {
    // Category 2: Stock (site)
    '2': [
        { id: 'C2:NEW', name: 'New order' },
        { id: 'C2:PREPARATION', name: 'Order placed' },
        { id: 'C2:PREPAYMENT_INVOICE', name: 'Payment control' },
        { id: 'C2:EXECUTING', name: 'Delivery' },
        { id: 'C2:FINAL_INVOICE', name: 'Feedback' },
        { id: 'C2:WON', name: 'Success' },
        { id: 'C2:LOSE', name: 'Loss' },
    ],
    // Category 4: Pre-order (shop)
    '4': [
        { id: 'C4:NEW', name: 'New order' },
        { id: 'C4:PREPARATION', name: "Manufacturer's availability check" },
        { id: 'C4:PREPAYMENT_INVOICE', name: '10% prepayment completed' },
        { id: 'C4:EXECUTING', name: 'Order from the manufacturer' },
        { id: 'C4:3', name: 'Order received' },
        { id: 'C4:FINAL_INVOICE', name: 'Communication with the client' },
        { id: 'C4:1', name: 'Payment control' },
        { id: 'C4:2', name: 'Delivery' },
        { id: 'C4:UC_BDP1UE', name: 'Waiting list' },
        { id: 'C4:WON', name: 'Success' },
        { id: 'C4:LOSE', name: 'Loss' },
    ],
    // Category 6: Notifications
    '6': [
        { id: 'C6:NEW', name: 'New notification' },
        { id: 'C6:PREPARATION', name: 'In progress' },
        { id: 'C6:WON', name: 'Success' },
        { id: 'C6:LOSE', name: 'Loss' },
    ],
    // Category 8: Pre-order (site)
    '8': [
        { id: 'C8:NEW', name: 'New order (10% pre-payment paid)' },
        { id: 'C8:PREPARATION', name: "Manufacturer's availability check" },
        { id: 'C8:PREPAYMENT_INVOICE', name: 'Ordered from the manufacturer' },
        { id: 'C8:EXECUTING', name: 'Order received' },
        { id: 'C8:FINAL_INVOICE', name: 'Communication with the client' },
        { id: 'C8:1', name: 'Payment control' },
        { id: 'C8:2', name: 'Delivery' },
        { id: 'C8:3', name: 'Feedback' },
        { id: 'C8:UC_7M1KC5', name: 'Waiting list' },
        { id: 'C8:WON', name: 'Success' },
        { id: 'C8:LOSE', name: 'Loss' },
    ],
};
