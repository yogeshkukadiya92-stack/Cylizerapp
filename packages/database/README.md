# Callora PostgreSQL foundation

This package owns Callora's PostgreSQL 15+ schema. It is intentionally SQL-first so the API, mobile ingest service, background workers, and reporting jobs share one enforceable tenant model.

The current foundation covers:

- organizations and settings;
- tenant-scoped users, memberships, roles, and permissions;
- teams, employees, Android/iOS installations, SIM slots, and hashed pairing codes;
- bounded sync batches and idempotent mobile call ingestion;
- call notes and append-only audit events;
- composite tenant foreign keys, keyset indexes, partial operational indexes, and FORCE RLS;
- tenant-bound OIDC identities, durable API idempotency, and a transactional outbox.
- one-time mobile bootstrap credentials, versioned consent receipts, revocable device sessions, and durable batch replay responses.
- authoritative, content-addressed mobile disclosures, crash-safe client-proposed credential transitions, and database-backed mobile throttling.

## Package layout

| Path | Purpose |
| --- | --- |
| `migrations/` | Immutable, ordered production migrations |
| `seed/dev.sql` | Deterministic data for two isolated development tenants |
| `access/roles.sql` | Optional least-privilege NOLOGIN group roles |
| `scripts/` | Dependency-free migration and offline verification tools |
| `tests/schema.test.mjs` | Offline structural contract tests |
| `tests/live-schema.sql` | Optional catalog and tenant-isolation checks |
| `tests/phase3d-runtime.sql` | Fail-closed non-owner/FORCE-RLS proof for a disposable live database |
| `tests/phase3d-pii-catalog.sql` | Exact live PII index/constraint/function ownership and ACL gate |
| `scripts/phase3d-live.mjs` | Migration replay, concurrency/load, backup/restore, and sanitized evidence harness |

## Verify without a database

From the repository root:

```bash
npm test --workspace @callora/database
npm run verify --workspace @callora/database
```

These checks use only Node.js. They verify migration ordering, required tables, tenant policies, FORCE RLS, OIDC and idempotency constraints, atomic upsert wiring, keyset/partial indexes, append-only audit protection, and both seed tenants.

## Apply to PostgreSQL

The runner requires the PostgreSQL `psql` client and refuses to guess a connection. Point `DATABASE_URL` at a database owned by the migration role:

```bash
export DATABASE_URL='postgresql://migration_user:password@localhost:5432/callora_dev'
export DATABASE_SSL_MODE=disable
npm run migrate --workspace @callora/database
npm run access:apply --workspace @callora/database
npm run seed --workspace @callora/database
npm run verify:live --workspace @callora/database
```

Every direct `migrate`, `access:apply`, `seed`, `pii:finalize`, or
`verify:live` invocation requires an explicit `DATABASE_SSL_MODE`; there is no
libpq `prefer` fallback.
Use `disable` only for an isolated local database. Remote/staging/production
connections require `verify-full`, using the system CA store or an explicit
`PGSSLROOTCERT` when the provider requires one. SSL query parameters in
`DATABASE_URL` are rejected, and URL passwords are moved to `PGPASSWORD` rather
than exposed in the `psql` process arguments.

`migrate` serializes every migration with an advisory lock, records a SHA-256
checksum in `callora.schema_migrations`, skips matching versions, and rejects
changed applied migrations. Normal files run atomically. A file whose first
header declares `callora:migration-mode nontransactional` runs in autocommit so
PostgreSQL can build or drop indexes `CONCURRENTLY`; such a file must contain
only retry-safe/idempotent operations because its DDL and checksum ledger cannot
share one transaction. Never edit an applied migration; add the next numbered
file.

`access:apply` requires a database-owner `INHERIT NOSUPERUSER NOCREATEDB
CREATEROLE NOREPLICATION NOBYPASSRLS` LOGIN. It creates six `NOLOGIN`,
`NOBYPASSRLS` group roles:

- `callora_api` for normal tenant CRUD;
- `callora_ingest` for the narrow mobile synchronization path;
- `callora_auditor` for read-only audit/reporting access;
- `callora_worker` for tenant-by-tenant outbox delivery;
- `callora_call_writer` as the never-login owner of encrypted-only call functions;
- `callora_pii_migrator` for a short-lived, explicitly revoked backfill LOGIN.

Grant the appropriate group role to separately managed LOGIN roles. Do not use the database owner or a `BYPASSRLS` role for application traffic. Re-run `access:apply` after a migration adds tables or callable functions so new objects receive explicit grants.

On PostgreSQL 16+, role creation leaves the migration owner an admin-only
control grant. The bootstrap normalizes writer/migrator control to `ADMIN TRUE,
INHERIT FALSE, SET FALSE`; global audits exclude only those non-capability edges
and still fail on any LOGIN that can inherit or `SET ROLE` to either role.

The development seed contains fictional PII and synthetic pairing hashes. Never apply it to staging or production.

For the full disposable PostgreSQL 15+ verification—including a second migration
runner pass, a real non-owner runtime LOGIN, credential/limiter concurrency,
bounded load, and a separate backup restore—use `npm run release:db:verify` from
the repository root. It requires four environment-supplied URLs and the exact
disposable-database confirmation documented in
`docs/PHASE_3D_PRODUCTION_VERIFICATION.md`. It refuses pre-existing user schemas
or relations, permits only `callora_api` on the runtime LOGIN, scopes the backup
to the `callora` schema, and emits only sanitized JSON evidence.

## Tenant context and transaction boundary

Every tenant table is protected by RLS and `FORCE ROW LEVEL SECURITY`. Policies read `app.current_organization_id`; permission checks can also read `app.current_user_id`.

Set both values transaction-locally only after the backend validates the authenticated user's signed membership claim:

```sql
begin;
set local statement_timeout = '5s';
select set_config('app.current_organization_id', $1, true);
select set_config('app.current_user_id', $2, true);

select id, started_at, direction, disposition, phone_number
from callora.call_logs
where (started_at, id) < ($3::timestamptz, $4::uuid)
order by started_at desc, id desc
limit 50;

commit;
```

The final `true` makes each setting transaction-local, which prevents organization context leaking through a connection pool. Derive the organization ID from trusted authentication/authorization state; never copy an arbitrary request parameter into the setting. RLS isolates organizations, while route/service authorization should still enforce the permission returned by `callora.current_user_has_permission(...)`.

Use transaction-mode pooling for API and ingest traffic. Keep transactions short:

- validate payloads and perform HTTP/object-storage work before opening the transaction;
- set tenant context, execute only required SQL, and commit;
- do not wait for a mobile client, webhook, email, or recording upload while locks are held;
- keep HTTP mobile sync batches at or below the API limit of 100 items (the database function retains a 500-row defensive ceiling) and use smaller chunks when latency is high;
- set local statement and lock timeouts appropriate to the endpoint.

## Atomic mobile call ingestion

The mobile retry key is `(organization_id, device_id, external_id)`. The database also protects batch retries with `(organization_id, device_id, batch_id)`.

A typical ingest transaction is:

1. Set the trusted organization context with `set_config(..., true)`.
2. Call `callora.register_call_ingest_batch(...)` once. Reusing a batch ID with different immutable metadata raises a uniqueness error.
3. Call `callora.upsert_mobile_call(...)` for each validated item. It returns `created`, `updated`, or `duplicate`; stale/unchanged retries do not write.
4. Update `callora.call_ingest_batches` with processed counts, a completion status, `completed_at`, and the exact JSON response used for retries.
5. Commit immediately, then perform downstream notifications asynchronously.

The unique constraint, `INSERT ... ON CONFLICT`, and follow-up update happen inside one database function call, avoiding a select-then-insert race. Cross-tenant employee, device, SIM, batch, call, note, and actor references use composite foreign keys, so application bugs cannot connect records from different organizations.

Pairing codes store only a 32-byte SHA-256 digest plus a short display hint. Generate high-entropy codes, compare digests, rate-limit failed attempts, expire codes promptly, and expose code redemption only through a narrowly privileged service path.

An unauthenticated pairing request cannot set tenant RLS context until its code is resolved. Migration `0007` therefore maintains a digest-only `pairing_code_resolutions` directory. Runtime roles receive no table privilege: `callora_api` can execute only `resolve_pairing_code_organization(bytea)`, which performs one exact digest lookup. After resolution, all pairing reads and mutations run in a short transaction under the resolved tenant's FORCE RLS policy.

Migration `0008` applies the same design to mobile credentials. Raw bootstrap and
session tokens never enter PostgreSQL. `device_credentials` stores only a
32-byte type-separated, peppered digest plus lifecycle timestamps, while the
unprivileged `device_credential_resolutions` directory is accessible only via
the exact-digest `resolve_device_credential(bytea, text)` security-definer
function. Runtime roles have no direct directory read privilege. Both
`device_credentials` and `device_consent_receipts` use FORCE RLS, indexed
tenant-first foreign keys, and at most one active session/consent per device.

Activation consumes the bootstrap, inserts the complete consent and permission
snapshot, creates the session digest, activates the device, and emits an outbox
event in one tenant transaction. Heartbeats persist last-observed time, battery,
charging, network, queue counts, permissions, and sync health. Batch auth,
registration, per-item upsert, stable response storage, device health update,
credential usage, and outbox rows also commit atomically.

Migration `0009` makes mobile disclosure and credential recovery
server-authoritative. `mobile_collection_policies` contains immutable disclosure
content; PostgreSQL computes the SHA-256 content digest on insert. The seeded
policies are:

- `30000000-0000-4000-8000-000000000001` for `synthetic_demo`;
- `30000000-0000-4000-8000-000000000002` for `android_call_log`.

Resolve a current policy only through
`resolve_mobile_collection_policy(collection_mode, purpose, at)`. Consent rows
store both the policy UUID and exact content digest. Receipt content cannot be
updated or deleted; the guard permits only a first, forward-moving
`withdrawn_at`. New acceptance creates another receipt, preserving history.
Policies are platform-bound (`android` in this phase); an advisory-locked
overlap guard and a partial unique index prevent two policies for the same
platform/mode/purpose from being current together. Mobile authorization must
call `device_has_current_collection_consent(organization_id, device_id, at)`;
checking only `withdrawn_at is null` is insufficient because a newer policy
invalidates an older receipt until the employee consents again.

The mobile client generates and durably stores each bootstrap/session secret
before its request. PostgreSQL receives only the peppered 32-byte digest.
`device_credential_requests` is an immutable exact-replay ledger protected by
FORCE RLS. Its unprivileged resolution directory is reachable only through
exact digest + request ID + operation + request-fingerprint functions. The
ordinary `resolve_device_credential(bytea, text)` function resolves `active`
credentials only: consumed bootstraps and revoked sessions require
`resolve_device_credential_replay`, while a pending rotation requires the
prepare-request-bound `resolve_pending_rotation_credential` path.

Credential transitions use a consistent employee → device → request → credential lock
order and run in short transactions:

1. `prepare_device_credential_request` consumes a pairing into an active
   bootstrap, consumes a bootstrap into a client-proposed active session, or
   creates a pending rotation while leaving the previous session active.
2. `confirm_device_session_rotation` atomically revokes the previous active
   session and promotes the pending digest after the client proves possession.
3. `revoke_device_session_request` is request-idempotent even when its response
   is lost and the source token is already revoked.
4. `accept_device_collection_policy` and
   `reconsent_device_collection_policy` bind consent to the server policy and
   update the device permission snapshot.

These functions insert append-only `audit_events` and transactional
`outbox_events` in the same database transaction as the mutation. Runtime roles
have no direct insert/update/delete privilege on credential, request, or consent
tables; credential usage timestamps use the narrow
`touch_active_device_credential` function.

`consume_mobile_rate_limit` provides an atomic fixed-window counter keyed only
by a server-HMAC digest and operation. Parameters are bounded to 100 attempts
and a 24-hour window. `consume_pairing_redemption_attempt` applies the fixed
five-attempt/ten-minute pairing policy, and `reset_mobile_rate_limit` clears the
same digest key after a successful operation. The table is split into 64 digest
buckets; each consume removes at most 64 expired rows under a bucket advisory
lock and refuses a new key once that bucket reaches 4,096 live rows. This gives
a hard 262,144-row ceiling even during rotating-key abuse. Expired rows also
have an indexed TTL so a maintenance job can delete them in larger bounded
batches off the request path.

## Production identity and runtime state

`user_identities` links an exact `(organization_id, issuer, subject)` OIDC identity to a Callora user. Resolve all three claims together and require the linked user plus organization membership to remain active. Never fall back to matching email addresses.

`api_idempotency_keys` persists a request fingerprint and resulting resource for retry-safe mutations. A reused key with a different fingerprint is a conflict. `call_logs.ingest_fingerprint` also detects a device/external-id retry sent under a new idempotency key.

`outbox_events` is written in the same transaction as its aggregate mutation. Workers should claim ready rows with `FOR UPDATE SKIP LOCKED`, bounded batches, and one trusted organization context per transaction. Deliver externally after the claim transaction, then mark delivery in a second short tenant-scoped transaction. Do not hold a database transaction open during network I/O.

The current HTTP application calls `appendAuditEvent` after each repository mutation, so the audit insert is a separate transaction and is not atomic with the mutation. The transactional outbox is atomic; the audit trail is not yet. Before calling the audit path production-complete, replace the split calls with a repository unit-of-work (or derive audit rows from the same outbox transaction) and add failure-injection integration tests.

The API adapter lives under `apps/api/src/postgres/`. It accepts a pool-compatible object, uses transaction-local organization/user settings, parameterized SQL, and keyset cursors. A real `pg.Pool` should use bounded connection counts and transaction-mode pooling. Its unit tests use a scripted pool and do not require PostgreSQL. To run a live integration check, apply migrations/access/seed, set `DATABASE_URL`, instantiate the adapter with `new pg.Pool({ connectionString: process.env.DATABASE_URL })`, and execute the same actor, employee, pairing, ingest, and cross-tenant cases through a non-owner `callora_api` LOGIN role.

Production wiring must also use the exported `UuidIdGenerator`. The development `RandomIdGenerator` prefixes IDs for readability and is intentionally incompatible with PostgreSQL `uuid` columns.

## Query and retention guidance

Call and audit timelines use descending `(organization_id, time, id)` indexes.
Always use keyset cursors; avoid deep `OFFSET` scans. Employee timelines and
tenant-bound keyed phone/contact blind-index lookups have matching composite
indexes, while attention, pinned, active-pairing, failed-sync, and
incomplete-batch paths use smaller partial indexes. Do not recreate a plaintext
phone-number index.

Retention fields on `organizations` are policy inputs, not automatic deletion. A background retention worker should delete or archive bounded keyset batches, commit between batches, and emit an audit event. Do not run one unbounded delete transaction across a tenant's history.

## Live isolation check

`npm run verify:live --workspace @callora/database` checks catalog state, constraint/function presence, index validity, and the two seeded tenant views. PostgreSQL superusers and `BYPASSRLS` roles always bypass RLS, so the script reports that it skipped data-isolation assertions for those roles. Run the final check through an application test LOGIN role for meaningful isolation evidence.

For a gate that refuses privileged execution rather than skipping isolation,
use `npm run release:db:verify`; it runs `tests/phase3d-runtime.sql` through the
dedicated non-owner LOGIN, rejects any LOGIN that can inherit the call writer or
still inherits the temporary PII migrator, and repeats the proof after backup
restore.
