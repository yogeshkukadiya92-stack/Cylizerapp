import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  Phase3dHarnessError,
  connectionEnvironment,
  databaseDumpArguments,
  parseDatabaseConnection,
  percentile,
  redactDatabaseText,
  validateHarnessEnvironment,
} from "../scripts/phase3d-live.mjs";

const harnessSource = readFileSync(new URL("../scripts/phase3d-live.mjs", import.meta.url), "utf8");
const runtimeSql = readFileSync(new URL("./phase3d-runtime.sql", import.meta.url), "utf8");
const piiCatalogSql = readFileSync(new URL("./phase3d-pii-catalog.sql", import.meta.url), "utf8");
const accessSql = readFileSync(new URL("../access/roles.sql", import.meta.url), "utf8");
const ciBootstrapSql = readFileSync(new URL("./phase3d-ci-bootstrap.sql", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");

function validEnvironment() {
  return {
    PHASE3D_CONFIRM_DISPOSABLE: "callora-phase3d-disposable-databases",
    PHASE3D_MIGRATION_DATABASE_URL: "postgresql://callora_phase3d_migration:admin-secret@127.0.0.1:5432/callora_phase3d",
    PHASE3D_RUNTIME_DATABASE_URL: "postgresql://callora_runtime:runtime-secret@127.0.0.1:5432/callora_phase3d",
    PHASE3D_RESTORE_MIGRATION_DATABASE_URL: "postgresql://callora_phase3d_migration:admin-secret@127.0.0.1:5432/callora_phase3d_restore",
    PHASE3D_RESTORE_RUNTIME_DATABASE_URL: "postgresql://callora_runtime:runtime-secret@127.0.0.1:5432/callora_phase3d_restore",
    PHASE3D_MAX_P95_MS: "3000",
    PHASE3D_DATABASE_SSL_MODE: "disable",
    PHASE3D_ALLOW_INSECURE_LOCALHOST: "true",
  };
}

test("accepts only separate disposable source/restore databases and a non-owner runtime role", () => {
  const config = validateHarnessEnvironment(validEnvironment());
  assert.equal(config.migration.databaseName, "callora_phase3d");
  assert.equal(config.restoreMigration.databaseName, "callora_phase3d_restore");
  assert.equal(config.runtime.username, "callora_runtime");
  assert.equal(config.sslPolicy.mode, "disable");
  assert.equal(connectionEnvironment(config.runtime).PGSSLMODE, "disable");
  assert.equal(connectionEnvironment(config.runtime, { PGSSLMODE: "prefer" }).PGSSLMODE, "disable");
});

test("rejects production-looking database names, reused owners, and same restore target", () => {
  assert.throws(
    () => parseDatabaseConnection("postgresql://owner:secret@db.internal/callora", "DATABASE_URL"),
    Phase3dHarnessError,
  );

  const ownerRuntime = validEnvironment();
  ownerRuntime.PHASE3D_RUNTIME_DATABASE_URL = "postgresql://callora_phase3d_migration:runtime-secret@127.0.0.1:5432/callora_phase3d";
  assert.throws(() => validateHarnessEnvironment(ownerRuntime), /distinct/);

  const sameRestore = validEnvironment();
  sameRestore.PHASE3D_RESTORE_MIGRATION_DATABASE_URL = sameRestore.PHASE3D_MIGRATION_DATABASE_URL;
  sameRestore.PHASE3D_RESTORE_RUNTIME_DATABASE_URL = sameRestore.PHASE3D_RUNTIME_DATABASE_URL;
  assert.throws(() => validateHarnessEnvironment(sameRestore), /different databases/);

  const differentSameClusterOwner = validEnvironment();
  differentSameClusterOwner.PHASE3D_RESTORE_MIGRATION_DATABASE_URL =
    "postgresql://different_migration_owner:admin-secret@127.0.0.1:5432/callora_phase3d_restore";
  assert.throws(() => validateHarnessEnvironment(differentSameClusterOwner), /same migration owner role/);

  const sslOverride = validEnvironment();
  sslOverride.PHASE3D_MIGRATION_DATABASE_URL += "?sslmode=disable";
  assert.throws(() => validateHarnessEnvironment(sslOverride), /must not contain SSL URL parameters/);
});

test("requires the explicit destructive-scope confirmation", () => {
  const environment = validEnvironment();
  environment.PHASE3D_CONFIRM_DISPOSABLE = "yes";
  assert.throws(() => validateHarnessEnvironment(environment), /must exactly equal/);
});

test("requires verified TLS remotely and a double-explicit localhost-only exception", () => {
  const missingPolicy = validEnvironment();
  delete missingPolicy.PHASE3D_DATABASE_SSL_MODE;
  assert.throws(() => validateHarnessEnvironment(missingPolicy), /PHASE3D_DATABASE_SSL_MODE is required/);

  const silentPrefer = validEnvironment();
  silentPrefer.PHASE3D_DATABASE_SSL_MODE = "prefer";
  assert.throws(() => validateHarnessEnvironment(silentPrefer), /prefer\/require are not allowed/);

  const missingException = validEnvironment();
  missingException.PHASE3D_ALLOW_INSECURE_LOCALHOST = "false";
  assert.throws(() => validateHarnessEnvironment(missingException), /requires PHASE3D_ALLOW_INSECURE_LOCALHOST=true/);

  const remoteInsecure = validEnvironment();
  for (const name of [
    "PHASE3D_MIGRATION_DATABASE_URL",
    "PHASE3D_RUNTIME_DATABASE_URL",
    "PHASE3D_RESTORE_MIGRATION_DATABASE_URL",
    "PHASE3D_RESTORE_RUNTIME_DATABASE_URL",
  ]) {
    remoteInsecure[name] = remoteInsecure[name].replace("127.0.0.1", "db.callora.company");
  }
  assert.throws(() => validateHarnessEnvironment(remoteInsecure), /all four URLs on exact localhost/);

  const remoteVerified = { ...remoteInsecure };
  remoteVerified.PHASE3D_DATABASE_SSL_MODE = "verify-full";
  remoteVerified.PHASE3D_ALLOW_INSECURE_LOCALHOST = "false";
  assert.equal(validateHarnessEnvironment(remoteVerified).sslPolicy.mode, "verify-full");
});

test("redacts raw URLs and passwords from command failures", () => {
  const environment = validEnvironment();
  const connection = parseDatabaseConnection(environment.PHASE3D_MIGRATION_DATABASE_URL, "source");
  const output = redactDatabaseText(
    `failed ${connection.rawUrl} password=${connection.password}`,
    [connection],
  );
  assert.equal(output.includes("admin-secret"), false);
  assert.equal(output.includes("postgresql://"), false);

  assert.equal(
    redactDatabaseText("token=temporary-secret", [], ["temporary-secret"]),
    "token=[REDACTED]",
  );
});

test("calculates nearest-rank percentiles deterministically", () => {
  assert.equal(percentile([9, 1, 4, 3, 7], 0.5), 4);
  assert.equal(percentile([9, 1, 4, 3, 7], 0.95), 9);
  assert.throws(() => percentile([], 0.95), Phase3dHarnessError);
});

test("scopes backups to Callora and fingerprints manifests in UTC", () => {
  const args = databaseDumpArguments("/tmp/evidence.dump", "postgresql://owner@db/callora_phase3d");
  assert.equal(args.includes("--schema=callora"), true);
  assert.equal(args.includes("--no-owner"), true);
  assert.equal(args.includes("--no-privileges"), true);
  assert.equal(args.some((argument) => argument.includes("public")), false);
  assert.match(harnessSource, /set timezone = 'UTC';[\s\S]*MANIFEST_SQL/i);
  assert.match(harnessSource, /create extension if not exists pgcrypto;[\s\S]*pg_restore/i);
});

test("uses actual grants for the runtime allowlist without treating ungranted superusers as members", () => {
  assert.match(
    runtimeSql,
    /with recursive inherited_roles[\s\S]*pg_auth_members[\s\S]*bool_or\(role_definition\.rolname = 'callora_api'\)[\s\S]*filter \(where role_definition\.rolname <> 'callora_api'\)/i,
  );
  assert.match(
    runtimeSql,
    /with recursive actual_memberships[\s\S]*pg_auth_members[\s\S]*'callora_call_writer', 'callora_pii_migrator'/i,
  );
  assert.match(
    harnessSource,
    /assertNoForbiddenLoginMemberships[\s\S]*with recursive actual_memberships[\s\S]*pg_auth_members[\s\S]*'callora_call_writer', 'callora_pii_migrator'/i,
  );
  assert.match(runtimeSql, /to_jsonb\(membership\)->>'admin_option'[\s\S]*to_jsonb\(membership\)->>'inherit_option'[\s\S]*to_jsonb\(membership\)->>'set_option'/i);
  assert.match(harnessSource, /to_jsonb\(membership\)->>'admin_option'[\s\S]*to_jsonb\(membership\)->>'inherit_option'[\s\S]*to_jsonb\(membership\)->>'set_option'/i);
  assert.match(runtimeSql, /unsafe_direct_memberships[\s\S]*login_role\.oid = database_definition\.datdba/i);
  assert.match(runtimeSql, /unsafe_high_impact_roles[\s\S]*capability_role\.rolcanlogin[\s\S]*capability_role\.rolbypassrls/i);
  assert.match(runtimeSql, /has_table_privilege\(current_user, 'callora\.call_logs', 'TRUNCATE'\)/i);
  assert.match(harnessSource, /unsafe high-impact role attributes or forbidden LOGIN paths/i);
  assert.match(harnessSource, /login_role\.oid = database_definition\.datdba[\s\S]*directly_granted_role\.rolname in \('callora_call_writer', 'callora_pii_migrator'\)/i);
  assert.doesNotMatch(runtimeSql, /pg_has_role\(login_role\.oid/i);
  assert.doesNotMatch(harnessSource, /pg_has_role\(login_role\.oid/i);
});

test("runs exact post-0013 PII index, constraint, and SECURITY DEFINER catalog gates", () => {
  for (const indexName of [
    "call_logs_phone_nonce_unique",
    "call_logs_contact_nonce_unique",
    "call_logs_phone_blind_started_keyset_idx",
    "call_logs_contact_blind_started_keyset_idx",
  ]) {
    assert.match(piiCatalogSql, new RegExp(indexName));
  }
  assert.match(piiCatalogSql, /indisvalid[\s\S]*indisready[\s\S]*indislive/i);
  assert.match(piiCatalogSql, /pii_blind_index_key_version/i);
  assert.match(piiCatalogSql, /key_options[\s\S]*array\[0, 0, 0, 3, 3\]/i);
  assert.match(piiCatalogSql, /to_regclass\('callora\.call_logs_phone_started_keyset_idx'\) is not null/i);
  assert.match(piiCatalogSql, /call_logs_pii_representation_valid/i);
  assert.match(piiCatalogSql, /constraint_definition\.convalidated/i);
  assert.match(piiCatalogSql, /prosecdef is distinct from true/i);
  assert.match(piiCatalogSql, /owner_role\.rolname is distinct from 'callora_call_writer'/i);
  assert.match(piiCatalogSql, /search_path=pg_catalog/i);
  assert.match(piiCatalogSql, /aclexplode[\s\S]*grantee = 0[\s\S]*privilege_type = 'EXECUTE'/i);
  assert.match(
    piiCatalogSql,
    /namespace\.nspname = 'callora'[\s\S]*function_definition\.prosecdef[\s\S]*Callora SECURITY DEFINER functions remain executable by PUBLIC/i,
  );
  assert.match(
    accessSql,
    /namespace\.nspname = 'callora'[\s\S]*procedure_definition\.prosecdef[\s\S]*revoke execute on %s %I\.%I\(%s\) from public/i,
  );
  const purgeEnd = accessSql.indexOf("$purge_callora_pii_role_memberships$;");
  const temporaryWriterEnable = accessSql.indexOf("do $enable_callora_writer_maintenance$");
  const publicAclRepair = accessSql.indexOf("do $revoke_public_security_definer_execute$");
  const temporaryWriterDisable = accessSql.indexOf("do $disable_callora_writer_maintenance$");
  assert.ok(purgeEnd >= 0 && purgeEnd < temporaryWriterEnable);
  assert.ok(temporaryWriterEnable < publicAclRepair);
  assert.ok(publicAclRepair < temporaryWriterDisable);
  assert.match(
    accessSql,
    /enable_callora_writer_maintenance[\s\S]*server_version_number >= 160000[\s\S]*admin true, inherit true, set true/i,
  );
  assert.match(
    accessSql,
    /disable_callora_writer_maintenance[\s\S]*admin true, inherit false, set false[\s\S]*else[\s\S]*revoke %I from %I/i,
  );
  assert.match(accessSql, /missing_control_roles[\s\S]*callora_call_writer[\s\S]*callora_pii_migrator/i);
  assert.match(
    harnessSource,
    /assertDedicatedMigrationOwner[\s\S]*role_definition\.rolcreatedb[\s\S]*not role_definition\.rolcreaterole[\s\S]*role_definition\.rolreplication[\s\S]*not role_definition\.rolinherit[\s\S]*database_definition\.datdba <> role_definition\.oid/i,
  );
  assert.match(
    harnessSource,
    /grantRuntimeMembership[\s\S]*runtime LOGIN role gate[\s\S]*normalize_runtime_api_membership[\s\S]*admin false, inherit true, set true/i,
  );
  assert.match(harnessSource, /revoke admin option for callora_api[\s\S]*runtime callora_api membership gate/i);
  assert.doesNotMatch(harnessSource, /alter role \$\{role\}/i);
  assert.match(
    harnessSource,
    /"database access grants"\)[\s\S]*"database access grant replay"\)/i,
  );
  assert.match(
    harnessSource,
    /"restored access grants"\)[\s\S]*"restored access grant replay"\)[\s\S]*phase3d-pii-catalog\.sql/i,
  );
  assert.equal(harnessSource.match(/runDatabaseScript\([^\n]+"access\/roles\.sql"/g)?.length, 4);
  assert.equal(harnessSource.match(/phase3d-pii-catalog\.sql/g)?.length, 2);
  assert.match(ciBootstrapSql, /callora_phase3d_migration login nosuperuser nocreatedb createrole inherit noreplication nobypassrls/i);
  assert.match(ciBootstrapSql, /create database callora_phase3d owner callora_phase3d_migration/i);
  assert.match(ciWorkflow, /postgres:\s*\["15", "16"\]/i);
  assert.match(ciWorkflow, /postgres:\$\{\{ matrix\.postgres \}\}-alpine/i);
});
