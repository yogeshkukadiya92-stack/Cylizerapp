# Phase 3B backend handoff

Status: implemented and covered by offline/API tests. A live PostgreSQL run and
the production recovery gates below are still required before release.

## Delivered

- One-time pairing redemption creates a pending device and a 10-minute maximum
  bootstrap bearer atomically. Pairing, bootstrap, and session secrets are
  stored only as type-separated HMAC-SHA-256 digests using `AUTH_SECRET` as the
  application pepper.
- Activation accepts a strict, versioned `call_metadata` consent receipt and the
  complete six-field permission snapshot, consumes the bootstrap once, and
  creates a rotatable opaque session with a seven-day maximum lifetime.
- Heartbeat, call-batch, rotation, and self-revocation use device-session auth.
  Tenant, employee, and device identity comes from the credential; redundant
  request IDs must exactly match it.
- PostgreSQL mutations revalidate and lock the current credential, organization,
  employee, device, and active consent inside the tenant transaction. Mutations
  write transactional outbox events; HTTP audit events remain separate.
- Call batches require `Idempotency-Key == batchId`, contain at most 100 items,
  fit within 512 KiB, and require active call-log permission in production.
  Registration and item upserts are atomic, and an exact retry receives the
  originally persisted per-item response. A changed payload under the same
  device/batch identity is a conflict.
- `synthetic_demo` batches are explicitly non-production. SIM-card and recording
  IDs are rejected in this technical alpha rather than silently mis-associated.
- Migration `0008_mobile_device_sessions.sql` adds consent, hashed credentials,
  exact digest resolution, device-health fields, stable batch responses, FORCE
  RLS policies, left-prefix FK indexes, constraints, triggers, and least-privilege
  runtime grants.
- Re-pairing the same organization/employee/installation revokes prior
  credentials, withdraws consent, resets the device to pending, and issues a new
  bootstrap. An installation cannot be silently moved to another employee.

## Mobile HTTP contract

1. An authorized web admin creates an employee pairing code.
2. The app calls `POST /v1/device-pairings/redeem` with `code`, installation and
   platform metadata, and all permission states. It stores the returned
   `bootstrapCredential.token` in secure device storage.
3. The app shows the versioned prominent disclosure, then calls
   `POST /v1/mobile/activate` with the bootstrap bearer, consent versions,
   acceptance time, purpose, locale, and all permission states. It atomically
   replaces the bootstrap with `sessionCredential.token` in secure storage.
4. The app uses the session bearer for heartbeat and call batches. Enterprise
   collection sends `collectionMode: "android_call_log"`; local demo generation
   sends `synthetic_demo` only against a non-production API.
5. The app rotates with `POST /v1/mobile/session/rotate` and deletes the local
   session after a successful `DELETE /v1/mobile/session`.

Bootstrap and session authentication failures deliberately return the same
generic message. Credentials must never appear in logs, analytics, crash
reports, URLs, or database rows.

## Verified checks

```text
@callora/contracts build                     pass
@callora/api TypeScript typecheck             pass
@callora/api Vitest                           61/61 pass
@callora/database Node schema tests            8/8 pass
@callora/database offline schema verifier      pass
                                                   8 migrations
                                                   20 FORCE RLS tenant tables
```

API tests cover pairing expiry/reuse/revocation/throttling, bootstrap expiry and
one-time use, strict consent windows, generic credential failures, exact context
matching, heartbeat health/permission changes, session expiry, same-installation
re-pair, batch size/body/idempotency/replay/conflict behavior, production demo
blocking, rotation, and self-revocation. Scripted PostgreSQL tests cover exact
digest resolution, activation atomicity, trust-row locking, heartbeat health,
batch replay, and rotation order.

## Production release gates

1. Make raw-credential delivery recoverable. Today redemption, activation, and
   rotation return a secret once. If the HTTP response is lost after commit, the
   client cannot recover that secret; rotation has already revoked the old one.
   Same-installation re-pair is the current administrative recovery path. Before
   production, implement an acknowledged/two-phase handoff or a bounded rotation
   grace protocol without storing recoverable raw tokens.
2. Replace the process-local, IP-keyed pairing throttle with a shared limiter
   suitable for multiple API instances and trusted-proxy deployment.
3. Move device HTTP audit inserts into the same repository unit of work as the
   mutation, or derive the audit trail transactionally from outbox events. The
   outbox is atomic today; HTTP audit append is not.
4. Run migrations, grants, and isolation/integration tests against PostgreSQL 15+
   through non-owner `callora_api` and `callora_ingest` LOGIN roles. The current
   environment did not provide a live PostgreSQL target.
5. Define and implement the production protection policy for phone numbers and
   contact names at rest (for example application-layer encryption or tightly
   controlled database encryption/tokenization plus key rotation).

## Deferred product scope

- SIM/subscription mapping and recording upload are not wired; incoming IDs are
  rejected.
- Mobile rows currently set `isWithinWorkingHours` to `false`; organization and
  employee schedule calculation is a later phase.
- Expired sessions require re-pairing. Automatic refresh beyond explicit session
  rotation is not implemented.
