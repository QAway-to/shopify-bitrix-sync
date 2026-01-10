# Batch Inventory Sync Documentation (`sync_inventory_batch.py`)

## Overview
This script synchronizes product inventory and properties from Shopify to Bitrix24. It is optimized for performance using Bitrix's `batch` API method, allowing 50 commands per request. This significantly reduces execution time compared to sequential requests.

## Key Features
- **Batch Processing**: Groups up to 50 operations into a single API call.
- **Dynamic Property Mapping**: Parses "Size", "Color", "Brand", and "Category" from Shopify variants.
- **Stock Aggregation**: Consolidates stock adjustments into a single Bitrix "Store Adjustment" document per batch (A/W types).
- **Targeted Sync**: Can sync a specific variant ID (via `TARGET_ID`) or all products.

## Configuration & Mappings

### Credentials
- configured via `SHOPIFY_STORE`, `SHOPIFY_TOKEN`, and `BITRIX_WEBHOOK` constants.
- **Warning**: Credentials currently hardcoded in script.

### Section Mapping (`SECTION_MAP`)
Determines Bitrix Catalog Section ID based on SKU first letter:
- `A-F`: Section 36
- `G-M`: Section 38 (Default)
- `N-S`: Section 40
- `T-Z`: Section 42

### Property Mapping
Maps Shopify attributes to Bitrix Custom Property IDs:
- **Size** (`PROPERTY_98`): Maps validated values (e.g., "40") to Bitrix Enum IDs (e.g., `334`).
- **Brand** (`PROPERTY_102`): Maps directly from Shopify Vendor.
- **Category** (`PROPERTY_104`): Maps from Shopify Product Type.
- **Color** (`PROPERTY_106`): Maps from Shopify Option "Color".

## Execution Flow

### 1. Fetch Data
- **Shopify**: Fetches products via REST API.
  - *Optimization*: If `TARGET_ID` is set, fetches only that variant and its parent product.
  - *Filtering*: Skips items with `<= 0` stock (unless it's the target).
  - *Option Parsing*: Identifies Size/Color option indices dynamically.
- **Bitrix**: Fetches **ALL** products (`crm.product.list`) to build an index of `XML_ID` -> `ID`.
  - *Fields*: `ID`, `PRICE`, `XML_ID`, `NAME`.

### 2. Plan Changes
Iterates through fetched Shopify variants and compares with Bitrix index:

- **Update Logic** (if `XML_ID` exists in Bitrix):
  - Checks **Price** difference (> 0.01).
  - Checks **Properties** (Brand, Size, Color, Category).
  - *Batching*: If changes needed, adds a `crm.product.update` command string to `update_payloads`.
  - Adds ID to `ensure_stock_ids` list for stock verification.

- **Create Logic** (if `XML_ID` missing):
  - Creates payload with: `NAME`, `PRICE`, `CODE` (SKU), `XML_ID` (VariantID), `SECTION_ID` (via SKU), and properties.
  - Adds to `create_payloads`.

### 3. Execute Product Updates (Batch)
- Sends nested `update_payloads` commands to Bitrix using `batch` endpoint.
- Processed in chunks of 50.

### 4. Execute Creates (1-by-1)
- Executes `crm.product.add` for new items sequentially (Create is less frequent, so 1-by-1 is acceptable/safer for now).
- Newly created IDs are added to `ensure_stock_ids`.
- **Note**: Stock is NOT set here; it is queued for step 5.

### 5. Check & Sync Stock
- **Fetch Levels**: Calls `catalog.storeproduct.list` (batched) for all IDs in `ensure_stock_ids`.
- **Calculate Diff**: Compares Shopify `inventory_quantity` vs Bitrix `amount`.
  - `Diff > 0`: Needs Arrival (`docType: 'A'`).
  - `Diff < 0`: Needs Write-off (`docType: 'W'`).

### 6. Apply Stock Documents
- Creates a **Single Document** (Arrival or Deduction) to cover up to 100 items.
- **Add Elements**: Uses `batch` to add all rows (`catalog.document.element.add`) to the document.
- **Conduct**: Conducts the document (`catalog.document.conduct`) to apply changes.

## Helper Functions
- `get_size_enum_id(size_text)`: Validates size against `SIZE_ENUM_MAP`.
- `get_section_id_by_sku(sku)`: Routes product to correct catalog folder.
- `fetch_shopify_products(...)`: Handles pagination and single-fetch optimization.
- `call_batch(...)`: Wrapper for Bitrix batch requests.

## Limitations / Notes
- **Images**: This script (batch version) does **NOT** currently sync images. (On-demand/Certificate sync scripts handle images separately).
- **Price**: Updates price if difference > 0.01.
- **Deletions**: Does not delete products from Bitrix if removed from Shopify.
