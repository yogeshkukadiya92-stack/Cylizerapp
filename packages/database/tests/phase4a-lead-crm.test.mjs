import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findMissingForeignKeyIndexes,
  packageRoot,
  readSchemaFiles,
} from "../scripts/schema-contract.mjs";

const migrationSql = readFileSync(
  `${packageRoot}/migrations/0014_lead_crm_foundation.sql`,
  "utf8",
);
const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
const seedSql = readFileSync(`${packageRoot}/seed/dev.sql`, "utf8");

const crmTenantTables = [
  "membership_team_scopes",
  "lead_statuses",
  "leads",
  "lead_notes",
  "lead_follow_ups",
  "lead_activities",
  "call_lead_links",
];

function tableBody(table) {
  const match = new RegExp(
    `create table callora\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    "i",
  ).exec(migrationSql);
  assert.ok(match, `missing create table callora.${table}`);
  return match[1];
}

test("Phase 4A CRM tables are tenant-owned, FORCE RLS protected, and closed to PUBLIC", () => {
  for (const table of crmTenantTables) {
    assert.match(tableBody(table), /organization_id uuid not null/i);
    assert.match(
      migrationSql,
      new RegExp(`alter table callora\\.${table} enable row level security`, "i"),
    );
    assert.match(
      migrationSql,
      new RegExp(`alter table callora\\.${table} force row level security`, "i"),
    );
    assert.match(
      migrationSql,
      new RegExp(
        `create policy [a-z0-9_]+ on callora\\.${table}[\\s\\S]*?using \\(organization_id = callora\\.current_organization_id\\(\\)\\)[\\s\\S]*?with check \\(organization_id = callora\\.current_organization_id\\(\\)\\)`,
        "i",
      ),
    );
    assert.match(
      migrationSql,
      new RegExp(`revoke all on callora\\.${table} from public`, "i"),
    );
  }
});

test("every Phase 4A foreign key and secondary index starts with organization_id", () => {
  for (const table of crmTenantTables) {
    for (const match of tableBody(table).matchAll(/foreign key\s*\(([^)]+)\)/gi)) {
      assert.equal(
        match[1].split(",")[0].trim().toLowerCase(),
        "organization_id",
        `${table} has a non-tenant-first foreign key`,
      );
    }
  }

  const secondaryIndexes = migrationSql.matchAll(
    /create(?: unique)? index\s+\w+\s+on callora\.(\w+)\s*\(\s*([^,\s)]+)/gi,
  );
  for (const [, table, firstColumn] of secondaryIndexes) {
    if (!crmTenantTables.includes(table)) continue;
    assert.equal(firstColumn.toLowerCase(), "organization_id", `${table} has a non-tenant-first index`);
  }

  const { schemaSql } = readSchemaFiles();
  const missingCrmIndexes = findMissingForeignKeyIndexes(schemaSql).filter(({ tableName }) =>
    crmTenantTables.includes(tableName),
  );
  assert.deepEqual(missingCrmIndexes, []);
});

test("membership scopes and lead assignments enforce exact same-tenant team ownership", () => {
  assert.match(
    tableBody("membership_team_scopes"),
    /foreign key \(organization_id, membership_id\)[\s\S]*references callora\.organization_memberships \(organization_id, id\)/i,
  );
  assert.match(
    tableBody("membership_team_scopes"),
    /foreign key \(organization_id, team_id\)[\s\S]*references callora\.teams \(organization_id, id\)/i,
  );
  assert.match(
    migrationSql,
    /employees_organization_team_id_key[\s\S]*unique \(organization_id, team_id, id\)/i,
  );
  assert.match(
    tableBody("leads"),
    /foreign key \([\s\n]*organization_id, team_id, assigned_employee_id[\s\n]*\)[\s\S]*references callora\.employees \(organization_id, team_id, id\)/i,
  );
  assert.match(
    tableBody("lead_follow_ups"),
    /foreign key \(organization_id, team_id, lead_id\)[\s\S]*references callora\.leads \(organization_id, team_id, id\)/i,
  );
});

test("lead PII uses complete encrypted envelopes without plaintext phone columns", () => {
  const leads = tableBody("leads");
  for (const column of [
    "phone_number_ciphertext bytea not null",
    "phone_number_nonce bytea not null",
    "phone_number_blind_index bytea not null",
    "alternate_phone_number_ciphertext bytea",
    "alternate_phone_number_nonce bytea",
    "alternate_phone_number_blind_index bytea",
  ]) {
    assert.match(leads, new RegExp(column, "i"));
  }
  assert.match(leads, /phone_encryption_version smallint not null default 2/i);
  assert.match(leads, /octet_length\(phone_number_nonce\) = 12/i);
  assert.match(leads, /octet_length\(phone_number_blind_index\) = 32/i);
  assert.match(leads, /leads_alternate_phone_envelope_complete check/i);
  assert.match(
    leads,
    /num_nonnulls\([\s\S]*alternate_phone_encryption_version[\s\S]*alternate_phone_encrypted_at[\s\S]*\) = 8/i,
  );
  assert.match(leads, /alternate_phone_encryption_version = 2/i);
  assert.match(leads, /octet_length\(alternate_phone_number_nonce\) = 12/i);
  assert.match(leads, /octet_length\(alternate_phone_number_blind_index\) = 32/i);
  assert.doesNotMatch(leads, /^\s*(?:phone_number|alternate_phone_number)\s+text\b/im);
});

test("lead extension fields persist tag arrays and custom-field objects", () => {
  const leads = tableBody("leads");
  assert.match(leads, /tag_ids jsonb not null default '\[\]'::jsonb/i);
  assert.match(leads, /custom_fields jsonb not null default '\{\}'::jsonb/i);
  assert.match(leads, /jsonb_typeof\(tag_ids\) = 'array'/i);
  assert.match(leads, /jsonb_typeof\(custom_fields\) = 'object'/i);
});

test("lead and follow-up writes use strict optimistic versions and valid lifecycle states", () => {
  for (const table of ["leads", "lead_follow_ups"]) {
    assert.match(tableBody(table), /version bigint not null default 1/i);
  }
  assert.match(
    migrationSql,
    /require_next_lead_version[\s\S]*new\.version is distinct from old\.version \+ 1[\s\S]*errcode = '40001'/i,
  );
  assert.match(
    migrationSql,
    /require_next_lead_follow_up_version[\s\S]*new\.version is distinct from old\.version \+ 1[\s\S]*errcode = '40001'/i,
  );
  assert.match(
    migrationSql,
    /create trigger leads_require_next_version[\s\S]*before update on callora\.leads/i,
  );
  assert.match(
    migrationSql,
    /create trigger lead_follow_ups_require_next_version[\s\S]*before update on callora\.lead_follow_ups/i,
  );
  assert.match(tableBody("leads"), /converted_at is null or lost_at is null/i);
  assert.match(
    tableBody("lead_follow_ups"),
    /lead_follow_ups_state_complete check[\s\S]*status = 'pending'[\s\S]*status = 'completed'[\s\S]*status = 'cancelled'/i,
  );
});

test("lead activities and manual call corrections retain immutable history", () => {
  const activities = tableBody("lead_activities");
  for (const kind of ["updated", "unassigned", "tag_added", "tag_removed"]) {
    assert.match(activities, new RegExp(`'${kind}'`, "i"));
  }
  assert.match(
    migrationSql,
    /create trigger lead_activities_append_only[\s\S]*before update or delete on callora\.lead_activities/i,
  );
  assert.match(
    tableBody("call_lead_links"),
    /foreign key \(organization_id, call_log_id\)[\s\S]*foreign key \(organization_id, lead_id\)/i,
  );
  assert.match(
    migrationSql,
    /create unique index call_lead_links_one_active_call_key[\s\S]*where unlinked_at is null/i,
  );
  assert.match(
    migrationSql,
    /create trigger call_lead_links_guard_history[\s\S]*before update or delete on callora\.call_lead_links/i,
  );
  assert.match(migrationSql, /one-way audited unlink/i);
});

test("CRM grants are explicit and exclude ingest, worker, writer, and migrator roles", () => {
  assert.match(
    accessSql,
    /revoke all on[\s\S]*callora\.membership_team_scopes[\s\S]*callora\.call_lead_links[\s\S]*from[\s\S]*callora_api[\s\S]*callora_ingest[\s\S]*callora_auditor[\s\S]*callora_worker[\s\S]*callora_call_writer[\s\S]*callora_pii_migrator/i,
  );
  assert.match(
    accessSql,
    /grant select, insert, update on[\s\S]*callora\.lead_statuses[\s\S]*callora\.call_lead_links[\s\S]*to callora_api/i,
  );
  assert.match(accessSql, /grant select, insert on callora\.lead_activities to callora_api/i);

  const crmGrantStatements = (accessSql.match(/grant[\s\S]*?;/gi) ?? []).filter((statement) =>
    crmTenantTables.some((table) => statement.includes(`callora.${table}`)),
  );
  for (const role of [
    "callora_ingest",
    "callora_worker",
    "callora_call_writer",
    "callora_pii_migrator",
  ]) {
    assert.ok(
      crmGrantStatements.every((statement) => !new RegExp(`\\b${role}\\b`, "i").test(statement)),
      `${role} must not receive CRM table grants`,
    );
  }
  assert.ok(
    crmGrantStatements
      .filter((statement) => statement.includes("callora.lead_activities"))
      .every((statement) => !/\b(?:update|delete|truncate)\b/i.test(statement)),
    "lead activities must remain append-only at the ACL layer",
  );
});

test("development seed contains isolated Phase 4A fixtures for both tenants", () => {
  for (const table of crmTenantTables) {
    assert.equal(
      (seedSql.match(new RegExp(`insert into callora\\.${table}\\b`, "gi")) ?? []).length,
      2,
      `expected one ${table} fixture per tenant`,
    );
  }
  for (const leadId of [
    "10000000-0000-4000-8000-000000000e01",
    "20000000-0000-4000-8000-000000000e01",
  ]) {
    assert.ok(seedSql.includes(leadId));
  }
  assert.match(seedSql, /alternate_phone_number_ciphertext/i);
  assert.match(seedSql, /tag_ids, custom_fields/i);
  assert.doesNotMatch(migrationSql, /create table callora\.[a-z0-9_]*import[a-z0-9_]*/i);
});
