# Current Flow Documentation

This document describes the current webhook handling logic in `bitrix.js` and `shopify.js`.

## Source of Truth Matrix

| Data Type | Source of Truth | Direction |
|-----------|-----------------|-----------|
| Orders | **Shopify** | Shopify → Bitrix |
| Payments | **Shopify** | Shopify → Bitrix |
| Inventory | **Shopify** | Shopify → Bitrix |
| Deal Workflow | **Bitrix24** | Bitrix → Shopify |
| Customer Notifications | **Shopify** | - |

---

## Bitrix → Shopify Flow (`pages/api/webhook/bitrix.js`)

### Entry Point: `handleDealUpdate(dealId, requestId)`

This is the main handler for Bitrix deal updates. It processes events in the following order:

```
┌─────────────────────────────────────────────────────────────────┐
│                    handleDealUpdate                             │
│                    (Lines 1633-3601)                            │
└─────────────────────────────────────────────────────────────────┘
                              │
     ┌────────────────────────┼────────────────────────┐
     ▼                        ▼                        ▼
┌──────────┐           ┌──────────┐            ┌──────────┐
│ Block A  │           │ Block B  │            │ Block C  │
│ Pre-Order│           │  Stub    │            │  Cancel  │
│ Cat. 8   │           │ Upgrade  │            │  (LOSE)  │
└──────────┘           └──────────┘            └──────────┘
     │                        │                        │
     ▼                        ▼                        ▼
┌──────────┐           ┌──────────┐            ┌──────────┐
│ Block D  │           │ Block E  │            │ Block F  │
│ MW Action│           │ Address  │            │ Quantity │
│          │           │ Update   │            │  Sync    │
└──────────┘           └──────────┘            └──────────┘
     │                        │                        │
     ▼                        ▼                        ▼
┌──────────┐           ┌──────────┐
│ Block G  │           │ Block H  │
│ Payment  │           │  Order   │
│  Sync    │           │ Create   │
└──────────┘           └──────────┘
```

---

### Block Details

#### Block A: Pre-Order (Lines 1706-1822)
**File:** `src/lib/blocks/preOrder.js`

**Trigger:** `categoryId === '8'`

**Purpose:** Create Shopify order for pre-order deals

**Steps:**
1. Extract Brand, Model, Size from deal fields
2. Find matching Shopify variant by attributes
3. Create pending order in Shopify
4. Sync product to Bitrix (on-demand)
5. Add product row to deal
6. Update deal with Shopify Order ID (LAST to avoid race condition)

**Returns:** Mutates `shopifyOrderId` in local scope

---

#### Block B: Stub Upgrade (Lines 1824-1884)
**File:** `src/lib/blocks/stubUpgrade.js`

**Trigger:** `shopifyOrderId` exists AND order has `BITRIX_STUB` tag

**Purpose:** Cancel stub order when real products are added

**Steps:**
1. Check if order has BITRIX_STUB tag
2. Check if deal has real product rows
3. Cancel the stub order via GraphQL
4. Clear `shopifyOrderId` to force new order creation

**Returns:** May set `shopifyOrderId = null`

---

#### Block C: Cancel (Lines 1897-2062)
**File:** `src/lib/blocks/cancel.js`

**Trigger:** `stageId` ends with `:LOSE` OR is `CANCELLED`/`REFUNDED`

**Purpose:** Cancel Shopify order when deal is lost

**Steps:**
1. Cancel by `shopifyOrderId` if exists
2. Fallback: Cancel by `BITRIX:{dealId}` tag search
3. Add `BitrixUpdated` tag to prevent webhook loop

**Returns:** Early return with `{ action: 'order_cancelled' }`

---

#### Block D: MW Action (Lines 2081-2086)
**File:** Already separate function `handleMWAction()`

**Trigger:** `UF_MW_SHOPIFY_ACTION` field contains JSON

**Purpose:** Handle explicit middleware actions

**Supported Actions:**
- `hold_create` - Create hold order
- `refund_create` - Create refund
- `address_update` - Update shipping address
- `order_cancel` - Cancel order
- `order_position_add/increment/decrement` - Modify line items

**Returns:** Early return with action result

---

#### Block E: Address Update (Lines 2088-2394)
**File:** TODO: `src/lib/blocks/addressUpdate.js`

**Trigger:** `shopifyOrderId` exists AND address field changed

**Purpose:** Sync address changes from Bitrix to Shopify

**Steps:**
1. Parse address from `UF_CRM_1742037435676`
2. Compare with current Shopify address
3. Enrich with contact name/phone
4. Update via Shopify API
5. Also handles delivery price updates

**Returns:** Continues to next block (no early return)

---

#### Block F: Quantity Sync (Lines 2396-2792)
**File:** TODO: `src/lib/blocks/quantitySync.js`

**Trigger:** `shopifyOrderId` exists AND order has `BITRIX:` tag

**Purpose:** Sync product quantities from Bitrix deal to Shopify order

**Steps:**
1. Get product rows from Bitrix deal
2. Get line items from Shopify order
3. Compare quantities by SKU
4. Add/increment/decrement line items via orderEdit API
5. Clean up stub products if real products added

**Returns:** Continues to next block (no early return)

---

#### Block G: Payment Sync (Lines 2794-2798)
**File:** Already separate function `syncShopifyPaymentStatusFromBitrix()`

**Trigger:** `shopifyOrderId` exists

**Purpose:** Sync payment status from Bitrix to Shopify

**Mapping:**
- Bitrix `56` (Paid) → Shopify `orderMarkAsPaid`
- Bitrix `58` (Unpaid) → No action (can't un-pay)

**Returns:** Continues to next block

---

#### Block H: Order Create (Lines 2800-3600)
**File:** TODO: `src/lib/blocks/orderCreate.js`

**Trigger:** `shopifyOrderId` is empty AND deal has product rows

**Purpose:** Create Shopify order from Bitrix deal

**Steps:**
1. Re-check for existing order (race condition prevention)
2. Get product rows from deal
3. Map products to Shopify variants (by CODE/SKU or XML_ID)
4. Create stub order if no valid products (optional)
5. Create order with customer email
6. Update deal with new `shopifyOrderId`

**Returns:** Success/failure result

---

## Shopify → Bitrix Flow (`pages/api/webhook/shopify.js`)

### Entry Points

| Webhook Topic | Handler | Purpose |
|---------------|---------|---------|
| `orders/create` | `handleOrderCreated()` | Create Bitrix deal |
| `orders/updated` | `handleOrderUpdated()` | Update Bitrix deal |

### Duplicate Prevention

1. **In-memory lock:** `processingOrders` Set prevents concurrent processing
2. **Tag check:** Skip if order has `BitrixUpdated` tag (Bitrix-originated change)
3. **Existing deal check:** Search for deal with matching `shopifyOrderId`

---

## Collision Prevention Tags

| Tag | Added By | Purpose |
|-----|----------|---------|
| `BITRIX:{dealId}` | `shopify.js` | Link order to deal for lookup |
| `BitrixUpdated` | `bitrix.js` | Prevent Shopify→Bitrix loop |
| `BITRIX_STUB` | `bitrix.js` | Mark stub orders for later cleanup |

---

## Bitrix User Fields Reference

| Field ID | Name | Purpose |
|----------|------|---------|
| `UF_CRM_1742556489` | Shopify Order ID | Links deal to Shopify order |
| `UF_CRM_1768251890190` | Brand | Pre-order search |
| `UF_CRM_1739793668182` | Model | Pre-order search |
| `UF_CRM_1739793720585` | Size | Pre-order search |
| `UF_CRM_1742037435676` | Address | Shipping address string |
| `UF_CRM_67BEF8B2AA721` | Delivery Price | Shipping cost |
| `UF_CRM_1739183959976` | Payment Status | 56=Paid, 58=Unpaid |
| `UF_MW_SHOPIFY_ACTION` | MW Action | JSON action payload |

---

## Extracted Modules

| Block | Original Lines | Module Path | Status |
|-------|---------------|-------------|--------|
| Pre-Order | 1706-1822 | `src/lib/blocks/preOrder.js` | ✅ Done |
| Stub Upgrade | 1824-1884 | `src/lib/blocks/stubUpgrade.js` | ✅ Done |
| Cancel | 1897-2062 | `src/lib/blocks/cancel.js` | ✅ Done |
| MW Action | 601-1631 | Already separate function | ✅ Exists |
| Address Update | 2088-2394 | `src/lib/blocks/addressUpdate.js` | ✅ Done |
| Quantity Sync | 2396-2792 | `src/lib/blocks/quantitySync.js` | ✅ Done |
| Payment Sync | 2794-2798 | Already separate function | ✅ Exists |
| Order Create | 2800-3200 | `src/lib/blocks/orderCreate.js` | ✅ Done |

**Total extracted: ~1370 lines into 6 modular files**

---

## Debugging Tips

1. **Find block by error message:**
   - `[PRE-ORDER]` → `preOrder.js`
   - `[STUB UPGRADE]` → `stubUpgrade.js`
   - `BITRIX_TO_SHOPIFY_ORDER_CANCEL` → `cancel.js`

2. **Check webhook loop:**
   - Look for `BitrixUpdated` tag addition
   - Check `SHOPIFY_WEBHOOK_SKIPPED` log events

3. **Race condition:**
   - Look for `DUPLICATE_CHECK` log events
   - Check `findExistingOrderByDealId` calls
