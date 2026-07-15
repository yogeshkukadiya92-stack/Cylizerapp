# Callora Phase 3B Android technical-alpha handoff

- Date: 15 July 2026
- Status: complete as a technical alpha; not approved for production collection
- Next phase: Phase 3C production security, consent, staging, and distribution gates

## Delivered

### Mobile backend

- short-lived single-use pairing redemption and bootstrap activation;
- opaque `clb_` bootstrap and `cls_` session credentials with peppered digest-only server storage;
- mobile heartbeat, session rotation/revocation, and bounded call-batch endpoints;
- tenant, employee, and device context derived only from verified credentials;
- maximum 100 calls and 512 KiB per batch with exact `Idempotency-Key` replay;
- durable stored batch responses, conflict detection, outbox records, audit events, and PostgreSQL row locks;
- migration `0008_mobile_device_sessions.sql` with FORCE RLS, integrity constraints, indexes, grants, consent receipts, and device health;
- production rejection of synthetic mobile data.

### Native Android app

- Kotlin/Jetpack Compose app under `apps/android` with `demo` and `enterprise` flavors;
- disclosure, pairing, permission, collector status, diagnostics, settings, supervised rotation, revocation, and recovery states;
- `READ_CALL_LOG` only in the enterprise manifest; demo uses deterministic synthetic events;
- no contacts, microphone, recording, SMS, broad storage, camera, or location permission;
- first checkpoint at activation time, so historical call rows are not backfilled;
- Room offline queue with phone/cached-name fields encrypted by Android Keystore AES-256-GCM;
- provider-generated 96-bit GCM IVs, authenticated context, crypto-first purge, WAL truncation, and secure delete;
- one serialized WorkManager sync lane with network constraint, bounded retry, stable batch/request identifiers, and deterministic replay bodies;
- fail-closed behavior for missing, unreadable, expired, unauthorized, revoked, or withdrawn sessions;
- release API-origin pinning and debug-only localhost/emulator cleartext allowance;
- 48 dp minimum controls, semantic headings/tabs, scroll-aware disclosure, light/dark theme, and keyboard Done pairing action.

## Verification evidence

### Workspace

- `npm run check`: pass;
- API: 61/61 tests;
- web: 35/35 tests;
- database: 8/8 tests;
- schema verifier: 8 ordered migrations, 20 FORCE RLS tenant tables, 2 seeded tenants;
- contracts/API/web type checks and production builds: pass.

The external `npm audit --omit=dev --audit-level=high` request was not completed in this run because execution policy requires explicit approval before sending project dependency metadata to the public npm registry.

### Android

- demo JVM tests: 9/9;
- enterprise JVM tests: 9/9;
- demo lint: 0 errors, 33 non-blocking warnings;
- enterprise lint: 0 errors, 33 non-blocking warnings;
- demo and enterprise debug APK assembly: pass;
- API 37.1 arm64 emulator connected onboarding test: pass;
- optional emulator-to-host-loopback API E2E: pass through disclosure, pairing redemption, activation, Keystore persistence, and `Demo collector ready`.

Emulator QA found and fixed two issues that JVM tests could not reproduce:

1. a Room open crash caused by executing a result-returning `PRAGMA secure_delete` through `execSQL`;
2. Android Keystore rejecting a caller-provided AES-GCM IV while randomized encryption is required.

## APK artifacts

| Artifact | SHA-256 |
| --- | --- |
| `Callora-Demo-Debug.apk` | `7105c9b24ef0fb8b16f0b564b8a2b93b0b15be28abfc7be1fe8ef6b833f08ea3` |
| `Callora-Enterprise-Debug.apk` | `2a06e39e43a2ea369ad1c3ff5220dcf30aa77ae38543528b522005cf58bdf412` |

Both are approximately 12 MiB debug-signed technical-alpha builds. The enterprise APK must remain limited to controlled testing until distribution and restricted-permission approval.

## Phase 3C mandatory production gates

### P0

1. Replace one-time server-generated credential transitions with client-generated pending secrets, exact replay, overlapping two-phase rotation, idempotent revoke-by-digest, and audited administrator recovery.
2. Add an immutable authoritative policy/disclosure version and content-hash registry; reject unknown/stale consent and fail collection closed after required policy upgrades.
3. Establish organization identity first, then show the complete prominent disclosure immediately before requesting `READ_CALL_LOG`; obtain product/legal and distribution-channel approval.

### P1

1. Move pairing throttling to a bounded shared store with trusted-proxy-aware IP, code-digest, and installation dimensions.
2. Make consent evidence append-only except one-way withdrawal; protect credential identity/digest/ancestry behind narrow database transition functions.
3. Put HTTP audit evidence in the same transaction/outbox unit as irreversible mutations.
4. Decide and implement backend encryption/tokenization for stored phone/contact PII.
5. Run PostgreSQL 15+ migrations, grants, two-tenant isolation, batch replay, revoke, rotation, backup/restore, and load tests with non-owner runtime roles.
6. Configure production API origin, release signing, supported API/OEM/power matrix, privacy/data-safety declarations, and approved public/private distribution route.

## Recommended next implementation order

1. authoritative consent registry and disclosure/permission flow;
2. crash-safe credential transition protocol and client pending-state vault;
3. append-only database transitions, transactional audit, and shared rate limiting;
4. live PostgreSQL/OIDC staging plus deployed-origin Android E2E;
5. device matrix, signing, policy evidence, and controlled release candidate.

