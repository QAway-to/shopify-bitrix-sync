# On-Demand Product Creation Logic

## Overview
When a Shopify order contains an item that does not exist in Bitrix24 (identified by SKU or variant_id mapping), the integration automatically creates the product in Bitrix24 "On-Demand".

## process Flow

### 1. Detection
- System checks for product in Bitrix by `CODE` (SKU).
- If not found, checks internal mapping caches (certificates, category maps).
- If still not found, initiates On-Demand creation.

### 2. Product Creation (Bitrix)
The product is created in Bitrix (`crm.product.add`) with:
- **Name**: `Product Title - Variant Title` (e.g., "Abriana Fantasy KL white - 40")
- **CODE**: SKU (or variant_id if SKU missing)
- **XML_ID**: Shopify Variant ID
- **Price**: Item price from order
- **Section**: Determined by SKU prefix (e.g., 'K' -> Section A-F)
- **Description**: Fetches `body_html` from Shopify.
  - *Fallback*: `Shopify Product: {Title}\nSKU: {SKU}\nVariant ID: {ID}`

### 3. Property Enrichment
After creation, the system fetches metadata from Shopify to fill Bitrix properties:
- **Brand** (`PROPERTY_102`): Mapped from Shopify Vendor.
- **Category/Type** (`PROPERTY_104`): Mapped from Shopify Product Type (e.g., "Atlas MJ").
- **Size** (`PROPERTY_98`): Parsed from Options or Title.
- **Color** (`PROPERTY_106`): Parsed from Options.

### 4. Stock Synchronization (Pre-Order Logic)
Since the product is new, it has 0 stock. To allow the deal to reserve stock and be processed:
- **Action**: Creates a "Store Adjustment" document (`docType: 'S'`).
- **Warehouse**: Store ID 2.
- **Amount**: `Order Quantity + 1`.
  - *Reasoning*: Bitrix deals automatically reserve stock. Adding +1 ensures that after the deal reserves its quantity, the product remains available (positive stock) or at least not negative, preventing "Out of Stock" errors during deal processing.

### 5. Deal Association
- The newly created product ID is linked to the deal row.
- `PRODUCT_ID` is set (linking to catalog).
- `PRODUCT_NAME` is left empty (Bitrix fills it).

## Duplicate Prevention
- **Locking**: The webhook handler implements an in-memory lock on `Shopify Order ID`.
- If multiple webhooks for the same order arrive simultaneously, only the first one processes. Subsequent requests are dropped with `locked_processing` status.
