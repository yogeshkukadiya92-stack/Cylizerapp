# Phase 5D handoff — report worker foundation

## Delivered

- Provider-independent report worker contract with bounded polling and graceful abort.
- PostgreSQL `SKIP LOCKED` export-job claims through the existing security-definer function.
- Lease-owner and lease-expiry enforcement before artifact completion.
- Five-attempt bounded retry with exponential delay and terminal failure state.
- Duplicate-safe due-schedule enqueue and bounded operational ticks.
- Production PostgreSQL row loaders for every current report kind, with strict
  date/relative-period resolution, tenant transaction context, a 30-second SQL
  timeout, aggregate-only call output, and a 10,000-row ceiling.
- UTF-8 CSV rendering with spreadsheet BOM, quoting, and stable union columns.
- Atomic, permission-restricted filesystem artifact storage with path traversal rejection.
- Authenticated single-use artifact response streaming with private/no-store,
  nosniff, safe attachment names, bounded file reads, and no object-key exposure.
- Fail-closed worker runtime configuration with separate queue/data LOGIN URLs,
  production `verify-full` TLS, explicit artifact root, validated worker identity,
  and bounded poll/lease/schedule/job settings.
- Authenticated claim-on-demand download grants: a ready report owner can mint a
  short-lived plaintext token in memory while persistence receives only its
  SHA-256 hash; redeemed jobs cannot mint replacement grants.
- Cryptographically random download grants; only their SHA-256 digests enter persistence.

## Verification

- API worker and PostgreSQL adapter unit tests cover claim, enqueue, bounded drain,
  successful completion, unsupported format failure, retry cleanup, and shutdown.
- The full API test suite, typecheck, and production build pass.

## Remaining Phase 5D work

- Production-volume reconciliation evidence proving loader aggregates remain
  identical to the interactive API metric definitions.
- XLSX and PDF renderers with bounded memory and output-size limits.
- S3-compatible encrypted object storage reader/writer implementation.
- Email provider delivery, verified bounce/complaint/unsubscribe webhooks, and in-app delivery materialization.
- Live PostgreSQL concurrency/DST/provider-failure evidence.
