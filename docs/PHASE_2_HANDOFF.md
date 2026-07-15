# Callora Phase 2 handoff

- Date: 14 July 2026
- Increment: tenant-safe backend foundation and live dashboard vertical slice
- Status: implemented and locally verified

## Outcome

Callora now has a working end-to-end development path from the React dashboard
to a tenant-aware Fastify API. The API supports signed development sessions,
server-side permissions, employee administration, device pairing, idempotent
simulated call ingestion, call/dashboard reads, audit events, and health checks.

The PostgreSQL package defines the durable tenant model with ordered migrations,
composite tenant foreign keys, indexed cursor paths, atomic mobile call upsert,
least-privilege roles, and forced row-level security. The local API repository is
intentionally in memory; production startup fails closed until a PostgreSQL
adapter is injected.

## Implemented packages

| Area | Implementation |
| --- | --- |
| Web | React dashboard with live API loading, honest demo fallback, filters, employee creation, loading/error states, and responsive UI |
| API | Fastify routes, HMAC bearer verification, token-derived tenant context, server-side RBAC, exact-origin CORS, bounded validation, cursor pagination, pairing controls, and request envelopes |
| Database | Six checksum-tracked PostgreSQL migrations, two-tenant seed, 15 forced-RLS tables, FK/keyset/partial indexes, atomic ingest functions, and least-privilege roles |
| Contracts | Shared TypeScript organization, employee, device, call, sync, lead, analytics, and API types |
| Delivery | Root verification command, locked dependencies, and GitHub Actions CI workflow |

## Development API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Process liveness |
| `GET` | `/ready` | Repository readiness |
| `POST` | `/v1/dev/session` | Local/test signed session; absent in production |
| `GET`, `POST` | `/v1/employees` | Cursor list and employee creation |
| `POST` | `/v1/employees/:id/suspend` | Employee suspension |
| `POST` | `/v1/employees/:id/pairing-codes` | Create a short-lived pairing code |
| `DELETE` | `/v1/pairing-codes/:id` | Revoke an unused code |
| `POST` | `/v1/device-pairings/redeem` | Single-use device pairing |
| `POST` | `/v1/calls/ingest/simulated` | Development/test idempotent call ingest |
| `GET` | `/v1/calls` | Tenant-bound cursor call list |
| `GET` | `/v1/dashboard/overview` | Timezone-aware dashboard metrics |
| `GET` | `/v1/audit-events` | Tenant-scoped audit trail |

## Run locally

```bash
npm install
cp .env.example .env
```

Run the services in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

Open `http://localhost:4173`. Run all schema, type, test, and build checks with:

```bash
npm run check
```

## Verification evidence

- PostgreSQL offline contract: six ordered migrations, 15 forced-RLS tenant
  tables, two isolated seed tenants.
- API request suite: 20 tests covering authentication, token tampering/expiry, tenant isolation,
  permissions, exact-origin CORS, pairing lifecycle/rate limit, call
  idempotency, tenant-bound cursors, audit events, readiness, and Asia/Kolkata
  dashboard reconciliation.
- Web suite: 19 tests covering honest live/zero and demo states, API mapping,
  cursor pagination, ID-based filters, employee mutation success/failure,
  zero-safe charts, CSV formula neutralization, and core dashboard interactions.
- Database suite: six offline contract tests covering migration order, forced
  RLS, FK indexes, least-privilege roles, and two-tenant seed structure.
- Production dependency audit: zero known vulnerabilities at handoff time.
- Browser smoke test: an employee was created through the UI, three calls were
  ingested through the development API, and the live dashboard reconciled to
  three total calls, two connected calls, one missed call, three talk minutes,
  three unique clients, and the Amit Patel employee filter. Desktop and 390×844
  mobile layouts were captured from the running API state.

## Production gates still open

This increment is a development vertical slice, not a deployable production
release. The next backend cut must deliver:

1. A PostgreSQL `CalloraRepository` adapter with short transactions, tenant-local
   RLS context, atomic mutation plus audit/outbox writes, and aggregate SQL.
2. Real OIDC/managed authentication, refresh/session rotation, account recovery,
   and production web login; the development session route is not a production
   authentication mechanism.
3. Shared Redis/gateway pairing rate limits for multiple API replicas.
4. Live PostgreSQL migration/RLS/concurrency tests in CI and a staging database.
5. Team/self authorization scope before manager or employee data routes are
   enabled; unresolved scopes remain fail-closed.
6. Deployment, secrets, telemetry, backup/restore, retention jobs, and incident
   runbooks.

PostgreSQL was not available on this workstation, so migrations were structurally
verified but not applied to a live server during this increment.

## Recommended next phase

Complete the PostgreSQL repository and real authentication slice first. Once its
tenant/RLS tests pass against a live database, start the Android pairing and
consent proof of concept, encrypted local queue, and idempotent batch sync.
