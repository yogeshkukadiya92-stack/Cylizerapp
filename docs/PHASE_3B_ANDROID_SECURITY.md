# Callora Phase 3B Android security and privacy boundary

- Date: 15 July 2026
- Status: implementation contract for the technical alpha
- Collection model: transparent, consented enterprise call-metadata sync

## Distribution flavors

`demo` is the default development and public-safe flavor. It contains no
`READ_CALL_LOG`, contact, recording, broad-storage, SMS, or call-control
permission and can enqueue only synthetic call records.

`enterprise` is the only flavor allowed to declare `READ_CALL_LOG`. Building the
flavor does not authorize distribution or collection. It remains behind a
corporate-login/distribution decision, Google Play or managed-enterprise policy
approval, an in-app privacy policy, a prominent disclosure, and runtime consent.
The project intentionally does not request contacts or recording-file access.

## Pairing and session lifecycle

1. An administrator creates a short-lived pairing code for one active employee.
2. The Android installation redeems it with non-sensitive device/app metadata.
3. The API atomically consumes the pairing code, creates a pending device, and
   returns a one-time bootstrap credential. Only a peppered digest is stored.
4. The app presents the versioned prominent disclosure. Pairing is not consent.
5. The app submits the accepted policy/disclosure versions, timestamp, locale,
   and complete permission snapshot using the bootstrap credential.
6. The API records the consent receipt, consumes the bootstrap, activates the
   device, and returns one opaque seven-day session credential exactly once.
7. The session credential is encrypted with an Android Keystore AES-GCM key.
   Server storage contains only a digest. Rotation is a supervised technical-alpha
   action; automatic production rotation is blocked on the Phase 3C recovery
   protocol described below.
8. Expired, revoked, inactive-employee, inactive-device, withdrawn-consent, and
   wrong-scope credentials receive the same generic unauthorized response.

No organization, employee, or device ID supplied in a mobile body selects tenant
context. The API derives all three from the verified device credential and treats
redundant IDs only as equality assertions.

## Collection gates

The enterprise reader may query `CallLog.Calls` only when all conditions are
true at the same time:

- build flavor permits enterprise collection;
- a non-expired device session exists;
- the current disclosure/policy version has an active consent receipt;
- Android reports `READ_CALL_LOG` as granted;
- the device/employee is active and server configuration has not paused sync.

If any gate becomes false, the app cancels collection and sync work immediately.
Consent withdrawal or sign-out additionally revokes the server session, deletes
the local credential, purges queued sensitive payloads, and removes the local
checkpoint. Denying permission never loops or repeatedly prompts the employee;
the UI explains how to recover through Settings.

## Local protection

- Keystore AES-256-GCM keys are non-exportable and limited to encrypt/decrypt.
- Every encryption uses a new secure-random 96-bit IV; ciphertext includes the
  format version and authentication tag.
- The Room queue stores phone/contact payload fields only as ciphertext.
- The database, preferences, and app-private files are excluded from backup and
  device-to-device transfer.
- No bearer/bootstrap/session token, pairing code, phone number, contact name,
  ciphertext, IV, raw API body, or CallLog row is written to logs or crash
  breadcrumbs.
- Screen state exposes masked diagnostic identifiers only.

## Queue and synchronization

- A stable local ID is derived once per native row/version and reused on retry.
- Room inserts the encrypted event and advances its read checkpoint in one local
  transaction.
- WorkManager runs only with a network constraint and exponential backoff.
- One request contains at most 100 items and remains below the API body limit.
- Batch ID and immutable payload are reused exactly across retries.
- The API writes batch registration, item upserts, results, and outbox state in
  one tenant transaction. Reusing a batch ID with different immutable data is a
  conflict.
- Created, updated, duplicate, rejected, and retryable outcomes are explicit.
  Acknowledged items are removed; rejected items remain visible for diagnostics
  without exposing their sensitive payload.
- Heartbeats report only bounded operational metadata: permission states, queue
  counts, app/OS version, sync state, network class, and optional battery state.

## Explicit exclusions in this alpha

- no hidden/background collection before disclosure and consent;
- no contact permission or address-book upload;
- no recording discovery, audio capture, upload, playback, or transcription;
- no SMS, outgoing-call control, accessibility service, VPN, or broad storage;
- no advertising, profiling, or secondary use of call metadata;
- no production distribution claim before the chosen channel accepts the
  restricted-permission use case;
- no claim of production readiness before live PostgreSQL/RLS, real identity,
  device revocation, key rotation, load, backup/restore, and incident tests pass.

## Phase 3C production credential gate (P0)

The current API returns a server-generated bootstrap/session secret once and
stores only its digest. This preserves hash-only server storage, but a network
loss after redeem, activation, rotation, or revocation can leave the client
unable to prove the resulting server state. Rotation also invalidates the old
credential before the replacement response is durably known. Therefore the
technical-alpha rotation control must not be used as automatic production
rotation, and an unconfirmed self-revocation requires an administrator fallback.

Before production, implement a crash-safe protocol with all of these properties:

- the client generates each 256-bit bootstrap/session secret in Android Keystore
  and durably records current/pending state plus a request ID before sending;
- redeem and activation accept the proposed credential and replay the exact
  previous result for the same installation/request identity;
- rotation creates a pending overlapping credential, lets the client probe and
  acknowledge it, then promotes it without an authentication gap;
- revocation is idempotent for the same credential digest and returns the stored
  revocation result when the first response was lost;
- an audited administrator revoke path resolves devices whose client credential
  is unavailable or unreadable.

Do not solve recovery by storing recoverable plaintext credentials on the server.

## Phase 3C production consent/compliance gate (P0)

The technical alpha persists local disclosure acceptance as a Boolean/timestamp
and the API accepts bounded version strings supplied by the client. That is not
an authoritative, upgrade-safe production consent boundary. Before production:

- keep an immutable server registry of the current policy/disclosure version and
  content hash for each collection purpose and distribution channel;
- issue only server-approved versions, bind the exact hash into the receipt, and
  reject activation or heartbeat when the client/receipt is stale or unknown;
- fail collection closed after an app/policy upgrade until the required current
  disclosure has been affirmatively accepted;
- have product/legal owners approve a sequence that establishes organization
  identity first, then shows the complete prominent disclosure immediately before
  the Android restricted-permission request; and
- repeat collection, use, sharing, retention, and withdrawal facts at the
  permission decision rather than referring only to an earlier screen.

## Phase 3C structural hardening (P1)

- replace the process-local IP-only pairing limiter with a bounded shared limiter
  using trusted-proxy-aware IP, code digest, and installation dimensions;
- make consent receipts append-only except for a one-way withdrawal transition;
- make credential digest, identity, and ancestry immutable behind narrow database
  transition functions instead of broad table update/delete grants;
- write HTTP audit evidence in the same transaction/outbox unit as each mutation;
- complete the backend phone/contact PII encryption or tokenization decision; and
- run migrations and two-tenant isolation/E2E tests against live PostgreSQL 15+
  using the non-owner runtime roles.

## Required evidence before real-device collection

- approved distribution decision and permissions declaration;
- prominent-disclosure copy, privacy policy, data-safety answers, and consent
  withdrawal flow reviewed by product/legal owners;
- two-tenant staging tests with the non-owner database role;
- device credential replay, rotation, expiry, revocation, and brute-force tests;
- supported Android/API/OEM and power-management matrix;
- offline seven-day catch-up, process-death, upgrade, and clock-skew tests;
- sensitive-log scan and local-storage inspection;
- backend PII encryption/tokenization decision for stored phone/contact fields.
