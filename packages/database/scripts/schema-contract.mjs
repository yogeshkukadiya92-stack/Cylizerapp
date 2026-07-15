import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const migrationsDirectory = join(packageRoot, "migrations");
export const seedFile = join(packageRoot, "seed", "dev.sql");

export const tenantTables = [
  "organizations",
  "users",
  "roles",
  "organization_memberships",
  "role_permissions",
  "membership_roles",
  "membership_team_scopes",
  "user_identities",
  "teams",
  "employees",
  "employee_devices",
  "sim_cards",
  "device_pairing_codes",
  "device_consent_receipts",
  "device_credentials",
  "device_credential_requests",
  "device_admin_revocations",
  "call_ingest_batches",
  "call_logs",
  "call_notes",
  "lead_statuses",
  "leads",
  "lead_notes",
  "lead_follow_ups",
  "lead_activities",
  "call_lead_links",
  "lead_assignment_rules",
  "lead_assignment_rule_employees",
  "lead_import_jobs",
  "lead_import_rows",
  "saved_report_views",
  "report_schedules",
  "notification_preferences",
  "report_export_jobs",
  "report_download_redemptions",
  "notification_deliveries",
  "in_app_notifications",
  "audit_events",
  "api_idempotency_keys",
  "outbox_events",
];

export const requiredTables = [
  "schema_migrations",
  ...tenantTables,
  "permission_definitions",
  "pairing_code_resolutions",
  "device_credential_resolutions",
  "device_credential_request_resolutions",
  "mobile_collection_policies",
  "mobile_rate_limits",
];

export function readSchemaFiles() {
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrations = migrationNames.map((name) => ({
    name,
    sql: readFileSync(join(migrationsDirectory, name), "utf8"),
  }));
  return {
    migrationNames,
    migrations,
    schemaSql: migrations.map(({ sql }) => sql).join("\n"),
    seedSql: readFileSync(seedFile, "utf8"),
  };
}

function hasPattern(sql, pattern) {
  return pattern.test(sql);
}

function normalizeColumns(columnList) {
  return columnList.split(",").map((column) =>
    column
      .trim()
      .replace(/\s+(?:asc|desc)(?:\s+nulls\s+(?:first|last))?$/i, "")
      .toLowerCase(),
  );
}

export function findMissingForeignKeyIndexes(schemaSql) {
  const indexesByTable = new Map();
  const foreignKeys = [];
  const tablePattern = /create table callora\.(\w+)\s*\(([\s\S]*?)\n\);/gi;

  for (const tableMatch of schemaSql.matchAll(tablePattern)) {
    const [, tableName, tableBody] = tableMatch;
    const tableIndexes = indexesByTable.get(tableName) ?? [];

    for (const keyMatch of tableBody.matchAll(/(?:primary key|unique)\s*\(([^)]+)\)/gi)) {
      tableIndexes.push(normalizeColumns(keyMatch[1]));
    }
    for (const foreignKeyMatch of tableBody.matchAll(/foreign key\s*\(([^)]+)\)/gi)) {
      foreignKeys.push({ tableName, columns: normalizeColumns(foreignKeyMatch[1]) });
    }
    indexesByTable.set(tableName, tableIndexes);
  }

  const alterTableStatements = schemaSql.match(/alter table callora\.\w+[\s\S]*?;/gi) ?? [];
  const alteredForeignKeyPattern =
    /^alter table callora\.(\w+)[\s\S]*?foreign key\s*\(([^)]+)\)/i;
  for (const statement of alterTableStatements) {
    const foreignKeyMatch = alteredForeignKeyPattern.exec(statement);
    if (foreignKeyMatch === null) continue;
    foreignKeys.push({
      tableName: foreignKeyMatch[1],
      columns: normalizeColumns(foreignKeyMatch[2]),
    });
  }

  const indexPattern = /create(?: unique)? index(?: concurrently)?\s+\w+\s+on callora\.(\w+)\s*\(([\s\S]*?)\)\s*(?:include\s*\(|where\b|;)/gi;
  for (const indexMatch of schemaSql.matchAll(indexPattern)) {
    const [, tableName, columnList] = indexMatch;
    const tableIndexes = indexesByTable.get(tableName) ?? [];
    tableIndexes.push(normalizeColumns(columnList));
    indexesByTable.set(tableName, tableIndexes);
  }

  return foreignKeys.filter(({ tableName, columns }) => {
    const candidateIndexes = indexesByTable.get(tableName) ?? [];
    return !candidateIndexes.some((indexColumns) =>
      columns.every((column, index) => indexColumns[index] === column),
    );
  });
}

export function collectSchemaDiagnostics() {
  const { migrationNames, schemaSql, seedSql } = readSchemaFiles();
  const errors = [];

  if (migrationNames.length < 9) {
    errors.push("Expected at least nine ordered migrations.");
  }

  migrationNames.forEach((name, index) => {
    const expectedPrefix = String(index + 1).padStart(4, "0");
    if (!name.startsWith(`${expectedPrefix}_`)) {
      errors.push(`Migration ${name} is out of sequence; expected ${expectedPrefix}.`);
    }
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) {
      errors.push(`Migration ${name} does not use ordered snake_case naming.`);
    }
  });

  for (const table of requiredTables) {
    if (!hasPattern(schemaSql, new RegExp(`create table(?: if not exists)? callora\\.${table}\\b`, "i"))) {
      errors.push(`Missing required table callora.${table}.`);
    }
  }

  if (/\bvarchar\s*\(/i.test(schemaSql)) {
    errors.push("Use text plus constraints instead of varchar(n).");
  }
  if (/\b(?:small)?serial\b/i.test(schemaSql)) {
    errors.push("Serial identifiers are forbidden in the schema.");
  }
  if (/\btimestamp\s+(?!with\s+time\s+zone)/i.test(schemaSql)) {
    errors.push("Timestamp columns must be timezone-aware (timestamptz).");
  }

  for (const table of tenantTables) {
    const escapedTable = table.replaceAll("_", "_");
    if (!hasPattern(schemaSql, new RegExp(`alter table callora\\.${escapedTable} enable row level security`, "i"))) {
      errors.push(`RLS is not enabled on callora.${table}.`);
    }
    if (!hasPattern(schemaSql, new RegExp(`alter table callora\\.${escapedTable} force row level security`, "i"))) {
      errors.push(`RLS is not forced on callora.${table}.`);
    }
    if (!hasPattern(schemaSql, new RegExp(`create policy [a-z0-9_]+ on callora\\.${escapedTable}`, "i"))) {
      errors.push(`No tenant policy exists for callora.${table}.`);
    }
  }

  const requiredPatterns = [
    [
      /current_setting\('app\.current_organization_id',\s*true\)/i,
      "The RLS organization context helper is missing.",
    ],
    [
      /constraint call_logs_device_external_key unique\s*\(organization_id, device_id, external_id\)/i,
      "The call-log idempotency constraint is missing.",
    ],
    [
      /constraint call_ingest_batches_device_batch_key unique\s*\(organization_id, device_id, batch_id\)/i,
      "The ingest-batch idempotency constraint is missing.",
    ],
    [
      /on conflict on constraint call_logs_device_external_key do nothing/i,
      "Atomic call upsert does not target the idempotency constraint.",
    ],
    [
      /create or replace function callora\.upsert_mobile_call/i,
      "The atomic mobile call ingest function is missing.",
    ],
    [
      /call_logs_tenant_started_keyset_idx[\s\S]*organization_id, started_at desc, id desc/i,
      "The tenant call-log keyset index is missing.",
    ],
    [
      /call_logs_employee_started_keyset_idx[\s\S]*organization_id, employee_id, started_at desc, id desc/i,
      "The employee call-log keyset index is missing.",
    ],
    [
      /where disposition in \('missed', 'rejected', 'busy'\)/i,
      "The attention-queue partial index is missing.",
    ],
    [
      /before update or delete on callora\.audit_events/i,
      "Audit events are not protected as append-only.",
    ],
    [
      /constraint user_identities_oidc_key unique\s*\(organization_id, issuer, subject\)/i,
      "The tenant-scoped OIDC identity key is missing.",
    ],
    [
      /constraint api_idempotency_keys_tenant_scope_key[\s\S]*unique\s*\(organization_id, scope, idempotency_key\)/i,
      "The API idempotency ledger key is missing.",
    ],
    [
      /outbox_events_ready_idx[\s\S]*organization_id, available_at, id[\s\S]*where delivered_at is null/i,
      "The outbox ready-queue partial index is missing.",
    ],
    [
      /create or replace function callora\.resolve_pairing_code_organization\(p_code_hash bytea\)/i,
      "The narrow pairing-code organization resolver is missing.",
    ],
    [
      /create or replace function callora\.resolve_device_credential\([\s\S]*p_token_hash bytea,[\s\S]*p_credential_type text/i,
      "The narrow device-credential resolver is missing.",
    ],
    [
      /constraint device_credentials_token_hash_length[\s\S]*octet_length\(token_hash\) = 32/i,
      "Device credentials are not stored as fixed-length hashes.",
    ],
    [
      /create unique index device_credentials_active_session_key[\s\S]*credential_type = 'session'[\s\S]*revoked_at is null/i,
      "A device can have multiple active session credentials.",
    ],
    [
      /create unique index device_consent_receipts_active_device_key[\s\S]*withdrawn_at is null/i,
      "A device can have multiple active consent receipts.",
    ],
    [
      /add column response_body jsonb/i,
      "Ingest batches cannot persist a stable retry response.",
    ],
    [
      /create table callora\.device_consent_receipts[\s\S]*permissions jsonb not null/i,
      "Consent receipts do not preserve the accepted permission snapshot.",
    ],
    [
      /constraint device_consent_receipts_permissions_complete[\s\S]*permissions \?& array[\s\S]*backgroundExecution/i,
      "Consent permission snapshots are not structurally complete.",
    ],
    [
      /constraint device_consent_receipts_employee_device_fk[\s\S]*foreign key \(organization_id, employee_id, device_id\)/i,
      "Consent receipts do not enforce the employee-device binding.",
    ],
    [
      /constraint device_credentials_employee_device_fk[\s\S]*foreign key \(organization_id, employee_id, device_id\)/i,
      "Device credentials do not enforce the employee-device binding.",
    ],
    [
      /constraint device_credentials_rotated_from_device_fk[\s\S]*foreign key \(organization_id, device_id, rotated_from_credential_id\)/i,
      "Session rotation ancestry can cross devices.",
    ],
    [
      /constraint device_credentials_ttl_valid[\s\S]*interval '10 minutes'[\s\S]*interval '7 days'/i,
      "Mobile credential maximum lifetimes are not enforced by the schema.",
    ],
    [
      /alter table callora\.employee_devices[\s\S]*add column last_heartbeat_at timestamptz[\s\S]*add column battery_percent smallint[\s\S]*add column pending_call_count integer not null default 0/i,
      "Employee devices do not persist the mobile heartbeat health snapshot.",
    ],
    [
      /create unique index call_logs_manual_external_key[\s\S]*source = 'manual'[\s\S]*device_id is null/i,
      "Device-less manual calls do not have a stable external identity.",
    ],
    [
      /add column ingest_fingerprint text/i,
      "Call payload fingerprints are not persisted for conflict detection.",
    ],
    [
      /add column actor_device_id uuid/i,
      "Audit events cannot attribute a device actor.",
    ],
    [
      /add constraint audit_events_action_format\s+check \(action ~ '\^\[a-z\]\[a-z_\]\*\(\\\.\[a-z\]\[a-z_\]\*\)\+\$'\)/i,
      "Audit action segments do not allow production underscore names.",
    ],
    [
      /constraint outbox_events_event_type_format[\s\S]*event_type ~ '\^\[a-z\]\[a-z0-9_\]\*\(\\\.\[a-z\]\[a-z0-9_\]\*\)\+\$'/i,
      "Outbox event types do not accept the emitted event namespace format.",
    ],
    [
      /create table callora\.mobile_collection_policies[\s\S]*content_hash bytea not null/i,
      "The authoritative mobile collection policy registry is missing.",
    ],
    [
      /foreign key \(policy_id, policy_content_hash\)[\s\S]*references callora\.mobile_collection_policies \(id, content_hash\)/i,
      "Consent receipts are not bound to an exact policy content hash.",
    ],
    [
      /create trigger device_consent_receipts_guard_mutation[\s\S]*before update or delete/i,
      "Consent history is not protected as append-only with one-way withdrawal.",
    ],
    [
      /create unique index device_credentials_pending_session_key[\s\S]*lifecycle_state = 'pending'/i,
      "A device can have multiple pending session rotations.",
    ],
    [
      /create or replace function callora\.resolve_device_credential_replay\([\s\S]*p_request_fingerprint bytea/i,
      "Consumed or revoked credential replay is not bound to a request fingerprint.",
    ],
    [
      /create or replace function callora\.confirm_device_session_rotation\(/i,
      "Two-phase session rotation confirmation is missing.",
    ],
    [
      /create or replace function callora\.consume_mobile_rate_limit\(/i,
      "The shared atomic mobile rate limiter is missing.",
    ],
    [
      /create or replace function callora\.reset_mobile_rate_limit\(/i,
      "The mobile rate limiter cannot be reset after success.",
    ],
    [
      /create trigger mobile_collection_policies_prevent_overlap[\s\S]*before insert or update/i,
      "Mobile collection policy effective windows can overlap.",
    ],
    [
      /create or replace function callora\.device_has_current_collection_consent\([\s\S]*current_policy\.id = receipt\.policy_id[\s\S]*current_policy\.content_hash = receipt\.policy_content_hash/i,
      "Mobile authorization cannot prove consent to the exact current policy.",
    ],
    [
      /create table callora\.membership_team_scopes[\s\S]*primary key \(organization_id, membership_id, team_id\)[\s\S]*foreign key \(organization_id, membership_id\)[\s\S]*foreign key \(organization_id, team_id\)/i,
      "Memberships cannot be restricted to exact same-tenant team scopes.",
    ],
    [
      /create table callora\.leads[\s\S]*phone_encryption_version smallint not null default 2[\s\S]*phone_number_ciphertext bytea not null[\s\S]*phone_number_nonce bytea not null[\s\S]*phone_number_blind_index bytea not null/i,
      "Lead phone numbers are not stored as encrypted, blind-indexed envelopes.",
    ],
    [
      /create trigger leads_require_next_version[\s\S]*before update on callora\.leads[\s\S]*require_next_lead_version/i,
      "Lead optimistic-concurrency updates are not guarded by a version trigger.",
    ],
    [
      /create trigger lead_activities_append_only[\s\S]*before update or delete on callora\.lead_activities/i,
      "Lead activity history is not immutable.",
    ],
    [
      /create unique index call_lead_links_one_active_call_key[\s\S]*organization_id, call_log_id[\s\S]*where unlinked_at is null/i,
      "A call can be actively linked to multiple leads.",
    ],
    [
      /constraint call_lead_links_call_log_fk foreign key \(organization_id, call_log_id\)[\s\S]*constraint call_lead_links_lead_fk foreign key \(organization_id, lead_id\)/i,
      "Call-to-lead history does not enforce same-tenant references.",
    ],
    [
      /constraint lead_follow_ups_state_complete check[\s\S]*status = 'pending'[\s\S]*status = 'completed'[\s\S]*status = 'cancelled'/i,
      "Lead follow-up lifecycle states are not structurally complete.",
    ],
  ];

  for (const [pattern, message] of requiredPatterns) {
    if (!hasPattern(schemaSql, pattern)) {
      errors.push(message);
    }
  }

  for (const missingIndex of findMissingForeignKeyIndexes(schemaSql)) {
    errors.push(
      `Foreign key on callora.${missingIndex.tableName} (${missingIndex.columns.join(", ")}) ` +
        "does not have a matching left-prefix index.",
    );
  }

  const seededTenantIds = [
    "10000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000001",
  ];
  for (const tenantId of seededTenantIds) {
    if (!seedSql.includes(tenantId)) {
      errors.push(`Development seed is missing tenant ${tenantId}.`);
    }
  }
  for (const subject of ["oidc-aster-owner", "oidc-beacon-owner"]) {
    if (!seedSql.includes(subject)) {
      errors.push(`Development seed is missing external identity ${subject}.`);
    }
  }
  const contextSwitchCount = seedSql.match(/app\.current_organization_id/g)?.length ?? 0;
  if (contextSwitchCount < 2) {
    errors.push("Development seed must enter two separate tenant contexts.");
  }

  return {
    errors,
    facts: {
      migrationCount: migrationNames.length,
      tenantTableCount: tenantTables.length,
      seededTenantCount: seededTenantIds.length,
    },
  };
}
