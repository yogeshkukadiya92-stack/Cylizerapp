import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { packageRoot } from "../scripts/schema-contract.mjs";

const migrationPath = `${packageRoot}/migrations/0011_call_log_pii_encryption.sql`;
const rotationPath = `${packageRoot}/migrations/0012_call_log_blind_index_rotation.sql`;
const indexPath = `${packageRoot}/migrations/0013_call_log_pii_concurrent_indexes.sql`;
const backfillPath = `${packageRoot}/../../apps/api/src/tools/call-pii-backfill.ts`;
const accessPath = `${packageRoot}/access/roles.sql`;

test("call-log PII migration supports encrypted-only rows with strict envelope constraints", () => {
  assert.equal(existsSync(migrationPath), true, "missing migration 0011_call_log_pii_encryption.sql");
  const sql = readFileSync(migrationPath, "utf8");

  for (const column of [
    "pii_encryption_version",
    "pii_key_version",
    "phone_number_ciphertext",
    "phone_number_nonce",
    "phone_number_blind_index",
    "contact_name_ciphertext",
    "contact_name_nonce",
    "contact_name_blind_index",
    "pii_encrypted_at",
  ]) {
    assert.match(sql, new RegExp(`add column ${column}\\b`, "i"));
  }
  assert.match(sql, /alter column phone_number drop not null/i);
  assert.match(sql, /pii_encryption_version\s*=\s*1/i);
  assert.match(sql, /pii_key_version\s*>\s*0/i);
  assert.match(sql, /octet_length\(phone_number_nonce\)\s*=\s*12/i);
  assert.match(sql, /octet_length\(contact_name_nonce\)\s*=\s*12/i);
  assert.match(sql, /octet_length\(phone_number_blind_index\)\s*=\s*32/i);
  assert.match(sql, /octet_length\(contact_name_blind_index\)\s*=\s*32/i);
  assert.match(sql, /phone_number is null[\s\S]*contact_name is null/i);
  assert.match(sql, /phone_number_ciphertext is not null/i);
  assert.match(sql, /phone_number_ciphertext is null/i);
});

test("call-log PII migration enforces nonce uniqueness and replaces plaintext search indexes", () => {
  const sql = readFileSync(indexPath, "utf8");
  const foundation = readFileSync(migrationPath, "utf8");

  assert.match(sql, /drop index(?: concurrently)?(?: if exists)? callora\.call_logs_phone_started_keyset_idx/i);
  assert.match(sql, /create unique index(?: concurrently)? call_logs_phone_nonce_unique/i);
  assert.match(sql, /create unique index(?: concurrently)? call_logs_contact_nonce_unique/i);
  assert.match(sql, /create index(?: concurrently)? call_logs_phone_blind_started_keyset_idx/i);
  assert.match(sql, /create index(?: concurrently)? call_logs_contact_blind_started_keyset_idx/i);
  assert.match(foundation, /alter table callora\.call_logs enable row level security/i);
  assert.match(foundation, /alter table callora\.call_logs force row level security/i);
  assert.match(foundation, /revoke all on callora\.call_logs from public/i);
  assert.doesNotMatch(sql, /default\s+['"]?[A-Za-z0-9_-]{32,}/i);
});

test("backfill is tenant-scoped, bounded, clears plaintext atomically, and verifies authentication", () => {
  assert.equal(existsSync(backfillPath), true, "missing call-log PII backfill tool");
  const source = readFileSync(backfillPath, "utf8");
  const migration = readFileSync(migrationPath, "utf8");

  assert.match(source, /set_config\('app\.current_organization_id'/i);
  assert.match(source, /claim_call_pii_backfill_batch\(/i);
  assert.match(migration, /for update of call_log skip locked/i);
  assert.match(source, /backfill_call_pii_encrypted\(/i);
  assert.match(migration, /create or replace function callora\.backfill_call_pii_encrypted\(/i);
  assert.match(migration, /phone_number\s*=\s*null/i);
  assert.match(migration, /contact_name\s*=\s*null/i);
  assert.match(source, /decryptField\(/i);
  assert.match(source, /timingSafeEqual\(/i);
  assert.match(source, /postgresSslOptions\([\s\S]*requireVerified:\s*true/i);
  assert.match(source, /assertPostgresConnectionStringHasNoSslOverrides\(/i);
  assert.match(source, /assertDedicatedMigratorRole\(/i);
  assert.match(source, /with recursive current_capabilities[\s\S]*capability_role\.rolname = 'callora_pii_migrator'/i);
  assert.match(source, /has_admin_role_membership[\s\S]*admin_option/i);
  assert.match(source, /has_table_privilege\(current_user, 'callora\.call_logs', 'UPDATE'\)/i);
  assert.match(source, /has_any_column_privilege\(current_user, 'callora\.call_logs', 'INSERT'\)/i);
  assert.match(source, /has_any_column_privilege\(current_user, 'callora\.call_logs', 'UPDATE'\)/i);
  assert.match(source, /candidate\.rolname <> 'callora_pii_migrator'[\s\S]*pg_has_role\(current_user, candidate\.oid, 'member'\)/i);
  assert.match(source, /with recursive membership_closure[\s\S]*pg_catalog\.pg_auth_members/i);
  assert.match(source, /to_jsonb\(membership\)->>'admin_option'[\s\S]*to_jsonb\(membership\)->>'inherit_option'[\s\S]*to_jsonb\(membership\)->>'set_option'/i);
  assert.match(source, /login_role\.oid = database_definition\.datdba[\s\S]*directly_granted_role\.rolname in \('callora_call_writer', 'callora_pii_migrator'\)/i);
  assert.match(source, /join pg_catalog\.pg_roles as high_impact_role[\s\S]*high_impact_role\.rolname in \('callora_call_writer', 'callora_pii_migrator'\)[\s\S]*inherited\.roleid = high_impact_role\.oid/i);
  assert.match(source, /login_role\.rolcanlogin[\s\S]*not \([\s\S]*login_role\.oid = role\.oid[\s\S]*high_impact_role\.rolname = 'callora_pii_migrator'[\s\S]*\)/i);
  assert.match(source, /has_unsafe_login_high_impact_membership/i);
  assert.match(source, /callora_call_writer[\s\S]*callora_pii_migrator[\s\S]*high_impact_role\.rolcanlogin[\s\S]*high_impact_roles_are_safe/i);
  assert.match(source, /has_table_privilege\(current_user, 'callora\.call_logs', 'TRUNCATE'\)/i);
  assert.doesNotMatch(source, /pg_has_role\(login_role\.oid/i);
  assert.doesNotMatch(source, /left\(candidate\.rolname, 8\) = 'callora_'/i);
  assert.match(migration, /p_batch_size is null or p_batch_size < 1 or p_batch_size > 500/i);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:phone_number|contact_name|plaintext)/i);
});

test("blind-index versions support dual-read and bounded authenticated rotation", () => {
  assert.equal(existsSync(rotationPath), true, "missing migration 0012_call_log_blind_index_rotation.sql");
  const sql = readFileSync(rotationPath, "utf8");
  const source = readFileSync(backfillPath, "utf8");
  const crypto = readFileSync(`${packageRoot}/../../apps/api/src/call-pii-crypto.ts`, "utf8");

  assert.match(sql, /add column pii_blind_index_key_version integer/i);
  assert.match(sql, /set pii_blind_index_key_version = 1[\s\S]*pii_encryption_version is not null/i);
  assert.match(sql, /pii_encryption_version = 1 and pii_blind_index_key_version = 1/i);
  assert.match(sql, /pii_encryption_version = 2 and pii_blind_index_key_version > 0/i);
  assert.match(sql, /create trigger normalize_call_pii_blind_index_key_version[\s\S]*before insert or update/i);
  assert.match(sql, /pii_encryption_version is null[\s\S]*pii_blind_index_key_version := null/i);
  assert.match(sql, /pii_encryption_version = 1[\s\S]*pii_blind_index_key_version := 1/i);
  assert.doesNotMatch(sql, /alter column pii_blind_index_key_version set default/i);
  assert.match(sql, /create or replace function callora\.claim_call_pii_rotation_batch\(/i);
  assert.match(sql, /for update of call_log skip locked/i);
  assert.match(sql, /create or replace function callora\.rotate_call_pii_encrypted\(/i);
  assert.match(sql, /pii_blind_index_key_version = p_expected_blind_index_key_version/i);
  assert.match(source, /mode !== "backfill" && mode !== "rotate" && mode !== "verify"/i);
  assert.match(source, /claim_call_pii_rotation_batch\(/i);
  assert.match(source, /rotate_call_pii_encrypted\(/i);
  assert.match(crypto, /computeBlindIndexCandidates\(/i);
  assert.match(crypto, /CALL_PII_ROW_ID_KEY must be independent/i);
});

test("post-migration plaintext seed rows retain a NULL blind-index version", () => {
  const sql = readFileSync(rotationPath, "utf8");
  const seed = readFileSync(`${packageRoot}/seed/dev.sql`, "utf8");

  assert.match(seed, /insert into callora\.call_logs \([\s\S]*?phone_number,[\s\S]*?contact_name/i);
  assert.doesNotMatch(seed, /insert into callora\.call_logs \([\s\S]{0,500}pii_blind_index_key_version/i);
  assert.match(sql, /if new\.pii_encryption_version is null then[\s\S]*new\.pii_blind_index_key_version := null/i);
});

test("runtime mobile upserts accept encrypted envelopes and cannot write plaintext PII", () => {
  const sql = readFileSync(migrationPath, "utf8");

  assert.match(sql, /create or replace function callora\.upsert_mobile_call_encrypted\(/i);
  assert.match(sql, /phone_number_ciphertext[\s\S]*phone_number_nonce[\s\S]*phone_number_blind_index/i);
  assert.match(sql, /phone_number[\s\S]{0,120}contact_name[\s\S]{0,120}null[\s\S]{0,120}null/i);
  assert.doesNotMatch(sql, /upsert_mobile_call_encrypted\([\s\S]*?p_phone_number text/i);
  assert.match(sql, /upsert_mobile_call_encrypted\([\s\S]*?security definer[\s\S]*?set search_path = pg_catalog/i);
});

test("all runtime call-log writes are encrypted-function-only", () => {
  const sql = readFileSync(migrationPath, "utf8");
  const access = readFileSync(accessPath, "utf8");

  assert.match(sql, /create or replace function callora\.insert_manual_call_encrypted\(/i);
  assert.match(sql, /insert_manual_call_encrypted\([\s\S]*?security definer[\s\S]*?set search_path = pg_catalog/i);
  assert.doesNotMatch(sql, /insert_manual_call_encrypted\([\s\S]*?p_phone_number text/i);
  assert.match(access, /revoke insert, update, delete on callora\.call_logs from callora_api, callora_ingest/i);
  assert.match(
    access,
    /revoke truncate on callora\.call_logs from[\s\S]*callora_api[\s\S]*callora_ingest[\s\S]*callora_auditor[\s\S]*callora_worker[\s\S]*callora_call_writer[\s\S]*callora_pii_migrator/i,
  );
  assert.match(access, /assert_no_callora_call_log_truncate[\s\S]*has_table_privilege\([\s\S]*'TRUNCATE'/i);
  assert.match(access, /grant select, insert, update on callora\.call_logs to callora_call_writer/i);
  assert.match(access, /grant select on callora\.call_logs to callora_pii_migrator/i);
  assert.doesNotMatch(access, /grant (?:insert|update)[^;]*callora\.call_logs to callora_pii_migrator/i);
  assert.match(access, /alter function callora\.upsert_mobile_call_encrypted\([\s\S]*?owner to callora_call_writer/i);
  assert.match(access, /alter function callora\.insert_manual_call_encrypted\([\s\S]*?owner to callora_call_writer/i);
  assert.match(access, /alter function callora\.backfill_call_pii_encrypted\([\s\S]*?owner to callora_call_writer/i);
  assert.match(access, /alter function callora\.claim_call_pii_backfill_batch\([\s\S]*?owner to callora_call_writer/i);
  assert.match(access, /alter function callora\.claim_call_pii_rotation_batch\([\s\S]*?owner to callora_call_writer/i);
  assert.match(access, /alter function callora\.rotate_call_pii_encrypted\([\s\S]*?owner to callora_call_writer/i);
  assert.match(access, /revoke execute on function callora\.upsert_mobile_call_encrypted\([\s\S]*?smallint, integer, timestamptz[\s\S]*?from callora_api, callora_ingest/i);
  assert.match(access, /revoke execute on function callora\.insert_manual_call_encrypted\([\s\S]*?smallint, integer,[\s\S]*?from callora_api/i);
  assert.match(access, /revoke execute on function callora\.backfill_call_pii_encrypted\([\s\S]*?smallint, integer, bytea[\s\S]*?from callora_pii_migrator/i);
});
