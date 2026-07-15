# Production completion handoff

## Newly live-wired

- Report worker and API download runtime now share an explicit
  `REPORT_ARTIFACT_STORE=filesystem|s3` selection. S3 mode requires HTTPS,
  SigV4 credentials and an exact 32-byte client-side encryption key.
- Durable PostgreSQL API-key management is connected to authenticated
  `/v1/api-keys` create/list/revoke routes with tenant transaction context.
- API-key plaintext is returned only once on creation; lists contain metadata
  only. Runtime grants ship in ordered migration `0022` without rewriting prior
  migrations.
- Health/readiness responses include the immutable release SHA and non-secret
  capability availability for support diagnostics.

## Repository-complete vs externally blocked

All numbered roadmap phases and repository-implementable closeout controls are
present. The application must still be considered **not production launched**
until real infrastructure and third-party inputs exist:

- Deployed PostgreSQL/S3/Resend/OIDC/Stripe/connector credentials and live tests.
- Persistent recording metadata/object pipeline, malware validation, retention
  worker and approved recording/transcription provider terms.
- Stripe products/prices, verified billing webhook endpoint and tax scope.
- APNs, iOS Keychain/OIDC/signing/privacy manifest and Play/App Store approvals.
- Independent security review, production-like restore/load drills, two 14-day
  pilot sign-offs, legal/DPA/subprocessor approvals and launch-owner sign-offs.

The machine launch gate remains fail-closed until those evidence IDs are supplied.
