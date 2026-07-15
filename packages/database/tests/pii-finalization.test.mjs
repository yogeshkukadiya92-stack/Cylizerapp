import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { packageRoot } from "../scripts/schema-contract.mjs";

test("PII finalization is fail-closed, validated, bounded, and closes legacy overloads", () => {
  const sql = readFileSync(`${packageRoot}/operations/finalize-call-pii.sql`, "utf8");

  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('callora\.call-pii-finalize'/i);
  assert.match(sql, /set local lock_timeout = '5s'/i);
  assert.match(sql, /set local statement_timeout = '30min'/i);
  assert.match(sql, /database_definition\.datdba[\s\S]*owner_role\.rolname = current_user[\s\S]*owner_role\.rolcreaterole/i);
  assert.match(sql, /unsafe_high_impact_roles[\s\S]*capability_role\.rolcanlogin[\s\S]*capability_role\.rolbypassrls/i);
  assert.match(sql, /with recursive membership_closure[\s\S]*pg_catalog\.pg_auth_members/i);
  assert.match(sql, /to_jsonb\(membership\)->>'admin_option'[\s\S]*to_jsonb\(membership\)->>'inherit_option'[\s\S]*to_jsonb\(membership\)->>'set_option'/i);
  assert.match(sql, /login_role\.oid = database_definition\.datdba[\s\S]*ADMIN-only/i);
  assert.match(sql, /login_role\.rolcanlogin[\s\S]*'callora_call_writer', 'callora_pii_migrator'/i);
  assert.doesNotMatch(sql, /pg_has_role\(login_role\.oid/i);
  assert.match(sql, /add constraint call_logs_pii_encrypted_only check/i);
  assert.match(sql, /pii_encryption_version = 2/i);
  assert.match(sql, /pii_blind_index_key_version is not null/i);
  assert.match(sql, /phone_number is null[\s\S]*contact_name is null/i);
  assert.match(sql, /validate constraint call_logs_pii_encrypted_only/i);
  assert.match(sql, /conname = 'call_logs_pii_encrypted_only'[\s\S]*convalidated/i);
  assert.equal((sql.match(/revoke execute on function callora\./gi) ?? []).length, 3);
  assert.match(sql, /enable_callora_writer_finalization[\s\S]*admin true, inherit true, set true/i);
  assert.match(sql, /disable_callora_writer_finalization[\s\S]*admin true, inherit false, set false[\s\S]*revoke %I from %I/i);
  assert.match(sql, /writer or PII migrator capability remains after finalization cleanup/i);
});
