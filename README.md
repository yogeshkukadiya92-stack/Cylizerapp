# Callora

Callora is an original, Android-first call analytics and lead-operations product for sales and support teams. It provides a shared web dashboard for call activity, employee performance, missed-opportunity recovery, lead follow-ups, recordings, and reports.

This repository is a clean-room functional implementation. It does not contain Callyzer source code, assets, branding, or proprietary data.

## Repository layout

- `apps/web` — React + Vite manager dashboard
- `apps/api` — Fastify tenant-aware API, production OIDC bearer verification, PostgreSQL runtime adapter, RBAC, ingest, pairing, and dashboard analytics
- `apps/android` — native Kotlin/Compose employee companion with consented pairing, encrypted offline queueing, and bounded background sync
- `packages/contracts` — shared TypeScript domain and API contracts
- `packages/database` — ordered PostgreSQL migrations, RLS policies, seed data, and schema checks
- `docs` — phase plan, architecture, security, and delivery notes

## Start the current vertical slice

```bash
npm install
cp .env.example .env
```

Run the API and web dashboard in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

The web app opens at `http://localhost:4173` by default and uses the API at
`http://localhost:4100`. The API's development session route is enabled only
outside production. The dashboard can use deterministic demo data only while
running in development authentication mode; OIDC/production mode never falls
back to demo or locally stored customer data.

Run the complete local verification:

```bash
npm run check
```

With Android Studio's JDK and Android SDK configured, verify both Android
flavors separately:

```bash
npm run android:check
```

The `demo` flavor uses generated sample call metadata and never requests call-log
access. The `enterprise` flavor is the separately governed build that can request
`READ_CALL_LOG` only after the in-app disclosure and runtime consent flow.

The database package can be verified without PostgreSQL. Applying the migrations
requires PostgreSQL 15+ and the `psql` client:

```bash
export DATABASE_SSL_MODE=disable # isolated local PostgreSQL only
npm run db:migrate
npm run db:seed
```

All database CLI commands require this explicit policy. Use `verify-full` for
every remote, staging, or production connection (plus `PGSSLROOTCERT` when
needed); SSL URL parameters and silent libpq `prefer` are rejected.

## Production bridge

Local development and tests intentionally use the deterministic in-memory
repository. With `NODE_ENV=production`, the server instead constructs a bounded
`pg.Pool`, the PostgreSQL `CalloraRepository`, UUID identifiers, and a strict
OIDC/JWKS verifier. Startup fails closed if any required database, OIDC, secret,
or exact-origin setting is missing or invalid. The production web build likewise
requires Authorization Code + PKCE OIDC and keeps tokens in memory only.

Apply all fourteen migrations and least-privilege role grants before starting the
production API. Do not apply the development seed to staging or production. See
`docs/PRODUCTION_AUTH_DATABASE_RUNBOOK.md` for the complete configuration,
identity-linking, rollout, and verification procedure.

Phase 4A adds the first complete lead-CRM slice: tenant/team/assigned scopes,
encrypted lead phone fields with blind-index search, optimistic versions,
append-only activity history, automatic same-team call matching, a responsive
web pipeline, and an employee-scoped Android lead workspace with system-dialer
handoff. CSV import, assignment rules, manual call-link correction UI/API,
Android post-call mutations, and lead reports remain Phase 4B work. See
`docs/PHASE_4A_HANDOFF.md` for the exact delivered boundary.

This is still not a production launch sign-off. Live PostgreSQL and
identity-provider evidence, tenant-by-tenant PII backfill, observability,
managed backup/restore drills, release signing, physical-device coverage, and
distribution approval remain explicit gates. See
`docs/PHASE_3D_PRODUCTION_VERIFICATION.md`.
