# Callora Phase 3C security and recovery handoff

- Date: 15 July 2026
- Status: implementation complete and locally verified; not production-approved
- Next slice: Phase 3D live staging, privacy, administrator recovery, and release approval

## Delivered

### Authoritative policy and consent

- Pairing establishes the organization and administrator-selected collection mode before disclosure.
- An immutable PostgreSQL policy registry owns the exact disclosure, version, purpose, effective window, and SHA-256 content identity.
- Android displays and accepts only the policy ID/hash returned by the authenticated API.
- Consent receipts bind the exact policy ID/hash and are append-only except for one-way withdrawal.
- A policy rollover closes collection, purges queued data, fetches the new authoritative disclosure, and requires affirmative re-consent.
- Activation performs one more authoritative policy fetch before the enterprise permission boundary, preventing a stale exact replay from opening `READ_CALL_LOG` prompting.

### Crash-safe mobile credentials

- Android generates every 256-bit `clb_`/`cls_` secret locally and stores it with Keystore AES-GCM before network use.
- The server persists only type-separated credential digests and never returns a raw secret.
- Redeem, activation, re-consent, rotation prepare/confirm, and revoke use UUID request IDs with exact non-secret replay.
- Rotation is two-phase: the current session remains valid while a pending replacement is prepared; confirmation promotes the pending session and revokes its predecessor atomically.
- Protocol journals repair process death, lost responses, expired pending rotations, policy rollovers, revocation purge boundaries, and rekey windows.
- Rotation drains the shared collection mutex before changing credentials, preventing an old-token worker from erasing the newly promoted session.
- No historical call-log backfill occurs before the affirmative activation/re-consent checkpoint.

### API and PostgreSQL hardening

- Migration `0009_mobile_policy_and_credential_recovery.sql` adds the policy registry, request ledger, credential lifecycle, append-only consent transitions, current-consent authorization, and bounded rate-limit store.
- Mobile security transitions run through narrow `SECURITY DEFINER` functions with pinned search paths, tenant rechecks, short lock ordering, and same-transaction audit/outbox evidence.
- All 21 tenant tables use RLS plus `FORCE ROW LEVEL SECURITY`; runtime roles have no direct request-resolution/rate-table access or credential/consent mutation privileges.
- Pairing redemption uses separate HMAC-only trusted-IP, pairing-code-digest, and installation limiter dimensions in a shared PostgreSQL backend.
- Forwarded client IPs are trusted only from explicit `TRUSTED_PROXY_CIDRS`; invalid CIDRs and `/0` networks fail configuration.
- Consent-rollover races return `CONSENT_REQUIRED`, while genuinely absent/revoked credentials retain generic `401` behavior.

### Android flavor boundary

- `demo` generates synthetic rows and does not declare or request `READ_CALL_LOG`.
- `enterprise` alone declares `READ_CALL_LOG`, and its prompt can open only after exact current-policy acknowledgement.
- Contacts, microphone/audio recording, SMS, camera, location, phone-state, broad storage, accessibility, VPN, and call-control permissions are not requested.

## Verification

- `npm run check`: passed.
  - API: 83/83 tests.
  - Web: 35/35 tests.
  - Database: 14/14 tests.
  - Total: 132/132 tests, plus contracts/API/web type checks and production builds.
- Schema verifier: 9 migrations, 21 FORCE-RLS tenant tables, 2 seeded tenants.
- `npm run android:check`: passed in 28 seconds; 113 Gradle tasks.
  - Demo: 23/23 tests.
  - Enterprise: 23/23 tests.
  - Both APK assemblies passed.
  - Both lint variants: 0 errors; 36 non-fatal dependency/SDK/KTX warnings each.
- API 37.1 emulator: clean install → pair-first → exact policy/hash → activation → post-activation policy preflight → `Demo collector ready`.
- Manual WorkManager run: `SUCCESS`; queue remained zero because pre-activation synthetic rows were correctly outside the no-backfill lower bound.
- Final crash log: 0 lines; no Callora fatal/protocol/sync errors.
- Final adversarial re-review: no open High, Medium, or Low finding inside the Phase 3C implementation scope.

The external npm registry audit was not rerun because sending dependency metadata to the public registry requires explicit approval.

## Packaged artifacts

| Artifact | SHA-256 |
| --- | --- |
| `Callora-Demo-Debug.apk` | `94e11035b0fe07b15ebaf0d4dfc15f6867fa465658a7beca4a0583c9218f14c4` |
| `Callora-Enterprise-Debug.apk` | `49c38fb0a52224d56c328ef933c5b1085a72b694ea9a7ae1b564de311236211f` |
| `callora-phase-3c-android-ready.png` | `0fbef09d6859d6392978cf12ea1c60c63ffb561eee0e320ccf6ca3920f1ec108` |
| `callora-phase-3c-authoritative-policy.png` | `401744fcb190adb3815fd4804587edecce1361ab1e500abcfe8faa7398ab14f3` |

Both APKs are debug-signed verification builds. Do not distribute the enterprise APK outside controlled testing.

## Production release gates

1. Apply and compile all migrations on PostgreSQL 15+; run live catalog, non-owner RLS, replay, rotation, limiter-concurrency, load, backup, and restore tests.
2. Add an audited administrator endpoint that revokes one stranded device when its client credential is unavailable.
3. Decide and enforce encryption or tokenization for stored phone numbers and contact names.
4. Integrate the real OIDC provider and deployed HTTPS origins; validate the exact reverse-proxy CIDRs.
5. Obtain product/legal approval for disclosure/privacy copy and the restricted-permission distribution route.
6. Add production signing and complete the supported Android API/OEM/power-management and physical-device matrix.

Phase 3C is internally consistent and fail-closed, but these gates prevent a production-readiness claim.
