# Phase 6 handoff — external recordings and transcription

## Delivered

- Fail-closed, organization-level policy with explicit disclosure/consent,
  enablement, quota, retention and transcription switches.
- External-source manifests (`device_folder`, `voip_provider`, or
  `manual_upload`) that never imply native cellular audio capture.
- Resumable 5 MiB parts, per-part and final SHA-256 validation, one-hour upload
  sessions, organization-scoped checksum deduplication and a 500 MiB file cap.
- Five-minute opaque playback grants, private/no-store ranged responses and no
  permanent public object URL.
- Optional asynchronous transcription whose provider failures leave the call
  recording available, plus deletion of the source object and transcript.
- Authenticated API routes for upload, completion, playback authorization,
  ranged playback and deletion.
- Migration `0020_recordings_and_transcripts.sql`: tenant-isolated recording,
  upload-part, transcript and access-audit tables with FORCE RLS, retention and
  lookup indexes.

## Production gates still required

- Approved jurisdiction-specific legal/employee/customer disclosure text and a
  proven lawful recording source. Uploads must remain disabled until approved.
- Persistent PostgreSQL implementation of the recording service metadata and a
  production object-store adapter for audio (the shipped in-memory service is a
  tested orchestration/reference implementation).
- Malware/media validation worker, legal-hold/retention deletion scheduler,
  quota usage reconciliation and immutable access-audit writes.
- Chosen transcription provider, redaction policy, DPA, cost metering, webhook
  verification and provider-failure/live-load evidence.
- Web recording settings/player and Android external-folder onboarding UI.

## Verification

- Consent rejection, checksum validation, deduplication, short-lived ranged
  playback, transcription failure isolation and derivative deletion are covered
  by automated tests.
- API typecheck/test, schema verification and full production build pass.
