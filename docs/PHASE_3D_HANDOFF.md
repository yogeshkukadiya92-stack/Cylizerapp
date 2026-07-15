# Callora Phase 3D production-hardening handoff

- Date: 15 July 2026
- Status: implementation complete and locally verified; not production-approved
- Next product slice: Phase 4 lead CRM and employee follow-up workflow
- Parallel launch track: live PostgreSQL/OIDC/Android release evidence

## Delivered

### Audited administrator device recovery

- Added `POST /v1/devices/:deviceId/revoke` for owner/administrator recovery of
  one stranded device.
- Enforced `devices.manage`, exact tenant/device scope, a UUID idempotency key,
  bounded single-line reason, actor/target/payload-bound replay, and stable
  conflicts when a request ID is reused differently.
- Migration `0010_admin_device_recovery.sql` atomically revokes active/pending
  credentials, withdraws consent, updates the device, and appends audit/outbox
  evidence.
- Added a permission-gated dashboard action, exact-device confirmation, warning
  copy, reason validation, destructive confirmation, and immediate row refresh.

### Call participant PII protection and rotation

- Phone numbers and contact names now use application-layer AES-256-GCM
  envelopes; no key material enters PostgreSQL.
- Format 2 authenticates tenant, row, field, encryption version, encryption-key
  version, blind-index-key version, and blind index through AES-GCM AAD.
- Encryption keys and blind-index keys are independent versioned keyrings. A
  third independent stable row-ID key prevents blind-key rotation from changing
  deterministic mobile call identities.
- Exact lookup can compute `(blind key version, tenant-bound HMAC)` candidates
  for every retained version during a rolling rotation.
- Migrations `0011`–`0013` add encrypted envelopes, persisted blind-key version,
  legacy format-1 compatibility, bounded `SKIP LOCKED` backfill/rotation,
  optimistic compare-and-swap updates, and retry-safe concurrent index builds.
- Existing mobile calls reuse their stored UUID during upgrade, preventing an
  AAD/identity conflict after row-ID key separation.
- Added `pii:backfill`, `pii:rotate`, `pii:verify`, and `pii:finalize`. Finalize
  refuses unauthorized writer/migrator LOGIN capability or ADMIN paths,
  transaction-locally acquires and removes writer ACL authority, and validates
  a format-2 encrypted-only constraint before traffic can resume.

### Database and runtime boundary

- Runtime/API/ingest roles have no direct `call_logs` write permission; writes
  go only through encrypted, tenant-checking `SECURITY DEFINER` functions.
- Access replay removes and verifies `TRUNCATE` denial for every Callora group
  role; live runtime and PII-migrator gates also reject direct/inherited
  `TRUNCATE`, which is not protected by row-level security.
- An isolated `NOLOGIN` writer owns the call-write functions. A separate
  `NOLOGIN` migrator is granted only to one short-lived backfill LOGIN.
- Access bootstrap purges stale writer/migrator capability membership and uses
  recursive, version-aware `pg_auth_members` proofs instead of
  superuser-sensitive `pg_has_role` checks. PostgreSQL 16+ keeps only the
  migration owner's non-capability `ADMIN TRUE, INHERIT FALSE, SET FALSE`
  control edge.
- Access bootstrap always revokes legacy implicit-blind-version overloads and
  grants only explicit versioned runtime functions.
- Every access/bootstrap replay dynamically removes default PUBLIC EXECUTE from
  all Callora `SECURITY DEFINER` routines. This also repairs ACL-free restores
  created with `pg_dump --no-privileges`.
- ACL repair is replay-safe under the required non-super migration owner: writer
  capability is enabled only after stale-capability purge and removed after
  owner assignments, while PostgreSQL 16+ retains only admin control. The live
  harness replays this path twice on both source and restored databases.
- Direct database CLI commands remove URL passwords from process arguments,
  reject SSL URL overrides, require an explicit TLS mode, and permit disabled
  TLS only on an exact loopback host. Every remote connection requires
  `verify-full`.

### Reproducible release gates

- Added config/network/Android preflight for production auth mode, exact HTTPS
  origins, CORS, proxy CIDRs, PostgreSQL TLS, PII key independence/versioning,
  OIDC discovery/JWKS compatibility, deployed health/readiness, Android endpoint,
  external keystore, alias, certificate validity, and signer fingerprint.
- OIDC/JWKS validation rejects private/symmetric keys, malformed keys, weak or
  incompatible algorithms, and Ed448 when runtime support is Ed25519-only.
- Android release variants fail closed on placeholder/IP/loopback endpoints or
  absent signing inputs; debug flavors keep their controlled local behavior.
- Added a PostgreSQL 15+ evidence harness for migration replay, non-owner FORCE
  RLS, exact role membership, shared limiter/credential concurrency, bounded
  load, schema-scoped backup/restore, UTC data manifests, exact PII index and
  constraint state, function owner/search-path/ACL state, and sanitized JSON
  evidence.
- CI includes ephemeral PostgreSQL 15 and 16 jobs and uploads version-labelled,
  sanitized Phase 3D evidence artifacts.

## Verification

- `npm run check`: passed.
  - Release preflight: 8/8.
  - API: 98/98.
  - Web: 39/39.
  - Database: 40/40.
  - All TypeScript type checks and production builds passed.
- Schema verifier: 13 ordered migrations, 22 FORCE-RLS tenant tables, and two
  seeded tenants.
- `npm run android:check`: passed in 22 seconds; 113 Gradle tasks.
  - Demo: 23/23 JVM tests and debug APK assembly.
  - Enterprise: 23/23 JVM tests and debug APK assembly.
  - Both lint variants completed with zero errors.
- Dashboard recovery visual QA passed against the local API:
  - only the permitted employee row exposed the action;
  - exact device/warning/reason/disabled-enabled confirmation states worked;
  - cancel closed safely and no destructive request was sent;
  - desktop and 360 px layouts had no horizontal overflow or console errors.
- Final adversarial review found no validated High, Medium, or Low code finding
  in the integrated Phase 3D scope.

The public dependency registry audit was not rerun because it requires external
network access. No real PostgreSQL server/client, production IdP, deployed
origin, release keystore, or physical Android fleet was available locally.

## Mandatory production evidence

Phase 3D tooling is ready, but Callora must not be labelled production-ready
until all of these gates have recorded owners, timestamps, environment IDs, and
evidence links:

1. Rehearse migrations `0011`–`0013` on a production-scale restored clone and
   approve measured lock, constraint-scan, index-build, and rollback/roll-forward
   windows.
2. Take and restore-check a provider backup, drain API/ingest/worker/call writers,
   apply all migrations and access rules, then keep traffic drained.
3. For every tenant, run backfill, active-key rotation, and verification through
   the sole short-lived migrator LOGIN; revoke/drop it and prove zero actual
   writer/migrator LOGIN membership.
4. Run `pii:finalize`, the exact PII catalog gate, non-owner RLS/concurrency/load
   checks, schema-scoped backup/restore, and source/restore manifest comparison.
5. Validate the real OIDC PKCE flow, negative token cases, exact deployed
   web/API/CORS/proxy topology, certificates, DNS, WAF limits, monitoring, and
   incident/rollback authority.
6. Build signed demo/enterprise release artifacts with the protected keystore,
   verify signer/checksums, complete the supported API/OEM/power/device matrix,
   and obtain legal/privacy/restricted-permission/distribution approval.

The exact commands and fail-closed requirements are in
`docs/PHASE_3D_PRODUCTION_VERIFICATION.md` and
`docs/PRODUCTION_AUTH_DATABASE_RUNBOOK.md`.
