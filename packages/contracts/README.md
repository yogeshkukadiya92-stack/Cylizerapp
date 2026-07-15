# `@callora/contracts`

Shared TypeScript contracts for the Callora web dashboard, backend services, workers, and mobile synchronization layer. The package intentionally has no runtime or development dependencies of its own.

## What belongs here

- Stable domain shapes exchanged between applications.
- API envelopes, pagination, sorting, and filter contracts.
- Android collector payloads, acknowledgements, upload manifests, and heartbeats.
- Lightweight guards for validating untrusted values at a transport boundary.

Database models, ORM decorators, framework request objects, React props, and business operations do **not** belong here. Those concerns should map to these contracts at their respective application boundaries.

## Modules

| Module | Responsibility |
| --- | --- |
| `common` | Transport primitives, date ranges, audit fields, JSON values, and basic guards |
| `organizations` | Tenants, users, roles, permissions, and organization settings |
| `employees` | Employees, registered devices, SIM cards, permissions, and pairing |
| `calls` | Call logs, notes, recordings, transcripts, and call imports |
| `leads` | Leads, custom fields, tags, pipeline statuses, activities, and follow-ups |
| `analytics` | Dashboard KPIs, trends, funnels, employee performance, and reports |
| `api` | Success/error envelopes, pagination, sorting, and domain filters |
| `sync` | Mobile call batches, recording uploads, heartbeats, and diagnostics |

Everything is re-exported from the package root:

```ts
import type {
  ApiResponse,
  CallLog,
  CallLogFilters,
  CallLogSyncBatch,
  PaginatedData,
} from "@callora/contracts";

import { isCallLogSyncBatch } from "@callora/contracts";
```

## Boundary validation

Interfaces disappear at runtime, so parse incoming JSON as `unknown` and apply a guard before trusting it:

```ts
import { isCallLogSyncBatch } from "@callora/contracts";

export function acceptMobileBatch(payload: unknown) {
  if (!isCallLogSyncBatch(payload)) {
    throw new Error("Invalid mobile sync batch");
  }

  // payload is now narrowed to CallLogSyncBatch.
  return payload.items.length;
}
```

The included guards deliberately validate only structural and transport-safety invariants. Services must still enforce authorization, tenant ownership, uniqueness, quotas, and business rules.

## Conventions

- All IDs are serialized strings and are opaque to consumers.
- Timestamps are RFC 3339 strings; calendar dates use `YYYY-MM-DD`.
- Phone numbers should be E.164 after server normalization. Mobile payloads may arrive less clean and should be normalized during ingestion.
- Durations are seconds; storage sizes are bytes; monetary values use integer minor units.
- Optional means the field may be absent. Explicit clearing in update inputs uses `null`.
- Mobile retries reuse `batchId` and each item's `localId`; the ingestion service must be idempotent.
- A mobile call sync batch is capped at 100 items by the supplied guard and the API also enforces a 512 KiB request-body limit.
- Every call batch declares `collectionMode`: `android_call_log` for real collection or `synthetic_demo` for non-production demos.
- The HTTP transport must send an `Idempotency-Key` header that exactly matches `batchId`.
- Mobile credentials are opaque bearer values. Raw credentials are transport-only and must never be persisted by a server implementation.

## Building

The workspace must provide a TypeScript compiler:

```sh
npm run build --workspace @callora/contracts
npm run typecheck --workspace @callora/contracts
```

The build emits ESM JavaScript, declarations, declaration maps, and source maps into `dist/`.

## Evolving contracts

Prefer additive changes. When changing mobile sync semantics, add a new `SyncSchemaVersion` and keep the server compatible with supported old versions until mobile adoption is complete. Removing or renaming an exported field should be treated as a breaking package change.
