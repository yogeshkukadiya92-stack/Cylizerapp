# Callora Phase 4A handoff

- Status: implemented and locally verified
- Completed: 15 July 2026
- Scope: lead CRM foundation, web lead operations, automatic call linking, and Android assigned-lead access

## Delivered

### Database and security

- Migration `0014_lead_crm_foundation.sql` adds membership team scopes, lead statuses, leads, notes, follow-ups, append-only activities, and call-to-lead link history.
- All seven new tenant tables use organization-first keys, composite same-tenant foreign keys, enabled and forced RLS, deny-by-default PUBLIC access, and explicit least-privilege role grants.
- Primary and alternate phone numbers use authenticated encryption envelopes, versioned blind indexes, unique nonces, and last-four display fields. Names, company, email, source, tags, and custom fields remain ordinary tenant-scoped relational attributes.
- Lead and follow-up mutations enforce positive optimistic versions. Activity rows are immutable; a call-link record can only make its one-way audited unlink transition.
- Development fixtures cover two isolated organizations so tenant-boundary tests exercise real cross-tenant identifiers.

### Contracts and API

- Canonical contracts cover statuses, queues, cursor pages, lead detail, notes, follow-ups, activities, validation, and compare-and-swap updates.
- Web routes provide scoped status/owner metadata, lead list/detail, create/update, note creation, follow-up scheduling, and follow-up completion.
- Owner/admin scope is organization-wide, manager scope is limited to configured teams, and employee scope is assigned-lead only. Repository checks repeat the scope enforcement; it is not delegated to UI hiding.
- Mobile lead list/detail require an active session and current policy consent. The server derives the employee from the credential and never accepts a client-supplied employee scope.
- Exact same-team encrypted-phone matching links a non-internal call only when one active lead is unambiguous. Answered matches update last contact; ambiguous matches stay unlinked.

### Web application

- The Leads module has search, owner/status filters, all/not-contacted/overdue/unreturned queues, stable list pagination, responsive rows, and a desktop split detail panel.
- Lead detail supports owner/status changes, notes, follow-up scheduling/completion, and a chronological call/note/status/follow-up timeline against the canonical API.
- Development authentication may show deterministic demo data and memory-only local drafts when the API is unavailable. OIDC/production mode continues to fail closed and does not persist customer drafts locally.
- CSV import is intentionally disabled and labeled for Phase 4B so the UI does not imply a partial importer is safe to use.

### Android application

- Demo and enterprise flavors expose an employee-scoped Leads tab with assigned-lead search, all/not-contacted/overdue/unreturned queues, refresh, cards, and detail bottom sheet.
- Lead data is memory-only and is cleared whenever onboarding leaves `READY`, authentication fails, or consent becomes stale, preventing data from crossing re-enrollment boundaries.
- Calling uses `ACTION_DIAL`; Callora does not request `CALL_PHONE` and does not place a call without user confirmation in the system dialer.
- Phase 4A Android is intentionally read-only for CRM data. Post-call notes, status changes, and follow-up writes belong to Phase 4B.

## Verification evidence

- `npm run check`: passed.
  - API: 116 tests passed.
  - Web: 46 tests passed.
  - Database: 49 tests passed.
  - Release preflight: 8 tests passed.
  - Contracts/API/web type checks and production builds passed.
  - Schema gate: 14 ordered migrations, 29 FORCE-RLS tenant tables, and two seeded tenants.
- Android demo and enterprise: 46 JVM tests passed across both flavors; both debug APKs assembled; both lint variants passed with zero errors.
- Browser QA: desktop 1556×1011 and mobile 427×922; no document-level horizontal overflow and no console warning/error; lead navigation, detail, and add-lead dialog were exercised.
- `git diff --check`: passed.
- Focused local review covered RLS, composite tenant keys, role grants, phone encryption/blind indexes, RBAC/IDOR, mobile consent, compare-and-swap versions, and immutable history; no blocking finding remains.

## Local run

```bash
npm install
cp .env.example .env
npm run dev:api
npm run dev:web
```

In another terminal, verify the complete JavaScript/database slice:

```bash
npm run check
```

With the Android toolchain configured:

```bash
npm run android:check
```

## Environment boundary

The migration and PostgreSQL repository passed offline schema/contract tests, but this workspace had neither `psql` nor a configured `DATABASE_URL`. Migration 0014 was therefore not applied to a live PostgreSQL instance in this phase. A disposable PostgreSQL 15 restored-clone run remains required before deployment.

## Phase 4B backlog

1. CSV import jobs with preview, validation, idempotency, deduplication, resumability, visible results, and an error file.
2. Manual and rule-based assignment with dry-run visibility and audited reassignment.
3. Manual call-to-lead correction API and UI using the correction-history schema delivered in Phase 4A.
4. Android post-call note/status/follow-up mutations with offline/replay-safe behavior.
5. Lead conversion, activity, status, and employee reports.
6. Live PostgreSQL migration/query-plan evidence plus deployed web/API and physical Android end-to-end coverage.
