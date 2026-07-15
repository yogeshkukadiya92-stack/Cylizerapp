import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  collectSchemaDiagnostics,
  findMissingForeignKeyIndexes,
  packageRoot,
  readSchemaFiles,
  tenantTables,
} from "../scripts/schema-contract.mjs";

test("migrations use a contiguous, deterministic order", () => {
  const { migrationNames } = readSchemaFiles();
  assert.deepEqual(migrationNames, [
    "0001_foundation.sql",
    "0002_identity_and_rbac.sql",
    "0003_workforce_and_devices.sql",
    "0004_calls_notes_and_audit.sql",
    "0005_atomic_call_ingest.sql",
    "0006_row_level_security.sql",
    "0007_production_runtime.sql",
    "0008_mobile_device_sessions.sql",
    "0009_mobile_policy_and_credential_recovery.sql",
    "0010_admin_device_recovery.sql",
    "0011_call_log_pii_encryption.sql",
    "0012_call_log_blind_index_rotation.sql",
    "0013_call_log_pii_concurrent_indexes.sql",
    "0014_lead_crm_foundation.sql",
  ]);
});

test("schema satisfies the offline production contract", () => {
  const diagnostics = collectSchemaDiagnostics();
  assert.deepEqual(diagnostics.errors, []);
  assert.equal(diagnostics.facts.tenantTableCount, tenantTables.length);
  assert.equal(diagnostics.facts.seededTenantCount, 2);
});

test("every tenant table is protected with ENABLE and FORCE RLS", () => {
  const { schemaSql } = readSchemaFiles();
  for (const table of tenantTables) {
    assert.match(schemaSql, new RegExp(`alter table callora\\.${table} enable row level security`, "i"));
    assert.match(schemaSql, new RegExp(`alter table callora\\.${table} force row level security`, "i"));
  }
});

test("every foreign key has a matching left-prefix index", () => {
  const { schemaSql } = readSchemaFiles();
  assert.deepEqual(findMissingForeignKeyIndexes(schemaSql), []);
});

test("runtime roles are least-privilege group roles without RLS bypass", () => {
  const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
  for (const role of ["callora_api", "callora_ingest", "callora_auditor", "callora_worker"]) {
    assert.match(accessSql, new RegExp(`create role ${role} nologin[\\s\\S]*nobypassrls`, "i"));
  }
  assert.doesNotMatch(accessSql, /grant all privileges/i);
  assert.match(
    accessSql,
    /assert_callora_role_attributes[\s\S]*role_definition\.rolsuper[\s\S]*role_definition\.rolreplication[\s\S]*role_definition\.rolbypassrls/i,
  );
});

test("call writer and PII migrator are re-hardened non-login roles on every bootstrap", () => {
  const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
  for (const role of ["callora_call_writer", "callora_pii_migrator"]) {
    assert.match(
      accessSql,
      new RegExp(
        `alter role ${role} nologin nocreaterole noinherit`,
        "i",
      ),
    );
  }
  assert.doesNotMatch(
    accessSql,
    /alter role callora_[a-z_]+[^;]*(?:nosuperuser|nocreatedb|noreplication|nobypassrls)/i,
  );
  assert.match(
    accessSql,
    /where granted_role\.rolname in \('callora_call_writer', 'callora_pii_migrator'\)[\s\S]*server_version_number < 160000[\s\S]*revoke %I from %I cascade/i,
  );
  assert.match(
    accessSql,
    /server_version_number >= 160000[\s\S]*admin true, inherit false, set false/i,
  );
  assert.match(
    accessSql,
    /to_jsonb\(membership\)[\s\S]*admin_option[\s\S]*inherit_option[\s\S]*set_option/i,
  );
  assert.match(
    accessSql,
    /revoke truncate on callora\.call_logs from[\s\S]*callora_api[\s\S]*callora_ingest[\s\S]*callora_auditor[\s\S]*callora_worker[\s\S]*callora_call_writer[\s\S]*callora_pii_migrator/i,
  );
  assert.match(
    accessSql,
    /assert_no_callora_call_log_truncate[\s\S]*has_table_privilege\([\s\S]*'TRUNCATE'/i,
  );
});

test("every Callora SECURITY DEFINER routine loses default PUBLIC EXECUTE on bootstrap", () => {
  const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
  assert.match(
    accessSql,
    /from pg_proc as procedure_definition[\s\S]*namespace\.nspname = 'callora'[\s\S]*procedure_definition\.prosecdef[\s\S]*revoke execute on %s %I\.%I\(%s\) from public/i,
  );
});

test("runtime ingest roles can write only encrypted call-log PII envelopes", () => {
  const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
  assert.match(
    accessSql,
    /revoke execute on function callora\.upsert_mobile_call\([\s\S]*?\) from callora_api, callora_ingest/i,
  );
  assert.match(
    accessSql,
    /grant execute on function callora\.upsert_mobile_call_encrypted\([\s\S]*?\) to callora_api, callora_ingest/i,
  );
});

test("pairing tenant resolution is exposed only through the exact-hash function", () => {
  const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
  assert.match(
    accessSql,
    /grant execute on function callora\.resolve_pairing_code_organization\(bytea\)[\s\S]*to callora_api/i,
  );
  assert.doesNotMatch(accessSql, /grant\s+select\s+on\s+callora\.pairing_code_resolutions/i);
});

test("device credential tenant resolution is exposed only through the exact-hash function", () => {
  const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
  assert.match(
    accessSql,
    /grant execute on function callora\.resolve_device_credential\(bytea, text\)[\s\S]*to callora_api, callora_ingest/i,
  );
  assert.doesNotMatch(accessSql, /grant\s+select\s+on\s+callora\.device_credential_resolutions/i);
});

test("mobile collection policy content is authoritative and consent binds its exact hash", () => {
  const { schemaSql } = readSchemaFiles();
  assert.match(schemaSql, /create table callora\.mobile_collection_policies/i);
  assert.match(
    schemaSql,
    /create trigger mobile_collection_policies_guard_mutation[\s\S]*before update or delete/i,
  );
  assert.match(
    schemaSql,
    /foreign key \(policy_id, policy_content_hash\)[\s\S]*references callora\.mobile_collection_policies \(id, content_hash\)/i,
  );
  assert.match(schemaSql, /30000000-0000-4000-8000-000000000001/);
  assert.match(schemaSql, /30000000-0000-4000-8000-000000000002/);
  assert.match(schemaSql, /'synthetic_demo'/);
  assert.match(schemaSql, /'android_call_log'/);
  assert.match(schemaSql, /create unique index mobile_collection_policies_unretired_key/i);
  assert.match(schemaSql, /create trigger mobile_collection_policies_prevent_overlap/i);
  assert.match(schemaSql, /mobile collection policy effective windows cannot overlap/i);
  assert.match(schemaSql, /create or replace function callora\.device_has_current_collection_consent\(/i);
  assert.match(
    schemaSql,
    /current_policy\.id = receipt\.policy_id[\s\S]*current_policy\.content_hash = receipt\.policy_content_hash/i,
  );
  assert.equal(
    (schemaSql.match(/or v_policy\.id <> p_policy_id[\s\S]{0,100}v_policy\.content_hash <> p_policy_content_hash/gi) ?? []).length,
    2,
  );
});

test("consent history is append-only except for one-way withdrawal", () => {
  const { schemaSql } = readSchemaFiles();
  assert.match(schemaSql, /create or replace function callora\.guard_device_consent_receipt_mutation\(\)/i);
  assert.match(
    schemaSql,
    /create trigger device_consent_receipts_guard_mutation[\s\S]*before update or delete/i,
  );
  assert.match(schemaSql, /consent receipts are append-only/i);
});

test("credential recovery uses request-bound replay and two-phase rotation", () => {
  const { schemaSql } = readSchemaFiles();
  assert.match(schemaSql, /create table callora\.device_credential_requests/i);
  assert.match(schemaSql, /lifecycle_state text not null/i);
  assert.match(
    schemaSql,
    /create unique index device_credentials_pending_session_key[\s\S]*lifecycle_state = 'pending'/i,
  );
  assert.match(
    schemaSql,
    /create unique index device_credentials_active_session_key[\s\S]*lifecycle_state = 'active'/i,
  );
  assert.match(schemaSql, /create or replace function callora\.prepare_device_credential_request\(/i);
  assert.match(schemaSql, /create or replace function callora\.confirm_device_session_rotation\(/i);
  assert.match(schemaSql, /create or replace function callora\.revoke_device_session_request\(/i);
  assert.match(schemaSql, /create or replace function callora\.resolve_device_credential_replay\(/i);
  assert.match(
    schemaSql,
    /p_operation in \('activate', 'rotation_prepare', 'rotation_confirm', 'reconsent', 'revoke'\)/i,
  );
  assert.match(schemaSql, /create or replace function callora\.resolve_pending_rotation_credential\(/i);
  assert.match(schemaSql, /request\.request_id = p_request_id/i);
  assert.doesNotMatch(
    schemaSql,
    /device_credential_request_resolutions as request[\s\S]{0,300}request\.id = p_request_id/i,
  );
  assert.match(
    schemaSql,
    /lifecycle_state = 'pending'[\s\S]{0,200}expires_at <= p_requested_at/i,
  );
  assert.match(
    schemaSql,
    /credential\.lifecycle_state = 'pending'[\s\S]{0,120}credential\.expires_at > statement_timestamp\(\)/i,
  );
  assert.doesNotMatch(
    schemaSql,
    /v_existing\.proposed_credential_id is distinct from p_proposed_credential_id/i,
  );
  assert.match(
    schemaSql,
    /return query select[\s\S]{0,120}v_existing\.proposed_credential_id[\s\S]{0,120}true/i,
  );
  assert.match(schemaSql, /v_pending\.rotated_from_credential_id <> v_source\.id/i);
  assert.doesNotMatch(schemaSql, /resolve_device_credential\([\s\S]{0,200}allowed_states/i);
});

test("Phase 3C security-definer functions pin an empty-safe search path", () => {
  const { schemaSql } = readSchemaFiles();
  for (const functionName of [
    "resolve_mobile_collection_policy",
    "resolve_pairing_redemption_replay",
    "resolve_device_credential_replay",
    "resolve_pending_rotation_credential",
    "prepare_device_credential_request",
    "confirm_device_session_rotation",
    "revoke_device_session_request",
    "accept_device_collection_policy",
    "reconsent_device_collection_policy",
    "withdraw_device_consent",
    "consume_mobile_rate_limit",
    "reset_mobile_rate_limit",
    "device_has_current_collection_consent",
  ]) {
    assert.match(
      schemaSql,
      new RegExp(
        `create or replace function callora\\.${functionName}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path = pg_catalog`,
        "i",
      ),
    );
  }
});

test("mobile mutation tables are not broadly writable by runtime roles", () => {
  const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
  assert.doesNotMatch(
    accessSql,
    /grant[\s\S]{0,80}(?:update|delete)[\s\S]{0,120}callora\.mobile_collection_policies/i,
  );
  assert.doesNotMatch(
    accessSql,
    /grant[\s\S]{0,80}(?:insert|update|delete)[\s\S]{0,120}callora\.device_credential_requests/i,
  );
  assert.match(accessSql, /grant execute on function callora\.prepare_device_credential_request\(/i);
  assert.match(accessSql, /grant execute on function callora\.revoke_device_session_request\(/i);
  assert.doesNotMatch(
    accessSql,
    /grant execute on function callora\.resolve_device_credential_replay\(bytea, uuid, text, bytea\)[\s\S]{0,80}callora_ingest/i,
  );
});

test("pairing redemption attempt throttle is atomic and digest-only", () => {
  const { schemaSql } = readSchemaFiles();
  assert.match(schemaSql, /create table callora\.mobile_rate_limits/i);
  assert.match(schemaSql, /primary key \(key_hash, operation\)/i);
  assert.match(schemaSql, /octet_length\(key_hash\) = 32/i);
  assert.match(schemaSql, /create or replace function callora\.consume_pairing_redemption_attempt\(/i);
  assert.match(schemaSql, /create or replace function callora\.reset_mobile_rate_limit\(/i);
  assert.match(schemaSql, /pg_advisory_xact_lock\(914203, v_bucket::integer\)/i);
  assert.match(schemaSql, /limit 64/i);
  assert.match(schemaSql, /v_bucket_count >= 4096/i);
  assert.match(schemaSql, /for update/i);
});

test("administrator device recovery is tenant-scoped, immutable, atomic, and least privilege", () => {
  const { schemaSql } = readSchemaFiles();
  const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
  assert.match(schemaSql, /create table callora\.device_admin_revocations/i);
  assert.match(schemaSql, /alter table callora\.device_admin_revocations enable row level security/i);
  assert.match(schemaSql, /alter table callora\.device_admin_revocations force row level security/i);
  assert.match(
    schemaSql,
    /create trigger device_admin_revocations_append_only[\s\S]*before update or delete/i,
  );
  assert.match(
    schemaSql,
    /create or replace function callora\.admin_revoke_device\([\s\S]*?security definer[\s\S]*?set search_path = pg_catalog/i,
  );
  assert.match(schemaSql, /current_user_has_permission\('devices\.manage'\)/i);
  assert.match(
    schemaSql,
    /update callora\.device_credentials[\s\S]*lifecycle_state in \('pending', 'active'\)/i,
  );
  assert.match(schemaSql, /update callora\.device_consent_receipts[\s\S]*withdrawn_at is null/i);
  assert.match(schemaSql, /insert into callora\.audit_events/i);
  assert.match(schemaSql, /insert into callora\.outbox_events/i);
  assert.match(
    accessSql,
    /grant execute on function callora\.admin_revoke_device\([\s\S]*?\) to callora_api/i,
  );
  assert.doesNotMatch(
    accessSql,
    /grant[\s\S]{0,80}(?:insert|update|delete)[\s\S]{0,120}callora\.device_admin_revocations/i,
  );
});

test("development seed contains distinct tenant-owned call data", () => {
  const { seedSql } = readSchemaFiles();
  assert.match(seedSql, /aster-call-001/);
  assert.match(seedSql, /beacon-call-001/);
  assert.equal((seedSql.match(/app\.current_organization_id/g) ?? []).length, 2);
});
