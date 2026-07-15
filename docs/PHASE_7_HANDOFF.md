# Phase 7 handoff — API, integrations and billing

## Delivered

- Show-once API keys stored as SHA-256 digests, explicit scopes, per-minute
  quotas, rotation/revocation primitives and constant-time verification.
- Customer webhook signing with a five-minute timestamp window, stable delivery
  IDs, endpoint/event replay protection, bounded exponential retries and
  organization-isolated failure handling.
- Connector runner that isolates provider failures and schema for separate
  sandbox/production encrypted credentials, cursors and idempotent run replay.
- Stripe Billing adapter using Checkout Sessions for subscriptions and Customer
  Portal for self-service management with API version `2026-02-25.clover`.
- Subscription plan/seat/storage/API limits, trial/past-due/grace states,
  replay-safe provider events, invoice records and safe read-only fallback.
- Migration `0021_api_connectors_billing.sql` adds eight FORCE-RLS tenant tables.

## Production gates

- Persistent PostgreSQL repositories and authenticated management routes for
  keys, endpoints, connectors, subscriptions and invoices.
- KMS-backed connector/webhook credential vault and one customer-selected live
  source plus Google Sheets destination.
- Stripe account, products/prices, webhook endpoint/secret, tax/currency scope,
  hosted Checkout success/cancel URLs and live signature/replay evidence.
- Worker deployment, delivery observability, quota reconciliation and customer
  webhook/API documentation.

The payment provider cannot delete customer data. A missing or expired
subscription enters read-only mode; export access remains a deployment policy.
