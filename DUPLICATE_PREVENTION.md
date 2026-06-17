# Duplicate Order Prevention

## Problem

Shopify webhooks are delivered at-least-once — retries and race conditions can cause the same order event to create multiple Bitrix24 deals.

## Prevention Layers

### 1. In-memory processing lock
`processingOrders` Set in `shopify.js` blocks concurrent processing of the same order ID within a single server instance.

### 2. Tag-based loop prevention
Orders modified by Bitrix actions receive a `BitrixUpdated` tag. Shopify webhook handler skips any order carrying this tag, breaking the Bitrix→Shopify→Bitrix feedback loop.

### 3. Existing deal check
Before creating a new deal, the handler searches Bitrix for an existing deal with a matching `UF_CRM_1742556489` (Shopify Order ID). If found, it updates the existing deal instead of creating a new one.

### 4. Payload hash idempotency
Each processed payload is hashed. Duplicate payloads with the same hash are rejected within the same server session.

### 5. Provenance metafield
After Bitrix-originated Shopify operations (refunds, address updates, fulfillments), a provenance marker is written to the Shopify order metafield. Subsequent webhooks for the same operation are detected and skipped.

## Stub Order Pattern

When a deal has no valid product rows yet, a lightweight "stub" order is created in Shopify (tagged `BITRIX_STUB`). Once real product rows are added to the deal, the stub is cancelled and replaced with a proper order. This prevents the order create block from being retriggered unnecessarily.
