# Callora production authentication and database runbook

- Date: 15 July 2026
- Scope: Phase 3D production bridge
- Audience: backend, platform, and identity administrators

Phase 3D adds a fail-closed live database, deployed OIDC/origin, PII-key/backfill,
and Android signing procedure. Complete
[`PHASE_3D_PRODUCTION_VERIFICATION.md`](./PHASE_3D_PRODUCTION_VERIFICATION.md)
alongside this configuration runbook; neither document is production approval by
itself.

## 1. Preconditions

Use Node.js 20+, PostgreSQL 15+, HTTPS web/API origins, and a standards-compliant
OIDC provider. Provision separate migration and application database LOGIN roles.
The migration LOGIN must be the database owner and use `INHERIT NOSUPERUSER
NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS`; `access/roles.sql` temporarily enables its isolated
writer capability for ACL/owner repair. PostgreSQL 15 revokes that membership
in the same transaction. PostgreSQL 16+ retains only an `ADMIN TRUE, INHERIT
FALSE, SET FALSE` control edge so a non-super role administrator can replay the
bootstrap without inheriting writer data privileges.
The application LOGIN role must inherit `callora_api`, must not own the schema,
and must be `NOSUPERUSER NOBYPASSRLS`.

Run from a clean checkout:

```bash
npm ci
npm run check
npm audit
```

## 2. Apply the database foundation

Point `DATABASE_URL` at the privileged migration connection, not the runtime
application connection:

```bash
export DATABASE_URL='postgresql://migration_user:secret@db.example.com:5432/callora'
export DATABASE_SSL_MODE=verify-full
# Optional when the provider CA is not in the system trust store:
# export PGSSLROOTCERT='/absolute/path/to/provider-ca.pem'
npm run db:migrate
npm run access:apply --workspace @callora/database
```

The migration runner checksum-locks and applies thirteen ordered migrations. The
access script creates the `NOLOGIN`, `NOBYPASSRLS` group roles. Grant
`callora_api` to the separately managed application LOGIN role. Never apply
`packages/database/seed/dev.sql` outside a disposable development/integration
database.

Reapply the access script immediately after every schema migration and before
enabling API traffic. Migration `0011` revokes runtime `call_logs` DML and moves
mobile/manual writes behind encrypted-only functions owned by the isolated
`callora_call_writer` role. A catalog gate must confirm the effective API and
ingest LOGIN roles have no direct `INSERT`, `UPDATE`, or `DELETE` on
`callora.call_logs` and are not members of `callora_call_writer` or
`callora_pii_migrator`.

The current `verify:live` script includes assertions for the two deterministic
seed tenants. Run it in a disposable integration database, through the non-owner
application LOGIN role, after migration, grants, and the development seed:

```bash
npm run db:migrate
npm run access:apply --workspace @callora/database
npm run db:seed
npm run verify:live --workspace @callora/database
```

This is where FORCE RLS isolation is meaningfully exercised. On staging and
production, validate the catalog/migration checksum and `/ready` without loading
the development fixture.

### Mandatory production PII cutover

Do not run migrations `0011`–`0013` against production without a full
maintenance window. First rehearse them against a production-scale restored
clone and record lock wait plus table/index scan duration; `0013` uses
`CONCURRENTLY` for its large index builds/drops, while constraint validation
still scans rows. Then take and restore-check a fresh provider backup, drain all
API/ingest/worker/call-writer traffic, apply the migrations, and reapply roles.

Through the one-purpose PII migrator LOGIN, run `pii:backfill`, `pii:rotate` to
the active encryption/blind versions, and `pii:verify` for every tenant. Revoke
the migrator, disable/drop it, and prove recursively through `pg_auth_members`
that zero LOGIN roles can inherit or `SET ROLE` to the writer or migrator. A
PostgreSQL 16+ migration-owner `ADMIN`-only control edge is expected and is not
a capability path. With traffic still drained and the owner connection using
`DATABASE_SSL_MODE=verify-full`,
run:

```bash
npm run pii:finalize --workspace @callora/database
```

Finalization independently enforces the zero capability/escalation-path proof,
validates the format-2 encrypted-only constraint, and closes legacy overload
grants. Resume
traffic only after its result and the exact PII catalog gate pass. The complete
key migration/rotation procedure is in
`docs/PHASE_3D_PRODUCTION_VERIFICATION.md`.

## 3. Provision a Callora identity link

Create the Callora organization, user, active membership, role, and role mapping
through an approved provisioning path. Then link the OIDC identity using the
exact issuer and subject issued by the provider. The token's configured
organization claim must contain the same Callora organization UUID.

Run the link as an authorized provisioning role with tenant context set locally:

```sql
begin;
select set_config('app.current_organization_id', '<organization-uuid>', true);
select set_config('app.current_user_id', '<callora-user-uuid>', true);

insert into callora.user_identities (
  organization_id,
  user_id,
  provider,
  issuer,
  subject,
  email_at_link_time
) values (
  '<organization-uuid>',
  '<callora-user-uuid>',
  'oidc',
  'https://identity.example.com',
  '<provider-subject>',
  '<optional-audit-email>'
);

commit;
```

Do not derive this row from an unverified email address. Callora resolves the
exact `(organization_id, issuer, subject)` tuple and requires the linked user,
membership, and organization to remain active. Treat a uniqueness conflict as a
security event: verify the existing link and use an explicit, audited re-link
procedure instead of silently moving an identity to another user.

## 4. Register the OIDC clients

Register the web application as a public browser/SPA client using Authorization
Code + PKCE. Do not create or expose a browser client secret.

Allow these exact web URLs:

- sign-in callback: `https://app.example.com/auth/callback`
- sign-out callback: `https://app.example.com/auth/logout-callback`

Configure the access token for the exact Callora API audience and add one signed,
top-level custom claim containing the Callora organization UUID. Publish keys at
an HTTPS JWKS endpoint. Prefer `RS256` unless the provider and operations team
have explicitly selected another algorithm already supported by the allowlist.

## 5. Configure the production API

Provide secrets through the deployment platform, not a committed `.env` file:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=4100
DEV_AUTH_ENABLED=false
AUTH_SECRET=<unique-random-value-of-at-least-32-characters>
CORS_ALLOWED_ORIGINS=https://app.example.com
TRUSTED_PROXY_CIDRS=10.20.0.0/16

DATABASE_URL=postgresql://callora_api_login:<secret>@db.example.com:5432/callora
DATABASE_SSL_MODE=verify-full
DATABASE_POOL_MAX=10
DATABASE_IDLE_TIMEOUT_MS=30000
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_STATEMENT_TIMEOUT_MS=5000
DATABASE_LOCK_TIMEOUT_MS=1000

OIDC_ISSUER=https://identity.example.com
OIDC_AUDIENCE=callora-api
OIDC_JWKS_URI=https://identity.example.com/.well-known/jwks.json
OIDC_ORGANIZATION_CLAIM=https://callora.example/claims/organization_id
OIDC_ALLOWED_ALGORITHMS=RS256
OIDC_CLOCK_TOLERANCE_SECONDS=5
```

Leave `TRUSTED_PROXY_CIDRS` empty when the API is directly exposed. Behind a
reverse proxy, list only the exact proxy network(s); the API rejects `/0` and
ignores forwarded client-IP headers from all other peers.

Do not put SSL query parameters in `DATABASE_URL`; select database TLS behavior
with `DATABASE_SSL_MODE`. Every direct migration/access/seed/live SQL command
requires an explicit mode: `disable` is local-only and staging/production must
use `verify-full`. The runner maps it to libpq `PGSSLMODE`, supports the system
CA store or `PGSSLROOTCERT`, strips URL passwords from child process arguments,
and never falls back to silent `prefer`. Keep `DATABASE_POOL_MAX` within the
managed database connection budget across all API replicas.

## 6. Configure and build the production web app

The root Vite environment is compiled into the static bundle:

```dotenv
VITE_AUTH_MODE=oidc
VITE_API_URL=https://api.example.com
VITE_OIDC_AUTHORITY=https://identity.example.com
VITE_OIDC_CLIENT_ID=callora-web
VITE_OIDC_REDIRECT_URI=https://app.example.com/auth/callback
VITE_OIDC_POST_LOGOUT_REDIRECT_URI=https://app.example.com/auth/logout-callback
VITE_OIDC_SCOPE=openid profile email callora-api
```

Build both services:

```bash
npm run build
NODE_ENV=production npm run start --workspace @callora/api
```

Serve `apps/web/dist` from an HTTPS static host with SPA fallback to `index.html`.
Bearer requests intentionally use `credentials: 'omit'`. Access, ID, and refresh
tokens remain memory-only; only short-lived, versioned PKCE transaction state is
stored in `sessionStorage`.

## 7. Staging verification

Perform these checks before production traffic:

1. `GET /health` returns process liveness and `GET /ready` confirms PostgreSQL.
2. The development session route returns `404` in production.
3. A valid linked OIDC user can complete PKCE login and `GET /v1/session`.
4. Wrong issuer, audience, organization, subject, expired tokens, inactive users,
   and inactive memberships all return the same generic `401` body.
5. An authorized admin can list/create employees and create/revoke/redeem one
   short-lived pairing code.
6. In the disposable integration database, exercise repository ingest retries
   and confirm a fingerprint mismatch returns a stable conflict. The simulated
   HTTP ingest route is intentionally absent from production.
7. Run `verify:live` with its two seeded tenants through the non-owner application
   role in that disposable integration database.
8. Confirm logs contain request IDs but no bearer tokens, pairing codes, or raw
   sensitive request bodies.

## 8. Rollout and rollback

Back up the database before applying migrations. Migrations are forward-only;
never edit an applied migration. Deploy the web and API only after the migration
and identity links exist. Roll back application code independently when schema
compatibility permits; otherwise ship a forward corrective migration. Revoke
compromised OIDC sessions/keys at the provider and disable affected identity
links or memberships in Callora.

## 9. Open launch gates

The current implementation is intentionally not a production sign-off:

- no live PostgreSQL or real IdP was available on the implementation workstation;
- HTTP audit appends are a separate transaction from their domain mutation;
- mobile pairing limits are database-backed; a coarse edge/WAF abuse layer still
  needs deployed evidence;
- manager team scopes and employee self scopes remain fail-closed;
- identity provisioning is SQL/admin-path only, with no customer onboarding UI;
- dashboard aggregation still needs production-volume SQL/load evidence;
- real tenant-by-tenant PII backfill/rotation/verification/finalization evidence
  remains mandatory;
- post-transition enforcement evidence,
  retention workers, telemetry, managed backup/restore, incident response, and
  deployment infrastructure remain open;
- Android restricted-permission distribution and policy approval remain launch
  gates before real call-log collection.
