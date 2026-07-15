import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findMissingForeignKeyIndexes,
  packageRoot,
  readSchemaFiles,
} from "../scripts/schema-contract.mjs";

const migrationSql = readFileSync(
  `${packageRoot}/migrations/0015_lead_operations.sql`,
  "utf8",
);
const accessSql = readFileSync(`${packageRoot}/access/roles.sql`, "utf8");
const tables = [
  "lead_assignment_rules",
  "lead_assignment_rule_employees",
  "lead_import_jobs",
  "lead_import_rows",
];

function tableBody(table) {
  const match = new RegExp(
    `create table callora\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    "i",
  ).exec(migrationSql);
  assert.ok(match, `missing create table callora.${table}`);
  return match[1];
}

test("Phase 4B state is tenant-owned, FORCE RLS protected, and closed to PUBLIC", () => {
  for (const table of tables) {
    assert.match(tableBody(table), /organization_id uuid not null/i);
    assert.match(migrationSql, new RegExp(`alter table callora\\.${table} enable row level security`, "i"));
    assert.match(migrationSql, new RegExp(`alter table callora\\.${table} force row level security`, "i"));
    assert.match(
      migrationSql,
      new RegExp(`create policy [a-z0-9_]+ on callora\\.${table}[\\s\\S]*?current_organization_id`, "i"),
    );
    assert.match(migrationSql, new RegExp(`revoke all on callora\\.${table} from public`, "i"));
  }
});

test("Phase 4B foreign keys and indexes remain tenant-first", () => {
  for (const table of tables) {
    for (const match of tableBody(table).matchAll(/foreign key\s*\(([^)]+)\)/gi)) {
      assert.equal(match[1].split(",")[0].trim().toLowerCase(), "organization_id");
    }
  }
  const { schemaSql } = readSchemaFiles();
  const missing = findMissingForeignKeyIndexes(schemaSql).filter(({ tableName }) => tables.includes(tableName));
  assert.deepEqual(missing, []);
});

test("import staging never has plaintext phone columns and invalid rows cannot retain ciphertext", () => {
  const rows = tableBody("lead_import_rows");
  assert.doesNotMatch(rows, /^\s*(?:phone_number|alternate_phone_number)\s+text\b/im);
  assert.match(rows, /phone_number_ciphertext bytea/i);
  assert.match(rows, /phone_number_nonce bytea/i);
  assert.match(rows, /phone_number_blind_index bytea/i);
  assert.match(rows, /lead_import_rows_phone_envelope_complete check[\s\S]*num_nonnulls[\s\S]*= 8/i);
  assert.match(
    rows,
    /decision = 'invalid'[\s\S]*jsonb_array_length\(issues\) > 0[\s\S]*phone_number_ciphertext is null/i,
  );
  assert.match(migrationSql, /lead_import_rows_phone_nonce_key/i);
  assert.match(migrationSql, /lead_import_rows_alternate_phone_nonce_key/i);
});

test("imports are bounded and resumable while assignment rules use strict optimistic versions", () => {
  const jobs = tableBody("lead_import_jobs");
  const rules = tableBody("lead_assignment_rules");
  const rows = tableBody("lead_import_rows");
  assert.match(jobs, /total_rows between 1 and 1000/i);
  assert.match(jobs, /status in \('preview_ready', 'processing', 'completed', 'interrupted', 'failed'\)/i);
  assert.match(jobs, /processed_rows = total_rows/i);
  assert.match(rules, /strategy in \('fixed_owner', 'round_robin'\)/i);
  assert.match(rules, /round_robin_cursor bigint not null default 0/i);
  assert.match(rows, /assignment_rule_version bigint/i);
  assert.match(
    rows,
    /assignment_rule_id is null and assignment_rule_version is null[\s\S]*assignment_rule_id is not null and assignment_rule_version > 0/i,
  );
  assert.match(
    migrationSql,
    /require_next_lead_assignment_rule_version[\s\S]*new\.version is distinct from old\.version \+ 1/i,
  );
});

test("Phase 4B grants are explicit and exclude ingest and worker mutation", () => {
  assert.match(
    accessSql,
    /grant select, insert, update on[\s\S]*callora\.lead_assignment_rules[\s\S]*callora\.lead_import_rows[\s\S]*to callora_api/i,
  );
  assert.match(
    accessSql,
    /grant select, insert, update, delete on callora\.lead_assignment_rule_employees to callora_api/i,
  );
  const grants = (accessSql.match(/grant[\s\S]*?;/gi) ?? []).filter((statement) =>
    tables.some((table) => statement.includes(`callora.${table}`)),
  );
  for (const role of ["callora_ingest", "callora_worker", "callora_call_writer", "callora_pii_migrator"]) {
    assert.ok(grants.every((statement) => !new RegExp(`\\b${role}\\b`, "i").test(statement)));
  }
});
