# Phase 5A handoff — report automation foundation

## Delivered

- Shared contracts for saved report views, daily/weekly schedules, notification preferences, and automation snapshots.
- Migration `0016_report_automation.sql` with four tenant-owned FORCE RLS tables.
- Tenant-first foreign keys and indexes, bounded export retries, opaque hashed download tokens, expiry fields, and a least-privilege worker claim function using `FOR UPDATE SKIP LOCKED`.
- Reports workspace tabs and a responsive Automation surface with schedule status, saved views, export progress, and accessible email/in-app preference toggles.
- Automated schema/security and component interaction coverage.

## Security and operational invariants

- API and workers do not receive broad table ownership or PUBLIC grants.
- A report download cannot be represented as ready without object key, token hash, and expiry.
- Queue workers atomically claim different eligible jobs and stop after five attempts.
- Organization-local schedule periods retain a de-duplication key.
- Every tenant foreign key begins with `organization_id` and has a left-prefix index.

## Validation

- `npm run check`
- In-app Browser: `Reports → Automation → device_offline in-app toggle` changed `aria-pressed=false` to `true` and emitted the saved toast.
- Desktop default viewport and mobile `390 × 844`; no application console warnings/errors.

## Phase 5B continuation

- Add authenticated CRUD API/repository methods for views, schedules, preferences, and jobs.
- Replace web demo fixtures with live API state and schedule/editor dialogs.
- Add the report renderer, object storage adapter, token redemption endpoint, scheduler, email provider, in-app inbox, retry/suppression ledger, and delivery observability.
- Add live Postgres concurrency tests and organization-local DST/period boundary tests.
