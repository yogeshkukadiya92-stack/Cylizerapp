# Callora Android Phase 4A

Native Android companion for the Callora dashboard. The underlying Phase 3C foundation adds pair-first onboarding, a server-authoritative disclosure, client-generated device credentials, crash-safe replay/reconciliation, two-phase rotation, idempotent revocation, and fail-closed consent renewal.

Phase 4A also adds a session-authenticated, employee-scoped Leads workspace. The enrolled employee can search assigned leads, switch between not-contacted/overdue/unreturned queues, review the next follow-up in a bottom sheet, refresh from the server, and launch Android's system dialer. Lead data stays in memory only, is cleared whenever onboarding leaves `READY`, and is never exposed across device re-enrollment. The dial action uses `ACTION_DIAL`; the app does not request `CALL_PHONE`.

This is a technical alpha, not a Play Store-ready release. The enterprise flavor's call-log access requires an approved distribution path, policy/legal review, a real production API origin, release signing, and end-to-end testing on supported devices before deployment.

## Build variants

| Variant | Collection source | `READ_CALL_LOG` | Intended use |
| --- | --- | --- | --- |
| `demoDebug` | Deterministic synthetic rows | Absent | UI, API, queue, and sync demonstrations |
| `enterpriseDebug` | Android `CallLog.Calls` | Enterprise manifest only; requested at runtime after disclosure | Managed-device integration testing |
| Release variants | Same flavor boundary | Same flavor boundary | Blocked until production origin, signing, policy, and E2E gates are complete |

No flavor requests contacts, microphone, recording, phone-state, camera, or location permissions. The enterprise reader uses only the cached caller name already present on a call-log row; it never queries the contacts database. SIM/account identity is neither queried nor persisted and is intentionally omitted from the mobile upload contract.

## User and data flow

1. The fresh app starts with pairing. This step states that no call metadata is read.
2. Before the network request, the app generates a 256-bit `clb_` bootstrap secret and UUID request ID, then commits both with the pairing code to an encrypted protocol journal.
3. Pairing confirms the organization. The app fetches `GET /v1/mobile/collection-policy` with the proposed bootstrap secret.
4. The UI displays the server's exact title, summary, disclosure items, policy ID, versions, effective time, and opaque SHA-256 content hash. The app compares the hash for equality but never recomputes it from presentation JSON.
5. Acceptance generates and durably journals a 256-bit `cls_` session secret, UUID request ID, exact policy reference, receipt time, locale, and no-backfill checkpoint before activation.
6. Activation responses never contain a secret. The app promotes its proposed session secret only after the server echoes the exact policy ID/hash and matching device identity.
7. The enterprise build immediately requests `READ_CALL_LOG` after acknowledged activation. A one-policy-hash prompt marker is committed before launching Android's permission dialog, preventing process-death prompt loops. Denial keeps collection off.
8. The first scan checkpoint is the activation/renewal decision time. Only calls beginning afterward are eligible; historical rows are never backfilled.
9. Phone numbers and cached names are AES-GCM encrypted before a Room transaction commits them. WorkManager sends bounded deterministic batches through one serialized lane.
10. A `consent_required` directive first journals the required ID/hash, closes collection, cancels work, and crypto-erases the prior queue. Only the newly fetched exact policy can be accepted through `/v1/mobile/reconsent`.
11. Withdrawing consent journals an idempotent revoke request before the local purge. Lost responses replay with the same revoked credential and request ID.

Missing, unreadable, expired, unauthorized, or remotely revoked sessions fail closed: scheduled work is cancelled, the queue and WAL are purged, encryption keys and credentials are destroyed, consent is cleared, and the installation is marked revoked before re-enrollment.

## Architecture

- Jetpack Compose + Material 3: pair-first onboarding, exact server policy, activation, immediate enterprise permission, collector status, diagnostics, settings, rotation, and revocation.
- Android Keystore + AES-GCM: separate keys and authenticated context for the active credential, crash-safe protocol journal, and queued phone/contact fields.
- Room: durable offline queue with explicit `PENDING`, `IN_FLIGHT`, `RETRY`, `SYNCED`, and `REJECTED` transitions.
- WorkManager: network-constrained periodic tick and manual trigger both funnel through one unique one-time sync lane.
- UUID operation IDs plus stable SHA-256 call/batch IDs: mutation IDs are persisted before network use and must exactly equal `Idempotency-Key`.
- `HttpURLConnection`: bounded response bodies, timeouts, redirects disabled, Bearer auth, and no secret logging.

The queue contains metadata only. There is no audio recording or recording upload implementation.

## Mobile API contract

All successful endpoints return the repository's standard JSON envelope. Authenticated routes use `Authorization: Bearer <sessionCredential>`.

| Operation | Route | Notes |
| --- | --- | --- |
| Redeem pairing code | `POST /v1/device-pairings/redeem` | Sends UUID request ID, proposed `clb_` secret, collection mode, device facts, and permission report; response contains only a credential descriptor |
| Fetch policy | `GET /v1/mobile/collection-policy` | Bootstrap or session Bearer auth; returns the authoritative policy copy and opaque content hash |
| Activate device | `POST /v1/mobile/activate` | Bootstrap Bearer auth; submits proposed `cls_`, exact policy reference, consent, and permissions; response never contains the secret |
| Renew consent | `POST /v1/mobile/reconsent` | Active session auth; exact-replay policy receipt after a `consent_required` directive |
| Heartbeat | `POST /v1/mobile/heartbeat` | Reports app/OS, queue state, and exact permission state; handles tagged directives |
| Upload calls | `POST /v1/mobile/call-batches` | Maximum 100 items; `collectionMode` required; deterministic `Idempotency-Key` and immutable payload |
| Assigned leads | `GET /v1/mobile/leads` | Current-consent session only; repository enforces the credential employee as an assigned-only scope |
| Assigned lead detail | `GET /v1/mobile/leads/:leadId` | Returns `404` for another employee or tenant and never accepts a client-supplied employee scope |
| Prepare rotation | `POST /v1/mobile/session/rotation/prepare` | Old session auth; creates an overlapping pending client-proposed `cls_` credential |
| Confirm rotation | `POST /v1/mobile/session/rotation/confirm` | Proposed new session auth; uses a distinct confirm UUID plus `prepareRequestId`, promotes new and revokes old, and replays exactly |
| Revoke session | `DELETE /v1/mobile/session` | UUID body plus matching idempotency key; replay works with the same already-revoked credential |

`collectionMode` is `synthetic_demo` or `android_call_log`. `simCardId` and `recordingLocalId` are not sent. Provisioning, activation, re-consent, rotation, and revocation requests use a UUID body `requestId` that must exactly match `Idempotency-Key`.

## Crash and replay guarantees

- Proposed `clb_`/`cls_` credentials contain 32 bytes of CSPRNG entropy and are generated on-device. The server receives the plaintext once and stores only its keyed digest.
- Pairing code, proposed credentials, operation bearer, exact consent receipt, lower-bound checkpoint, and UUID are encrypted in one authenticated protocol journal before the first request.
- Redeem, activate, re-consent, rotation prepare/confirm, and revoke retry the exact immutable body after a lost response.
- Rotation never invalidates the old session during prepare. Confirmation durably records a new UUID bound to `prepareRequestId`, authenticates with the pending session, and only its acknowledged response promotes the local credential.
- Completing an operation destroys the journal encryption key before writing secret-free policy state under a fresh key.
- If the process dies between journal-key deletion and secret-free policy rewrite, startup journals a fail-closed re-consent repair with the still-valid session, purges the queue, and fetches the current policy.
- An unreadable journal, stale/unknown policy, policy ID/hash mismatch, wrong collection mode, missing/expired credential, or unauthorized response closes collection and prevents queue ownership from crossing enrollment boundaries.

## Toolchain

- Android Studio 2026.1
- JDK 21 to run Gradle; app bytecode target Java/Kotlin 17
- Gradle 9.4.1 (wrapper)
- Android Gradle Plugin 9.2.0
- Kotlin and Compose compiler plugin 2.2.10
- Compose BOM 2026.02.01
- compile/target SDK 36; minimum SDK 26

Android Studio includes a suitable JBR at:

```text
/Applications/Android Studio.app/Contents/jbr/Contents/Home
```

Create an untracked `local.properties` if Android Studio does not do so:

```properties
sdk.dir=/Users/<you>/Library/Android/sdk
```

## Build and test

From `apps/android`:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew :app:testDemoDebugUnitTest :app:testEnterpriseDebugUnitTest \
  :app:assembleDemoDebug :app:assembleEnterpriseDebug
./gradlew :app:lintDemoDebug :app:lintEnterpriseDebug
```

Run the Compose smoke test on an available emulator or managed test device:

```bash
./gradlew :app:connectedDemoDebugAndroidTest
```

The connected test validates that a fresh install starts at pairing and explicitly says no call metadata is read. With optional local API arguments it additionally verifies policy download, off-screen exact disclosure review, acceptance/activation, and the demo-ready state without committing a pairing secret. Start the development API on host loopback, create a `synthetic_demo` pairing code through the admin API/UI, then use an ADB reverse tunnel:

```bash
adb reverse tcp:4100 tcp:4100
./gradlew :app:connectedDemoDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.pairingCode=<SHORT_LIVED_CODE> \
  -Pandroid.testInstrumentationRunnerArguments.apiBaseUrl=http://127.0.0.1:4100
```

The JVM suite covers pair-first/activation permission gating, stale-consent transitions, 256-bit credential format, full protocol-journal round trips and truncation rejection, Android-compatible AES-GCM IV generation and tamper rejection, credential encoding, phone normalization, deterministic batching/size limits, retry bounds, and safe-log redaction. Room schemas are exported to `app/schemas`.

The wrapper JAR SHA-256 used by this alpha is:

```text
7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172
```

An offline build succeeds only after all plugins and artifacts are in Gradle's cache. On a clean machine, the first `--offline` attempt can fail for missing artifacts such as `kotlin-compiler-embeddable:2.2.10`, `kotlin-reflect:1.6.10`, and `kotlinx-coroutines-core-jvm:1.8.0`; allow Android Studio or Gradle to resolve dependencies once, then use `--offline` for reproducibility checks.

## Local API integration

Debug builds default to `http://10.0.2.2:4100`, the Android emulator route to the host machine. Debug cleartext is restricted to emulator/localhost loopback hosts. The address can be changed in the debug Settings screen; use HTTPS for any non-loopback environment.

Release builds hide URL editing, reject cleartext, and pin requests to
`BuildConfig.DEFAULT_API_BASE_URL`. Supply the exact deployed HTTPS origin through
`CALLORA_ANDROID_API_BASE_URL`; debug builds retain their emulator-loopback
override. Release pre-build and packaging paths reject placeholders and every
IP literal (including the complete IPv4 loopback range and bracketed IPv6
loopback), and fail closed unless that DNS origin plus the external keystore
path, alias, store password, and key password are present in the process
environment. Run `npm run release:preflight:android` from the root before
creating a release candidate; see
`docs/PHASE_3D_PRODUCTION_VERIFICATION.md` for the complete signing gate.

## Remaining release gates

- The demo APK, connected Compose onboarding test, and host-loopback API pairing/activation E2E passed on the available API 37.1 arm64 emulator. A deployed-origin E2E and supported API/OEM/power-management matrix remain release gates.
- Call-log permission is highly restricted for public store distribution. Enterprise/managed distribution and policy eligibility must be confirmed before enabling the real flavor outside a controlled test.
- Product/legal must approve every authoritative policy version and the prominent-disclosure placement immediately before the restricted permission request.
- Root integration still needs emulator and deployed-origin E2E for lost-response redeem/activate/re-consent/rotation/revoke, stale-policy directives, and tenant-bound queue purge.
- Real backend integration still needs admin revocation, supported OEM/API/power-management coverage, release signing, monitoring, and incident/restore exercises.

See `PHASE_3C_SECURITY.md` for the protocol state table and fail-closed invariants.
