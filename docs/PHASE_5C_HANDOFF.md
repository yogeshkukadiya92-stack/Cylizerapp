# Phase 5C handoff — scheduler, delivery, and secure downloads

## Delivered

- Migration `0017_report_delivery_workflows.sql` with tenant-isolated download redemption, delivery-attempt, and in-app inbox tables.
- Organization-local daily/ISO-week period keys and a bounded due-schedule enqueue function.
- Concurrent scheduler claims use `FOR UPDATE SKIP LOCKED`; schedule periods have a unique export-job key.
- Notification delivery de-duplication per user/channel/event occurrence, five-attempt cap, suppression state, lock completeness, and partial ready-queue indexes.
- Cryptographically random 256-bit download tokens; only SHA-256 digests are persisted and compared.
- Authenticated, owner-scoped, single-use report download redemption with an immutable redemption record.
- Authenticated inbox list and idempotent mark-read repository/API workflows.
- In-memory and PostgreSQL repository parity for artifact completion, redemption, inbox listing, and mark-read.
- Bounded exponential retry policy and timezone-aware period utilities with unit tests.

## API additions

- `POST /v1/report-downloads/:jobId/redeem`
- `GET /v1/notifications?limit=25`
- `POST /v1/notifications/:notificationId/read`

The redemption endpoint never accepts an object key from the caller. It validates authenticated tenant/user ownership, job readiness, expiry, exact token digest, and prior redemption before returning the storage key grant.

## Validation

- `npm run check`
- 17 ordered migrations and 40 FORCE RLS tenant tables.
- API: 141 tests across 10 files.
- Web: 58 tests across 11 files.
- Database: 62 tests, including four Phase 5C state/security tests.

## Provider boundary / remaining work

No production email or object-storage credentials were supplied, so Phase 5C deliberately stops at secure provider-independent interfaces and durable workflow state. Next work:

- A deployable worker executable that invokes schedule enqueue, claims export jobs, renders CSV/XLSX/PDF, uploads artifacts, and calls artifact completion.
- S3/GCS/Azure object-storage adapter with server-side encryption, lifecycle deletion, and streaming download response.
- Email provider adapter plus bounce/complaint/unsubscribe webhook authentication.
- Worker delivery loop that materializes in-app notifications and updates delivery retry/suppression state.
- Live PostgreSQL concurrency, DST-boundary, provider failure-injection, and object-retention evidence.
