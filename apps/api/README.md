# Callora API

Fastify/TypeScript API for the Callora vertical slice. Development and tests use
a deterministic in-memory repository. Production startup automatically wires a
bounded PostgreSQL pool, the durable `PostgresCalloraRepository`, UUID IDs, and
a strict OIDC/JWKS access-token verifier. Missing production trust-boundary
configuration fails startup rather than falling back to development behavior.

## Local development

From the repository root:

```bash
npm run dev --workspace @callora/api
```

The API listens on `http://127.0.0.1:4100`. The dev script explicitly enables
`POST /v1/dev/session`; this route is never registered in production. The local
web origin is restricted to `http://localhost:4173` by default.

Useful environment variables:

- `AUTH_SECRET`: application signing secret, required in production and at least 32 characters.
- `DEV_AUTH_ENABLED=true`: enables seeded session issuance outside production.
- `CORS_ALLOWED_ORIGINS`: comma-separated exact origins. Wildcards are rejected.
- `PORT` / `HOST`: listener configuration.
- `AUTH_TOKEN_TTL_SECONDS`: access-token lifetime.
- `PAIRING_CODE_TTL_SECONDS`: default pairing lifetime.
- `DEVICE_BOOTSTRAP_TTL_SECONDS`: one-time mobile activation credential lifetime; 60–600 seconds, default 600.
- `DEVICE_SESSION_TTL_SECONDS`: opaque mobile session lifetime; 5 minutes–7 days, default 7 days.
- `PAIRING_ATTEMPT_LIMIT` and `PAIRING_ATTEMPT_WINDOW_SECONDS`: redemption throttle.
- `TRUSTED_PROXY_CIDRS`: optional comma-separated proxy CIDRs. Leave empty for a
  directly exposed API; `/0`, hostnames, and untrusted forwarded headers are rejected.
- `DATABASE_URL`, `DATABASE_SSL_MODE`, and `DATABASE_*_TIMEOUT_MS`: durable PostgreSQL connection and bounded-pool controls.
- `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, and `OIDC_ORGANIZATION_CLAIM`: exact production bearer-token trust boundary.
- `OIDC_ALLOWED_ALGORITHMS`: explicit asymmetric signature allowlist; defaults to `RS256`.

## Seeded local actors

Request a signed token with an organization of `org_alpha` or `org_beta` and a
role of `owner`, `admin`, `manager`, `analyst`, or `employee`:

```json
{
  "organizationId": "org_alpha",
  "role": "owner"
}
```

Every protected request uses `Authorization: Bearer <accessToken>`. Organization
context is resolved only from the verified token and active repository
membership; an organization supplied elsewhere by a client is not trusted.

## Production authentication and database

The OIDC verifier checks the exact issuer and API audience, an expiry, subject,
the configured signed organization claim, and an explicit asymmetric algorithm
allowlist using the provider's remote JWKS. The API then resolves the exact
`(organization_id, issuer, subject)` tuple in `callora.user_identities` and
requires both the user and membership to be active. It never treats `sub` as an
internal user ID and never falls back to email matching. Invalid, unmapped,
inactive, and cross-tenant identities receive the same generic `401` response.

Every tenant operation uses one checked-out PostgreSQL client and a short
transaction. It sets `app.current_organization_id` and, when available,
`app.current_user_id` transaction-locally before querying FORCE RLS tables.
Phase 3C mobile credential/consent mutations and their audit/outbox evidence
commit in the same transaction. Audit coupling for remaining ordinary web CRUD
paths still requires staging review.

Build and start the production API with:

```bash
npm run build --workspace @callora/api
NODE_ENV=production npm run start --workspace @callora/api
```

Use the repository-level `docs/PRODUCTION_AUTH_DATABASE_RUNBOOK.md` before any
staging or production rollout. Never use a database owner, superuser, or
`BYPASSRLS` role for application traffic.

## Mobile pairing and synchronization

The Phase 3C mobile trust flow is separate from web OIDC auth:

| Route | Credential | Purpose |
| --- | --- | --- |
| `POST /v1/device-pairings/redeem` | Public one-time pairing code | Bind an installation to an administrator-selected mode and activate its client-proposed bootstrap credential |
| `GET /v1/mobile/collection-policy` | Bootstrap or session | Return the exact current server policy/disclosure and content hash |
| `POST /v1/mobile/activate` | Bootstrap bearer | Accept exact-policy consent, consume bootstrap, and activate the client-proposed session credential |
| `POST /v1/mobile/reconsent` | Device session | Renew consent only for the exact current policy ID/hash |
| `POST /v1/mobile/heartbeat` | Device session | Persist permission, sync, app/OS, battery, network, and pending-work health |
| `POST /v1/mobile/call-batches` | Device session | Atomically ingest at most 100 call-log rows and persist an exact replay response |
| `POST /v1/mobile/session/rotation/prepare` | Device session | Create a client-proposed pending session while the current session remains active |
| `POST /v1/mobile/session/rotation/confirm` | Pending session | Promote the pending session and revoke its predecessor atomically |
| `DELETE /v1/mobile/session` | Device session | Revoke device credentials, withdraw active consent, and mark the device revoked |
| `POST /v1/devices/:deviceId/revoke` | Web bearer with `devices.manage` | Idempotently revoke one tenant-owned stranded device with atomic audit and outbox evidence |

Android generates every random opaque 256-bit mobile bearer and durably encrypts
it before network use. The server persists only a type-separated HMAC-SHA-256
digest and returns credential metadata, never the raw value. Every transition is
bound to a UUID request ID and supports exact non-secret replay. Bootstrap
credentials expire within 10 minutes and are consumed exactly once. Session
credentials expire within 7 days and may be rotated or revoked. Invalid,
expired, revoked, malformed, and wrong-type credentials share the same generic
authentication failure.

Administrator device recovery requires a UUID `requestId` that exactly matches
`Idempotency-Key` and a single-line 8–500 character reason. An exact retry
returns the stored response; reusing the request ID for another target or
payload returns `409`. Device state, active/pending credentials, active consent,
the immutable recovery ledger, audit, and outbox evidence commit together.

Production redemption consumes three shared HMAC-only limiter dimensions: the
trusted client IP, pairing-code digest, and installation identity. Fastify trusts
`X-Forwarded-For` only when the direct peer matches `TRUSTED_PROXY_CIDRS`.

Heartbeat and batch organization, employee, and device IDs are redundant only
for client diagnostics: they must exactly match the identity derived from the
credential. The database adapter revalidates and locks the active credential,
device, employee, organization, and consent in the mutation transaction. A
production call batch requires `collectionMode: "android_call_log"` and active
call-log permission. `synthetic_demo` is available only outside production.
Every batch must send `Idempotency-Key: <batchId>`, is capped at 100 items and by
the API-wide 512 KiB body limit, and returns the originally stored response for
an exact retry.

Crash-recovery invariants and remaining production evidence are tracked in
[`apps/android/PHASE_3C_SECURITY.md`](../android/PHASE_3C_SECURITY.md).
