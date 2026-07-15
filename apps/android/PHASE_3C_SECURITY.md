# Phase 3C Android security notes

## Non-negotiable invariants

- Pairing precedes disclosure and never reads the call log.
- Only a policy returned by the authenticated collection-policy endpoint is displayable or acceptable.
- `contentHash` is an opaque server canonical SHA-256 identifier. Android compares exact lowercase values across fetch, directive, activation, and re-consent; it does not derive a hash from presentation JSON.
- Every mutating protocol request has a UUID `requestId`; the same value is sent as `Idempotency-Key`.
- Every proposed credential, operation bearer, request ID, and exact immutable receipt is Keystore AES-GCM encrypted and synchronously committed before network use.
- Collection requires secret-free `IDLE` protocol state, an acknowledged current policy/receipt, a valid session, local consent, non-stale server consent, and the flavor-specific permission gate.
- Any identity or consent transition closes collection before source reads. Enrollment, stale consent, revocation, invalid credentials, and unreadable crypto state purge the queue before another tenant can own the installation.
- Phase 4B lead writebacks are immutable, employee/device-bound composite commands. User-entered notes and follow-up text are encrypted under a separate Keystore key, request IDs exactly match `Idempotency-Key`, and the commands are purged at the same identity/consent boundaries as call metadata.
- Activation and renewed consent set a durable lower-bound checkpoint at the affirmative decision time. No historical backfill is performed.

## Journal phases

| Phase | Durable replay material | Collection |
| --- | --- | --- |
| `REDEEM_PENDING` | pairing code, installation ID, UUID, proposed `clb_` | Off |
| `DISCLOSURE_READY` | bootstrap identity/secret and exact server policy | Off |
| `ACTIVATION_PENDING` | exact policy receipt, UUID, proposed `cls_`, checkpoint | Off |
| `IDLE` | secret-free accepted policy/receipt | Allowed only when all other gates pass |
| `RECONSENT_POLICY_PENDING` | expected directive ID/hash and current session snapshot | Off; queue purged |
| `RECONSENT_READY` | exact replacement policy and current session snapshot | Off; queue purged |
| `RECONSENT_PENDING` | exact new receipt and UUID | Off; queue purged |
| `ROTATION_PREPARE_PENDING` | current session, proposed session, UUID | Off until reconciliation |
| `ROTATION_CONFIRM_PENDING` | current/pending sessions, distinct confirm UUID, `prepareRequestId`, pending expiry | Off until promotion |
| `REVOKE_PENDING` | current session and UUID | Off; queue purged; exact server retry allowed |

Completed pending secrets are crypto-erased by deleting the journal key before the accepted policy state is written under a fresh key. A crash in that rekey window is detected as a valid session without an accepted policy journal; startup persists a re-consent repair, closes and purges collection state, then fetches the authoritative current policy.

## Permission boundary

`demo` has no `READ_CALL_LOG` declaration and can emit only `synthetic_demo` rows. `enterprise` alone declares `READ_CALL_LOG`. After acknowledged activation, Compose commits a per-policy prompt marker and immediately launches Android's permission request. Denial does not loop; manual recovery remains available from the permission screen and system settings.

No flavor requests contacts, microphone, audio recording, SMS, camera, location, phone-state, broad storage, accessibility, VPN, or call-control permissions.

## Remaining integrated evidence

- emulator process-death at every journal/network/commit boundary;
- proxy-induced lost response for each idempotent mutation;
- stale directive with matching and mismatching policy ID/hash;
- two-tenant re-enrollment proving queue/key/checkpoint isolation;
- supported API/OEM/power-management matrix and seven-day offline catch-up;
- release-origin TLS, signing, sensitive-log scan, local-storage inspection, and managed-distribution approval.
