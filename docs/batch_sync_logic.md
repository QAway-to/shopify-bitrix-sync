# Batch Inventory Sync Logic (`sync_inventory_batch.py`)

This document describes the logic of the optimized batch synchronization script for updating Bitrix24 inventory from Shopify.

## 1. Core Principles
*   **Source of Truth**: **Shopify**. Bitrix is always updated to match Shopify.
*   **Batch Processing**: Operations are grouped into batches of 50 commands (Bitrix API limit) for speed.
*   **Scope**: Synchronization typically runs for a specific **Category/Section** (e.g., A-F).

## 2. Process Workflow

### Step 1: Fetch Shopify Data
*   Fetches **ALL** variants from Shopify (even with `qty=0`) to ensure full data consistency.
*   **Filters** immediately by SKU prefix (Section map) to process only relevant items.
*   Parses **Size** and **Color** from options or Title heuristics.

### Step 2: Fetch Bitrix Data
*   Fetches existing products from Bitrix (`crm.product.list`) in pages.
*   Retrieves: `ID`, `XML_ID`, `PRICE`, `NAME`, `SECTION_ID`, Properties (Size/Brand), `DETAIL_TEXT`.
*   Uses `XML_ID` (which holds Shopify Variant ID) to map Shopify items to Bitrix items.

### Step 3: Planning Updates (Comparison)
The script iterates through Shopify variants and compares them with Bitrix products:

*   **Logic for Existing Products:**
    *   **Price**: Updates if different.
    *   **Name**: Updates if different (cleans "Default Title").
    *   **Description**: Checks `body_html` vs `DETAIL_TEXT`. If different, queues for separate update.
    *   **Properties**: **ALWAYS** updates Size, Color, Brand, Category for all items in the target section.
    *   **Stock**: Calculated later.

*   **Logic for New Products:**
    *   If `Shopify Qty > 0`: Plans **Creation** (`crm.product.add`).
    *   If `Shopify Qty <= 0`: **SKIPS** creation (prevents cluttering Bitrix with out-of-stock items).

### Step 4: Batch Execution
1.  **General Updates**: Executes `crm.product.update` for Price, Name, Properties using the Batch API.
2.  **Description Updates (Separate Pass)**:
    *   Uses `catalog.product.update` (Catalog API) instead of CRM API.
    *   Updates `detailText` AND `previewText`.
    *   Explicitly sets type to `html`.
    *   This ensures description formatting is preserved and avoids conflicts.
3.  **Creation**: Creates new products one-by-one (Batch creation is complex due to ID dependency for stock).

### Step 5: Stock Synchronization
*   Comparing `Shopify Qty` vs `Bitrix Store (ID: 2) Qty`.
*   **Arrival**: If `Shopify > Bitrix` -> Creates `docType='S'` (Store Adjustment) | `storeTo=2`.
*   **Deduction**: If `Shopify < Bitrix` -> Creates `docType='D'` (Deduct) | `storeFrom=2`.
*   Uses **Batch API** to check current stocks (`catalog.storeproduct.list`) to minimize requests.

### Step 6: Zero-Stock Cleanup
*   Iterates through Bitrix products that exist but were **NOT** found in the current Shopify list (e.g., deleted or processed out of scope).
*   **Section Filter**: Strictly skips checking products that belong to other sections.
*   Checks Shopify API specifically for these missing items.
*   If Shopify returns 404 or Qty=0 -> Writes off full stock in Bitrix.

## 3. Key Configuration
*   **`target_section_ids`**: List of Bitrix Section IDs to sync (e.g., `[36]` for A-F).
*   **Filter 0 Qty**: Disabled for updates (updates existing 0-stock items), Enabled for creation (skips new 0-stock).
*   **Store ID**: Fixed to `2` (Main Warehouse).

## 4. Error Handling & Logging
*   **Network**: Robust 60-second progress logging.
*   **Pagination**: Strict `rel="next"` parsing for Shopify to prevent infinite loops.
*   **Batch Errors**: Logs individual batch command errors (warnings) but continues execution.
