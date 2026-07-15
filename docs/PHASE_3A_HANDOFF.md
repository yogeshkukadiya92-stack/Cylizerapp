# Callora Phase 3A handoff

- Date: 15 July 2026
- Increment: production PostgreSQL and OIDC bridge
- Status: implemented and locally verified; live infrastructure validation pending

## Outcome

The Phase 2 in-memory development slice now has a production runtime path. In
production the API creates a bounded PostgreSQL pool, applies tenant/user context
inside short same-client transactions, uses UUID identifiers, and verifies OIDC
access tokens against an exact issuer, audience, organization claim, asymmetric
algorithm allowlist, and remote JWKS. The web app uses Authorization Code + PKCE,
memory-only tokens, exact callback handling, and fail-closed live-service gates.

## Delivered

| Area | Delivered capability |
| --- | --- |
| Database | Migration `0007`, OIDC identity links, durable API idempotency, pairing resolution, ingest fingerprints, transactional outbox, indexes, grants, and 18 FORCE RLS tenant tables |
| API runtime | `pg.Pool`, `PostgresCalloraRepository`, transaction-local RLS context, cursor queries, employee/device/pairing/ingest/audit operations, and outbox worker claims |
| API authentication | Strict `jose` JWT/JWKS verification, exact external identity mapping, active membership enforcement, generic unauthorized responses, and `/v1/session` |
| Web authentication | `oidc-client-ts` PKCE flow, memory-only token store, ten-minute versioned callback state, expiry handling, dedicated logout callback, and no production demo fallback |
| Hardening | Exact-origin CORS, bearer requests without ambient cookies, production config validation, production-only durable wiring, and local development isolation |
| Documentation | Updated run instructions, authentication policy, database guidance, production runbook, and phase plan status |

## Verification evidence

- Clean `npm ci`: 220 packages installed, 225 audited, zero known vulnerabilities.
- `npm run check`: schema verification, all type checks, all tests, and all builds passed.
- 91 tests passed: 49 API, 35 web, and 7 database tests.
- Database verifier found seven ordered migrations, 18 FORCE RLS tables, and two
  deterministic isolation tenants.
- Full and production dependency audits reported zero vulnerabilities.
- Browser smoke test passed against the running API: live data loaded, the
  seven-day filter changed state, a synthetic employee was created, desktop and
  390px mobile layouts rendered, and console error/warning logs were empty.

## Architecture decisions

- One checked-out PostgreSQL client owns each `BEGIN`/`COMMIT` transaction.
- Tenant and user settings are transaction-local to prevent pooled-connection
  context leakage.
- External identity is the exact organization + issuer + subject tuple; email is
  never an authentication key.
- Domain mutation and outbox write are atomic. HTTP audit append remains separate
  and is explicitly not described as production-complete.
- Production web access tokens are memory-only. PKCE/state data is versioned,
  session-scoped, and rejected after ten minutes.
- Production configuration fails closed; development auth, demo data, and local
  PII drafts cannot activate in a production build.

## Remaining gates

No PostgreSQL server, Docker daemon, or real OIDC tenant was available locally,
so migration/RLS and provider flows still need a staging integration pass. Also
open are atomic audit units of work, shared rate limiting, manager/employee data
scopes, onboarding UI, production-volume aggregate queries, PII encryption,
telemetry, backups/restores, retention jobs, and deployment infrastructure.

## Recommended next increment: Phase 3B

Start the native Android technical alpha with Kotlin + Compose, secure device
pairing, prominent consent, encrypted Room queue, WorkManager retries, token
rotation, bounded sync batches, and device-health reporting. In parallel, apply
the Phase 3A stack to a staging PostgreSQL database and real OIDC provider using
`docs/PRODUCTION_AUTH_DATABASE_RUNBOOK.md`. Real call-log access remains behind
the selected distribution route and Play/enterprise policy approval.
