# Callora Phase 4B handoff

- Completed locally: 15 July 2026
- Status: implementation and local verification complete
- Next product slice: Phase 5 reports, notifications, and operational delivery workflows
- Production release gate: Phase 3E external evidence remains open

## Delivered

### Lead imports

- Robust browser CSV parsing for UTF-8 BOM, CRLF, quoted commas/newlines,
  escaped quotes, malformed-row evidence, duplicate headers, 2 MB files, and
  at most 1,000 data rows.
- Server-authoritative preview, validation, team-scoped primary/alternate-phone
  deduplication, encrypted staging, masked error output, audit events, and
  stable request replay.
- Resumable 50-row commits. A verified 51-row case completes as 50 + 1 without
  losing round-robin position or invalidating its own remaining rows.
- Invalid rows never retain phone ciphertext or reserve a phone that prevents a
  later valid row from importing. Tags and bounded custom fields survive commit.

### Assignment and correction

- Versioned fixed-owner and round-robin rules with conditions, active-owner
  validation, deterministic cursor persistence, dry-run, and explicit apply.
- Commit-time rule/member locks, canonical employee lock order, staged-version
  drift detection, and globally ordered phone locks close the production race
  and deadlock paths covered by the security review.
- Atomic call-to-lead correction verifies the current link, locks affected
  calls/leads, preserves immutable history, and supports idempotent replay.

### Lead reports

- Scoped filters for date range, team, owner, and source.
- Cohort, conversion, follow-up, pipeline, trend, owner, and source metrics.
- Average first response is derived from the first answered active linked call;
  in-memory and PostgreSQL implementations use the organization timezone.
- Accessible labels and a semantic trend table preserve exact values without
  requiring hover or color alone.

### Android post-call workflow

- Truthful `ACTION_DIAL` return behavior: returning from Phone only suggests an
  update and never claims that a call connected or completed.
- Status, note, and optional follow-up are one durable mutation with one stable
  request UUID and compare-and-swap lead version.
- Room database version 2 adds a separately encrypted AES-GCM lead-mutation
  queue with bounded retry, conflict/rejected states, and WorkManager sync.
- Queue writes re-read consent, policy, credential, and enrollment state inside
  the enqueue gate. Revocation or consent withdrawal purges queued mutations
  and the dedicated key.
- Server replay receipts are minimal and PII-free. Exact successful retries are
  replayable after reassignment and after the fresh-command age window, while
  new stale commands remain rejected.

## API surface

- `POST /v1/lead-imports/preview`
- `GET /v1/lead-imports`
- `GET /v1/lead-imports/:jobId`
- `GET /v1/lead-imports/:jobId/errors`
- `POST /v1/lead-imports/:jobId/commit`
- `GET|POST|PATCH /v1/lead-assignment-rules`
- `POST /v1/lead-assignment-rules/dry-run`
- `POST /v1/lead-assignment-rules/apply`
- `POST /v1/calls/:callId/lead-link/correct`
- `GET /v1/lead-reports`
- `GET /v1/mobile/lead-statuses`
- `POST /v1/mobile/leads/:leadId/updates`

## Data and authorization

- Migration `0015_lead_operations.sql` brings the repository to 15 ordered
  migrations and 33 tenant tables protected by ENABLE + FORCE RLS.
- Import staging stores encrypted phone envelopes and HMAC request
  fingerprints; invalid raw phones and plaintext replay PII are not retained.
- Import/rule operations require `leads.assign`; reports require `reports.read`;
  correction requires `calls.annotate` and `leads.assign`.
- Current team/actor scope is rechecked for previews, list/detail/error access,
  commit, and replay. A user moved off a team cannot read or commit staged PII.
- Mobile update, heartbeat, and ingest share the same explicit trust-row lock
  order, removing update/revocation/ingest deadlock paths.

## Verification evidence

- `npm run check`: passed
  - API: 136/136
  - Web: 56/56
  - Database: 54/54
  - Release preflight: 8/8
  - Total local JavaScript/TypeScript/schema checks: 254
  - Contracts/API/web type checks and production builds: passed
- Schema: 15 migrations, 33 FORCE-RLS tenant tables, 2 isolated seed tenants.
- Focused Phase 4/PostgreSQL security and concurrency tests: 44/44 inside the
  API suite.
- `npm run android:check`: passed
  - Demo JVM: 36/36
  - Enterprise JVM: 36/36
  - Demo and enterprise debug APK builds: passed
  - Demo and enterprise lint: passed with zero errors
- Browser QA: live local API plus demo fallback, clean console, no framework
  overlay, and no page-level horizontal overflow at 320, 390, and 1440 px.
- Final bounded backend review: approved with no remaining blocker.
- `git diff --check`: passed.

## Visual fidelity ledger

1. Shell geometry keeps the Callora sidebar, header, active navigation,
   true-white surfaces, cool-gray canvas, teal actions, and Lucide icon family.
2. Locked copy matches the concepts for `Lead operations`, `Lead reports`,
   `Apply filters`, `Export CSV`, `Preview import`, and `Import valid rows`.
3. Report hierarchy matches the concept: filters, four KPIs, direct pipeline
   progression, labeled trend, owner table, and source table.
4. The implementation intentionally uses native separate From/To date controls
   and directly labeled bars instead of a decorative tapered funnel. This keeps
   keyboard/mobile behavior and exact values clearer.
5. The demo-only API warning and data-source badge are implementation additions
   required for product truth; they disappear/change when live data is active.
6. At 720 px and below, filters stack, KPIs become a contained 2 × 2 grid,
   tables become structured rows, and the chart scroll stays inside its own
   container. The document itself remains 320/390 px wide.

## Artifacts

- `outputs/callora-phase4b-lead-operations-concept.png`
- `outputs/callora-phase4b-lead-reports-concept.png`
- `outputs/callora-phase4b-android-post-call-concept.png`
- `outputs/callora-phase4b-web-implementation.png` (1440 × 1000)
- `outputs/callora-phase4b-web-mobile-implementation.png` (390 × 844)
- `outputs/Callora-Demo-Debug.apk`
  - SHA-256: `a4b95df14fb4a67adae5c846fc63e8d9e99c7bc963a6e63cf3be1156f08b7715`
- `outputs/Callora-Enterprise-Debug.apk`
  - SHA-256: `31cf716351713d944cfbf1f7fda0acf8fb6608226c83891819919393afd90f8d`

## Remaining launch boundaries

- Debug APKs are not production-signed release artifacts.
- Physical Android API/OEM/power-restriction coverage, distribution approval,
  legal consent review, and production signing remain Phase 3E evidence.
- Live PostgreSQL restored-clone migration/backfill/rotation/restore drills and
  deployed OIDC/origin verification remain release gates.
- Scheduled summaries, notifications, background large-report jobs, expiring
  download links, and delivery tracking belong to Phase 5.
