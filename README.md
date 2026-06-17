# Shopify–Bitrix24 Integration

A bi-directional integration dashboard connecting Shopify (e-commerce) and Bitrix24 (CRM). Receives webhooks from both platforms, syncs orders and deals, manages product catalog, and provides a monitoring UI.

**Live:** https://render-agent-a-mvp.onrender.com

## Features

- **Shopify → Bitrix24** — inbound webhooks create and update deals, map line items to Bitrix products
- **Bitrix24 → Shopify** — deal stage changes trigger fulfillments, refunds, address updates, and order creation
- **Product catalog sync** — bulk sync of Shopify inventory to Bitrix24 by category (A–F, G–M, N–S, T–Z) and certificates
- **On-demand product creation** — missing products are auto-created in Bitrix24 when an order arrives
- **Duplicate prevention** — idempotency via payload hash, provenance tags, and in-memory locks
- **Event monitoring** — real-time dashboard showing Shopify and Bitrix24 event streams
- **Structured logging** — PostgreSQL-backed log storage with queryable API
- **Auth** — HMAC-signed session cookies; all sensitive API routes protected

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (Pages Router) |
| Runtime | Node.js |
| Database | PostgreSQL (Render managed) |
| Deployment | Render |
| External APIs | Shopify Admin API, Bitrix24 REST API |

## Getting Started

```bash
npm install
npm run dev
```

App runs at `http://localhost:3000`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SHOPIFY_24_DOMAIN` | Shopify store domain (e.g. `store.myshopify.com`) |
| `SHOPIFY_24_ADMIN` | Shopify Admin API access token |
| `SHOPIFY_CLIENT_ID` | Shopify app client ID |
| `SHOPIFY_CLIENT_SECRET` | Shopify app client secret |
| `SHOPIFY_API_VERSION` | API version (e.g. `2025-07`) |
| `BITRIX_WEBHOOK_BASE` | Bitrix24 inbound webhook URL |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret for HMAC session signing |
| `WEBHOOK_PASSWORD` | Shared password for API route auth |

## API Routes

### Webhooks (inbound)
| Route | Method | Description |
|-------|--------|-------------|
| `/api/webhook/shopify` | POST | Receive Shopify order events |
| `/api/webhook/bitrix` | POST | Receive Bitrix24 deal updates |

### Manual Operations (auth required)
| Route | Method | Description |
|-------|--------|-------------|
| `/api/send-to-bitrix` | POST | Push selected events to Bitrix24 |
| `/api/send-to-shopify` | POST | Push selected events to Shopify |
| `/api/sync/category` | POST | Bulk sync product category |
| `/api/sync/category-optimized` | POST | Parallel bulk sync with progress tracking |
| `/api/sync/certificates` | POST | Sync gift certificates |
| `/api/bitrix/refresh-mapping` | POST | Rebuild SKU→Bitrix product ID mapping |

### Monitoring (auth required)
| Route | Method | Description |
|-------|--------|-------------|
| `/api/events` | GET | All Shopify events |
| `/api/events/bitrix` | GET | All Bitrix24 events |
| `/api/events/latest` | GET | Latest Shopify event |
| `/api/logs/stream` | GET | SSE log stream |

## Architecture

See [`docs/current_flow.md`](docs/current_flow.md) for the full webhook processing flow and block diagram.

## Deployment

Deployed on [Render](https://render.com). Set the environment variables listed above in the Render dashboard under **Environment**.

## License

MIT
