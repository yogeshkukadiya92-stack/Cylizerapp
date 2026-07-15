# Callora Phase 3D production verification

- Date: 15 July 2026
- Scope: reproducible release gates for PostgreSQL, deployed OIDC/origins, call-log PII keys, and Android release inputs
- Status: tooling implemented; real infrastructure, identity, signing, device-matrix, legal, and distribution evidence remains external

This runbook is a verification procedure, not a production approval. It never
creates production infrastructure, changes DNS/IdP settings, or supplies secret
material. Every database URL, encryption key, Android password, and keystore is
read from the process environment and is redacted from harness failures.

## 1. Offline gate

From a clean checkout with Node.js 20 or newer:

```bash
npm ci
npm run check
```

`npm run check` includes the Phase 3D preflight unit tests. Those tests prove the
configuration validator rejects placeholders, wildcard CORS, ambiguous proxy
topology, unsafe or rolled-back PII keyrings, missing Android signing material,
and accidental credential/URL output. They do not contact a real IdP or database.

## 2. Disposable PostgreSQL evidence

The live harness requires PostgreSQL and `psql`, `pg_dump`, and `pg_restore` 15+
on `PATH`. Provision two empty disposable databases on an isolated integration
server:

- source database whose name contains a distinct `phase3d` segment;
- restore database whose name contains a distinct `phase3d` segment;
- one `LOGIN INHERIT NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION
  NOBYPASSRLS` migration owner for
  each database, authorized to create/alter the shared NOLOGIN group roles used
  by `access/roles.sql`; the harness rejects a superuser or `NOINHERIT` owner,
  and two databases on the same PostgreSQL server must use the same owner role;
- one separate `LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS` runtime role usable in both, with no membership in
  any privileged or schema-owner role.

Do not point the harness at staging or production. It deliberately applies the
fictional development seed and exercises a real pairing-code race. It refuses
any pre-existing user schema or relation—not only a `callora` schema—and never
drops an existing schema.

Supply the connections through a secret-aware shell or CI environment:

```bash
export PHASE3D_CONFIRM_DISPOSABLE=callora-phase3d-disposable-databases
export PHASE3D_MIGRATION_DATABASE_URL='<source-owner-url-from-secret-store>'
export PHASE3D_RUNTIME_DATABASE_URL='<source-runtime-url-from-secret-store>'
export PHASE3D_RESTORE_MIGRATION_DATABASE_URL='<restore-owner-url-from-secret-store>'
export PHASE3D_RESTORE_RUNTIME_DATABASE_URL='<restore-runtime-url-from-secret-store>'
export PHASE3D_DATABASE_SSL_MODE=verify-full
export PHASE3D_ALLOW_INSECURE_LOCALHOST=false
export PHASE3D_EVIDENCE_DIR="$PWD/work/phase3d-evidence"
export PHASE3D_LIMITER_CONCURRENCY=24
export PHASE3D_LOAD_REQUESTS=48
export PHASE3D_LOAD_CONCURRENCY=8
export PHASE3D_MAX_P95_MS=3000
npm run release:db:verify
```

All four URLs must omit SSL query parameters. Remote databases require
`PHASE3D_DATABASE_SSL_MODE=verify-full`; the harness exports that policy as
libpq `PGSSLMODE` to every `psql`, `pg_dump`, and `pg_restore` child. The only
unencrypted exception is an isolated disposable service on exact
`localhost`/`127.0.0.1`/`::1`, and it requires both
`PHASE3D_DATABASE_SSL_MODE=disable` and
`PHASE3D_ALLOW_INSECURE_LOCALHOST=true`. Silent libpq `prefer`/`require` modes
are rejected.

Choose `PHASE3D_MAX_P95_MS` from the integration environment's documented
service objective. The measurement includes a short-lived `psql` client for each
attempt, so retain the environment shape and threshold with the evidence when
comparing runs.

The harness fails unless all of these gates pass:

1. PostgreSQL server and client tools are version 15+.
2. Every ordered migration applies to an empty database, a second runner pass
   accepts exactly the recorded checksums without reapplying a migration, and
   the non-super migration owner replays `access/roles.sql` twice on both source
   and restored databases without retaining writer capability.
3. The runtime LOGIN is a `callora_api` capability member but is not an owner, superuser,
   `BYPASSRLS` role, schema creator, or owner-role member, and has no other
   direct or transitive Callora capability-role membership. No LOGIN may inherit
   or `SET ROLE` to `callora_call_writer`; normal release verification also
   requires zero LOGIN capability paths to the short-lived
   `callora_pii_migrator` role. On PostgreSQL 16+, the migration owner retains
   only `ADMIN TRUE, INHERIT FALSE, SET FALSE` control grants for these roles;
   those grants confer no writer/migrator data capability and make replay safe.
4. Every tenant table has `ENABLE RLS`, `FORCE RLS`, and a policy; two seeded
   tenants cannot see one another, including direct primary-key lookup.
5. Runtime has no direct credential request/digest-directory, limiter,
   `call_logs` write, or `TRUNCATE` access and uses only the narrow encrypted
   functions. The dedicated PII login independently rejects `TRUNCATE`.
6. Two simultaneous pairing redemptions produce exactly one commit and one
   controlled rejection, leaving one active bootstrap.
7. Concurrent limiter calls permit exactly five attempts, deny the rest with a
   positive retry interval, and the bounded unique-key load stays within the
   configured p95 threshold.
8. `pg_dump` creates an owner/ACL-free custom backup scoped strictly to the
   `callora` schema (so unrelated `public` or other-schema objects cannot be
   copied), `pg_restore` loads it into the separate empty database, migration
   replay and non-owner RLS pass again,
   and Callora row/sequence fingerprints plus the schema inventory (relations,
   columns, constraints, indexes, functions, policies, and triggers) match the
   source.
9. The post-`0013` live catalog has valid/ready/live exact nonce and blind-index
   definitions, no plaintext phone keyset index, and a validated PII
   representation constraint. Every encrypted write/backfill/rotation function
   is `SECURITY DEFINER`, owned by `callora_call_writer`, pins
   `search_path=pg_catalog`, and denies `PUBLIC` execute.

The temporary dump is deleted. The only durable output is
`phase3d-database-evidence.json`, which contains versions, counts, latency
statistics, and a backup SHA-256—never URLs, usernames, passwords, tokens, raw
rows, phone numbers, or contact names. CI runs the same harness against isolated
PostgreSQL 15 and 16 services and uploads version-labelled JSON for 14 days,
covering both role-membership models.

## 3. Call-log PII key and backfill gate

Generate these values in a KMS/secret manager. They must be independent 32-byte
random values encoded as unpadded base64url:

```dotenv
CALL_PII_ENCRYPTION_KEYS=1:<32-byte-base64url-key>
CALL_PII_ACTIVE_KEY_VERSION=1
CALL_PII_BLIND_INDEX_KEYS=1:<independent-32-byte-base64url-key>
CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION=1
CALL_PII_ROW_ID_KEY=<independent-stable-32-byte-base64url-key>
```

Encryption and blind-index rotation is additive: retain every version still
needed by stored rows, append the next higher version to the relevant keyring,
and make that highest version active. The row-ID key is deliberately stable so
blind-index rotation cannot change deterministic call IDs. Every key across all
three purposes must use different material. The legacy singleton
`CALL_PII_BLIND_INDEX_KEY` is rejected in production.

For an existing installation, place the former singleton material at blind
version 1 (`CALL_PII_BLIND_INDEX_KEYS=1:<former-singleton>`) so legacy HMAC
domains remain readable, and generate a separate stable `CALL_PII_ROW_ID_KEY`.
The repository reuses the stored row UUID for existing mobile calls, so
separating row identity from blind-index rotation does not rewrite those IDs.

Migrations `0011`–`0013` are a maintenance operation, not an online toggle.
Rehearse them on a production-scale restored clone and record lock-wait plus
constraint/index scan duration. Migration `0013` builds and drops the large
indexes with PostgreSQL `CONCURRENTLY`, but the constraint validations still
scan rows. Before production, take a provider backup, complete a restore
exercise, enter a full maintenance window, and drain every API, ingest, worker,
and call writer. Apply all three migrations and reapply `access/roles.sql` while
traffic remains stopped. Migration `0011_call_log_pii_encryption.sql` permits
legacy plaintext only inside this bounded transition. Provision a
short-lived `LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS` used only for this operation, then grant it only the non-login
`callora_pii_migrator` role. Never reuse the API or ingest runtime credential.

As the role administrator:

```sql
grant callora_pii_migrator to callora_pii_backfill_login;
```

Then process one tenant at a time through that dedicated login:

```bash
export DATABASE_URL='<dedicated-pii-migrator-url-from-secret-store>'
export DATABASE_SSL_MODE=verify-full
export CALL_PII_BACKFILL_ORGANIZATION_ID='<canonical-organization-uuid>'
export CALL_PII_BACKFILL_BATCH_SIZE=100
npm run pii:backfill --workspace @callora/api
npm run pii:rotate --workspace @callora/api
npm run pii:verify --workspace @callora/api
```

The backfill uses short tenant transactions and `FOR UPDATE SKIP LOCKED`, clears
the plaintext columns in the same update that writes each authenticated envelope,
and verifies decryption plus blind indexes afterward. It refuses `disable` and
certificate-unverified `require` modes, and rejects SSL overrides embedded in
`DATABASE_URL`; the dedicated PII CLI connection must authenticate the database
with `verify-full`. It also rejects superuser, `BYPASSRLS`, API/ingest membership, or
direct `call_logs` UPDATE capability. Capture a successful
`pii:backfill`, active-version `pii:rotate`, and `pii:verify` results for every
production tenant. Do not leave
`CALL_PII_BACKFILL_ORGANIZATION_ID` or `CALL_PII_BACKFILL_BATCH_SIZE` in the
long-running API environment. The static release preflight rejects them there.

After every tenant verifies, revoke the temporary membership:

```sql
revoke callora_pii_migrator from callora_pii_backfill_login;
```

Prove through a recursive `pg_auth_members` query that zero LOGIN roles can
inherit or `SET ROLE` to `callora_pii_migrator`, then disable or drop the
temporary LOGIN. On PostgreSQL 16+, ignore only the migration owner's exact
`ADMIN TRUE, INHERIT FALSE, SET FALSE` control edge. Do not use `pg_has_role`
for this global proof because PostgreSQL treats superusers as implicit members
even without an actual capability grant.

With traffic still drained, point the migration-owner `DATABASE_URL` at
production, keep `DATABASE_SSL_MODE=verify-full`, and close the compatibility
surface:

```bash
npm run pii:finalize --workspace @callora/database
```

Finalization first aborts if any unauthorized LOGIN can inherit, administer, or
`SET ROLE` to the writer or migrator. It then enables writer authority only
inside its bounded transaction, validates the format-2 encrypted-only constraint,
revokes legacy overloads, and restores the PostgreSQL-version-appropriate safe
control state. Capture its success plus a catalog proof that the
constraint is validated and legacy runtime grants are absent. Only then resume
API/ingest/worker traffic. A successful `0011` migration alone, or even tenant
backfill without rotation/verification/finalization, is not PII closure.

For future rotations, append independent higher encryption/blind versions,
grant the dedicated migrator only for the bounded tenant-by-tenant
`pii:rotate`/`pii:verify` run, then revoke it again. Remove retired key material
only after every tenant's evidence confirms the current active versions.

## 4. Production configuration and deployed-origin probes

Load the real production API/web environment plus:

```dotenv
PHASE3D_WEB_ORIGIN=https://app.company.example
PHASE3D_API_ORIGIN=https://api.company.example
PHASE3D_EXPECT_PROXY=true
```

Use real non-placeholder domains despite the illustrative names above. Set
`PHASE3D_EXPECT_PROXY=false` and leave `TRUSTED_PROXY_CIDRS` empty only when the
API is directly exposed. Otherwise list the exact proxy CIDRs; `/0`, wildcard,
padding, duplicates, and empty entries fail.

Run the local/static check before deployment:

```bash
npm run release:preflight:config
```

It requires production mode, disabled development auth, exact HTTPS DNS origins
(all IPv4/IPv6 literals and local/placeholder hosts are rejected),
`verify-full` database TLS, bounded pool/timeouts, exact CORS, OIDC+PKCE settings,
and valid independent encryption/blind-index/row-ID key configuration. Its JSON
output includes only non-secret identifiers, key version/count metadata, and
origins.

After deploying web, API, and IdP configuration:

```bash
npm run release:preflight:network
```

The network gate checks, without a user token:

- OIDC discovery over HTTPS, exact issuer and JWKS URI, authorization code, and
  advertised PKCE `S256`;
- a bounded public JWKS with unique `kid` values, compatible asymmetric signing
  keys, and no private/symmetric material;
- API `/health` and `/ready` JSON responses;
- exact-origin CORS preflight with credentialed browser requests disabled;
- a successful production web-origin response.

Then complete an interactive Authorization Code + PKCE login with a linked test
identity and the negative issuer/audience/organization/subject cases in the main
production runbook. Public discovery/JWKS checks do not replace token-flow E2E.

## 5. Android release-origin and signing gate

Keep the keystore outside the repository and inject all signing values through
the build environment:

```bash
export CALLORA_ANDROID_API_BASE_URL='<exact-deployed-https-api-origin>'
export CALLORA_ANDROID_KEYSTORE_PATH='<absolute-external-keystore-path>'
export CALLORA_ANDROID_KEY_ALIAS='<release-key-alias>'
export CALLORA_ANDROID_KEYSTORE_PASSWORD='<from-secret-store>'
export CALLORA_ANDROID_KEY_PASSWORD='<from-secret-store>'
npm run release:preflight:android
```

The preflight rejects placeholder/local/cleartext endpoints—including every IP
literal, the complete IPv4 loopback range, and bracketed IPv6 loopback—requires
a readable external keystore, reads the alias through `keytool` using its
environment-password mode, and requires the signing certificate to be currently
valid with at least one year remaining. It outputs only the public SHA-256
certificate fingerprint, expiry, alias, and API origin.

Release Gradle variants use `CALLORA_ANDROID_API_BASE_URL`; debug variants retain
the emulator loopback override. Every release variant's pre-build task, including
the normal assemble/bundle paths, depends on the Gradle
`phase3dReleasePreflight` task, so a placeholder endpoint, missing keystore, or
incomplete signing environment stops the build:

```bash
cd apps/android
./gradlew :app:bundleDemoRelease :app:bundleEnterpriseRelease --console=plain
```

Verify each final APK/AAB with the Android SDK signing tools, compare the signer
fingerprint to the approved certificate record, store checksums, and run the
deployed-origin enrollment/sync/re-consent/rotation/revocation suite on the
supported API/OEM/power-management matrix.

## 6. Gates that remain external

No local or CI harness can approve these items:

- real IdP client registration, user/membership provisioning, MFA/session policy,
  or interactive negative-token E2E;
- managed database backup retention, point-in-time recovery, replica/failover,
  monitoring, alerting, and production-scale soak evidence;
- production DNS, certificates, WAF/load-balancer limits, exact proxy networks,
  incident response, and rollback authority;
- Android Play/enterprise restricted-permission eligibility, product/legal
  disclosure approval, managed-distribution approval, protected signing custody,
  and the physical supported-device matrix.

Record the responsible owner, timestamp, environment, artifact/evidence link,
and explicit pass/fail for every external gate. Do not label Callora production
ready while any required item remains unverified.
