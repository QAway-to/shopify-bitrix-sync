# Architecture: Shopify ↔ Bitrix24

## System Overview

The integration acts as a middleware layer between Shopify and Bitrix24, running as a Next.js application on Render.

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│   Bitrix24  │◄───────►│  shopify-bitrix  │◄───────►│   Shopify   │
│  (Webhooks) │         │   (Next.js)      │         │ (Admin API) │
└─────────────┘         └──────────────────┘         └─────────────┘
                                │
                                ▼
                        ┌──────────────┐
                        │  Monitoring  │
                        │  UI (React)  │
                        └──────────────┘
```

## Data Flow

| Data Type | Source of Truth | Direction |
|-----------|-----------------|-----------|
| Orders | Shopify | Shopify → Bitrix |
| Payments | Shopify | Shopify → Bitrix |
| Inventory | Shopify | Shopify → Bitrix |
| Deal Workflow | Bitrix24 | Bitrix → Shopify |

## Key Components

### Webhook Handlers
- `pages/api/webhook/shopify.js` — receives Shopify order events, creates/updates Bitrix deals
- `pages/api/webhook/bitrix.js` — receives Bitrix deal stage changes, triggers Shopify actions

### Processing Blocks (Bitrix → Shopify)
Modular handlers under `src/lib/blocks/`:

| Block | Trigger | Action |
|-------|---------|--------|
| `preOrder.js` | Category 8 deal | Create Shopify order for pre-order |
| `stubUpgrade.js` | BITRIX_STUB tag + real products | Cancel stub, force new order |
| `cancel.js` | Stage ends `:LOSE` | Cancel Shopify order |
| `addressUpdate.js` | Address field changed | Update Shopify shipping address |
| `quantitySync.js` | Product rows changed | Sync line items in Shopify order |
| `orderCreate.js` | No Shopify order ID | Create new Shopify order from deal |

MW actions (`UF_MW_SHOPIFY_ACTION` JSON field): `hold_create`, `refund_create`, `address_update`, `order_cancel`, `order_position_*`

### Product Catalog Sync
- `pages/api/sync/category*.js` — bulk sync of Shopify variants to Bitrix product catalog by letter range
- `pages/api/sync/certificates.js` — sync gift certificates
- `pages/api/bitrix/refresh-mapping.js` — rebuild in-memory SKU↔Bitrix ID mapping

### Adapters
- `src/lib/adapters/shopify/` — Shopify event normalization and storage
- `src/lib/adapters/bitrix/` — Bitrix event normalization and storage

## Bitrix24 Custom Fields

| Field ID | Purpose |
|----------|---------|
| `UF_CRM_1742556489` | Shopify Order ID |
| `UF_CRM_1768251890190` | Brand (pre-order search) |
| `UF_CRM_1739793668182` | Model (pre-order search) |
| `UF_CRM_1739793720585` | Size (pre-order search) |
| `UF_CRM_1742037435676` | Shipping address |
| `UF_CRM_1739183959976` | Payment status (56=Paid, 58=Unpaid) |
| `UF_MW_SHOPIFY_ACTION` | Middleware action payload (JSON) |

## Collision Prevention Tags

| Tag | Set by | Purpose |
|-----|--------|---------|
| `BITRIX:{dealId}` | shopify.js | Link Shopify order to Bitrix deal |
| `BitrixUpdated` | bitrix.js | Prevent Shopify→Bitrix webhook loop |
| `BITRIX_STUB` | bitrix.js | Mark stub orders for replacement |
