# Callora delivery plan

- Status: working plan for implementation
- Product: Callora team call analytics and lead CRM
- Planning horizon: MVP in 12–16 weeks; production V1 in 24–32 weeks; broader parity in 32–44 weeks
- Last updated: 15 July 2026

## Current execution status

- Phase 1 and Phase 2 vertical slices are implemented and locally verified.
- Phase 3A–3D are implemented locally: 13 migrations, 22 FORCE-RLS tenant tables, production OIDC/PostgreSQL adapters, authoritative mobile policy/consent, client-generated hash-only credentials, exact replay, audited administrator per-device recovery, encrypted phone/contact envelopes, versioned blind-index rotation, encrypted-only database finalization, and native Android demo/enterprise flavors.
- The automated baseline is 177 passing API/web/database tests plus 8 release-preflight tests, 46 passing Android JVM tests, zero Android lint errors, schema verification, type checking, successful production/debug builds, and a clean scoped adversarial security review.
- The Phase 3E launch-evidence track remains external: real PostgreSQL 15 restored-clone migration/backfill/rotation/finalization/backup evidence, real OIDC/deployed-origin validation, production Android signing, legal/distribution approval, and the physical API/OEM/power matrix.
- The next feature-development slice is Phase 4: lead CRM, import/assignment, call-to-lead timeline, and employee follow-up workflow. Phase 3E evidence should continue in parallel and remains a launch gate.

## 1. Product intent

Callora helps a business connect employee work phones, understand team calling activity, follow up missed opportunities, and move leads through a lightweight CRM. It is an original product with its own brand, interface, implementation, and product language. The goal is functional equivalence with the useful workflows in the reference category, not a copy of another product's source code, protected assets, text, or visual identity.

The first shippable outcome is an Android-first, multi-tenant SaaS with:

- an admin web dashboard;
- company, user, role, employee, and device management;
- consent-based Android call-log synchronization;
- searchable call history and reliable team metrics;
- lead import, assignment, status, notes, and follow-ups;
- exports, scheduled summaries, auditability, and retention controls.

Call recording, transcription, paid connectors, billing, and the iOS companion follow only after the core data path is stable. Native cellular recording is not a baseline promise.

## 2. Outcome and success measures

### Product outcomes

- Managers can understand calling activity without collecting reports manually.
- Employees can see assigned work, call a lead, and record the next action quickly.
- A missed or unanswered call can become an owned, trackable follow-up.
- Customers can prove who accessed or changed sensitive data.
- A customer can export or delete its data without engineering intervention.

### V1 service indicators

| Indicator | Initial target |
| --- | --- |
| Web/API availability | 99.9% monthly, excluding announced maintenance |
| Read API latency | p95 below 400 ms at agreed launch load |
| Write API latency | p95 below 700 ms, excluding file uploads and exports |
| Call ingestion | p95 visible within 5 minutes on a connected, unrestricted Android device; within 30 minutes under supported power restrictions |
| Duplicate call events | fewer than 1 in 10,000 accepted events; duplicates never double-count metrics |
| Dashboard correctness | aggregate totals exactly reconcile with canonical call-log queries for the same tenant, filters, and timezone |
| Restore readiness | recovery point objective 15 minutes; recovery time objective 4 hours |
| Critical security findings | zero open at production launch |

These targets become enforceable SLOs after launch traffic and supported-device behavior have been measured.

## 3. Users and permissions

| Role | Primary capabilities |
| --- | --- |
| Organization owner | company, plan, billing, retention, integrations, all users, all data |
| Administrator | employees, devices, roles, settings, reports, imports, exports |
| Manager | allowed teams, calls, leads, recordings, reports, assignments |
| Employee | own device status, own calls, assigned leads, notes, follow-ups |
| Analyst/read-only | permitted dashboards, reports, and exports without mutation rights |

Authorization is organization- and team-scoped. Permission checks must run on the server; hiding a control in the UI is not authorization.

## 4. Scope boundaries

### Included in production V1

- Organization onboarding and secure sign-in
- Role-based access and team scoping
- Employee invitation and device pairing
- Android call-log synchronization, retry, deduplication, and device health
- Dashboard metrics, trends, attention queues, and employee comparison
- Call-log search, filters, notes, pinning, and exports
- Lead import, assignment, statuses, tags, custom fields, notes, and follow-ups
- Daily/weekly summaries and operational notifications
- API keys, signed webhooks, and at least one useful connector
- Audit log, data export, retention, deletion, backup, and restore procedure

### Conditional or later scope

- Recording-file discovery/upload, playback, and transcription
- Advanced billing and add-on marketplace
- Many third-party CRM/lead-source connectors
- iOS companion and region-limited default-dialer research
- Customer-managed encryption keys, SSO/SAML, SCIM, and advanced enterprise policies
- VoIP, predictive dialer, auto-dial campaigns, or contact-center routing

### Explicit non-goals for the first release

- Hidden employee monitoring or collection without informed consent
- A universal native cellular-call recorder
- Guaranteed real-time sync on every Android OEM and battery configuration
- Reading the general cellular call history on a normal iOS companion app
- Advertising use, resale, or unrelated profiling from call, contact, or lead data
- Pixel-identical reproduction of any third-party application

## 5. Mobile feasibility gates

### Android

`READ_CALL_LOG` and related permissions are restricted by Google Play. Business CRM/enterprise use can be an eligible exception, but it is subject to declaration, review, prominent disclosure, corporate login, limited use, and continuing policy compliance. Callora must validate the distribution route before making call sync a commercial commitment. See [Google Play's Call Log permission guidance](https://support.google.com/googleplay/android-developer/answer/10208820?hl=en) and [user-data requirements](https://support.google.com/googleplay/android-developer/answer/10144311).

Full uplink/downlink cellular audio capture is not a general third-party Android capability: Android's `VOICE_CALL` audio source requires a system-only permission. Recording work therefore starts as discovery/upload of a recording file created by an OEM dialer or other lawful source, not as an in-app universal recorder. See the [Android audio-source reference](https://developer.android.com/reference/android/media/MediaRecorder.AudioSource).

Required pre-build gate:

1. Confirm public Play Store, managed Play, private enterprise distribution, and any MDM route with product/legal owners.
2. Build a policy-minimal proof of concept using a corporate account and prominent disclosure.
3. Test supported Android/API/OEM combinations and power-management states.
4. Prepare the Play Console permission declaration and privacy/data-safety evidence.
5. Decide whether unsupported devices degrade to CRM plus user-initiated dial actions.

### iOS

The global baseline is a companion CRM: assigned leads, `tel:`-initiated calling, notes, tasks, reports, alerts, and device/session management. CallKit primarily supports app/VoIP calling and active-call observation; it is not a general historical cellular call-log API.

Newer Apple APIs provide default-calling capabilities, while default cellular dialer/history support has additional entitlement and regional constraints. Apple currently documents the default-dialer path as EU-limited. Treat this as a separate research track, not V1 parity. See [CallKit](https://developer.apple.com/documentation/callkit), [default calling apps](https://developer.apple.com/documentation/callkit/preparing-your-app-to-be-the-default-calling-app), and [default dialer preparation](https://developer.apple.com/documentation/livecommunicationkit/preparing-your-app-to-be-the-default-dialer-app).

## 6. Delivery sequence

Durations assume a stable team of one product/design lead, two web/backend engineers, two mobile engineers, and one QA/platform engineer. A smaller team should expect a longer schedule. Privacy/legal review and Play policy work run in parallel but remain launch gates.

### Phase 0 — Definition and mobile proof, 1–2 weeks

Goal: remove the largest product, policy, and data-definition uncertainties before broad implementation.

Deliverables:

- Product requirements, role matrix, page/flow inventory, and glossary
- Canonical call direction/outcome definitions and metric formulas
- Android permission/distribution decision record and proof-of-concept plan
- Consent, retention, export, deletion, and recording policy requirements
- Supported device/API test matrix
- Low-fidelity web and Android flows
- Architecture, data model, threat outline, and delivery backlog

Acceptance criteria:

- Every dashboard metric maps to source events and a deterministic formula.
- Product/legal owners sign off on what Callora may collect and why.
- Android distribution has one viable primary route and one documented fallback.
- Native cellular recording is either removed from commitments or backed by a proven, lawful device-specific route.
- MVP scope, success measures, owners, and launch market are approved.

Exit risk: no-go or scope change if call-log access cannot be distributed compliantly.

### Phase 1 — Foundation and first vertical slice, 2–3 weeks

Goal: establish the production skeleton and demonstrate one complete tenant-safe path using simulated call events.

Deliverables:

- Monorepo/workspace, environments, CI, code quality, and release conventions
- Original Callora design tokens and responsive application shell
- Organization, membership, user, role, employee, and team domain model
- Authentication, session management, tenant middleware, and server-side RBAC
- Simulated call-event ingest, canonical call list, and overview dashboard
- Initial audit events, structured logs, traces, and health endpoints
- Seeded demo tenant for safe UI development

Acceptance criteria:

- A user cannot access another organization by URL, identifier substitution, API call, or export.
- An administrator can create employees and teams; an employee can see only allowed data.
- A simulated event is accepted idempotently and appears in call history and metrics.
- Dashboard totals reconcile exactly with the seeded call list.
- CI runs type checking, linting, unit tests, build, dependency scan, and migration checks.
- A staging deployment is reproducible from the main branch.

### Phase 2 — Core web administration and call intelligence, 3–4 weeks

Goal: make the web product usable before connecting real devices.

Deliverables:

- Employee invite/activation/suspension and team assignment
- Device pairing code lifecycle and device-status views
- Call history with date, employee, team, number/contact, direction, and outcome filters
- Call detail, notes, pinning, and activity history
- Dashboard KPIs, hourly trends, outcome distribution, attention queues, and team table
- Employee/client/never-attended/client-not-pickup report definitions
- CSV export with tenant/timezone-safe formatting

Acceptance criteria:

- Pairing codes are single-use, short-lived, rate-limited, and revocable.
- All list endpoints have stable cursor pagination and bounded filters.
- Exports use the same authorization and filters as on-screen data.
- Metrics remain correct across midnight, daylight-saving changes, and organization timezones.
- Dashboard and call-log views pass responsive, keyboard, and WCAG 2.1 AA smoke checks.
- Query plans meet latency targets at the agreed synthetic launch volume.

### Phase 3 — Android call synchronization, 4–6 weeks

Goal: safely collect permitted work-call events from supported Android devices.

Deliverables:

- Native Android application, secure pairing, and token rotation
- Prominent disclosure, granular permission onboarding, and persistent sync status
- Local encrypted queue, checkpointed call-log reader, WorkManager retry, and offline recovery
- Batched/idempotent event ingestion and conflict handling
- Device health, last sync, permission loss, clock skew, app version, and diagnostics
- OEM/API compatibility suite and support runbook
- Play/internal distribution artifacts and policy declarations

Acceptance criteria:

- Removing consent, corporate access, or required permission stops collection and invalidates relevant credentials.
- Re-reading a device history or retrying a batch does not duplicate calls or metrics.
- A device offline for seven days can catch up without data loss within configured retention limits.
- Tokens are stored using platform secure storage; sensitive payloads do not appear in logs.
- Tested behavior is documented for the supported API/OEM matrix, including power-restricted modes.
- The selected distribution channel accepts the permission approach before public launch.

### Phase 4 — Lead CRM and employee workflow, 4–5 weeks

Goal: convert call information into owned sales/service follow-up work.

Deliverables:

- Lead lifecycle, status pipeline, tags, source, custom fields, and ownership
- CSV import with preview, validation, deduplication, error file, and resumability
- Manual and rule-based employee assignment
- Lead detail timeline combining calls, notes, status changes, and follow-ups
- Android assigned-lead list, search, `tel:` dial action, post-call note/status, and due work
- Not-contacted, overdue, and unreturned-missed-call queues
- Lead conversion, status, activity, and employee reports

Acceptance criteria:

- Imports are idempotent, auditable, and never partially appear without a visible job result.
- Two concurrent updates produce a controlled conflict or a deterministic outcome; neither silently loses data.
- Every ownership/status/custom-field change records actor, time, old value, and new value.
- An employee cannot inspect or assign a lead outside the teams granted to them.
- Call-to-lead matching has documented rules and a manual correction path.
- Core web and Android lead journeys pass end-to-end tests.

### Phase 5 — Reports, notifications, and operational workflows, 3–4 weeks

Goal: make Callora useful without a manager continuously watching the dashboard.

Deliverables:

- Saved report filters and scheduled daily/weekly summaries
- Email and in-app notification preferences
- Missed-call, overdue follow-up, device-offline, import, and export notifications
- Background report jobs with secure, expiring download links
- Manager comparison and lead/call performance reports
- Delivery tracking, retries, suppression, and unsubscribe/preferences behavior

Acceptance criteria:

- Scheduled reports are generated once per intended organization-local period.
- Retries cannot send the same alert repeatedly beyond the defined policy.
- Report links expire, are access-controlled, and are not guessable.
- Notification preference changes take effect before the next queued delivery where technically feasible.
- Large reports execute outside request threads and cannot exhaust the transactional database.

### Phase 6 — Recording-file and transcript option, 4–6 weeks

Goal: support lawfully available recordings without promising unsupported call capture.

Entry condition: approved legal/consent design plus a proven source of recording files for named devices or a supported VoIP provider.

Deliverables:

- Recording source/folder onboarding and explicit per-organization enablement
- Resumable upload, checksum/deduplication, malware/content validation, and storage quotas
- Short-lived playback authorization and range requests
- Configurable retention/legal hold, deletion jobs, and recording access audit
- Optional asynchronous transcription with redaction and provider data-processing terms
- Cost/usage metering and tenant-level kill switch

Acceptance criteria:

- Callora does not imply it records native cellular audio when it only discovers/uploads an external file.
- No audio is uploaded until the employee and organization disclosures are satisfied.
- Playback never exposes a permanent public object URL.
- Deletes remove the database reference, object, derivatives, and transcript according to documented timelines.
- Transcription failures do not block call-log or lead workflows.
- Storage/transcription quotas prevent unbounded cost.

### Phase 7 — API, integrations, and billing, 4–6 weeks

Goal: connect Callora to customer systems and support commercial plans.

Deliverables:

- Versioned REST API, scoped API keys, quotas, and auditability
- Signed, retried, replay-safe webhooks with a customer delivery log
- One lead-source connector and one CRM/sheet destination selected from customer demand
- Connector credential vaulting, reconnect, replay, and failure handling
- Plan/seat/storage limits, trial state, invoices, and payment-provider integration
- Subscription enforcement with grace periods and safe read-only modes

Acceptance criteria:

- Webhook signatures, timestamp tolerance, retry schedule, and idempotency examples are documented.
- Connector failures are isolated per organization and never stall ingestion.
- API keys are shown once, stored hashed, scoped, rotatable, and revocable.
- Billing webhooks are signature-verified and replay-safe.
- A payment outage cannot delete data or unexpectedly lock out export access.
- Sandbox and production connector credentials are separated.

### Phase 8 — iOS companion, 3–4 weeks

Goal: give iPhone users the CRM and management experience that iOS can support consistently.

Deliverables:

- Secure sign-in, organization selection, assigned leads, search, and follow-ups
- User-initiated `tel:` calls, post-call workflow, notes, and status updates
- Push notifications, manager metrics, and device/session management
- App Store privacy declarations and review materials
- Separate spike for entitlement/region-specific default dialer capabilities

Acceptance criteria:

- Product copy does not claim general iOS cellular history synchronization.
- Employee and manager access matches the same server-side permissions as web/Android.
- Push notifications reveal no sensitive lead/call content on a locked screen by default.
- Offline edits retry idempotently and surface unresolved conflicts.
- Any regional default-dialer feature is feature-flagged and does not change the global baseline.

### Phase 9 — Hardening, beta, and launch, 3–4 weeks

Goal: prove operability, security, policy compliance, and customer readiness.

Deliverables:

- Threat-model refresh and independent security review
- Load, soak, failure, backup-restore, and tenant-isolation tests
- Accessibility, browser, mobile OEM/API, and upgrade regression passes
- Incident response, on-call alerts, support diagnostics, and status communication
- Privacy policy, data-processing terms, subprocessor list, consent evidence, and store declarations
- Pilot migration/onboarding, release checklist, rollback, and customer support runbooks

Acceptance criteria:

- Zero open critical/high launch-blocking defects; medium risks have owners and dates.
- Restore drill meets RPO/RTO and is documented with evidence.
- Load test meets launch targets with at least 2× expected peak headroom.
- Two pilot organizations complete onboarding and at least two weeks of normal use.
- Data export and deletion are exercised end-to-end in staging and production-like infrastructure.
- Play/App Store and legal launch gates are satisfied for the enabled feature set.

## 7. Recommended release cuts

| Release | Included phases | Customer value | Expected timing |
| --- | --- | --- | --- |
| Internal alpha | 0–2 | responsive web experience using simulated data | week 5–7 |
| Technical Android alpha | 0–3 | real supported-device sync and device health | week 9–13 |
| Pilot MVP | 0–5, recording excluded | call analytics plus lead follow-up and reports | week 12–16 with parallel work |
| Production V1 | 0–5 plus 7 essentials and phase 9 | supported commercial SaaS | week 24–32 |
| Expanded product | conditional 6, broader 7, and 8 | recordings/transcripts, integrations, iOS companion | week 32–44 |

The Android proof may change the order. If public call-log permission is delayed, ship the web/CRM product with imports, API/telephony-provider events, and user-initiated calling while the permitted Android route continues separately.

## 8. Quality strategy

### Automated test layers

- Unit tests for metric formulas, permissions, state machines, normalization, and retention rules
- Property tests for call deduplication, timezone boundaries, and import parsing
- Database integration tests with migrations and real PostgreSQL behavior
- Contract tests for Android sync, public API, webhooks, connectors, and payment events
- Web end-to-end tests for onboarding, RBAC, call logs, leads, exports, and deletion
- Android instrumented tests for permission transitions, offline queues, process death, and upgrades
- iOS UI/integration tests for the companion workflows
- Load tests for ingestion bursts, dashboards, exports, and report generation
- Security tests for IDOR/tenant escape, injection, file access, signed URLs, and secret leakage

### Required release evidence

- Test summary linked to a release artifact
- Migration forward and rollback/roll-forward assessment
- Dependency and container scan results
- Supported-device regression result
- Observability dashboard and alert smoke test
- Privacy/store declaration diff when collection changes
- Product owner and engineering owner sign-off

## 9. Privacy, security, and compliance workstream

This is product design, not legal advice. Counsel must determine obligations for launch markets, including India's Digital Personal Data Protection Act, GDPR/UK GDPR where applicable, employment monitoring rules, telecom rules, and one-party/all-party call-recording consent.

Mandatory controls:

- Prominent, plain-language disclosure before permission or collection
- Organization authorization plus individual employee acknowledgement where required
- Purpose limitation: no ads, sale, unrelated scoring, or covert monitoring
- Configurable collection, recording, transcript, and audit retention
- Data-subject/customer export, correction, revocation, and deletion workflows
- Encryption in transit and at rest; separate secret management; least privilege
- Field-level protection or equivalent controls for phone numbers and especially sensitive content
- Server-enforced RBAC and team scoping; privileged-action reauthentication where appropriate
- Immutable or tamper-evident audit events for access, export, playback, assignment, and administration
- Subprocessor inventory, data-processing terms, region and transfer review
- Privacy review for every new SDK and connector; SDKs may not receive call data by default
- Breach/incident response and notification playbook
- Clear BYOD offboarding that removes work access without pretending to control personal data outside Callora

## 10. Delivery risks and mitigations

| Risk | Impact | Mitigation and decision point |
| --- | --- | --- |
| Google Play rejects call-log permission | Core Android proposition blocked | Phase 0 policy proof; enterprise/private route; provider/API/import fallback; never hide collection |
| OEM background restrictions delay sync | Metrics appear stale | WorkManager plus explicit health; tested OEM matrix; diagnostic guidance; truthful freshness labels |
| Native recording is unavailable/inconsistent | Recording promise fails | Treat recording as conditional file/provider ingest; publish supported sources; never rely on hidden APIs |
| Call-to-lead matching is ambiguous | Incorrect ownership/CRM history | Normalize numbers carefully; expose confidence/source; allow manual link/unlink; audit corrections |
| Multi-tenant data leak | Severe legal and trust damage | Tenant context at repository boundary, database constraints/RLS where feasible, adversarial isolation tests |
| Dashboard definitions drift | Users distrust reports | Versioned metric glossary, canonical query layer, reconciliation tests, timezone rules |
| Large exports/reports overload DB | Availability incident | queued jobs, read replicas/warehouse later, row/period limits, cancellation, rate limits |
| Recordings/transcripts create high cost | Margin or abuse problem | quotas, lifecycle policies, asynchronous processing, provider budgets, kill switches |
| Connector APIs change or throttle | Sync failures/data gaps | adapter boundary, cursor/checkpoint state, retries with DLQ, customer-visible health and replay |
| Consent differs by market/customer | Launch/legal risk | launch-market matrix, configurable enablement, counsel sign-off, feature flags and regional policy |
| Feature breadth delays reliable core | Long time to value | pilot release cuts, strict entry gates, one connector first, recording after core stability |

## 11. Decision log required before MVP commitment

1. Launch country/countries and data-residency promise
2. Android distribution path and Play permission declaration owner
3. Supported Android API levels and named OEM/device matrix
4. Whether Phase 6 is OEM-file upload, VoIP/provider recording, both, or deferred
5. Auth provider and enterprise identity roadmap
6. Initial billing provider/currency/tax scope
7. First connector based on signed customer demand
8. Default retention periods for calls, leads, recordings, transcripts, and audit events
9. SLO/support tier and initial capacity assumptions
10. Whether database row-level security is mandatory in addition to application enforcement

## 12. Definition of done

A feature is done only when:

- acceptance criteria and error/empty/loading/permission states are implemented;
- server-side authorization and tenant-isolation tests exist;
- audit, metric, and privacy implications have been reviewed;
- telemetry contains no sensitive payload and includes useful correlation identifiers;
- unit/integration/end-to-end coverage is appropriate to the risk;
- accessibility and responsive behavior are checked;
- migrations are safe and deployment/rollback behavior is understood;
- customer-facing help and support diagnostics are updated;
- the feature is deployed to staging and accepted by product/QA.

Production enablement additionally requires monitoring, alerting, release notes, and a feature flag or rollback path for high-risk behavior.
