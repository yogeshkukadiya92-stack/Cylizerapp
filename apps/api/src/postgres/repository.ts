import { randomUUID } from "node:crypto";
import {
  isIsoDateTime,
  isLeadSource,
  isRecord,
  type CallLogSyncItemResult,
  CallLog,
  CallLogSyncResult,
  CreateEmployeeInput,
  DevicePermissions,
  Employee,
  EmployeeDevice,
  FollowUp,
  Lead,
  LeadActivity,
  LeadDetail,
  LeadListItem,
  LeadNote,
  LeadQueueSummary,
  LeadStatus,
  LeadAssignmentRule,
  LeadImportPreview,
  LeadImportJob,
  LeadImportResult,
  LeadAssignmentDryRun,
  ApplyLeadAssignmentRulesResult,
  CorrectCallLeadLinkResult,
  MobileLeadUpdateReceipt,
  LeadReport,
  ReportAutomationSnapshot,
  SavedReportView,
  ReportSchedule,
  NotificationPreference,
  ReportExportJob,
  InAppNotification,
  NotificationInbox,
  LeadSource,
  OrganizationId,
  SystemRoleKey,
} from "@callora/contracts";
import type {
  ActorContext,
  AdminRevokeDeviceResult,
  AuditEvent,
  CallCursor,
  CallListFilter,
  DeviceRegistration,
  EmployeeCursor,
  EmployeeListFilter,
  LeadAccessScope,
  LeadCursor,
  LeadListFilter,
  LeadListResult,
  CreateLeadOptions,
  UpdateLeadOptions,
  CreateLeadNoteOptions,
  CreateLeadFollowUpOptions,
  CompleteLeadFollowUpOptions,
  PreviewLeadImportOptions,
  LeadImportAccessOptions,
  CommitLeadImportOptions,
  CreateLeadAssignmentRuleOptions,
  UpdateLeadAssignmentRuleOptions,
  LeadAssignmentOperationOptions,
  ApplyLeadAssignmentRulesOptions,
  CorrectCallLeadLinkOptions,
  MobileLeadUpdateOptions,
  LeadReportOptions,
  IngestCallResult,
  MobileActivationPayload,
  MobilePolicy,
  MobileCallBatchOptions,
  MobileCallBatchResult,
  MobileDeviceContext,
  MobileHeartbeatPayload,
  MobileHeartbeatResult,
  MobileReconsentPayload,
  NewDeviceCredential,
  ActivateMobileDeviceResult,
  ReconsentMobileDeviceResult,
  PrepareMobileSessionRotationResult,
  ConfirmMobileSessionRotationResult,
  RevokeMobileSessionResult,
  PairingCodeRecord,
  PairingRedemptionResult,
  SimulatedCallInput,
} from "../domain.js";
import {
  CallPiiConfigurationError,
  type CallPiiCrypto,
  type EncryptedCallPiiField,
} from "../call-pii-crypto.js";
import type { CalloraRepository, IdGenerator } from "../repository.js";
import {
  badRequest as domainBadRequest,
  conflict as domainConflict,
  consentRequired as domainConsentRequired,
  forbidden as domainForbidden,
} from "../errors.js";
import {
  makeActor,
  mapAuditEvent,
  mapCall,
  mapDevice,
  mapEmployee,
  mapLead,
  mapLeadActivity,
  mapLeadFollowUp,
  mapLeadNote,
  mapLeadStatus,
  mapOutboxEvent,
  mapPairingCode,
  mapRole,
  type DbRow,
} from "./mappers.js";
import type {
  ExternalIdentity,
  OutboxEventRecord,
  PgClientLike,
  PgPoolLike,
  PostgresRepositoryOptions,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanonicalUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export class UuidIdGenerator implements IdGenerator {
  next(_prefix: string): string {
    return randomUUID();
  }
}

const ACTOR_SQL = `
select
  organization.id as organization_id,
  organization.name as organization_name,
  organization.slug as organization_slug,
  organization.status as organization_status,
  organization.plan as organization_plan,
  organization.industry,
  organization.logo_url,
  organization.support_email,
  organization.primary_phone,
  organization.time_zone,
  organization.default_country_code,
  organization.working_week_days,
  organization.working_day_starts_at,
  organization.working_day_ends_at,
  organization.recording_retention_days,
  organization.call_log_retention_days,
  organization.require_recording_consent,
  organization.mask_phone_numbers_for_restricted_users,
  organization.trial_ends_at,
  organization.created_at as organization_created_at,
  organization.updated_at as organization_updated_at,
  app_user.id as user_id,
  app_user.email as user_email,
  app_user.display_name as user_display_name,
  app_user.phone_number,
  app_user.avatar_url,
  app_user.status as user_status,
  app_user.last_signed_in_at,
  app_user.created_at as user_created_at,
  app_user.updated_at as user_updated_at,
  (
    select employee.id
    from callora.employees as employee
    where employee.organization_id = organization.id
      and employee.linked_user_id = app_user.id
    order by employee.id
    limit 1
  ) as linked_employee_id,
  coalesce(
    array(
      select team.name
      from callora.membership_team_scopes as scope
      join callora.teams as team
        on team.organization_id = scope.organization_id
       and team.id = scope.team_id
      where scope.organization_id = membership.organization_id
        and scope.membership_id = membership.id
      order by team.name, team.id
    ),
    '{}'::text[]
  ) as lead_team_names
from callora.organizations as organization
join callora.users as app_user
  on app_user.organization_id = organization.id
join callora.organization_memberships as membership
  on membership.organization_id = app_user.organization_id
 and membership.user_id = app_user.id
where organization.id = $1::uuid
  and app_user.id = $2::uuid
  and organization.status in ('trial', 'active')
  and app_user.status = 'active'
  and membership.status = 'active'
limit 1`;

const ROLES_SQL = `
select
  role.id,
  role.organization_id,
  role.name,
  role.description,
  role.system_key,
  role.is_editable,
  role.created_at,
  role.updated_at,
  coalesce(
    array_agg(role_permission.permission_key order by role_permission.permission_key)
      filter (where role_permission.permission_key is not null),
    '{}'::text[]
  ) as permissions
from callora.organization_memberships as membership
join callora.membership_roles as membership_role
  on membership_role.organization_id = membership.organization_id
 and membership_role.membership_id = membership.id
join callora.roles as role
  on role.organization_id = membership_role.organization_id
 and role.id = membership_role.role_id
left join callora.role_permissions as role_permission
  on role_permission.organization_id = role.organization_id
 and role_permission.role_id = role.id
where membership.organization_id = $1::uuid
  and membership.user_id = $2::uuid
  and membership.status = 'active'
group by role.id
order by role.system_key nulls last, role.id`;

const EMPLOYEE_COLUMNS = `
  employee.id,
  employee.organization_id,
  employee.linked_user_id,
  employee.manager_employee_id,
  employee.employee_code,
  employee.display_name,
  employee.email,
  employee.primary_phone,
  employee.job_title,
  employee.status,
  employee.working_time_zone,
  employee.working_week_days,
  employee.working_day_starts_at,
  employee.working_day_ends_at,
  employee.created_at,
  employee.updated_at,
  team.name as team_name,
  coalesce(
    array(
      select device.id
      from callora.employee_devices as device
      where device.organization_id = employee.organization_id
        and device.employee_id = employee.id
      order by device.id
    ),
    '{}'::uuid[]
  ) as device_ids`;

const DEVICE_COLUMNS = `
  device.*,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', sim.id,
          'device_id', sim.device_id,
          'slot_index', sim.slot_index,
          'carrier_name', sim.carrier_name,
          'phone_number', sim.phone_number,
          'subscription_id', sim.subscription_id,
          'is_enabled', sim.is_enabled
        ) order by sim.slot_index, sim.id
      )
      from callora.sim_cards as sim
      where sim.organization_id = device.organization_id
        and sim.device_id = device.id
    ),
    '[]'::jsonb
  ) as sim_cards`;

const PAIRING_COLUMNS = `
  pairing.id,
  pairing.organization_id,
  pairing.employee_id,
  encode(pairing.code_hash, 'hex') as code_hash,
  pairing.code_hint,
  pairing.created_by_user_id,
  pairing.collection_mode,
  pairing.expires_at,
  pairing.consumed_at,
  pairing.revoked_at,
  pairing.created_at`;

const CALL_COLUMNS = `
  call_log.id,
  call_log.organization_id,
  call_log.employee_id,
  call_log.device_id,
  call_log.sim_card_id,
  call_log.external_id,
  call_log.source,
  call_log.direction,
  call_log.disposition,
  call_log.phone_number,
  call_log.contact_name,
  call_log.pii_encryption_version,
  call_log.pii_key_version,
  call_log.pii_blind_index_key_version,
  call_log.phone_number_ciphertext,
  call_log.phone_number_nonce,
  call_log.phone_number_blind_index,
  call_log.contact_name_ciphertext,
  call_log.contact_name_nonce,
  call_log.contact_name_blind_index,
  call_log.pii_encrypted_at,
  call_log.is_internal,
  call_log.started_at,
  call_log.answered_at,
  call_log.ended_at,
  call_log.duration_seconds,
  call_log.ring_duration_seconds,
  call_log.is_within_working_hours,
  call_log.recording_status,
  call_log.is_pinned,
  call_log.ingest_fingerprint,
  call_log.created_at,
  call_log.updated_at,
  (
    select count(*)::integer
    from callora.call_notes as note
    where note.organization_id = call_log.organization_id
      and note.call_log_id = call_log.id
  ) as note_count`;

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 60_000) {
    throw new Error(`${name} must be an integer between 1 and 60000 milliseconds`);
  }
  return resolved;
}

function firstRow(rows: DbRow[], message: string): DbRow {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}

function assertTrustedUuid(value: string, name: string): void {
  if (!isCanonicalUuid(value)) {
    throw new Error(`${name} must be a canonical UUID`);
  }
}

function postgresConstraint(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && typeof candidate.constraint === "string"
    ? candidate.constraint
    : undefined;
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function leadScopePredicate(
  scope: LeadAccessScope,
  values: unknown[],
  leadAlias = "lead",
): string {
  if (scope.kind === "organization") return "true";
  if (scope.kind === "assigned") {
    if (!isCanonicalUuid(scope.employeeId)) return "false";
    values.push(scope.employeeId);
    return `${leadAlias}.assigned_employee_id = $${values.length}::uuid`;
  }
  if (scope.teamNames.length === 0) return "false";
  values.push(scope.teamNames);
  return `exists (
    select 1
    from callora.teams as scoped_team
    where scoped_team.organization_id = ${leadAlias}.organization_id
      and scoped_team.id = ${leadAlias}.team_id
      and scoped_team.name = any($${values.length}::text[])
  )`;
}

/**
 * Import jobs contain encrypted staged PII, so creator ownership alone is not
 * enough: non-organization actors must still cover every staged team now.
 */
function leadImportScopePredicate(
  scope: LeadAccessScope,
  values: unknown[],
  jobAlias = "job",
): string {
  if (scope.kind === "organization") return "true";
  if (scope.kind === "teams") {
    if (scope.teamNames.length === 0) return "false";
    values.push(scope.teamNames);
    return `not exists (
      select 1
      from callora.lead_import_rows as scoped_row
      left join callora.teams as scoped_team
        on scoped_team.organization_id = scoped_row.organization_id
       and scoped_team.id = scoped_row.team_id
      where scoped_row.organization_id = ${jobAlias}.organization_id
        and scoped_row.job_id = ${jobAlias}.id
        and scoped_row.team_id is not null
        and (scoped_team.id is null or scoped_team.name <> all($${values.length}::text[]))
    )`;
  }
  if (!isCanonicalUuid(scope.employeeId)) return "false";
  values.push(scope.employeeId);
  return `exists (
    select 1
    from callora.employees as scoped_employee
    where scoped_employee.organization_id = ${jobAlias}.organization_id
      and scoped_employee.id = $${values.length}::uuid
      and scoped_employee.status = 'active'
      and scoped_employee.team_id is not null
      and not exists (
        select 1
        from callora.lead_import_rows as scoped_row
        where scoped_row.organization_id = ${jobAlias}.organization_id
          and scoped_row.job_id = ${jobAlias}.id
          and scoped_row.team_id is not null
          and scoped_row.team_id <> scoped_employee.team_id
      )
  )`;
}

function leadImportAccessPredicate(
  scope: LeadAccessScope,
  actorUserId: string,
  values: unknown[],
  jobAlias = "job",
): string {
  if (scope.kind === "organization") return "true";
  values.push(actorUserId);
  const creatorParameter = values.length;
  const scopePredicate = leadImportScopePredicate(scope, values, jobAlias);
  return `(${jobAlias}.created_by_user_id = $${creatorParameter}::uuid and ${scopePredicate})`;
}

interface LeadPhoneLookupCandidate {
  field: "phone" | "alternate";
  keyVersion: number;
  blindIndex: Buffer;
}

function leadPhoneLookupCandidates(
  crypto: CallPiiCrypto,
  organizationId: OrganizationId,
  normalizedPhones: string[],
): LeadPhoneLookupCandidate[] {
  return [...new Set(normalizedPhones)].flatMap((phoneNumber) => [
    ...crypto.computeBlindIndexCandidates(
      { organizationId, field: "phone_number" }, phoneNumber,
    ).map((candidate) => ({ ...candidate, field: "phone" as const })),
    ...crypto.computeBlindIndexCandidates(
      { organizationId, field: "alternate_phone_number" }, phoneNumber,
    ).map((candidate) => ({ ...candidate, field: "alternate" as const })),
  ]);
}

function employeeScopePredicate(
  scope: LeadAccessScope,
  values: unknown[],
  employeeAlias = "employee",
): string {
  if (scope.kind === "organization") return "true";
  if (scope.kind === "assigned") {
    if (!isCanonicalUuid(scope.employeeId)) return "false";
    values.push(scope.employeeId);
    return `${employeeAlias}.id = $${values.length}::uuid`;
  }
  if (scope.teamNames.length === 0) return "false";
  values.push(scope.teamNames);
  return `exists (
    select 1
    from callora.teams as scoped_team
    where scoped_team.organization_id = ${employeeAlias}.organization_id
      and scoped_team.id = ${employeeAlias}.team_id
      and scoped_team.name = any($${values.length}::text[])
  )`;
}

function rowObject(value: unknown): DbRow | undefined {
  if (typeof value === "string") {
    try {
      return rowObject(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as DbRow
    : undefined;
}

function escapedLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function unreturnedMissedCallSql(leadAlias: string): string {
  return `(
    select count(*)::integer
    from callora.call_lead_links as missed_link
    join callora.call_logs as missed_call
      on missed_call.organization_id = missed_link.organization_id
     and missed_call.id = missed_link.call_log_id
    where missed_link.organization_id = ${leadAlias}.organization_id
      and missed_link.lead_id = ${leadAlias}.id
      and missed_link.unlinked_at is null
      and missed_call.direction = 'incoming'
      and missed_call.disposition = 'missed'
      and not exists (
        select 1
        from callora.call_lead_links as return_link
        join callora.call_logs as return_call
          on return_call.organization_id = return_link.organization_id
         and return_call.id = return_link.call_log_id
        where return_link.organization_id = missed_link.organization_id
          and return_link.lead_id = missed_link.lead_id
          and return_link.unlinked_at is null
          and return_call.direction = 'outgoing'
          and return_call.disposition = 'answered'
          and return_call.started_at > missed_call.started_at
      )
  )`;
}

function leadItemColumns(atParameter: string): string {
  return `
    lead.*,
    to_jsonb(lead_status) as lead_status_record,
    case when assigned_employee.id is null then null else jsonb_build_object(
      'id', assigned_employee.id,
      'display_name', assigned_employee.display_name,
      'team_name', assigned_team.name
    ) end as assigned_employee_record,
    (
      select to_jsonb(next_follow_up)
      from callora.lead_follow_ups as next_follow_up
      where next_follow_up.organization_id = lead.organization_id
        and next_follow_up.lead_id = lead.id
        and next_follow_up.status = 'pending'
      order by next_follow_up.due_at, next_follow_up.id
      limit 1
    ) as next_follow_up_record,
    (
      select count(*)::integer
      from callora.lead_follow_ups as overdue_follow_up
      where overdue_follow_up.organization_id = lead.organization_id
        and overdue_follow_up.lead_id = lead.id
        and overdue_follow_up.status = 'pending'
        and overdue_follow_up.due_at < ${atParameter}::timestamptz
    ) as overdue_follow_up_count,
    ${unreturnedMissedCallSql("lead")} as unreturned_missed_call_count`;
}

function permissionsFromRow(row: DbRow): DevicePermissions {
  return {
    callLog: String(row.call_log_permission) as DevicePermissions["callLog"],
    phoneState: String(row.phone_state_permission) as DevicePermissions["phoneState"],
    contacts: String(row.contacts_permission) as DevicePermissions["contacts"],
    notifications: String(row.notifications_permission) as DevicePermissions["notifications"],
    recordingFiles: String(row.recording_files_permission) as DevicePermissions["recordingFiles"],
    backgroundExecution: String(row.background_execution_permission) as DevicePermissions["backgroundExecution"],
  };
}

function parseBatchResponse(value: unknown): CallLogSyncResult | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(candidate) || typeof candidate.batchId !== "string" ||
    !isIsoDateTime(candidate.acceptedAt) || typeof candidate.nextCursor !== "string" ||
    !Array.isArray(candidate.items) || !isIsoDateTime(candidate.serverTime)) return undefined;
  const items: CallLogSyncItemResult[] = [];
  for (const item of candidate.items) {
    if (!isRecord(item) || typeof item.localId !== "string" ||
      !["created", "updated", "duplicate", "rejected"].includes(String(item.outcome))) return undefined;
    items.push({
      localId: item.localId,
      outcome: item.outcome as CallLogSyncItemResult["outcome"],
      ...(typeof item.callLogId === "string" ? { callLogId: item.callLogId } : {}),
      ...(typeof item.code === "string" ? { code: item.code } : {}),
      ...(typeof item.message === "string" ? { message: item.message } : {}),
      ...(typeof item.retryable === "boolean" ? { retryable: item.retryable } : {}),
    });
  }
  return {
    batchId: candidate.batchId,
    acceptedAt: candidate.acceptedAt,
    nextCursor: candidate.nextCursor,
    items,
    serverTime: candidate.serverTime,
  };
}

function parseStoredObject<T>(value: unknown): T | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return undefined;
    }
  }
  return isRecord(candidate) ? candidate as T : undefined;
}

function parseStoredArray<T>(value: unknown): T[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(candidate) ? candidate as T[] : [];
}

function mobilePolicyFromRow(row: DbRow): MobilePolicy {
  const disclosures = Array.isArray(row.disclosures) && row.disclosures.every((value) => typeof value === "string")
    ? row.disclosures as string[]
    : undefined;
  if (!disclosures) throw new Error("PostgreSQL returned invalid mobile policy disclosures");
  const policy: MobilePolicy = {
    id: String(row.id),
    contentHash: String(row.content_hash),
    policyVersion: String(row.policy_version),
    disclosureVersion: String(row.disclosure_version),
    collectionMode: String(row.collection_mode) as MobilePolicy["collectionMode"],
    purpose: "call_metadata",
    title: String(row.title),
    summary: String(row.summary),
    disclosures,
    effectiveAt: new Date(String(row.effective_at)).toISOString(),
  };
  if (!isCanonicalUuid(policy.id) || !/^[0-9a-f]{64}$/.test(policy.contentHash) ||
    !["android_call_log", "synthetic_demo"].includes(policy.collectionMode)) {
    throw new Error("PostgreSQL returned an invalid mobile policy");
  }
  return policy;
}

export class PostgresCalloraRepository implements CalloraRepository {
  readonly mobileTransitionEvidenceAtomic = true;
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly callPiiCrypto: CallPiiCrypto | undefined;

  constructor(
    private readonly pool: PgPoolLike,
    options: PostgresRepositoryOptions = {},
  ) {
    this.statementTimeoutMs = positiveTimeout(options.statementTimeoutMs, 5_000, "statementTimeoutMs");
    this.lockTimeoutMs = positiveTimeout(options.lockTimeoutMs, 2_000, "lockTimeoutMs");
    this.callPiiCrypto = options.callPiiCrypto;
  }

  private requireCallPiiCrypto(): CallPiiCrypto {
    if (!this.callPiiCrypto) {
      throw new CallPiiConfigurationError("PostgreSQL call-log access requires an explicit PII keyring");
    }
    return this.callPiiCrypto;
  }

  private mapCallRow(row: DbRow): CallLog {
    if (row.pii_encryption_version === null || row.pii_encryption_version === undefined) {
      if (this.callPiiCrypto) {
        throw new Error("Legacy plaintext call-log PII remains; complete and verify the tenant backfill");
      }
      return mapCall(row);
    }
    const crypto = this.requireCallPiiCrypto();
    const organizationId = typeof row.organization_id === "string" ? row.organization_id : "";
    const rowId = typeof row.id === "string" ? row.id : "";
    const formatVersion = Number(row.pii_encryption_version);
    const keyVersion = Number(row.pii_key_version);
    const blindIndexKeyVersion = Number(row.pii_blind_index_key_version);
    const encryptedField = (field: "phone_number" | "contact_name"): EncryptedCallPiiField | null => {
      const ciphertext = row[`${field}_ciphertext`];
      const nonce = row[`${field}_nonce`];
      const blindIndex = row[`${field}_blind_index`];
      if (field === "contact_name" && ciphertext === null && nonce === null && blindIndex === null) return null;
      if (!Buffer.isBuffer(ciphertext) || !Buffer.isBuffer(nonce) || !Buffer.isBuffer(blindIndex)) {
        throw new Error("PostgreSQL returned an incomplete encrypted call-log envelope");
      }
      return { formatVersion, keyVersion, blindIndexKeyVersion, ciphertext, nonce, blindIndex };
    };
    const phone = encryptedField("phone_number");
    if (!phone) throw new Error("PostgreSQL returned a call without encrypted phone data");
    const contact = encryptedField("contact_name");
    return mapCall({
      ...row,
      phone_number: crypto.decryptField({ organizationId, rowId, field: "phone_number" }, phone),
      contact_name: contact === null
        ? null
        : crypto.decryptField({ organizationId, rowId, field: "contact_name" }, contact),
    });
  }

  private mapLeadRow(row: DbRow): Lead {
    const crypto = this.requireCallPiiCrypto();
    const organizationId = typeof row.organization_id === "string" ? row.organization_id : "";
    const rowId = typeof row.id === "string" ? row.id : "";
    const envelope = (alternate: boolean): EncryptedCallPiiField | undefined => {
      const formatVersion = row[alternate ? "alternate_phone_encryption_version" : "phone_encryption_version"];
      const keyVersion = row[alternate ? "alternate_phone_key_version" : "phone_key_version"];
      const blindIndexKeyVersion = row[
        alternate ? "alternate_phone_blind_index_key_version" : "phone_blind_index_key_version"
      ];
      const ciphertext = row[alternate ? "alternate_phone_number_ciphertext" : "phone_number_ciphertext"];
      const nonce = row[alternate ? "alternate_phone_number_nonce" : "phone_number_nonce"];
      const blindIndex = row[alternate ? "alternate_phone_number_blind_index" : "phone_number_blind_index"];
      if (alternate && formatVersion === null && keyVersion === null && blindIndexKeyVersion === null &&
        ciphertext === null && nonce === null && blindIndex === null) return undefined;
      const numericFormat = Number(formatVersion);
      const numericKey = Number(keyVersion);
      const numericBlindKey = Number(blindIndexKeyVersion);
      if (!Number.isSafeInteger(numericFormat) || !Number.isSafeInteger(numericKey) ||
        !Number.isSafeInteger(numericBlindKey) || !Buffer.isBuffer(ciphertext) ||
        !Buffer.isBuffer(nonce) || !Buffer.isBuffer(blindIndex)) {
        throw new Error("PostgreSQL returned an incomplete encrypted lead-phone envelope");
      }
      return {
        formatVersion: numericFormat,
        keyVersion: numericKey,
        blindIndexKeyVersion: numericBlindKey,
        ciphertext,
        nonce,
        blindIndex,
      };
    };
    const phone = envelope(false);
    if (!phone) throw new Error("PostgreSQL returned a lead without encrypted phone data");
    const alternate = envelope(true);
    return mapLead({
      ...row,
      phone_number: crypto.decryptField({ organizationId, rowId, field: "phone_number" }, phone),
      alternate_phone_number: alternate === undefined
        ? null
        : crypto.decryptField({ organizationId, rowId, field: "alternate_phone_number" }, alternate),
    });
  }

  private mapLeadItemRow(row: DbRow, at: string): LeadListItem {
    const statusRow = rowObject(row.lead_status_record);
    if (!statusRow) throw new Error("PostgreSQL returned a lead without its status");
    const assignedRow = rowObject(row.assigned_employee_record);
    const nextFollowUpRow = rowObject(row.next_follow_up_record);
    return {
      lead: this.mapLeadRow(row),
      status: mapLeadStatus(statusRow),
      ...(assignedRow === undefined ? {} : {
        assignedEmployee: {
          id: String(assignedRow.id),
          displayName: String(assignedRow.display_name),
          ...(typeof assignedRow.team_name === "string" ? { team: assignedRow.team_name } : {}),
        },
      }),
      ...(nextFollowUpRow === undefined ? {} : { nextFollowUp: mapLeadFollowUp(nextFollowUpRow, at) }),
      overdueFollowUpCount: Number(row.overdue_follow_up_count ?? 0),
      unreturnedMissedCallCount: Number(row.unreturned_missed_call_count ?? 0),
    };
  }

  private mapLeadImportJob(row: DbRow): LeadImportJob {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      fileName: String(row.file_name),
      status: String(row.status) as LeadImportJob["status"],
      totalRows: Number(row.total_rows),
      validRows: Number(row.valid_rows),
      duplicateRows: Number(row.duplicate_rows),
      errorRows: Number(row.error_rows),
      importedRows: Number(row.imported_rows),
      processedRows: Number(row.processed_rows),
      createdByUserId: String(row.created_by_user_id),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
      ...(row.completed_at === null || row.completed_at === undefined
        ? {} : { completedAt: new Date(String(row.completed_at)).toISOString() }),
      ...(typeof row.last_error === "string" ? { lastError: row.last_error } : {}),
      errorDownloadAvailable: Number(row.error_rows) + Number(row.duplicate_rows) > 0,
    };
  }

  private mapLeadImportRow(row: DbRow): LeadImportPreview["rows"][number] {
    const crypto = this.requireCallPiiCrypto();
    const organizationId = String(row.organization_id);
    const rowId = String(row.id);
    const decrypt = (alternate: boolean): string | undefined => {
      const ciphertext = row[alternate ? "alternate_phone_number_ciphertext" : "phone_number_ciphertext"];
      if (ciphertext === null || ciphertext === undefined) return undefined;
      const nonce = row[alternate ? "alternate_phone_number_nonce" : "phone_number_nonce"];
      const blindIndex = row[alternate ? "alternate_phone_number_blind_index" : "phone_number_blind_index"];
      if (!Buffer.isBuffer(ciphertext) || !Buffer.isBuffer(nonce) || !Buffer.isBuffer(blindIndex)) {
        throw new Error("PostgreSQL returned an incomplete encrypted import-phone envelope");
      }
      return crypto.decryptField({
        organizationId,
        rowId,
        field: alternate ? "alternate_phone_number" : "phone_number",
      }, {
        formatVersion: Number(row[alternate ? "alternate_phone_encryption_version" : "phone_encryption_version"]),
        keyVersion: Number(row[alternate ? "alternate_phone_key_version" : "phone_key_version"]),
        blindIndexKeyVersion: Number(row[
          alternate ? "alternate_phone_blind_index_key_version" : "phone_blind_index_key_version"
        ]),
        ciphertext,
        nonce,
        blindIndex,
      });
    };
    const phoneNumber = decrypt(false) ?? "";
    const alternatePhoneNumber = decrypt(true);
    const input: LeadImportPreview["rows"][number]["input"] = {
      firstName: typeof row.first_name === "string" ? row.first_name : "",
      phoneNumber,
      ...(typeof row.last_name === "string" ? { lastName: row.last_name } : {}),
      ...(typeof row.company_name === "string" ? { companyName: row.company_name } : {}),
      ...(alternatePhoneNumber === undefined ? {} : { alternatePhoneNumber }),
      ...(typeof row.email === "string" ? { email: row.email } : {}),
      ...(typeof row.source === "string" ? { source: row.source as LeadSource } : {}),
      ...(typeof row.status_name === "string" ? { statusName: row.status_name } : {}),
      ...(typeof row.assigned_employee_code === "string"
        ? { assignedEmployeeCode: row.assigned_employee_code } : {}),
      ...(parseStoredArray<string>(row.tag_names).length > 0
        ? { tagNames: parseStoredArray<string>(row.tag_names) } : {}),
      ...(Object.keys(parseStoredObject<Record<string, unknown>>(row.custom_fields) ?? {}).length > 0
        ? { customFields: parseStoredObject<Record<string, never>>(row.custom_fields) ?? {} } : {}),
    };
    return {
      rowNumber: Number(row.row_number),
      decision: String(row.decision) as LeadImportPreview["rows"][number]["decision"],
      input,
      issues: parseStoredArray<LeadImportPreview["rows"][number]["issues"][number]>(row.issues),
      ...(typeof row.duplicate_lead_id === "string" ? { duplicateLeadId: row.duplicate_lead_id } : {}),
      ...(typeof row.proposed_assigned_employee_id === "string"
        ? { proposedAssignedEmployeeId: row.proposed_assigned_employee_id } : {}),
    };
  }

  private mapLeadAssignmentRule(row: DbRow): LeadAssignmentRule {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      name: String(row.name),
      priority: Number(row.priority),
      active: row.active === true,
      conditions: parseStoredObject<LeadAssignmentRule["conditions"]>(row.conditions) ?? {},
      strategy: String(row.strategy) as LeadAssignmentRule["strategy"],
      employeeIds: parseStoredArray<string>(row.employee_ids),
      version: Number(row.version),
      createdByUserId: String(row.created_by_user_id),
      updatedByUserId: String(row.updated_by_user_id),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  private async findLeadImportWithClient(
    client: PgClientLike,
    options: LeadImportAccessOptions & { jobId: string },
  ): Promise<LeadImportPreview | undefined> {
    if (!isCanonicalUuid(options.jobId)) return undefined;
    const accessValues: unknown[] = [options.organizationId, options.jobId];
    const access = leadImportAccessPredicate(options.scope, options.actorUserId, accessValues, "job");
    const result = await client.query<DbRow>(`
      select job.*
      from callora.lead_import_jobs as job
      where job.organization_id = $1::uuid and job.id = $2::uuid
        and ${access}
      limit 1
    `, accessValues);
    const jobRow = result.rows[0];
    if (!jobRow) return undefined;
    const rows = await client.query<DbRow>(`
      select *
      from callora.lead_import_rows
      where organization_id = $1::uuid and job_id = $2::uuid
      order by row_number
    `, [options.organizationId, options.jobId]);
    return {
      job: this.mapLeadImportJob(jobRow),
      rows: rows.rows.map((row) => this.mapLeadImportRow(row)),
      replayed: false,
    };
  }

  private async leadAssignmentPlanWithClient(
    client: PgClientLike,
    organizationId: OrganizationId,
    scope: LeadAccessScope,
    lockLeads: boolean,
  ): Promise<{
    dryRun: LeadAssignmentDryRun;
    assignments: Array<{ leadId: string; version: number; ruleId: string; employeeId: string }>;
    ruleAdvances: Map<string, number>;
  }> {
    const ruleValues: unknown[] = [organizationId];
    const ruleScope = scope.kind === "organization" ? "true"
      : scope.kind === "teams"
        ? (() => { ruleValues.push(scope.teamNames); return `exists (
            select 1 from callora.teams scoped_team
            where scoped_team.organization_id = rule.organization_id
              and scoped_team.id = rule.team_id and scoped_team.name = any($2::text[])
          )`; })()
        : (() => { ruleValues.push(scope.employeeId); return `exists (
            select 1 from callora.employees scoped_employee
            where scoped_employee.organization_id = rule.organization_id
              and scoped_employee.team_id = rule.team_id and scoped_employee.id = $2::uuid
          )`; })();
    // Rules are locked before members/employees, matching the update path's
    // lock order. This prevents a disable/member rewrite from racing an apply.
    const ruleRows = await client.query<DbRow>(`
      select rule.*
      from callora.lead_assignment_rules as rule
      where rule.organization_id = $1::uuid and rule.active and ${ruleScope}
      order by rule.priority, rule.id
      ${lockLeads ? "for update of rule" : ""}
    `, ruleValues);
    const ruleIds = ruleRows.rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string");
    const memberRows = ruleIds.length === 0 ? { rows: [] as DbRow[] } : await client.query<DbRow>(`
      select member.rule_id, member.employee_id, member.position,
        member.team_id as member_team_id, employee.team_id as employee_team_id,
        employee.status as employee_status
      from callora.lead_assignment_rule_employees as member
      join callora.employees as employee
        on employee.organization_id = member.organization_id
       and employee.id = member.employee_id
      where member.organization_id = $1::uuid and member.rule_id = any($2::uuid[])
      order by member.rule_id, member.position, member.employee_id
      ${lockLeads ? "for update of member, employee" : ""}
    `, [organizationId, ruleIds]);
    const rules = ruleRows.rows.flatMap((row) => {
      const members = memberRows.rows.filter((member) => member.rule_id === row.id);
      if (members.length === 0 || members.some((member) =>
        member.employee_status !== "active" || member.member_team_id !== row.team_id ||
        member.employee_team_id !== row.team_id || typeof member.employee_id !== "string")) return [];
      row.employee_ids = members.map((member) => String(member.employee_id));
      return [{ row, rule: this.mapLeadAssignmentRule(row) }];
    });
    const leadValues: unknown[] = [organizationId];
    const leadScope = leadScopePredicate(scope, leadValues);
    const leads = await client.query<DbRow>(`
      select lead.id, lead.team_id, lead.status_id, lead.source, lead.temperature, lead.version
      from callora.leads as lead
      where lead.organization_id = $1::uuid and lead.assigned_employee_id is null
        and lead.archived_at is null and ${leadScope}
      order by lead.created_at, lead.id
      ${lockLeads ? "for update" : ""}
    `, leadValues);
    const cursors = new Map(rules.map(({ row, rule }) => [rule.id, Number(row.round_robin_cursor ?? 0)]));
    const ruleAdvances = new Map<string, number>();
    const distribution = new Map<string, number>();
    const assignments: Array<{ leadId: string; version: number; ruleId: string; employeeId: string }> = [];
    let unmatchedLeads = 0;
    for (const lead of leads.rows) {
      const matched = rules.find(({ row, rule }) => {
        if (row.team_id !== lead.team_id) return false;
        if (rule.conditions.sources?.length && !rule.conditions.sources.includes(String(lead.source) as LeadSource)) return false;
        if (rule.conditions.temperatures?.length &&
          (typeof lead.temperature !== "string" || !rule.conditions.temperatures.includes(lead.temperature as Lead["temperature"] & string))) return false;
        if (rule.conditions.statusIds?.length && !rule.conditions.statusIds.includes(String(lead.status_id))) return false;
        return true;
      });
      if (!matched || matched.rule.employeeIds.length === 0) {
        unmatchedLeads += 1;
        continue;
      }
      const cursor = cursors.get(matched.rule.id) ?? 0;
      const employeeId = matched.rule.employeeIds[
        matched.rule.strategy === "fixed_owner" ? 0 : cursor % matched.rule.employeeIds.length
      ];
      if (!employeeId) {
        unmatchedLeads += 1;
        continue;
      }
      if (matched.rule.strategy === "round_robin") cursors.set(matched.rule.id, cursor + 1);
      ruleAdvances.set(matched.rule.id, (ruleAdvances.get(matched.rule.id) ?? 0) +
        (matched.rule.strategy === "round_robin" ? 1 : 0));
      distribution.set(employeeId, (distribution.get(employeeId) ?? 0) + 1);
      assignments.push({
        leadId: String(lead.id), version: Number(lead.version), ruleId: matched.rule.id, employeeId,
      });
    }
    return {
      dryRun: {
        matchedLeads: assignments.length,
        unmatchedLeads,
        distribution: [...distribution].map(([employeeId, leadCount]) => ({ employeeId, leadCount })),
      },
      assignments,
      ruleAdvances,
    };
  }

  private async findLeadDetailWithClient(
    client: PgClientLike,
    organizationId: OrganizationId,
    scope: LeadAccessScope,
    leadId: string,
    at: string,
  ): Promise<LeadDetail | undefined> {
    if (!isCanonicalUuid(leadId)) return undefined;
    const itemValues: unknown[] = [organizationId, at, leadId];
    const scopeSql = leadScopePredicate(scope, itemValues);
    const itemResult = await client.query<DbRow>(`
      select ${leadItemColumns("$2")}
      from callora.leads as lead
      join callora.lead_statuses as lead_status
        on lead_status.organization_id = lead.organization_id
       and lead_status.id = lead.status_id
      left join callora.employees as assigned_employee
        on assigned_employee.organization_id = lead.organization_id
       and assigned_employee.id = lead.assigned_employee_id
      left join callora.teams as assigned_team
        on assigned_team.organization_id = assigned_employee.organization_id
       and assigned_team.id = assigned_employee.team_id
      where lead.organization_id = $1::uuid
        and lead.id = $3::uuid
        and ${scopeSql}
      limit 1
    `, itemValues);
    const itemRow = itemResult.rows[0];
    if (!itemRow) return undefined;
    const [notes, followUps, activities] = await Promise.all([
      client.query<DbRow>(`
        select *
        from callora.lead_notes
        where organization_id = $1::uuid and lead_id = $2::uuid
        order by created_at desc, id desc
      `, [organizationId, leadId]),
      client.query<DbRow>(`
        select *
        from callora.lead_follow_ups
        where organization_id = $1::uuid and lead_id = $2::uuid
        order by due_at, id
      `, [organizationId, leadId]),
      client.query<DbRow>(`
        select *
        from callora.lead_activities
        where organization_id = $1::uuid and lead_id = $2::uuid
        order by occurred_at desc, id desc
      `, [organizationId, leadId]),
    ]);
    return {
      item: this.mapLeadItemRow(itemRow, at),
      notes: notes.rows.map(mapLeadNote),
      followUps: followUps.rows.map((row) => mapLeadFollowUp(row, at)),
      activities: activities.rows.map(mapLeadActivity),
    };
  }

  private async withTenant<T>(
    organizationId: OrganizationId,
    userId: string | undefined,
    work: (client: PgClientLike) => Promise<T>,
  ): Promise<T> {
    assertTrustedUuid(organizationId, "organizationId");
    if (userId !== undefined) assertTrustedUuid(userId, "userId");
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query("begin");
      began = true;
      await client.query(
        "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
        [`${this.statementTimeoutMs}ms`, `${this.lockTimeoutMs}ms`],
      );
      await client.query(
        "select set_config('app.current_organization_id', $1, true), set_config('app.current_user_id', $2, true)",
        [organizationId, userId ?? ""],
      );
      const result = await work(client);
      await client.query("commit");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("rollback");
        } catch {
          // Preserve the original database error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadActor(
    client: PgClientLike,
    organizationId: OrganizationId,
    userId: string,
  ): Promise<ActorContext | undefined> {
    const actorResult = await client.query<DbRow>(ACTOR_SQL, [organizationId, userId]);
    const actorRow = actorResult.rows[0];
    if (!actorRow) return undefined;
    const roleResult = await client.query<DbRow>(ROLES_SQL, [organizationId, userId]);
    return makeActor(actorRow, roleResult.rows.map(mapRole));
  }

  private async setCurrentUser(client: PgClientLike, userId: string): Promise<void> {
    assertTrustedUuid(userId, "userId");
    await client.query("select set_config('app.current_user_id', $1, true)", [userId]);
  }

  private async findEmployeeWithClient(
    client: PgClientLike,
    organizationId: OrganizationId,
    employeeId: string,
  ): Promise<Employee | undefined> {
    const result = await client.query<DbRow>(`
      select ${EMPLOYEE_COLUMNS}
      from callora.employees as employee
      left join callora.teams as team
        on team.organization_id = employee.organization_id
       and team.id = employee.team_id
      where employee.organization_id = $1::uuid
        and employee.id = $2::uuid
      limit 1
    `, [organizationId, employeeId]);
    return result.rows[0] ? mapEmployee(result.rows[0]) : undefined;
  }

  private async findDeviceWithClient(
    client: PgClientLike,
    organizationId: OrganizationId,
    deviceId: string,
  ): Promise<EmployeeDevice | undefined> {
    const result = await client.query<DbRow>(`
      select ${DEVICE_COLUMNS}
      from callora.employee_devices as device
      where device.organization_id = $1::uuid
        and device.id = $2::uuid
      limit 1
    `, [organizationId, deviceId]);
    return result.rows[0] ? mapDevice(result.rows[0]) : undefined;
  }

  private async findCallWithClient(
    client: PgClientLike,
    organizationId: OrganizationId,
    callId: string,
  ): Promise<CallLog | undefined> {
    const result = await client.query<DbRow>(`
      select ${CALL_COLUMNS}
      from callora.call_logs as call_log
      where call_log.organization_id = $1::uuid
        and call_log.id = $2::uuid
      limit 1
    `, [organizationId, callId]);
    return result.rows[0] ? this.mapCallRow(result.rows[0]) : undefined;
  }

  /** Link an external call only when one same-team lead has the exact encrypted-phone index. */
  private async linkCallToUniqueLeadWithClient(
    client: PgClientLike,
    organizationId: OrganizationId,
    callId: string,
    at: string,
  ): Promise<void> {
    const candidates = await client.query<DbRow>(`
      select
        lead.id as lead_id,
        call_log.direction,
        call_log.disposition,
        call_log.started_at
      from callora.call_logs as call_log
      join callora.employees as caller
        on caller.organization_id = call_log.organization_id
       and caller.id = call_log.employee_id
      join callora.leads as lead
        on lead.organization_id = call_log.organization_id
       and lead.team_id = caller.team_id
       and lead.phone_blind_index_key_version = call_log.pii_blind_index_key_version
       and lead.phone_number_blind_index = call_log.phone_number_blind_index
      where call_log.organization_id = $1::uuid
        and call_log.id = $2::uuid
        and not call_log.is_internal
        and lead.archived_at is null
      order by lead.id
      limit 2
    `, [organizationId, callId]);
    if (candidates.rows.length !== 1) return;
    const candidate = candidates.rows[0];
    if (!candidate) return;
    const leadId = candidate.lead_id;
    if (typeof leadId !== "string") return;
    const linkId = randomUUID();
    const inserted = await client.query<DbRow>(`
      insert into callora.call_lead_links (
        id, organization_id, call_log_id, lead_id, link_source,
        match_confidence, linked_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'automatic', 1.0000,
        $5::timestamptz
      )
      on conflict do nothing
      returning id
    `, [linkId, organizationId, callId, leadId, at]);
    if (!inserted.rows[0]) {
      const existing = await client.query<DbRow>(`
        select lead_id
        from callora.call_lead_links
        where organization_id = $1::uuid and call_log_id = $2::uuid and unlinked_at is null
        limit 1
      `, [organizationId, callId]);
      if (existing.rows[0]?.lead_id !== leadId) return;
    }
    if (candidate.disposition === "answered") {
      await client.query(`
        update callora.leads
        set last_contacted_at = $3::timestamptz,
            updated_at = $4::timestamptz,
            version = version + 1
        where organization_id = $1::uuid
          and id = $2::uuid
          and (last_contacted_at is null or last_contacted_at < $3::timestamptz)
      `, [organizationId, leadId, candidate.started_at, at]);
    }
    if (!inserted.rows[0]) return;
    const direction = candidate.direction === "outgoing" ? "Outgoing" : "Incoming";
    const disposition = candidate.disposition === "missed"
      ? "missed"
      : candidate.disposition === "answered" ? "answered" : String(candidate.disposition);
    await client.query(`
      insert into callora.lead_activities (
        organization_id, lead_id, call_log_id, kind, summary, metadata,
        occurred_at, created_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, 'call_linked', $4, $5::jsonb,
        $6::timestamptz, $7::timestamptz
      )
    `, [
      organizationId,
      leadId,
      callId,
      `${direction} ${disposition} call linked`,
      JSON.stringify({ linkId, linkSource: "automatic", matchConfidence: 1 }),
      candidate.started_at,
      at,
    ]);
    await this.insertOutboxEvent(client, organizationId, "lead", leadId, "lead.call_linked", {
      leadId,
      callId,
      linkId,
    });
  }

  private async insertOutboxEvent(
    client: PgClientLike,
    organizationId: OrganizationId,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(`
      insert into callora.outbox_events (
        organization_id, aggregate_type, aggregate_id, event_type, payload
      ) values ($1::uuid, $2, $3::uuid, $4, $5::jsonb)
    `, [organizationId, aggregateType, aggregateId, eventType, JSON.stringify(payload)]);
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.pool.query<DbRow>("select 1 as ok");
      return result.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async findActor(organizationId: OrganizationId, userId: string): Promise<ActorContext | undefined> {
    if (!isCanonicalUuid(organizationId) || !isCanonicalUuid(userId)) return undefined;
    return this.withTenant(organizationId, userId, (client) =>
      this.loadActor(client, organizationId, userId));
  }

  async resolveActorByExternalIdentity(identity: ExternalIdentity): Promise<ActorContext | undefined> {
    if (!isCanonicalUuid(identity.organizationId) || !identity.issuer || !identity.subject) {
      return undefined;
    }
    return this.withTenant(identity.organizationId, undefined, async (client) => {
      const identityResult = await client.query<DbRow>(`
        select identity.user_id
        from callora.user_identities as identity
        join callora.users as app_user
          on app_user.organization_id = identity.organization_id
         and app_user.id = identity.user_id
        join callora.organization_memberships as membership
          on membership.organization_id = app_user.organization_id
         and membership.user_id = app_user.id
        where identity.organization_id = $1::uuid
          and identity.issuer = $2
          and identity.subject = $3
          and app_user.status = 'active'
          and membership.status = 'active'
        limit 1
      `, [identity.organizationId, identity.issuer, identity.subject]);
      const userId = identityResult.rows[0]?.user_id;
      if (typeof userId !== "string" || !isCanonicalUuid(userId)) return undefined;
      await this.setCurrentUser(client, userId);
      return this.loadActor(client, identity.organizationId, userId);
    });
  }

  async findDevelopmentActor(
    organizationId: OrganizationId,
    role: SystemRoleKey,
  ): Promise<ActorContext | undefined> {
    if (!isCanonicalUuid(organizationId)) return undefined;
    return this.withTenant(organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select membership.user_id
        from callora.organization_memberships as membership
        join callora.membership_roles as membership_role
          on membership_role.organization_id = membership.organization_id
         and membership_role.membership_id = membership.id
        join callora.roles as role
          on role.organization_id = membership_role.organization_id
         and role.id = membership_role.role_id
        join callora.users as app_user
          on app_user.organization_id = membership.organization_id
         and app_user.id = membership.user_id
        where membership.organization_id = $1::uuid
          and role.system_key = $2
          and membership.status = 'active'
          and app_user.status = 'active'
        order by membership.created_at, membership.id
        limit 1
      `, [organizationId, role]);
      const userId = result.rows[0]?.user_id;
      if (typeof userId !== "string" || !isCanonicalUuid(userId)) return undefined;
      await this.setCurrentUser(client, userId);
      return this.loadActor(client, organizationId, userId);
    });
  }

  async listEmployees(options: {
    organizationId: OrganizationId;
    filter: EmployeeListFilter;
    after?: EmployeeCursor;
    limit: number;
  }): Promise<{ items: Employee[]; hasMore: boolean }> {
    if (!isCanonicalUuid(options.organizationId)) return { items: [], hasMore: false };
    if (options.after && !isCanonicalUuid(options.after.id)) return { items: [], hasMore: false };
    return this.withTenant(options.organizationId, undefined, async (client) => {
      const values: unknown[] = [options.organizationId];
      const where = ["employee.organization_id = $1::uuid"];
      if (options.filter.search?.trim()) {
        values.push(options.filter.search.trim());
        where.push(`position(lower($${values.length}::text) in lower(concat_ws(' ', employee.display_name, employee.email, employee.employee_code))) > 0`);
      }
      if (options.filter.status) {
        values.push(options.filter.status);
        where.push(`employee.status = $${values.length}`);
      }
      if (options.filter.team) {
        values.push(options.filter.team);
        where.push(`team.name = $${values.length}`);
      }
      if (options.after) {
        values.push(options.after.displayName, options.after.id);
        where.push(`(lower(employee.display_name), employee.id) > (lower($${values.length - 1}::text), $${values.length}::uuid)`);
      }
      values.push(options.limit + 1);
      const result = await client.query<DbRow>(`
        select ${EMPLOYEE_COLUMNS}
        from callora.employees as employee
        left join callora.teams as team
          on team.organization_id = employee.organization_id
         and team.id = employee.team_id
        where ${where.join(" and ")}
        order by lower(employee.display_name), employee.id
        limit $${values.length}::integer
      `, values);
      const hasMore = result.rows.length > options.limit;
      return { items: result.rows.slice(0, options.limit).map(mapEmployee), hasMore };
    });
  }

  async findEmployee(organizationId: OrganizationId, employeeId: string): Promise<Employee | undefined> {
    if (!isCanonicalUuid(organizationId) || !isCanonicalUuid(employeeId)) return undefined;
    return this.withTenant(organizationId, undefined, (client) =>
      this.findEmployeeWithClient(client, organizationId, employeeId));
  }

  async createEmployee(
    organizationId: OrganizationId,
    input: CreateEmployeeInput,
    actorUserId: string,
    at: string,
  ): Promise<Employee> {
    assertTrustedUuid(organizationId, "organizationId");
    assertTrustedUuid(actorUserId, "actorUserId");
    if (input.managerEmployeeId !== undefined) {
      assertTrustedUuid(input.managerEmployeeId, "managerEmployeeId");
    }
    try {
      return await this.withTenant(organizationId, actorUserId, async (client) => {
      let teamId: string | undefined;
      const teamName = input.team?.trim();
      if (teamName) {
        await client.query(`
          insert into callora.teams (organization_id, name)
          values ($1::uuid, $2)
          on conflict (organization_id, (lower(name))) do nothing
        `, [organizationId, teamName]);
        const teamResult = await client.query<DbRow>(`
          select id
          from callora.teams
          where organization_id = $1::uuid and lower(name) = lower($2)
          limit 1
        `, [organizationId, teamName]);
        const candidate = teamResult.rows[0]?.id;
        if (typeof candidate === "string") teamId = candidate;
      }

      const workingHours = input.workingHours;
      const inserted = await client.query<DbRow>(`
        insert into callora.employees (
          organization_id, team_id, manager_employee_id, employee_code,
          display_name, email, primary_phone, job_title, status,
          working_time_zone, working_week_days, working_day_starts_at,
          working_day_ends_at, created_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4,
          $5, $6, $7, $8, 'invited',
          $9, $10::smallint[], $11::time, $12::time,
          $13::timestamptz, $13::timestamptz
        )
        returning id
      `, [
        organizationId,
        teamId ?? null,
        input.managerEmployeeId ?? null,
        input.employeeCode ?? null,
        input.displayName,
        input.email ?? null,
        input.primaryPhone ?? null,
        input.jobTitle ?? null,
        workingHours?.timeZone ?? null,
        workingHours?.weekDays ?? null,
        workingHours?.startsAt ?? null,
        workingHours?.endsAt ?? null,
        at,
      ]);
      const employeeId = firstRow(inserted.rows, "Employee insert returned no row").id;
      if (typeof employeeId !== "string") throw new Error("Employee insert returned an invalid id");
      await this.insertOutboxEvent(client, organizationId, "employee", employeeId, "employee.created", {
        employeeId,
        actorUserId,
      });
      const employee = await this.findEmployeeWithClient(client, organizationId, employeeId);
      if (!employee) throw new Error("Created employee is not visible inside its tenant transaction");
        return employee;
      });
    } catch (error) {
      const constraint = postgresConstraint(error);
      if (constraint === "employees_organization_email_key") {
        throw domainConflict("An employee with this email already exists");
      }
      if (constraint === "employees_organization_employee_code_key") {
        throw domainConflict("An employee with this employee code already exists");
      }
      throw error;
    }
  }

  async suspendEmployee(
    organizationId: OrganizationId,
    employeeId: string,
    actorUserId: string,
    at: string,
  ): Promise<Employee | undefined> {
    if (![organizationId, employeeId, actorUserId].every(isCanonicalUuid)) return undefined;
    return this.withTenant(organizationId, actorUserId, async (client) => {
      const updated = await client.query<DbRow>(`
        update callora.employees
        set status = 'paused', updated_at = $3::timestamptz
        where organization_id = $1::uuid and id = $2::uuid
        returning id
      `, [organizationId, employeeId, at]);
      if (!updated.rows[0]) return undefined;
      await client.query(`
        update callora.employee_devices
        set status = 'revoked', revoked_at = $3::timestamptz, updated_at = $3::timestamptz
        where organization_id = $1::uuid
          and employee_id = $2::uuid
          and status <> 'revoked'
      `, [organizationId, employeeId, at]);
      await this.insertOutboxEvent(client, organizationId, "employee", employeeId, "employee.suspended", {
        employeeId,
        actorUserId,
      });
      return this.findEmployeeWithClient(client, organizationId, employeeId);
    });
  }

  async listLeadStatuses(organizationId: OrganizationId): Promise<LeadStatus[]> {
    if (!isCanonicalUuid(organizationId)) return [];
    return this.withTenant(organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select *
        from callora.lead_statuses
        where organization_id = $1::uuid and is_active
        order by position, id
      `, [organizationId]);
      return result.rows.map(mapLeadStatus);
    });
  }

  async listLeads(options: {
    organizationId: OrganizationId;
    scope: LeadAccessScope;
    filter: LeadListFilter;
    after?: LeadCursor;
    limit: number;
    at: string;
  }): Promise<LeadListResult> {
    const empty: LeadListResult = {
      items: [],
      summary: { total: 0, notContacted: 0, overdue: 0, unreturnedCalls: 0 },
      hasMore: false,
    };
    if (!isCanonicalUuid(options.organizationId) ||
      options.after && !isCanonicalUuid(options.after.id) ||
      options.filter.statusId !== undefined && !isCanonicalUuid(options.filter.statusId) ||
      options.filter.assignedEmployeeId !== undefined && !isCanonicalUuid(options.filter.assignedEmployeeId)) {
      return empty;
    }
    return this.withTenant(options.organizationId, undefined, async (client) => {
      const summaryValues: unknown[] = [options.organizationId, options.at];
      const summaryScope = leadScopePredicate(options.scope, summaryValues);
      const unreturned = unreturnedMissedCallSql("lead");
      const summaryResult = await client.query<DbRow>(`
        select
          count(*)::integer as total,
          count(*) filter (where lead.last_contacted_at is null)::integer as not_contacted,
          count(*) filter (where exists (
            select 1
            from callora.lead_follow_ups as due_follow_up
            where due_follow_up.organization_id = lead.organization_id
              and due_follow_up.lead_id = lead.id
              and due_follow_up.status = 'pending'
              and due_follow_up.due_at < $2::timestamptz
          ))::integer as overdue,
          count(*) filter (where ${unreturned} > 0)::integer as unreturned_calls
        from callora.leads as lead
        where lead.organization_id = $1::uuid
          and lead.archived_at is null
          and ${summaryScope}
      `, summaryValues);
      const summaryRow = summaryResult.rows[0] ?? {};
      const summary: LeadQueueSummary = {
        total: Number(summaryRow.total ?? 0),
        notContacted: Number(summaryRow.not_contacted ?? 0),
        overdue: Number(summaryRow.overdue ?? 0),
        unreturnedCalls: Number(summaryRow.unreturned_calls ?? 0),
      };

      const values: unknown[] = [options.organizationId, options.at];
      const where = [
        "lead.organization_id = $1::uuid",
        "lead.archived_at is null",
        leadScopePredicate(options.scope, values),
      ];
      if (options.filter.statusId) {
        values.push(options.filter.statusId);
        where.push(`lead.status_id = $${values.length}::uuid`);
      }
      if (options.filter.assignedEmployeeId) {
        values.push(options.filter.assignedEmployeeId);
        where.push(`lead.assigned_employee_id = $${values.length}::uuid`);
      }
      if (options.filter.queue === "not_contacted") {
        where.push("lead.last_contacted_at is null");
      } else if (options.filter.queue === "overdue") {
        where.push(`exists (
          select 1 from callora.lead_follow_ups as queued_follow_up
          where queued_follow_up.organization_id = lead.organization_id
            and queued_follow_up.lead_id = lead.id
            and queued_follow_up.status = 'pending'
            and queued_follow_up.due_at < $2::timestamptz
        )`);
      } else if (options.filter.queue === "unreturned_calls") {
        where.push(`${unreturnedMissedCallSql("lead")} > 0`);
      }
      const search = options.filter.search?.trim();
      if (search) {
        const searchClauses: string[] = [];
        values.push(escapedLike(search));
        searchClauses.push(`concat_ws(' ', lead.first_name, lead.last_name, lead.company_name, lead.email)
          ilike $${values.length} escape '\\'`);
        if (/^\+[1-9]\d{7,14}$/.test(search)) {
          const crypto = this.requireCallPiiCrypto();
          for (const candidate of crypto.computeBlindIndexCandidates({
            organizationId: options.organizationId,
            field: "phone_number",
          }, search)) {
            values.push(candidate.keyVersion, candidate.blindIndex);
            searchClauses.push(`(
              lead.phone_blind_index_key_version = $${values.length - 1}::integer
              and lead.phone_number_blind_index = $${values.length}::bytea
            )`);
          }
          for (const candidate of crypto.computeBlindIndexCandidates({
            organizationId: options.organizationId,
            field: "alternate_phone_number",
          }, search)) {
            values.push(candidate.keyVersion, candidate.blindIndex);
            searchClauses.push(`(
              lead.alternate_phone_blind_index_key_version = $${values.length - 1}::integer
              and lead.alternate_phone_number_blind_index = $${values.length}::bytea
            )`);
          }
        }
        where.push(`(${searchClauses.join(" or ")})`);
      }
      if (options.after) {
        values.push(options.after.createdAt, options.after.id);
        where.push(`(lead.created_at, lead.id) < (
          $${values.length - 1}::timestamptz, $${values.length}::uuid
        )`);
      }
      values.push(options.limit + 1);
      const result = await client.query<DbRow>(`
        select ${leadItemColumns("$2")}
        from callora.leads as lead
        join callora.lead_statuses as lead_status
          on lead_status.organization_id = lead.organization_id
         and lead_status.id = lead.status_id
        left join callora.employees as assigned_employee
          on assigned_employee.organization_id = lead.organization_id
         and assigned_employee.id = lead.assigned_employee_id
        left join callora.teams as assigned_team
          on assigned_team.organization_id = assigned_employee.organization_id
         and assigned_team.id = assigned_employee.team_id
        where ${where.join(" and ")}
        order by lead.created_at desc, lead.id desc
        limit $${values.length}::integer
      `, values);
      const hasMore = result.rows.length > options.limit;
      return {
        items: result.rows.slice(0, options.limit).map((row) => this.mapLeadItemRow(row, options.at)),
        summary,
        hasMore,
      };
    });
  }

  async findLeadDetail(options: {
    organizationId: OrganizationId;
    scope: LeadAccessScope;
    leadId: string;
    at: string;
  }): Promise<LeadDetail | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.leadId)) return undefined;
    return this.withTenant(options.organizationId, undefined, (client) =>
      this.findLeadDetailWithClient(
        client,
        options.organizationId,
        options.scope,
        options.leadId,
        options.at,
      ));
  }

  async createLead(options: CreateLeadOptions): Promise<LeadDetail | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      options.input.statusId !== undefined && !isCanonicalUuid(options.input.statusId) ||
      options.input.assignedEmployeeId !== undefined && !isCanonicalUuid(options.input.assignedEmployeeId) ||
      options.input.tagIds?.some((tagId) => !isCanonicalUuid(tagId))) return undefined;
    const leadId = randomUUID();
    const crypto = this.requireCallPiiCrypto();
    const phone = crypto.encryptField({
      organizationId: options.organizationId,
      rowId: leadId,
      field: "phone_number",
    }, options.input.phoneNumber);
    const alternate = options.input.alternatePhoneNumber === undefined
      ? undefined
      : crypto.encryptField({
        organizationId: options.organizationId,
        rowId: leadId,
        field: "alternate_phone_number",
      }, options.input.alternatePhoneNumber);
    try {
      return await this.withTenant(options.organizationId, options.actorUserId, async (client) => {
        const statusResult = await client.query<DbRow>(`
          select *
          from callora.lead_statuses
          where organization_id = $1::uuid
            and is_active
            and ($2::uuid is null or id = $2::uuid)
          order by case when id = $2::uuid then 0 when is_initial then 1 else 2 end, position, id
          limit 1
        `, [options.organizationId, options.input.statusId ?? null]);
        const statusRow = statusResult.rows[0];
        if (!statusRow || options.input.statusId !== undefined && statusRow.id !== options.input.statusId) return undefined;

        let teamId: string | undefined;
        if (options.input.assignedEmployeeId) {
          const employeeValues: unknown[] = [options.organizationId, options.input.assignedEmployeeId];
          const employeeScope = employeeScopePredicate(options.scope, employeeValues);
          const employeeResult = await client.query<DbRow>(`
            select employee.team_id
            from callora.employees as employee
            where employee.organization_id = $1::uuid
              and employee.id = $2::uuid
              and employee.status = 'active'
              and employee.team_id is not null
              and ${employeeScope}
            limit 1
          `, employeeValues);
          const candidate = employeeResult.rows[0]?.team_id;
          if (typeof candidate !== "string") return undefined;
          teamId = candidate;
        } else if (options.scope.kind === "assigned") {
          return undefined;
        } else {
          const teamValues: unknown[] = [options.organizationId];
          const teamWhere = options.scope.kind === "teams"
            ? (() => {
              if (options.scope.teamNames.length === 0) return "false";
              teamValues.push(options.scope.teamNames);
              return `team.name = any($2::text[])`;
            })()
            : "true";
          const teamResult = await client.query<DbRow>(`
            select team.id
            from callora.teams as team
            where team.organization_id = $1::uuid and ${teamWhere}
            order by lower(team.name), team.id
            limit 1
          `, teamValues);
          const candidate = teamResult.rows[0]?.id;
          if (typeof candidate !== "string") return undefined;
          teamId = candidate;
        }

        await client.query(`
          insert into callora.leads (
            id, organization_id, team_id, status_id, assigned_employee_id,
            created_by_user_id, updated_by_user_id, first_name, last_name,
            company_name, email, source, source_reference, temperature,
            phone_encryption_version, phone_key_version, phone_blind_index_key_version,
            phone_number_ciphertext, phone_number_nonce, phone_number_blind_index,
            phone_number_last_four, phone_encrypted_at,
            alternate_phone_encryption_version, alternate_phone_key_version,
            alternate_phone_blind_index_key_version, alternate_phone_number_ciphertext,
            alternate_phone_number_nonce, alternate_phone_number_blind_index,
            alternate_phone_number_last_four, alternate_phone_encrypted_at,
            tag_ids, custom_fields, converted_at, lost_at, created_at, updated_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            $6::uuid, $6::uuid, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17::bytea, $18::bytea, $19::bytea, $20, $21::timestamptz,
            $22, $23, $24, $25::bytea, $26::bytea, $27::bytea, $28, $29::timestamptz,
            $30::jsonb, $31::jsonb, $32::timestamptz, $33::timestamptz,
            $21::timestamptz, $21::timestamptz
          )
        `, [
          leadId,
          options.organizationId,
          teamId,
          String(statusRow.id),
          options.input.assignedEmployeeId ?? null,
          options.actorUserId,
          options.input.firstName,
          options.input.lastName ?? null,
          options.input.companyName ?? null,
          options.input.email ?? null,
          options.input.source ?? "manual",
          options.input.sourceReference ?? null,
          options.input.temperature ?? null,
          phone.formatVersion,
          phone.keyVersion,
          phone.blindIndexKeyVersion,
          phone.ciphertext,
          phone.nonce,
          phone.blindIndex,
          options.input.phoneNumber.replace(/\D/g, "").slice(-4),
          options.at,
          alternate?.formatVersion ?? null,
          alternate?.keyVersion ?? null,
          alternate?.blindIndexKeyVersion ?? null,
          alternate?.ciphertext ?? null,
          alternate?.nonce ?? null,
          alternate?.blindIndex ?? null,
          options.input.alternatePhoneNumber?.replace(/\D/g, "").slice(-4) ?? null,
          alternate === undefined ? null : options.at,
          JSON.stringify(options.input.tagIds ?? []),
          JSON.stringify(options.input.customFields ?? {}),
          statusRow.is_won === true ? options.at : null,
          statusRow.is_lost === true ? options.at : null,
        ]);
        await client.query(`
          insert into callora.lead_activities (
            organization_id, lead_id, actor_user_id, kind, summary, new_values, metadata,
            occurred_at, created_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, 'created', 'Lead created',
            $4::jsonb, $5::jsonb, $6::timestamptz, $6::timestamptz
          )
        `, [
          options.organizationId,
          leadId,
          options.actorUserId,
          JSON.stringify({ statusId: statusRow.id, assignedEmployeeId: options.input.assignedEmployeeId ?? null }),
          JSON.stringify({ source: options.input.source ?? "manual" }),
          options.at,
        ]);
        await this.insertOutboxEvent(client, options.organizationId, "lead", leadId, "lead.created", {
          leadId,
          statusId: String(statusRow.id),
          assignedEmployeeId: options.input.assignedEmployeeId ?? null,
        });
        return this.findLeadDetailWithClient(
          client,
          options.organizationId,
          options.scope,
          leadId,
          options.at,
        );
      });
    } catch (error) {
      if (postgresConstraint(error) === "leads_source_reference_key") {
        throw domainConflict("A lead from this source reference already exists");
      }
      throw error;
    }
  }

  async updateLead(options: UpdateLeadOptions): Promise<LeadDetail | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !isCanonicalUuid(options.leadId) ||
      options.request.changes.statusId !== undefined && !isCanonicalUuid(options.request.changes.statusId) ||
      options.request.changes.assignedEmployeeId !== undefined &&
        options.request.changes.assignedEmployeeId !== null &&
        !isCanonicalUuid(options.request.changes.assignedEmployeeId) ||
      options.request.changes.tagIds?.some((tagId) => !isCanonicalUuid(tagId))) return undefined;
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const accessValues: unknown[] = [options.organizationId, options.leadId];
      const accessScope = leadScopePredicate(options.scope, accessValues);
      const currentResult = await client.query<DbRow>(`
        select lead.*
        from callora.leads as lead
        where lead.organization_id = $1::uuid
          and lead.id = $2::uuid
          and ${accessScope}
        for update
      `, accessValues);
      const currentRow = currentResult.rows[0];
      if (!currentRow) return undefined;
      const currentVersion = Number(currentRow.version);
      if (currentVersion !== options.request.expectedVersion) {
        throw domainConflict("The lead changed; refresh and retry");
      }
      const current = this.mapLeadRow(currentRow);
      const changes = options.request.changes;

      let statusRow: DbRow;
      if (changes.statusId !== undefined) {
        const statusResult = await client.query<DbRow>(`
          select * from callora.lead_statuses
          where organization_id = $1::uuid and id = $2::uuid and is_active
          limit 1
        `, [options.organizationId, changes.statusId]);
        const candidate = statusResult.rows[0];
        if (!candidate) return undefined;
        statusRow = candidate;
      } else {
        const statusResult = await client.query<DbRow>(`
          select * from callora.lead_statuses
          where organization_id = $1::uuid and id = $2::uuid
          limit 1
        `, [options.organizationId, current.statusId]);
        const candidate = statusResult.rows[0];
        if (!candidate) throw new Error("Lead status disappeared while updating a lead");
        statusRow = candidate;
      }

      let nextAssignedEmployeeId = current.assignedEmployeeId ?? null;
      let nextTeamId = String(currentRow.team_id);
      if (changes.assignedEmployeeId !== undefined) {
        if (!options.canAssign) return undefined;
        if (changes.assignedEmployeeId === null) {
          nextAssignedEmployeeId = null;
        } else {
          const employeeValues: unknown[] = [options.organizationId, changes.assignedEmployeeId];
          const employeeScope = employeeScopePredicate(options.scope, employeeValues);
          const employeeResult = await client.query<DbRow>(`
            select employee.team_id
            from callora.employees as employee
            where employee.organization_id = $1::uuid
              and employee.id = $2::uuid
              and employee.status = 'active'
              and employee.team_id is not null
              and ${employeeScope}
            limit 1
          `, employeeValues);
          const teamId = employeeResult.rows[0]?.team_id;
          if (typeof teamId !== "string") return undefined;
          nextAssignedEmployeeId = changes.assignedEmployeeId;
          nextTeamId = teamId;
        }
      }

      const values: unknown[] = [options.organizationId, options.leadId];
      const assignments: string[] = [];
      const set = (column: string, value: unknown, cast = ""): void => {
        values.push(value);
        assignments.push(`${column} = $${values.length}${cast}`);
      };
      if (changes.firstName !== undefined) set("first_name", changes.firstName);
      if (changes.lastName !== undefined) set("last_name", changes.lastName);
      if (changes.companyName !== undefined) set("company_name", changes.companyName);
      if (changes.email !== undefined) set("email", changes.email);
      if (changes.statusId !== undefined) set("status_id", changes.statusId, "::uuid");
      if (changes.temperature !== undefined) set("temperature", changes.temperature);
      if (changes.assignedEmployeeId !== undefined) {
        set("assigned_employee_id", nextAssignedEmployeeId, "::uuid");
        set("team_id", nextTeamId, "::uuid");
      }
      if (changes.tagIds !== undefined) set("tag_ids", JSON.stringify(changes.tagIds), "::jsonb");
      if (changes.customFields !== undefined) set("custom_fields", JSON.stringify(changes.customFields), "::jsonb");
      if (changes.archived !== undefined) set("archived_at", changes.archived ? options.at : null, "::timestamptz");
      if (changes.phoneNumber !== undefined) {
        const encrypted = this.requireCallPiiCrypto().encryptField({
          organizationId: options.organizationId,
          rowId: options.leadId,
          field: "phone_number",
        }, changes.phoneNumber);
        set("phone_encryption_version", encrypted.formatVersion);
        set("phone_key_version", encrypted.keyVersion);
        set("phone_blind_index_key_version", encrypted.blindIndexKeyVersion);
        set("phone_number_ciphertext", encrypted.ciphertext, "::bytea");
        set("phone_number_nonce", encrypted.nonce, "::bytea");
        set("phone_number_blind_index", encrypted.blindIndex, "::bytea");
        set("phone_number_last_four", changes.phoneNumber.replace(/\D/g, "").slice(-4));
        set("phone_encrypted_at", options.at, "::timestamptz");
      }
      if (changes.alternatePhoneNumber !== undefined) {
        if (changes.alternatePhoneNumber === null) {
          for (const column of [
            "alternate_phone_encryption_version",
            "alternate_phone_key_version",
            "alternate_phone_blind_index_key_version",
            "alternate_phone_number_ciphertext",
            "alternate_phone_number_nonce",
            "alternate_phone_number_blind_index",
            "alternate_phone_number_last_four",
            "alternate_phone_encrypted_at",
          ]) assignments.push(`${column} = null`);
        } else {
          const encrypted = this.requireCallPiiCrypto().encryptField({
            organizationId: options.organizationId,
            rowId: options.leadId,
            field: "alternate_phone_number",
          }, changes.alternatePhoneNumber);
          set("alternate_phone_encryption_version", encrypted.formatVersion);
          set("alternate_phone_key_version", encrypted.keyVersion);
          set("alternate_phone_blind_index_key_version", encrypted.blindIndexKeyVersion);
          set("alternate_phone_number_ciphertext", encrypted.ciphertext, "::bytea");
          set("alternate_phone_number_nonce", encrypted.nonce, "::bytea");
          set("alternate_phone_number_blind_index", encrypted.blindIndex, "::bytea");
          set("alternate_phone_number_last_four", changes.alternatePhoneNumber.replace(/\D/g, "").slice(-4));
          set("alternate_phone_encrypted_at", options.at, "::timestamptz");
        }
      }
      set("converted_at", statusRow.is_won === true ? current.convertedAt ?? options.at : null, "::timestamptz");
      set("lost_at", statusRow.is_lost === true ? current.lostAt ?? options.at : null, "::timestamptz");
      set("updated_by_user_id", options.actorUserId, "::uuid");
      set("updated_at", options.at, "::timestamptz");
      assignments.push("version = version + 1");
      values.push(options.request.expectedVersion);
      const updatedResult = await client.query<DbRow>(`
        update callora.leads
        set ${assignments.join(", ")}
        where organization_id = $1::uuid
          and id = $2::uuid
          and version = $${values.length}::bigint
        returning version
      `, values);
      if (!updatedResult.rows[0]) throw domainConflict("The lead changed; refresh and retry");

      const nextStatusId = String(statusRow.id);
      const statusChanged = current.statusId !== nextStatusId;
      const assignedChanged = (current.assignedEmployeeId ?? null) !== nextAssignedEmployeeId;
      const customFieldsChanged = changes.customFields !== undefined &&
        JSON.stringify(current.customFields) !== JSON.stringify(changes.customFields);
      const tagsChanged = changes.tagIds !== undefined &&
        JSON.stringify(current.tagIds) !== JSON.stringify(changes.tagIds);
      const kind: LeadActivity["kind"] = statusChanged
        ? "status_changed"
        : assignedChanged
          ? nextAssignedEmployeeId === null ? "unassigned" : "assigned"
          : customFieldsChanged
            ? "custom_fields_changed"
            : tagsChanged
              ? (changes.tagIds?.length ?? 0) >= current.tagIds.length ? "tag_added" : "tag_removed"
              : "updated";
      const summary = statusChanged
        ? `Status changed to ${String(statusRow.name)}`
        : kind === "assigned" ? "Lead assigned"
          : kind === "unassigned" ? "Lead unassigned"
            : kind === "custom_fields_changed" ? "Custom fields updated"
              : kind === "tag_added" ? "Lead tag added"
                : kind === "tag_removed" ? "Lead tag removed" : "Lead updated";
      const oldValues = {
        version: currentVersion,
        statusId: current.statusId,
        assignedEmployeeId: current.assignedEmployeeId ?? null,
        tagCount: current.tagIds.length,
        customFieldCount: Object.keys(current.customFields).length,
      };
      const newValues = {
        version: currentVersion + 1,
        statusId: nextStatusId,
        assignedEmployeeId: nextAssignedEmployeeId,
        tagCount: changes.tagIds?.length ?? current.tagIds.length,
        customFieldCount: Object.keys(changes.customFields ?? current.customFields).length,
      };
      await client.query(`
        insert into callora.lead_activities (
          organization_id, lead_id, actor_user_id, kind, summary,
          old_values, new_values, metadata, occurred_at, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4, $5,
          $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz, $9::timestamptz
        )
      `, [
        options.organizationId,
        options.leadId,
        options.actorUserId,
        kind,
        summary,
        JSON.stringify(oldValues),
        JSON.stringify(newValues),
        JSON.stringify({ changedKeys: Object.keys(changes) }),
        options.at,
      ]);
      await this.insertOutboxEvent(client, options.organizationId, "lead", options.leadId, "lead.updated", {
        leadId: options.leadId,
        version: currentVersion + 1,
        kind,
      });
      return this.findLeadDetailWithClient(
        client,
        options.organizationId,
        options.scope,
        options.leadId,
        options.at,
      );
    });
  }

  async createLeadNote(options: CreateLeadNoteOptions): Promise<LeadDetail | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !isCanonicalUuid(options.leadId)) return undefined;
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const accessValues: unknown[] = [options.organizationId, options.leadId];
      const accessScope = leadScopePredicate(options.scope, accessValues);
      const leadResult = await client.query<DbRow>(`
        select lead.id
        from callora.leads as lead
        where lead.organization_id = $1::uuid
          and lead.id = $2::uuid
          and ${accessScope}
        limit 1
      `, accessValues);
      if (!leadResult.rows[0]) return undefined;
      const noteId = randomUUID();
      await client.query(`
        insert into callora.lead_notes (
          id, organization_id, lead_id, author_user_id, body, is_pinned, created_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $7::timestamptz
        )
      `, [
        noteId,
        options.organizationId,
        options.leadId,
        options.actorUserId,
        options.input.body,
        options.input.isPinned ?? false,
        options.at,
      ]);
      await client.query(`
        insert into callora.lead_activities (
          organization_id, lead_id, actor_user_id, kind, summary, metadata,
          occurred_at, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 'note_added', 'Note added', $4::jsonb,
          $5::timestamptz, $5::timestamptz
        )
      `, [
        options.organizationId,
        options.leadId,
        options.actorUserId,
        JSON.stringify({ noteId, isPinned: options.input.isPinned ?? false }),
        options.at,
      ]);
      await this.insertOutboxEvent(client, options.organizationId, "lead", options.leadId, "lead.note_added", {
        leadId: options.leadId,
        noteId,
      });
      return this.findLeadDetailWithClient(
        client,
        options.organizationId,
        options.scope,
        options.leadId,
        options.at,
      );
    });
  }

  async createLeadFollowUp(options: CreateLeadFollowUpOptions): Promise<LeadDetail | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !isCanonicalUuid(options.leadId) || !isCanonicalUuid(options.input.leadId) ||
      !isCanonicalUuid(options.input.assignedEmployeeId) || options.input.leadId !== options.leadId) {
      return undefined;
    }
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const accessValues: unknown[] = [options.organizationId, options.leadId];
      const accessScope = leadScopePredicate(options.scope, accessValues);
      const leadResult = await client.query<DbRow>(`
        select lead.team_id, lead.version
        from callora.leads as lead
        where lead.organization_id = $1::uuid
          and lead.id = $2::uuid
          and ${accessScope}
        for update
      `, accessValues);
      const leadRow = leadResult.rows[0];
      if (!leadRow || typeof leadRow.team_id !== "string") return undefined;

      const employeeValues: unknown[] = [
        options.organizationId,
        options.input.assignedEmployeeId,
        leadRow.team_id,
      ];
      const employeeScope = employeeScopePredicate(options.scope, employeeValues);
      const employeeResult = await client.query<DbRow>(`
        select employee.id
        from callora.employees as employee
        where employee.organization_id = $1::uuid
          and employee.id = $2::uuid
          and employee.team_id = $3::uuid
          and employee.status = 'active'
          and ${employeeScope}
        limit 1
      `, employeeValues);
      if (!employeeResult.rows[0]) return undefined;

      const followUpId = randomUUID();
      await client.query(`
        insert into callora.lead_follow_ups (
          id, organization_id, team_id, lead_id, assigned_employee_id,
          created_by_user_id, title, notes, due_at, reminder_at, priority,
          created_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::uuid, $7, $8, $9::timestamptz, $10::timestamptz, $11,
          $12::timestamptz, $12::timestamptz
        )
      `, [
        followUpId,
        options.organizationId,
        leadRow.team_id,
        options.leadId,
        options.input.assignedEmployeeId,
        options.actorUserId,
        options.input.title,
        options.input.notes ?? null,
        options.input.dueAt,
        options.input.reminderAt ?? null,
        options.input.priority ?? "normal",
        options.at,
      ]);
      const nextDueResult = await client.query<DbRow>(`
        select min(due_at) as next_due
        from callora.lead_follow_ups
        where organization_id = $1::uuid and lead_id = $2::uuid and status = 'pending'
      `, [options.organizationId, options.leadId]);
      await client.query(`
        update callora.leads
        set next_follow_up_at = $3::timestamptz,
            updated_by_user_id = $4::uuid,
            updated_at = $5::timestamptz,
            version = version + 1
        where organization_id = $1::uuid and id = $2::uuid
      `, [
        options.organizationId,
        options.leadId,
        nextDueResult.rows[0]?.next_due ?? options.input.dueAt,
        options.actorUserId,
        options.at,
      ]);
      await client.query(`
        insert into callora.lead_activities (
          organization_id, lead_id, actor_user_id, kind, summary, metadata,
          occurred_at, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 'follow_up_created', 'Follow-up scheduled',
          $4::jsonb, $5::timestamptz, $5::timestamptz
        )
      `, [
        options.organizationId,
        options.leadId,
        options.actorUserId,
        JSON.stringify({
          followUpId,
          assignedEmployeeId: options.input.assignedEmployeeId,
          priority: options.input.priority ?? "normal",
        }),
        options.at,
      ]);
      await this.insertOutboxEvent(client, options.organizationId, "follow_up", followUpId, "follow_up.created", {
        followUpId,
        leadId: options.leadId,
        assignedEmployeeId: options.input.assignedEmployeeId,
      });
      return this.findLeadDetailWithClient(
        client,
        options.organizationId,
        options.scope,
        options.leadId,
        options.at,
      );
    });
  }

  async completeLeadFollowUp(options: CompleteLeadFollowUpOptions): Promise<LeadDetail | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !isCanonicalUuid(options.followUpId)) return undefined;
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const accessValues: unknown[] = [options.organizationId, options.followUpId];
      const accessScope = leadScopePredicate(options.scope, accessValues);
      const followUpResult = await client.query<DbRow>(`
        select follow_up.*, lead.version as lead_version
        from callora.lead_follow_ups as follow_up
        join callora.leads as lead
          on lead.organization_id = follow_up.organization_id
         and lead.id = follow_up.lead_id
        where follow_up.organization_id = $1::uuid
          and follow_up.id = $2::uuid
          and ${accessScope}
        for update of follow_up, lead
      `, accessValues);
      const followUpRow = followUpResult.rows[0];
      if (!followUpRow) return undefined;
      const currentVersion = Number(followUpRow.version);
      if (currentVersion !== options.input.expectedVersion) {
        throw domainConflict("The follow-up changed; refresh and retry");
      }
      if (followUpRow.status !== "pending") {
        throw domainConflict("The follow-up is no longer pending");
      }
      const completedAt = options.input.completedAt ?? options.at;
      const createdAt = new Date(String(followUpRow.created_at)).toISOString();
      if (completedAt < createdAt) throw domainConflict("The completion time cannot precede the follow-up creation time");
      const updated = await client.query<DbRow>(`
        update callora.lead_follow_ups
        set status = 'completed',
            completed_at = $3::timestamptz,
            completed_by_user_id = $4::uuid,
            updated_at = $5::timestamptz,
            version = version + 1
        where organization_id = $1::uuid
          and id = $2::uuid
          and version = $6::bigint
          and status = 'pending'
        returning lead_id
      `, [
        options.organizationId,
        options.followUpId,
        completedAt,
        options.actorUserId,
        options.at,
        options.input.expectedVersion,
      ]);
      const leadId = updated.rows[0]?.lead_id;
      if (typeof leadId !== "string") throw domainConflict("The follow-up changed; refresh and retry");

      if (options.input.completionNote) {
        await client.query(`
          insert into callora.lead_notes (
            id, organization_id, lead_id, author_user_id, body, is_pinned, created_at, updated_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, false,
            $6::timestamptz, $6::timestamptz
          )
        `, [
          randomUUID(),
          options.organizationId,
          leadId,
          options.actorUserId,
          options.input.completionNote,
          options.at,
        ]);
      }
      const nextDueResult = await client.query<DbRow>(`
        select min(due_at) as next_due
        from callora.lead_follow_ups
        where organization_id = $1::uuid and lead_id = $2::uuid and status = 'pending'
      `, [options.organizationId, leadId]);
      await client.query(`
        update callora.leads
        set next_follow_up_at = $3::timestamptz,
            updated_by_user_id = $4::uuid,
            updated_at = $5::timestamptz,
            version = version + 1
        where organization_id = $1::uuid and id = $2::uuid
      `, [
        options.organizationId,
        leadId,
        nextDueResult.rows[0]?.next_due ?? null,
        options.actorUserId,
        options.at,
      ]);
      await client.query(`
        insert into callora.lead_activities (
          organization_id, lead_id, actor_user_id, kind, summary, metadata,
          occurred_at, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 'follow_up_completed', 'Follow-up completed',
          $4::jsonb, $5::timestamptz, $5::timestamptz
        )
      `, [
        options.organizationId,
        leadId,
        options.actorUserId,
        JSON.stringify({
          followUpId: options.followUpId,
          oldVersion: currentVersion,
          newVersion: currentVersion + 1,
          completionNoteAdded: options.input.completionNote !== undefined,
        }),
        options.at,
      ]);
      await this.insertOutboxEvent(
        client,
        options.organizationId,
        "follow_up",
        options.followUpId,
        "follow_up.completed",
        { followUpId: options.followUpId, leadId },
      );
      return this.findLeadDetailWithClient(
        client,
        options.organizationId,
        options.scope,
        leadId,
        options.at,
      );
    });
  }

  async previewLeadImport(options: PreviewLeadImportOptions): Promise<LeadImportPreview> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) {
      throw new Error("Lead import preview identifiers or fingerprint are invalid");
    }
    const crypto = this.requireCallPiiCrypto();
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      // Serialize first use of an organization/request pair. Without this,
      // concurrent previews can both observe absence and one surfaces the
      // unique request constraint as a 500 instead of a replay/conflict.
      await client.query(`
        select pg_advisory_xact_lock(hashtextextended($1, 0))
      `, [`lead-import-preview:${options.organizationId}:${options.input.requestId}`]);
      const existing = await client.query<DbRow>(`
        select id, request_fingerprint
        from callora.lead_import_jobs
        where organization_id = $1::uuid and request_id = $2
        for update
      `, [options.organizationId, options.input.requestId]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_fingerprint !== options.requestFingerprint) {
          throw domainConflict("The import request ID was already used with a different payload");
        }
        const jobId = existing.rows[0].id;
        if (typeof jobId !== "string") throw new Error("Lead import replay has an invalid job ID");
        const replay = await this.findLeadImportWithClient(client, { ...options, jobId });
        if (!replay) {
          throw domainForbidden("The lead import is outside your current lead scope");
        }
        return { ...replay, replayed: true };
      }

      const statuses = await client.query<DbRow>(`
        select * from callora.lead_statuses
        where organization_id = $1::uuid and is_active
        order by is_initial desc, position, id
      `, [options.organizationId]);
      const teamValues: unknown[] = [options.organizationId];
      const teamScope = options.scope.kind === "teams"
        ? (() => { teamValues.push(options.scope.teamNames); return "team.name = any($2::text[])"; })()
        : options.scope.kind === "assigned"
          ? (() => { teamValues.push(options.scope.employeeId); return `exists (
              select 1 from callora.employees scoped_employee
              where scoped_employee.organization_id = team.organization_id
                and scoped_employee.team_id = team.id and scoped_employee.id = $2::uuid
            )`; })()
          : "true";
      const teams = await client.query<DbRow>(`
        select team.id, team.name
        from callora.teams as team
        where team.organization_id = $1::uuid and team.is_active and ${teamScope}
        order by lower(team.name), team.id
      `, teamValues);
      const accessibleTeamIds = new Set(teams.rows.map((row) => String(row.id)));
      const employeeValues: unknown[] = [options.organizationId];
      const employeeScope = employeeScopePredicate(options.scope, employeeValues);
      const employees = await client.query<DbRow>(`
        select employee.id, employee.team_id, employee.employee_code, employee.display_name
        from callora.employees as employee
        where employee.organization_id = $1::uuid and employee.status = 'active'
          and employee.team_id is not null and ${employeeScope}
        order by employee.team_id, lower(employee.display_name), employee.id
      `, employeeValues);
      const defaultTeamId = typeof teams.rows[0]?.id === "string" ? teams.rows[0].id : undefined;

      const rules = await client.query<DbRow>(`
        select rule.*, coalesce(
          jsonb_agg(member.employee_id order by member.position)
            filter (where member.employee_id is not null), '[]'::jsonb
        ) as employee_ids
        from callora.lead_assignment_rules as rule
        left join callora.lead_assignment_rule_employees as member
          on member.organization_id = rule.organization_id and member.rule_id = rule.id
        left join callora.employees as rule_employee
          on rule_employee.organization_id = member.organization_id
         and rule_employee.id = member.employee_id
        where rule.organization_id = $1::uuid and rule.active
        group by rule.id
        having count(member.employee_id) > 0
          and count(member.employee_id) = count(rule_employee.id) filter (
            where rule_employee.status = 'active' and rule_employee.team_id = rule.team_id
          )
        order by rule.priority, rule.id
      `, [options.organizationId]);
      const availableRules = rules.rows
        .filter((row) => accessibleTeamIds.has(String(row.team_id)))
        .map((row) => ({ row, rule: this.mapLeadAssignmentRule(row) }))
        .filter(({ rule }) => rule.employeeIds.length > 0);
      const ruleCursors = new Map<string, number>();
      const phoneRows = new Map<string, number>();

      type Staged = {
        id: string;
        rowNumber: number;
        decision: "valid" | "duplicate" | "invalid";
        input: PreviewLeadImportOptions["input"]["rows"][number];
        issues: LeadImportPreview["rows"][number]["issues"];
        teamId?: string;
        statusId?: string;
        assignedEmployeeId?: string;
        ruleId?: string;
        ruleVersion?: number;
        duplicateRowNumber?: number;
        duplicateLeadId?: string;
        phone?: EncryptedCallPiiField;
        alternate?: EncryptedCallPiiField;
      };
      const staged: Staged[] = [];

      for (const [index, input] of options.input.rows.entries()) {
        const id = randomUUID();
        const rowNumber = index + 1;
        const firstName = input.firstName.trim();
        const phoneNumber = input.phoneNumber.trim();
        const validPhone = /^\+[1-9]\d{7,14}$/.test(phoneNumber);
        const issues: LeadImportPreview["rows"][number]["issues"] = [];
        if (!firstName) issues.push({ field: "firstName", code: "required", message: "First name is required" });
        if (!validPhone) issues.push({ field: "phoneNumber", code: "invalid_phone", message: "Phone must use E.164 format" });
        if (input.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
          issues.push({ field: "email", code: "invalid_email", message: "Email is invalid" });
        }
        if (input.alternatePhoneNumber !== undefined &&
          !/^\+[1-9]\d{7,14}$/.test(input.alternatePhoneNumber.trim())) {
          issues.push({ field: "alternatePhoneNumber", code: "invalid_phone", message: "Alternate phone must use E.164 format" });
        }
        if (input.source !== undefined && !isLeadSource(input.source)) {
          issues.push({ field: "source", code: "invalid_source", message: "Lead source is invalid" });
        }
        const statusRow = input.statusName
          ? statuses.rows.find((row) => String(row.name).toLocaleLowerCase() === input.statusName!.trim().toLocaleLowerCase())
          : statuses.rows[0];
        if (!statusRow) issues.push({ field: "statusName", code: "unknown_status", message: "Lead status was not found" });
        const ownerRow = input.assignedEmployeeCode
          ? employees.rows.find((row) => typeof row.employee_code === "string" &&
            row.employee_code.toLocaleLowerCase() === input.assignedEmployeeCode!.trim().toLocaleLowerCase())
          : undefined;
        if (input.assignedEmployeeCode && !ownerRow) {
          issues.push({ field: "assignedEmployeeCode", code: "unknown_owner", message: "Active owner was not found" });
        }
        const teamId = typeof ownerRow?.team_id === "string" ? ownerRow.team_id : defaultTeamId;
        if (!teamId) issues.push({ field: "assignedEmployeeCode", code: "unknown_owner", message: "No accessible team is available" });

        const alternatePhoneNumber = input.alternatePhoneNumber?.trim();
        const validAlternatePhone = alternatePhoneNumber !== undefined && /^\+[1-9]\d{7,14}$/.test(alternatePhoneNumber);
        let duplicateRowNumber: number | undefined;
        for (const [field, candidate] of [
          ["phoneNumber", validPhone ? phoneNumber : undefined],
          ["alternatePhoneNumber", validAlternatePhone ? alternatePhoneNumber : undefined],
        ] as const) {
          if (!candidate) continue;
          const phoneKey = `${teamId ?? "unresolved"}:${candidate}`;
          const priorRow = phoneRows.get(phoneKey);
          if (priorRow !== undefined) {
            duplicateRowNumber ??= priorRow;
            issues.push({ field, code: "duplicate_in_file", message: `Duplicates row ${priorRow}` });
          } else if (field === "alternatePhoneNumber" && candidate === phoneNumber) {
            duplicateRowNumber ??= rowNumber;
            issues.push({ field, code: "duplicate_in_file", message: "Duplicates phoneNumber in this row" });
          }
        }
        let duplicateLeadId: string | undefined;
        const invalidBeforeDuplicateLookup = issues.some((issue) =>
          !["duplicate_in_file", "duplicate_existing"].includes(issue.code));
        if (!invalidBeforeDuplicateLookup && validPhone && teamId && duplicateRowNumber === undefined) {
          const candidates = leadPhoneLookupCandidates(crypto, options.organizationId, [
            phoneNumber,
            ...(validAlternatePhone && alternatePhoneNumber ? [alternatePhoneNumber] : []),
          ]);
          const values: unknown[] = [options.organizationId, teamId];
          const predicates = candidates.map((candidate) => {
            values.push(candidate.keyVersion, candidate.blindIndex);
            const version = candidate.field === "phone" ? "phone_blind_index_key_version" : "alternate_phone_blind_index_key_version";
            const blind = candidate.field === "phone" ? "phone_number_blind_index" : "alternate_phone_number_blind_index";
            return `(lead.${version} = $${values.length - 1}::integer and lead.${blind} = $${values.length}::bytea)`;
          });
          const duplicate = await client.query<DbRow>(`
            select lead.id from callora.leads as lead
            where lead.organization_id = $1::uuid and lead.team_id = $2::uuid
              and lead.archived_at is null and (${predicates.join(" or ")})
            order by lead.id limit 1
          `, values);
          duplicateLeadId = typeof duplicate.rows[0]?.id === "string" ? duplicate.rows[0].id : undefined;
          if (duplicateLeadId) {
            issues.push({ field: "phoneNumber", code: "duplicate_existing", message: "An existing lead has this phone" });
          }
        }

        const duplicate = duplicateRowNumber !== undefined || duplicateLeadId !== undefined;
        const invalid = issues.some((issue) => !["duplicate_in_file", "duplicate_existing"].includes(issue.code));
        // Only importable rows reserve phones for later in-file duplicate
        // checks. An invalid/duplicate row must not poison a valid later row.
        if (!invalid && !duplicate) {
          phoneRows.set(`${teamId ?? "unresolved"}:${phoneNumber}`, rowNumber);
          if (validAlternatePhone && alternatePhoneNumber) {
            phoneRows.set(`${teamId ?? "unresolved"}:${alternatePhoneNumber}`, rowNumber);
          }
        }
        let assignedEmployeeId = typeof ownerRow?.id === "string" ? ownerRow.id : undefined;
        let ruleId: string | undefined;
        let ruleVersion: number | undefined;
        if (!invalid && !duplicate && !assignedEmployeeId && teamId && statusRow) {
          const source = input.source ?? "csv_import";
          const matched = availableRules.find(({ row, rule }) => {
            if (row.team_id !== teamId) return false;
            if (rule.conditions.sources?.length && !rule.conditions.sources.includes(source)) return false;
            if (rule.conditions.temperatures?.length) return false;
            if (rule.conditions.statusIds?.length && !rule.conditions.statusIds.includes(String(statusRow.id))) return false;
            return true;
          });
          if (matched) {
            ruleId = matched.rule.id;
            ruleVersion = matched.rule.version;
            const cursor = ruleCursors.get(ruleId) ?? Number(matched.row.round_robin_cursor ?? 0);
            const position = matched.rule.strategy === "fixed_owner" ? 0 : cursor % matched.rule.employeeIds.length;
            assignedEmployeeId = matched.rule.employeeIds[position];
            if (matched.rule.strategy === "round_robin" && assignedEmployeeId) {
              ruleCursors.set(ruleId, cursor + 1);
            }
          }
        }

        const decision = invalid ? "invalid" : duplicate ? "duplicate" : "valid";
        const phone = decision === "invalid" ? undefined : crypto.encryptField({
          organizationId: options.organizationId, rowId: id, field: "phone_number",
        }, phoneNumber);
        const alternate = decision === "invalid" || input.alternatePhoneNumber === undefined
          ? undefined
          : crypto.encryptField({
            organizationId: options.organizationId, rowId: id, field: "alternate_phone_number",
          }, input.alternatePhoneNumber.trim());
        staged.push({ id, rowNumber, decision, input, issues,
          ...(teamId === undefined ? {} : { teamId }),
          ...(typeof statusRow?.id === "string" ? { statusId: statusRow.id } : {}),
          ...(assignedEmployeeId === undefined ? {} : { assignedEmployeeId }),
          ...(ruleId === undefined ? {} : { ruleId }),
          ...(ruleVersion === undefined ? {} : { ruleVersion }),
          ...(duplicateRowNumber === undefined ? {} : { duplicateRowNumber }),
          ...(duplicateLeadId === undefined ? {} : { duplicateLeadId }),
          ...(phone === undefined ? {} : { phone }),
          ...(alternate === undefined ? {} : { alternate }),
        });
      }

      const jobId = randomUUID();
      const validRows = staged.filter((row) => row.decision === "valid").length;
      const duplicateRows = staged.filter((row) => row.decision === "duplicate").length;
      const errorRows = staged.filter((row) => row.decision === "invalid").length;
      await client.query(`
        insert into callora.lead_import_jobs (
          id, organization_id, request_id, request_fingerprint, file_name,
          total_rows, valid_rows, duplicate_rows, error_rows, processed_rows,
          created_by_user_id, created_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11::uuid, $12::timestamptz, $12::timestamptz
        )
      `, [jobId, options.organizationId, options.input.requestId, options.requestFingerprint,
        options.input.fileName.trim(), staged.length, validRows, duplicateRows, errorRows,
        duplicateRows + errorRows, options.actorUserId, options.at]);

      for (const row of staged) {
        const safeFirstName = row.decision === "invalid" ? null : row.input.firstName.trim();
        const safeEmail = row.decision === "invalid" ? null : row.input.email?.trim().toLocaleLowerCase() ?? null;
        await client.query(`
          insert into callora.lead_import_rows (
            id, organization_id, job_id, row_number, decision,
            team_id, status_id, proposed_assigned_employee_id, assignment_rule_id,
            assignment_rule_version,
            duplicate_row_number, duplicate_lead_id,
            first_name, last_name, company_name, email, source, status_name,
            assigned_employee_code, tag_names, custom_fields,
            phone_encryption_version, phone_key_version, phone_blind_index_key_version,
            phone_number_ciphertext, phone_number_nonce, phone_number_blind_index,
            phone_number_last_four, phone_encrypted_at,
            alternate_phone_encryption_version, alternate_phone_key_version,
            alternate_phone_blind_index_key_version, alternate_phone_number_ciphertext,
            alternate_phone_number_nonce, alternate_phone_number_blind_index,
            alternate_phone_number_last_four, alternate_phone_encrypted_at,
            issues, created_at, updated_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4, $5,
            $6::uuid, $7::uuid, $8::uuid, $9::uuid,
            $10::bigint,
            $11, $12::uuid,
            $13, $14, $15, $16, $17, $18,
            $19, $20::jsonb, $21::jsonb,
            $22, $23, $24, $25::bytea, $26::bytea, $27::bytea, $28, $29::timestamptz,
            $30, $31, $32, $33::bytea, $34::bytea, $35::bytea, $36, $37::timestamptz,
            $38::jsonb, $39::timestamptz, $39::timestamptz
          )
        `, [
          row.id, options.organizationId, jobId, row.rowNumber, row.decision,
          row.teamId ?? null, row.statusId ?? null, row.assignedEmployeeId ?? null, row.ruleId ?? null,
          row.ruleVersion ?? null,
          row.duplicateRowNumber ?? null, row.duplicateLeadId ?? null,
          safeFirstName,
          row.decision === "invalid" ? null : row.input.lastName?.trim() || null,
          row.decision === "invalid" ? null : row.input.companyName?.trim() || null,
          safeEmail, row.decision === "invalid" ? "unknown" : row.input.source ?? "csv_import",
          row.decision === "invalid" ? null : row.input.statusName?.trim() || null,
          row.decision === "invalid" ? null : row.input.assignedEmployeeCode?.trim() || null,
          JSON.stringify(row.decision === "invalid" ? [] : row.input.tagNames ?? []),
          JSON.stringify(row.decision === "invalid" ? {} : row.input.customFields ?? {}),
          row.phone?.formatVersion ?? null, row.phone?.keyVersion ?? null,
          row.phone?.blindIndexKeyVersion ?? null, row.phone?.ciphertext ?? null,
          row.phone?.nonce ?? null, row.phone?.blindIndex ?? null,
          row.phone ? row.input.phoneNumber.replace(/\D/g, "").slice(-4) : null,
          row.phone ? options.at : null,
          row.alternate?.formatVersion ?? null, row.alternate?.keyVersion ?? null,
          row.alternate?.blindIndexKeyVersion ?? null, row.alternate?.ciphertext ?? null,
          row.alternate?.nonce ?? null, row.alternate?.blindIndex ?? null,
          row.alternate ? row.input.alternatePhoneNumber?.replace(/\D/g, "").slice(-4) ?? null : null,
          row.alternate ? options.at : null,
          JSON.stringify(row.issues), options.at,
        ]);
      }
      const preview = await this.findLeadImportWithClient(client, { ...options, jobId });
      if (!preview) throw new Error("Created lead import is not visible inside its tenant transaction");
      return preview;
    });
  }

  async listLeadImports(options: LeadImportAccessOptions): Promise<LeadImportJob[]> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId)) return [];
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const accessValues: unknown[] = [options.organizationId];
      const access = leadImportAccessPredicate(options.scope, options.actorUserId, accessValues, "job");
      const result = await client.query<DbRow>(`
        select job.* from callora.lead_import_jobs as job
        where job.organization_id = $1::uuid and ${access}
        order by job.created_at desc, job.id desc limit 100
      `, accessValues);
      return result.rows.map((row) => this.mapLeadImportJob(row));
    });
  }

  async findLeadImport(options: LeadImportAccessOptions & { jobId: string }): Promise<LeadImportPreview | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !isCanonicalUuid(options.jobId)) return undefined;
    return this.withTenant(options.organizationId, options.actorUserId, (client) =>
      this.findLeadImportWithClient(client, options));
  }

  async commitLeadImport(options: CommitLeadImportOptions): Promise<LeadImportResult | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !isCanonicalUuid(options.jobId) || !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) return undefined;
    const crypto = this.requireCallPiiCrypto();
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const visibleValues: unknown[] = [options.organizationId, options.jobId];
      const visibleAccess = leadImportAccessPredicate(
        options.scope, options.actorUserId, visibleValues, "job",
      );
      const visible = await client.query<DbRow>(`
        select job.id from callora.lead_import_jobs as job
        where job.organization_id = $1::uuid and job.id = $2::uuid
          and ${visibleAccess}
        limit 1
      `, visibleValues);
      if (!visible.rows[0]) return undefined;
      const ledger = await client.query<DbRow>(`
        insert into callora.api_idempotency_keys (
          organization_id, scope, idempotency_key, request_fingerprint,
          resource_type, resource_id, expires_at, created_at, updated_at
        ) values (
          $1::uuid, 'lead.import.commit', $2, $3,
          'lead_import', $4::uuid, $5::timestamptz + interval '7 days',
          $5::timestamptz, $5::timestamptz
        )
        on conflict (organization_id, scope, idempotency_key) do nothing
        returning id
      `, [options.organizationId, options.input.requestId, options.requestFingerprint, options.jobId, options.at]);
      if (!ledger.rows[0]) {
        const existing = await client.query<DbRow>(`
          select request_fingerprint, resource_id, response_body
          from callora.api_idempotency_keys
          where organization_id = $1::uuid and scope = 'lead.import.commit' and idempotency_key = $2
          for update
        `, [options.organizationId, options.input.requestId]);
        const row = existing.rows[0];
        if (!row || row.request_fingerprint !== options.requestFingerprint || row.resource_id !== options.jobId) {
          throw domainConflict("The import commit request ID was already used with a different payload");
        }
        const stored = parseStoredObject<LeadImportResult>(row.response_body);
        if (!stored?.job || stored.job.id !== options.jobId) {
          throw new Error("Import commit replay response is incomplete");
        }
        return { ...stored, replayed: true };
      }

      const jobValues: unknown[] = [options.organizationId, options.jobId];
      const jobAccess = leadImportAccessPredicate(options.scope, options.actorUserId, jobValues, "job");
      const jobResult = await client.query<DbRow>(`
        select job.* from callora.lead_import_jobs as job
        where job.organization_id = $1::uuid and job.id = $2::uuid
          and ${jobAccess}
        for update
      `, jobValues);
      const jobRow = jobResult.rows[0];
      if (!jobRow) return undefined;
      if (jobRow.status === "completed") {
        const job = this.mapLeadImportJob(jobRow);
        const result: LeadImportResult = { job, replayed: true };
        await client.query(`
          update callora.api_idempotency_keys
          set response_status = 200, response_body = $4::jsonb
          where organization_id = $1::uuid and scope = 'lead.import.commit' and idempotency_key = $2
            and resource_id = $3::uuid
        `, [options.organizationId, options.input.requestId, options.jobId, JSON.stringify(result)]);
        return result;
      }
      await client.query(`
        update callora.lead_import_jobs
        set status = 'processing', last_error = null
        where organization_id = $1::uuid and id = $2::uuid
      `, [options.organizationId, options.jobId]);

      const pending = await client.query<DbRow>(`
        select * from callora.lead_import_rows
        where organization_id = $1::uuid and job_id = $2::uuid and decision = 'valid'
        order by row_number
        limit 50
        for update
      `, [options.organizationId, options.jobId]);
      let imported = 0;
      let newDuplicates = 0;
      let newErrors = 0;
      const ruleIncrements = new Map<string, number>();

      // Transaction advisory locks are retained until commit. Acquire the
      // whole batch's tenant/team lock set globally sorted so jobs containing
      // teams in opposite row order cannot deadlock. This intentionally
      // serializes import dedup per team; no phone plaintext enters lock keys.
      const importTeamLockKeys = [...new Set(pending.rows
        .map((row) => typeof row.team_id === "string"
          ? `lead-import-team:${options.organizationId}:${row.team_id}`
          : undefined)
        .filter((value): value is string => value !== undefined))].sort();
      for (const lockKey of importTeamLockKeys) {
        await client.query(`
          select pg_advisory_xact_lock(hashtextextended($1, 0))
        `, [lockKey]);
      }
      const referencedRuleIds = [...new Set(pending.rows
        .map((row) => typeof row.assignment_rule_id === "string" ? row.assignment_rule_id : undefined)
        .filter((value): value is string => value !== undefined))].sort();
      const lockedRules = referencedRuleIds.length === 0 ? { rows: [] as DbRow[] } : await client.query<DbRow>(`
        select id, team_id, version, active, strategy, conditions, round_robin_cursor
        from callora.lead_assignment_rules
        where organization_id = $1::uuid and id = any($2::uuid[])
        order by id
        for update
      `, [options.organizationId, referencedRuleIds]);
      const lockedRuleById = new Map(lockedRules.rows.map((row) => [String(row.id), row]));
      const lockedMembers = referencedRuleIds.length === 0 ? { rows: [] as DbRow[] } : await client.query<DbRow>(`
        select member.rule_id, member.employee_id, member.position,
          member.team_id as member_team_id, employee.team_id as employee_team_id,
          employee.status as employee_status
        from callora.lead_assignment_rule_employees as member
        join callora.employees as employee
          on employee.organization_id = member.organization_id
         and employee.id = member.employee_id
        where member.organization_id = $1::uuid and member.rule_id = any($2::uuid[])
        order by member.rule_id, member.position, member.employee_id
        for update of member, employee
      `, [options.organizationId, referencedRuleIds]);
      const lockedMembersByRule = new Map<string, DbRow[]>();
      for (const member of lockedMembers.rows) {
        const ruleId = String(member.rule_id);
        lockedMembersByRule.set(ruleId, [...(lockedMembersByRule.get(ruleId) ?? []), member]);
      }

      const invalidateRow = async (
        rowId: string,
        issue: LeadImportPreview["rows"][number]["issues"][number],
      ): Promise<void> => {
        await client.query(`
          update callora.lead_import_rows
          set decision = 'invalid', issues = $3::jsonb,
              team_id = null, status_id = null, proposed_assigned_employee_id = null,
              assignment_rule_id = null, assignment_rule_version = null,
              duplicate_row_number = null, duplicate_lead_id = null,
              first_name = null, last_name = null, company_name = null, email = null,
              source = 'unknown', status_name = null, assigned_employee_code = null,
              tag_names = '[]'::jsonb, custom_fields = '{}'::jsonb,
              phone_encryption_version = null, phone_key_version = null,
              phone_blind_index_key_version = null, phone_number_ciphertext = null,
              phone_number_nonce = null, phone_number_blind_index = null,
              phone_number_last_four = null, phone_encrypted_at = null,
              alternate_phone_encryption_version = null, alternate_phone_key_version = null,
              alternate_phone_blind_index_key_version = null,
              alternate_phone_number_ciphertext = null, alternate_phone_number_nonce = null,
              alternate_phone_number_blind_index = null,
              alternate_phone_number_last_four = null, alternate_phone_encrypted_at = null
          where organization_id = $1::uuid and id = $2::uuid
        `, [options.organizationId, rowId, JSON.stringify([issue])]);
        newErrors += 1;
      };

      for (const row of pending.rows) {
        const staged = this.mapLeadImportRow(row);
        const teamId = typeof row.team_id === "string" ? row.team_id : undefined;
        const statusId = typeof row.status_id === "string" ? row.status_id : undefined;
        if (!teamId || !statusId || !/^\+[1-9]\d{7,14}$/.test(staged.input.phoneNumber)) {
          throw new Error("A valid import row lost its normalized tenant-bound fields");
        }
        if (typeof row.assignment_rule_id === "string") {
          const lockedRule = lockedRuleById.get(row.assignment_rule_id);
          const stagedRuleVersion = Number(row.assignment_rule_version);
          const lockedRuleVersion = Number(lockedRule?.version);
          if (!lockedRule || !Number.isSafeInteger(stagedRuleVersion) ||
            !Number.isSafeInteger(lockedRuleVersion) || stagedRuleVersion !== lockedRuleVersion) {
            await invalidateRow(String(row.id), {
              field: "assignedEmployeeCode",
              code: "unknown_owner",
              message: "The assignment rule changed; preview the import again",
            });
            continue;
          }
          const conditions = parseStoredObject<LeadAssignmentRule["conditions"]>(lockedRule?.conditions) ?? {};
          const stagedSource = staged.input.source && isLeadSource(staged.input.source)
            ? staged.input.source : "csv_import";
          if (lockedRule.active !== true || lockedRule.team_id !== teamId ||
            conditions.sources?.length && !conditions.sources.includes(stagedSource) ||
            conditions.temperatures?.length ||
            conditions.statusIds?.length && !conditions.statusIds.includes(statusId)) {
            await invalidateRow(String(row.id), {
              field: "assignedEmployeeCode",
              code: "unknown_owner",
              message: "The assignment rule no longer matches this row",
            });
            continue;
          }
        }
        const normalizedPhones = [
          staged.input.phoneNumber,
          ...(staged.input.alternatePhoneNumber ? [staged.input.alternatePhoneNumber] : []),
        ];
        const candidates = leadPhoneLookupCandidates(crypto, options.organizationId, normalizedPhones);
        const duplicateValues: unknown[] = [options.organizationId, teamId];
        const duplicatePredicates = candidates.map((candidate) => {
          duplicateValues.push(candidate.keyVersion, candidate.blindIndex);
          const version = candidate.field === "phone" ? "phone_blind_index_key_version" : "alternate_phone_blind_index_key_version";
          const blind = candidate.field === "phone" ? "phone_number_blind_index" : "alternate_phone_number_blind_index";
          return `(lead.${version} = $${duplicateValues.length - 1}::integer and lead.${blind} = $${duplicateValues.length}::bytea)`;
        });
        const duplicate = await client.query<DbRow>(`
          select lead.id from callora.leads as lead
          where lead.organization_id = $1::uuid and lead.team_id = $2::uuid
            and lead.archived_at is null and (${duplicatePredicates.join(" or ")})
          order by lead.id limit 1
        `, duplicateValues);
        const duplicateLeadId = duplicate.rows[0]?.id;
        if (typeof duplicateLeadId === "string") {
          await client.query(`
            update callora.lead_import_rows
            set decision = 'duplicate', duplicate_lead_id = $3::uuid,
                issues = $4::jsonb
            where organization_id = $1::uuid and id = $2::uuid
          `, [options.organizationId, row.id, duplicateLeadId, JSON.stringify([{
            field: "phoneNumber", code: "duplicate_existing", message: "An existing lead has this phone",
          }])]);
          newDuplicates += 1;
          continue;
        }

        const leadId = randomUUID();
        const phone = crypto.encryptField({
          organizationId: options.organizationId, rowId: leadId, field: "phone_number",
        }, staged.input.phoneNumber);
        const alternate = staged.input.alternatePhoneNumber === undefined ? undefined : crypto.encryptField({
          organizationId: options.organizationId, rowId: leadId, field: "alternate_phone_number",
        }, staged.input.alternatePhoneNumber);
        const status = await client.query<DbRow>(`
          select is_won, is_lost from callora.lead_statuses
          where organization_id = $1::uuid and id = $2::uuid and is_active
          limit 1
        `, [options.organizationId, statusId]);
        if (!status.rows[0]) {
          await invalidateRow(String(row.id), {
            field: "statusName",
            code: "unknown_status",
            message: "The staged lead status is no longer active",
          });
          continue;
        }
        let assignedEmployeeId = typeof row.proposed_assigned_employee_id === "string"
          ? row.proposed_assigned_employee_id : undefined;
        if (typeof row.assignment_rule_id === "string") {
          const lockedRule = lockedRuleById.get(row.assignment_rule_id);
          const members = lockedMembersByRule.get(row.assignment_rule_id) ?? [];
          if (!lockedRule || members.length === 0 || members.some((member) =>
            member.employee_status !== "active" || member.member_team_id !== teamId ||
            member.employee_team_id !== teamId || typeof member.employee_id !== "string")) {
            await invalidateRow(String(row.id), {
              field: "assignedEmployeeCode",
              code: "unknown_owner",
              message: "The assignment rule has no eligible active owner",
            });
            continue;
          }
          const successfulForRule = ruleIncrements.get(row.assignment_rule_id) ?? 0;
          const cursor = Number(lockedRule.round_robin_cursor ?? 0) + successfulForRule;
          const memberIndex = lockedRule.strategy === "fixed_owner" ? 0 : cursor % members.length;
          assignedEmployeeId = String(members[memberIndex]?.employee_id ?? "");
        } else if (assignedEmployeeId) {
          const owner = await client.query<DbRow>(`
            select id from callora.employees
            where organization_id = $1::uuid and id = $2::uuid
              and team_id = $3::uuid and status = 'active'
            limit 1 for update
          `, [options.organizationId, assignedEmployeeId, teamId]);
          if (!owner.rows[0]) {
            await invalidateRow(String(row.id), {
              field: "assignedEmployeeCode",
              code: "unknown_owner",
              message: "The proposed owner is no longer active",
            });
            continue;
          }
        }
        const source = staged.input.source && isLeadSource(staged.input.source) ? staged.input.source : "csv_import";
        await client.query(`
          insert into callora.leads (
            id, organization_id, team_id, status_id, assigned_employee_id,
            created_by_user_id, updated_by_user_id, first_name, last_name,
            company_name, email, source, source_reference,
            phone_encryption_version, phone_key_version, phone_blind_index_key_version,
            phone_number_ciphertext, phone_number_nonce, phone_number_blind_index,
            phone_number_last_four, phone_encrypted_at,
            alternate_phone_encryption_version, alternate_phone_key_version,
            alternate_phone_blind_index_key_version, alternate_phone_number_ciphertext,
            alternate_phone_number_nonce, alternate_phone_number_blind_index,
            alternate_phone_number_last_four, alternate_phone_encrypted_at,
            tag_ids, custom_fields, converted_at, lost_at, created_at, updated_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            $6::uuid, $6::uuid, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16::bytea, $17::bytea, $18::bytea, $19, $20::timestamptz,
            $21, $22, $23, $24::bytea, $25::bytea, $26::bytea, $27, $28::timestamptz,
            $29::jsonb, $30::jsonb, $31::timestamptz, $32::timestamptz,
            $20::timestamptz, $20::timestamptz
          )
        `, [
          leadId, options.organizationId, teamId, statusId,
          assignedEmployeeId ?? null, options.actorUserId,
          staged.input.firstName.trim(), staged.input.lastName?.trim() || null,
          staged.input.companyName?.trim() || null, staged.input.email?.trim().toLocaleLowerCase() || null,
          source, `${options.jobId}:${row.row_number}`,
          phone.formatVersion, phone.keyVersion, phone.blindIndexKeyVersion,
          phone.ciphertext, phone.nonce, phone.blindIndex,
          staged.input.phoneNumber.replace(/\D/g, "").slice(-4), options.at,
          alternate?.formatVersion ?? null, alternate?.keyVersion ?? null,
          alternate?.blindIndexKeyVersion ?? null, alternate?.ciphertext ?? null,
          alternate?.nonce ?? null, alternate?.blindIndex ?? null,
          staged.input.alternatePhoneNumber?.replace(/\D/g, "").slice(-4) ?? null,
          alternate ? options.at : null,
          JSON.stringify((staged.input.tagNames ?? []).map((tagName) => tagName.trim())),
          JSON.stringify(staged.input.customFields ?? {}),
          status.rows[0].is_won === true ? options.at : null,
          status.rows[0].is_lost === true ? options.at : null,
        ]);
        await client.query(`
          insert into callora.lead_activities (
            organization_id, lead_id, actor_user_id, kind, summary,
            new_values, metadata, occurred_at, created_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, 'created', 'Lead imported',
            $4::jsonb, $5::jsonb, $6::timestamptz, $6::timestamptz
          )
        `, [options.organizationId, leadId, options.actorUserId,
          JSON.stringify({ statusId, assignedEmployeeId: assignedEmployeeId ?? null }),
          JSON.stringify({ source, importJobId: options.jobId, importRowNumber: row.row_number }), options.at]);
        await client.query(`
          update callora.lead_import_rows
          set decision = 'imported', imported_lead_id = $3::uuid
          where organization_id = $1::uuid and id = $2::uuid
        `, [options.organizationId, row.id, leadId]);
        await this.insertOutboxEvent(client, options.organizationId, "lead", leadId, "lead.created", {
          leadId, importJobId: options.jobId,
        });
        imported += 1;
        if (typeof row.assignment_rule_id === "string" &&
          lockedRuleById.get(row.assignment_rule_id)?.strategy === "round_robin") {
          ruleIncrements.set(row.assignment_rule_id, (ruleIncrements.get(row.assignment_rule_id) ?? 0) + 1);
        }
      }

      for (const [ruleId, increment] of ruleIncrements) {
        const lockedRule = lockedRuleById.get(ruleId);
        if (!lockedRule) throw new Error("Locked assignment rule disappeared during import commit");
        const advanced = await client.query<DbRow>(`
          update callora.lead_assignment_rules
          set round_robin_cursor = round_robin_cursor + $3::bigint,
              version = version + 1, updated_by_user_id = $4::uuid,
              updated_at = $5::timestamptz
          where organization_id = $1::uuid and id = $2::uuid and strategy = 'round_robin'
            and version = $6::bigint
          returning version
        `, [options.organizationId, ruleId, increment, options.actorUserId, options.at,
          Number(lockedRule.version)]);
        const nextRuleVersion = Number(advanced.rows[0]?.version);
        if (!Number.isSafeInteger(nextRuleVersion)) {
          throw domainConflict("The assignment rule changed; preview the import again");
        }
        // Keep this resumable job aligned with its own cursor advance. Other
        // jobs recompute under the newly locked cursor when they commit.
        await client.query(`
          update callora.lead_import_rows
          set assignment_rule_version = $4::bigint
          where organization_id = $1::uuid and job_id = $2::uuid
            and assignment_rule_id = $3::uuid and decision = 'valid'
        `, [options.organizationId, options.jobId, ruleId, nextRuleVersion]);
      }
      const remaining = await client.query<DbRow>(`
        select count(*)::integer as count
        from callora.lead_import_rows
        where organization_id = $1::uuid and job_id = $2::uuid and decision = 'valid'
      `, [options.organizationId, options.jobId]);
      const remainingCount = Number(remaining.rows[0]?.count ?? 0);
      const completed = remainingCount === 0;
      const updatedJob = await client.query<DbRow>(`
        update callora.lead_import_jobs
        set status = $3,
            imported_rows = imported_rows + $4,
            duplicate_rows = duplicate_rows + $5,
            error_rows = error_rows + $6,
            valid_rows = valid_rows - $5 - $6,
            processed_rows = processed_rows + $4 + $5 + $6,
            completed_at = case when $7 then $8::timestamptz else null end
        where organization_id = $1::uuid and id = $2::uuid
        returning *
      `, [options.organizationId, options.jobId, completed ? "completed" : "interrupted",
        imported, newDuplicates, newErrors, completed, options.at]);
      const job = this.mapLeadImportJob(firstRow(updatedJob.rows, "Import job update returned no row"));
      const result: LeadImportResult = { job, replayed: false };
      await client.query(`
        update callora.api_idempotency_keys
        set response_status = 200, response_body = $4::jsonb
        where organization_id = $1::uuid and scope = 'lead.import.commit'
          and idempotency_key = $2 and resource_id = $3::uuid
      `, [options.organizationId, options.input.requestId, options.jobId, JSON.stringify(result)]);
      return result;
    });
  }

  async listLeadAssignmentRules(options: LeadAssignmentOperationOptions): Promise<LeadAssignmentRule[]> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId)) return [];
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const values: unknown[] = [options.organizationId];
      const scope = options.scope.kind === "organization" ? "true"
        : options.scope.kind === "teams"
          ? (() => { values.push(options.scope.teamNames); return `exists (
              select 1 from callora.teams scoped_team
              where scoped_team.organization_id = rule.organization_id and scoped_team.id = rule.team_id
                and scoped_team.name = any($2::text[])
            )`; })()
          : (() => { values.push(options.scope.employeeId); return `exists (
              select 1 from callora.employees scoped_employee
              where scoped_employee.organization_id = rule.organization_id
                and scoped_employee.team_id = rule.team_id and scoped_employee.id = $2::uuid
            )`; })();
      const result = await client.query<DbRow>(`
        select rule.*, coalesce(
          jsonb_agg(member.employee_id order by member.position)
            filter (where member.employee_id is not null), '[]'::jsonb
        ) as employee_ids
        from callora.lead_assignment_rules as rule
        left join callora.lead_assignment_rule_employees as member
          on member.organization_id = rule.organization_id and member.rule_id = rule.id
        where rule.organization_id = $1::uuid and ${scope}
        group by rule.id
        order by rule.priority, rule.id
      `, values);
      return result.rows.map((row) => this.mapLeadAssignmentRule(row));
    });
  }

  private async validateRuleEmployeesWithClient(
    client: PgClientLike,
    organizationId: OrganizationId,
    scope: LeadAccessScope,
    employeeIds: string[],
  ): Promise<{ teamId: string; employeeIds: string[] } | undefined> {
    if (employeeIds.some((id) => !isCanonicalUuid(id)) || new Set(employeeIds).size !== employeeIds.length) {
      return undefined;
    }
    // Lock the same employee set in one canonical order regardless of the
    // caller's desired round-robin positions. Preserve caller order only for
    // the membership positions written after all locks are held.
    const lockIds = [...employeeIds].sort();
    const values: unknown[] = [organizationId, lockIds];
    const employeeScope = employeeScopePredicate(scope, values);
    const result = await client.query<DbRow>(`
      select employee.id, employee.team_id
      from callora.employees as employee
      where employee.organization_id = $1::uuid and employee.id = any($2::uuid[])
        and employee.status = 'active' and employee.team_id is not null and ${employeeScope}
      order by employee.id
      for update of employee
    `, values);
    if (result.rows.length !== employeeIds.length) return undefined;
    const teamId = result.rows[0]?.team_id;
    if (typeof teamId !== "string" || result.rows.some((row) => row.team_id !== teamId)) return undefined;
    return { teamId, employeeIds: [...employeeIds] };
  }

  async createLeadAssignmentRule(options: CreateLeadAssignmentRuleOptions): Promise<LeadAssignmentRule | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId)) return undefined;
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const resolved = await this.validateRuleEmployeesWithClient(
        client, options.organizationId, options.scope, options.input.employeeIds,
      );
      if (!resolved || options.input.strategy === "fixed_owner" && resolved.employeeIds.length !== 1) return undefined;
      const statusIds = options.input.conditions?.statusIds ?? [];
      if (statusIds.some((id) => !isCanonicalUuid(id))) return undefined;
      if (statusIds.length > 0) {
        const statuses = await client.query<DbRow>(`
          select count(*)::integer as count from callora.lead_statuses
          where organization_id = $1::uuid and id = any($2::uuid[]) and is_active
        `, [options.organizationId, statusIds]);
        if (Number(statuses.rows[0]?.count) !== new Set(statusIds).size) return undefined;
      }
      const id = randomUUID();
      const result = await client.query<DbRow>(`
        insert into callora.lead_assignment_rules (
          id, organization_id, team_id, name, priority, active, conditions, strategy,
          created_by_user_id, updated_by_user_id, created_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8,
          $9::uuid, $9::uuid, $10::timestamptz, $10::timestamptz
        ) returning *
      `, [id, options.organizationId, resolved.teamId, options.input.name.trim(), options.input.priority,
        options.input.active ?? true, JSON.stringify(options.input.conditions ?? {}), options.input.strategy,
        options.actorUserId, options.at]);
      for (const [position, employeeId] of resolved.employeeIds.entries()) {
        await client.query(`
          insert into callora.lead_assignment_rule_employees (
            organization_id, team_id, rule_id, employee_id, position, created_at
          ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz)
        `, [options.organizationId, resolved.teamId, id, employeeId, position, options.at]);
      }
      const row = firstRow(result.rows, "Assignment rule insert returned no row");
      row.employee_ids = resolved.employeeIds;
      return this.mapLeadAssignmentRule(row);
    });
  }

  async updateLeadAssignmentRule(options: UpdateLeadAssignmentRuleOptions): Promise<LeadAssignmentRule | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !isCanonicalUuid(options.ruleId)) return undefined;
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const accessValues: unknown[] = [options.organizationId, options.ruleId];
      const scope = options.scope.kind === "organization" ? "true"
        : options.scope.kind === "teams"
          ? (() => { accessValues.push(options.scope.teamNames); return `exists (
              select 1 from callora.teams scoped_team where scoped_team.organization_id = rule.organization_id
                and scoped_team.id = rule.team_id and scoped_team.name = any($3::text[])
            )`; })()
          : "false";
      const current = await client.query<DbRow>(`
        select rule.*
        from callora.lead_assignment_rules as rule
        where rule.organization_id = $1::uuid and rule.id = $2::uuid and ${scope}
        for update
      `, accessValues);
      const currentRow = current.rows[0];
      if (!currentRow) return undefined;
      const currentEmployees = await client.query<DbRow>(`
        select employee_id
        from callora.lead_assignment_rule_employees
        where organization_id = $1::uuid and rule_id = $2::uuid
        order by position
        for update
      `, [options.organizationId, options.ruleId]);
      currentRow.employee_ids = currentEmployees.rows.map((row) => String(row.employee_id));
      if (Number(currentRow.version) !== options.input.expectedVersion) {
        throw domainConflict("The assignment rule changed; refresh and retry");
      }
      const currentRule = this.mapLeadAssignmentRule(currentRow);
      const employeeIds = options.input.changes.employeeIds ?? currentRule.employeeIds;
      const resolved = await this.validateRuleEmployeesWithClient(client, options.organizationId, options.scope, employeeIds);
      const strategy = options.input.changes.strategy ?? currentRule.strategy;
      if (!resolved || strategy === "fixed_owner" && resolved.employeeIds.length !== 1) return undefined;
      if (resolved.teamId !== currentRow.team_id) {
        // Team identity is immutable. Besides keeping rule semantics stable,
        // this prevents a preview inserting an old-team composite FK while a
        // concurrent update moves the rule. Create a new rule for a new team.
        throw domainConflict("Assignment rule team is immutable; create a new rule for another team");
      }
      const conditions = options.input.changes.conditions ?? currentRule.conditions;
      const statusIds = conditions.statusIds ?? [];
      if (statusIds.some((id) => !isCanonicalUuid(id))) return undefined;
      if (statusIds.length > 0) {
        const statuses = await client.query<DbRow>(`
          select count(*)::integer as count from callora.lead_statuses
          where organization_id = $1::uuid and id = any($2::uuid[]) and is_active
        `, [options.organizationId, statusIds]);
        if (Number(statuses.rows[0]?.count) !== new Set(statusIds).size) return undefined;
      }
      await client.query(`
        delete from callora.lead_assignment_rule_employees
        where organization_id = $1::uuid and rule_id = $2::uuid
      `, [options.organizationId, options.ruleId]);
      const updated = await client.query<DbRow>(`
        update callora.lead_assignment_rules
        set team_id = $3::uuid, name = $4, priority = $5, active = $6,
            conditions = $7::jsonb, strategy = $8, updated_by_user_id = $9::uuid,
            updated_at = $10::timestamptz, version = version + 1
        where organization_id = $1::uuid and id = $2::uuid and version = $11::bigint
        returning *
      `, [options.organizationId, options.ruleId, resolved.teamId,
        options.input.changes.name?.trim() ?? currentRule.name,
        options.input.changes.priority ?? currentRule.priority,
        options.input.changes.active ?? currentRule.active, JSON.stringify(conditions), strategy,
        options.actorUserId, options.at, options.input.expectedVersion]);
      if (!updated.rows[0]) throw domainConflict("The assignment rule changed; refresh and retry");
      for (const [position, employeeId] of resolved.employeeIds.entries()) {
        await client.query(`
          insert into callora.lead_assignment_rule_employees (
            organization_id, team_id, rule_id, employee_id, position, created_at
          ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz)
        `, [options.organizationId, resolved.teamId, options.ruleId, employeeId, position, options.at]);
      }
      const row = updated.rows[0];
      row.employee_ids = resolved.employeeIds;
      return this.mapLeadAssignmentRule(row);
    });
  }

  async dryRunLeadAssignmentRules(options: LeadAssignmentOperationOptions): Promise<LeadAssignmentDryRun> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId)) {
      return { matchedLeads: 0, unmatchedLeads: 0, distribution: [] };
    }
    return this.withTenant(options.organizationId, options.actorUserId, async (client) =>
      (await this.leadAssignmentPlanWithClient(client, options.organizationId, options.scope, false)).dryRun);
  }

  async applyLeadAssignmentRules(options: ApplyLeadAssignmentRulesOptions): Promise<ApplyLeadAssignmentRulesResult> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) {
      throw new Error("Assignment application identifiers or fingerprint are invalid");
    }
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const inserted = await client.query<DbRow>(`
        insert into callora.api_idempotency_keys (
          organization_id, scope, idempotency_key, request_fingerprint,
          expires_at, created_at, updated_at
        ) values (
          $1::uuid, 'lead.assignment.apply', $2, $3,
          $4::timestamptz + interval '7 days', $4::timestamptz, $4::timestamptz
        ) on conflict (organization_id, scope, idempotency_key) do nothing
        returning id
      `, [options.organizationId, options.input.requestId, options.requestFingerprint, options.at]);
      if (!inserted.rows[0]) {
        const existing = await client.query<DbRow>(`
          select request_fingerprint, response_body from callora.api_idempotency_keys
          where organization_id = $1::uuid and scope = 'lead.assignment.apply' and idempotency_key = $2
          for update
        `, [options.organizationId, options.input.requestId]);
        const row = existing.rows[0];
        if (!row || row.request_fingerprint !== options.requestFingerprint) {
          throw domainConflict("The assignment request ID was already used with a different payload");
        }
        const stored = parseStoredObject<ApplyLeadAssignmentRulesResult>(row.response_body);
        if (!stored) throw new Error("Assignment replay response is incomplete");
        return { ...stored, replayed: true };
      }
      const plan = await this.leadAssignmentPlanWithClient(
        client, options.organizationId, options.scope, options.input.includeExistingUnassigned,
      );
      let appliedLeads = 0;
      const appliedRuleAdvances = new Map<string, number>();
      if (options.input.includeExistingUnassigned) {
        for (const assignment of plan.assignments) {
          const updated = await client.query<DbRow>(`
            update callora.leads
            set assigned_employee_id = $3::uuid, updated_by_user_id = $4::uuid,
                updated_at = $5::timestamptz, version = version + 1
            where organization_id = $1::uuid and id = $2::uuid
              and assigned_employee_id is null and version = $6::bigint
            returning id
          `, [options.organizationId, assignment.leadId, assignment.employeeId,
            options.actorUserId, options.at, assignment.version]);
          if (!updated.rows[0]) continue;
          appliedLeads += 1;
          if (plan.ruleAdvances.has(assignment.ruleId)) {
            appliedRuleAdvances.set(
              assignment.ruleId,
              (appliedRuleAdvances.get(assignment.ruleId) ?? 0) + 1,
            );
          }
          await client.query(`
            insert into callora.lead_activities (
              organization_id, lead_id, actor_user_id, kind, summary,
              old_values, new_values, metadata, occurred_at, created_at
            ) values (
              $1::uuid, $2::uuid, $3::uuid, 'assigned', 'Lead assigned by rule',
              '{"assignedEmployeeId":null}'::jsonb, $4::jsonb, $5::jsonb,
              $6::timestamptz, $6::timestamptz
            )
          `, [options.organizationId, assignment.leadId, options.actorUserId,
            JSON.stringify({ assignedEmployeeId: assignment.employeeId }),
            JSON.stringify({ assignmentRuleId: assignment.ruleId, requestId: options.input.requestId }), options.at]);
          await this.insertOutboxEvent(client, options.organizationId, "lead", assignment.leadId, "lead.assigned", {
            leadId: assignment.leadId, employeeId: assignment.employeeId, assignmentRuleId: assignment.ruleId,
          });
        }
        for (const [ruleId, advance] of appliedRuleAdvances) {
          if (advance === 0) continue;
          await client.query(`
            update callora.lead_assignment_rules
            set round_robin_cursor = round_robin_cursor + $3::bigint,
                updated_by_user_id = $4::uuid, updated_at = $5::timestamptz,
                version = version + 1
            where organization_id = $1::uuid and id = $2::uuid and strategy = 'round_robin'
          `, [options.organizationId, ruleId, advance, options.actorUserId, options.at]);
        }
      }
      const result: ApplyLeadAssignmentRulesResult = {
        ...plan.dryRun,
        requestId: options.input.requestId,
        replayed: false,
        appliedLeads,
      };
      await client.query(`
        update callora.api_idempotency_keys
        set response_status = 200, response_body = $3::jsonb
        where organization_id = $1::uuid and scope = 'lead.assignment.apply' and idempotency_key = $2
      `, [options.organizationId, options.input.requestId, JSON.stringify(result)]);
      return result;
    });
  }

  async correctCallLeadLink(options: CorrectCallLeadLinkOptions): Promise<CorrectCallLeadLinkResult | undefined> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.actorUserId) ||
      !isCanonicalUuid(options.callId) ||
      options.input.expectedLeadId !== null && !isCanonicalUuid(options.input.expectedLeadId) ||
      options.input.replacementLeadId !== null && !isCanonicalUuid(options.input.replacementLeadId) ||
      !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) return undefined;
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const callResult = await client.query<DbRow>(`
        select call_log.id, employee.team_id
        from callora.call_logs as call_log
        join callora.employees as employee
          on employee.organization_id = call_log.organization_id and employee.id = call_log.employee_id
        where call_log.organization_id = $1::uuid and call_log.id = $2::uuid
        for update of call_log
      `, [options.organizationId, options.callId]);
      const callRow = callResult.rows[0];
      if (!callRow || typeof callRow.team_id !== "string") return undefined;
      // Check replay after locking the call but before comparing the mutable
      // active link. A completed retry must not fail its original CAS after
      // the first request has already changed that link.
      const priorLedger = await client.query<DbRow>(`
        select request_fingerprint, resource_id, response_body
        from callora.api_idempotency_keys
        where organization_id = $1::uuid
          and scope = 'lead.call_link.correct'
          and idempotency_key = $2
        for update
      `, [options.organizationId, options.input.requestId]);
      if (priorLedger.rows[0]) {
        const row = priorLedger.rows[0];
        if (row.request_fingerprint !== options.requestFingerprint || row.resource_id !== options.callId) {
          throw domainConflict("The correction request ID was already used with a different payload");
        }
        const stored = parseStoredObject<CorrectCallLeadLinkResult>(row.response_body);
        if (!stored) throw new Error("Call-link correction replay response is incomplete");
        return { ...stored, replayed: true };
      }
      const activeResult = await client.query<DbRow>(`
        select * from callora.call_lead_links
        where organization_id = $1::uuid and call_log_id = $2::uuid and unlinked_at is null
        for update
      `, [options.organizationId, options.callId]);
      const active = activeResult.rows[0];
      const currentLeadId = typeof active?.lead_id === "string" ? active.lead_id : null;
      if (currentLeadId !== options.input.expectedLeadId) {
        throw domainConflict("The call link changed; refresh and retry");
      }
      const accessLeadIds = [...new Set([currentLeadId, options.input.replacementLeadId]
        .filter((value): value is string => value !== null))].sort();
      const lockedLeads = accessLeadIds.length === 0 ? { rows: [] as DbRow[] } : await client.query<DbRow>(`
        select lead.id, lead.team_id, lead.assigned_employee_id, lead.archived_at,
          lead_team.name as team_name
        from callora.leads as lead
        join callora.teams as lead_team
          on lead_team.organization_id = lead.organization_id and lead_team.id = lead.team_id
        where lead.organization_id = $1::uuid and lead.id = any($2::uuid[])
        order by lead.id
        for update of lead
      `, [options.organizationId, accessLeadIds]);
      const leadById = new Map(lockedLeads.rows.map((row) => [String(row.id), row]));
      const canAccessLockedLead = (row: DbRow | undefined): boolean => Boolean(row) && (
        options.scope.kind === "organization" ||
        options.scope.kind === "assigned" && row!.assigned_employee_id === options.scope.employeeId ||
        options.scope.kind === "teams" && typeof row!.team_name === "string" &&
          options.scope.teamNames.includes(row!.team_name)
      );
      // The current link is historical state: allow authorized unlinking even
      // after archive/team reassignment. A replacement is a new active link
      // and must remain active, in the call's team, and in scope while locked.
      if (currentLeadId && !canAccessLockedLead(leadById.get(currentLeadId))) return undefined;
      if (options.input.replacementLeadId) {
        const replacement = leadById.get(options.input.replacementLeadId);
        if (!canAccessLockedLead(replacement) || replacement?.archived_at != null ||
          replacement?.team_id !== callRow.team_id) return undefined;
      }

      const ledger = await client.query<DbRow>(`
        insert into callora.api_idempotency_keys (
          organization_id, scope, idempotency_key, request_fingerprint,
          resource_type, resource_id, expires_at, created_at, updated_at
        ) values (
          $1::uuid, 'lead.call_link.correct', $2, $3,
          'call', $4::uuid, $5::timestamptz + interval '30 days',
          $5::timestamptz, $5::timestamptz
        ) on conflict (organization_id, scope, idempotency_key) do nothing
        returning id
      `, [options.organizationId, options.input.requestId, options.requestFingerprint, options.callId, options.at]);
      if (!ledger.rows[0]) {
        const replay = await client.query<DbRow>(`
          select request_fingerprint, resource_id, response_body
          from callora.api_idempotency_keys
          where organization_id = $1::uuid and scope = 'lead.call_link.correct' and idempotency_key = $2
          for update
        `, [options.organizationId, options.input.requestId]);
        const row = replay.rows[0];
        if (!row || row.request_fingerprint !== options.requestFingerprint || row.resource_id !== options.callId) {
          throw domainConflict("The correction request ID was already used with a different payload");
        }
        const stored = parseStoredObject<CorrectCallLeadLinkResult>(row.response_body);
        if (!stored) throw new Error("Call-link correction replay response is incomplete");
        return { ...stored, replayed: true };
      }

      if (active && currentLeadId) {
        await client.query(`
          update callora.call_lead_links
          set unlinked_at = $3::timestamptz, unlinked_by_user_id = $4::uuid,
              unlink_reason = $5
          where organization_id = $1::uuid and id = $2::uuid and unlinked_at is null
        `, [options.organizationId, active.id, options.at, options.actorUserId, options.input.reason.trim()]);
        await client.query(`
          insert into callora.lead_activities (
            organization_id, lead_id, actor_user_id, call_log_id, kind, summary,
            metadata, occurred_at, created_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'call_unlinked',
            'Call link corrected', $5::jsonb, $6::timestamptz, $6::timestamptz
          )
        `, [options.organizationId, currentLeadId, options.actorUserId, options.callId,
          JSON.stringify({ requestId: options.input.requestId, reason: options.input.reason.trim() }), options.at]);
      }
      if (options.input.replacementLeadId) {
        const linkId = randomUUID();
        await client.query(`
          insert into callora.call_lead_links (
            id, organization_id, call_log_id, lead_id, link_source,
            linked_by_user_id, correction_reason, linked_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'manual',
            $5::uuid, $6, $7::timestamptz
          )
        `, [linkId, options.organizationId, options.callId, options.input.replacementLeadId,
          options.actorUserId, options.input.reason.trim(), options.at]);
        await client.query(`
          insert into callora.lead_activities (
            organization_id, lead_id, actor_user_id, call_log_id, kind, summary,
            metadata, occurred_at, created_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'call_linked',
            'Call manually linked', $5::jsonb, $6::timestamptz, $6::timestamptz
          )
        `, [options.organizationId, options.input.replacementLeadId, options.actorUserId, options.callId,
          JSON.stringify({ requestId: options.input.requestId, reason: options.input.reason.trim(),
            linkId, linkSource: "manual" }), options.at]);
      }

      for (const leadId of new Set([currentLeadId, options.input.replacementLeadId].filter(
        (value): value is string => value !== null,
      ))) {
        await client.query(`
          update callora.leads as lead
          set last_contacted_at = linked.maximum_started_at,
              updated_by_user_id = $3::uuid, updated_at = $4::timestamptz,
              version = lead.version + 1
          from (
            select max(call_log.started_at) filter (where call_log.disposition = 'answered') as maximum_started_at
            from callora.call_lead_links as link
            join callora.call_logs as call_log
              on call_log.organization_id = link.organization_id and call_log.id = link.call_log_id
            where link.organization_id = $1::uuid and link.lead_id = $2::uuid and link.unlinked_at is null
          ) as linked
          where lead.organization_id = $1::uuid and lead.id = $2::uuid
            and lead.last_contacted_at is distinct from linked.maximum_started_at
        `, [options.organizationId, leadId, options.actorUserId, options.at]);
      }

      const result: CorrectCallLeadLinkResult = {
        requestId: options.input.requestId,
        callLogId: options.callId,
        previousLeadId: currentLeadId,
        replacementLeadId: options.input.replacementLeadId,
        correctedAt: options.at,
        replayed: false,
      };
      await client.query(`
        update callora.api_idempotency_keys
        set response_status = 200, response_body = $3::jsonb
        where organization_id = $1::uuid and scope = 'lead.call_link.correct' and idempotency_key = $2
      `, [options.organizationId, options.input.requestId, JSON.stringify(result)]);
      await client.query(`
        insert into callora.audit_events (
          id, organization_id, actor_user_id, action, entity_type, entity_id,
          request_id, metadata, occurred_at, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 'lead.call_link_corrected', 'call_lead_link',
          $4::uuid, $5, $6::jsonb, $7::timestamptz, $7::timestamptz
        )
      `, [randomUUID(), options.organizationId, options.actorUserId, options.callId,
        options.input.requestId, JSON.stringify({ previousLeadId: currentLeadId,
          replacementLeadId: options.input.replacementLeadId }), options.at]);
      return result;
    });
  }

  private async lockActiveMobileTrustWithClient(
    client: PgClientLike,
    context: MobileDeviceContext,
    at: string,
    requireCurrentConsent = true,
  ): Promise<{ actorUserId: string; device: DbRow; consentCurrent: boolean } | undefined> {
    // Shared mutation lock order: employee -> device -> all device credentials
    // (stable ID order) -> consent -> organization. Heartbeat, ingest, and
    // lead update must never acquire this trust graph in a different order.
    const employeeLock = await client.query<DbRow>(`
      select linked_user_id, status
      from callora.employees
      where organization_id = $1::uuid and id = $2::uuid
      for update
    `, [context.organizationId, context.employeeId]);
    const employeeRow = employeeLock.rows[0];
    if (!employeeRow || employeeRow.status !== "active") return undefined;
    const deviceLock = await client.query<DbRow>(`
      select *
      from callora.employee_devices
      where organization_id = $1::uuid and id = $2::uuid
      for update
    `, [context.organizationId, context.deviceId]);
    const deviceRow = deviceLock.rows[0];
    if (!deviceRow || deviceRow.employee_id !== context.employeeId ||
      deviceRow.status !== "connected" || deviceRow.revoked_at != null) return undefined;
    const credentialLocks = await client.query<DbRow>(`
      select id, employee_id, credential_type, lifecycle_state,
        consumed_at, revoked_at, expires_at
      from callora.device_credentials
      where organization_id = $1::uuid and device_id = $2::uuid
      order by id
      for update
    `, [context.organizationId, context.deviceId]);
    const credentialRow = credentialLocks.rows.find((row) => row.id === context.credentialId);
    if (!credentialRow || credentialRow.employee_id !== context.employeeId ||
      credentialRow.credential_type !== "session" || credentialRow.lifecycle_state !== "active" ||
      credentialRow.consumed_at != null || credentialRow.revoked_at != null ||
      Date.parse(String(credentialRow.expires_at)) <= Date.parse(at)) return undefined;
    const consentLock = await client.query<DbRow>(`
      select id
      from callora.device_consent_receipts
      where organization_id = $1::uuid and device_id = $2::uuid and withdrawn_at is null
      order by id
      for update
    `, [context.organizationId, context.deviceId]);
    const organizationLock = await client.query<DbRow>(`
      select status
      from callora.organizations
      where id = $1::uuid
      for update
    `, [context.organizationId]);
    if (!organizationLock.rows[0] || !["trial", "active"].includes(String(organizationLock.rows[0].status))) {
      return undefined;
    }
    if (!consentLock.rows[0] && requireCurrentConsent) throw domainConsentRequired();
    const consent = await client.query<DbRow>(`
      select callora.device_has_current_collection_consent(
        $1::uuid, $2::uuid, $3::timestamptz
      ) as consent_current
    `, [context.organizationId, context.deviceId, at]);
    const consentCurrent = Boolean(consentLock.rows[0]) && consent.rows[0]?.consent_current === true;
    if (requireCurrentConsent && !consentCurrent) throw domainConsentRequired();
    const actorUserId = employeeRow.linked_user_id;
    if (typeof actorUserId !== "string" || !isCanonicalUuid(actorUserId)) return undefined;
    return { actorUserId, device: deviceRow, consentCurrent };
  }

  async applyMobileLeadUpdate(options: MobileLeadUpdateOptions): Promise<MobileLeadUpdateReceipt | undefined> {
    const context = options.context;
    if (context.credentialType !== "session" ||
      !isCanonicalUuid(context.organizationId) || !isCanonicalUuid(context.employeeId) ||
      !isCanonicalUuid(context.deviceId) || !isCanonicalUuid(context.credentialId) ||
      !isCanonicalUuid(options.leadId) ||
      options.input.statusId !== undefined && !isCanonicalUuid(options.input.statusId) ||
      !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) return undefined;
    const idempotencyKey = `${context.deviceId}:${options.input.requestId}`;
    return this.withTenant(context.organizationId, undefined, async (client) => {
      const trust = await this.lockActiveMobileTrustWithClient(client, context, options.at);
      if (!trust) return undefined;
      const { actorUserId } = trust;

      // Exact device/request/resource/fingerprint binding is a replay grant
      // for the already-completed command. Check it before requiring the lead
      // to remain active or assigned; reassignment must not break retries.
      const prior = await client.query<DbRow>(`
        select request_fingerprint, resource_id, response_body
        from callora.api_idempotency_keys
        where organization_id = $1::uuid and scope = 'mobile.lead.update'
          and idempotency_key = $2 and resource_type = 'lead'
        for update
      `, [context.organizationId, idempotencyKey]);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.request_fingerprint !== options.requestFingerprint || row.resource_id !== options.leadId) {
          throw domainConflict("The mobile update request ID was already used with a different payload");
        }
        const stored = parseStoredObject<{ requestId: string; appliedLeadVersion: number }>(row.response_body);
        if (!stored || stored.requestId !== options.input.requestId ||
          !Number.isSafeInteger(stored.appliedLeadVersion)) {
          throw new Error("Mobile lead-update replay response is incomplete");
        }
        return {
          requestId: stored.requestId,
          replayed: true,
          appliedLeadVersion: stored.appliedLeadVersion,
        };
      }

      // The relative offline window is mutable with server time, so enforce
      // it only for a first application. An exact persisted replay remains
      // valid for the idempotency ledger lifetime after a lost response.
      const occurredAt = Date.parse(options.input.occurredAt);
      const receivedAt = Date.parse(options.at);
      if (occurredAt > receivedAt + 5 * 60 * 1_000 ||
        occurredAt < receivedAt - 7 * 24 * 60 * 60 * 1_000) {
        throw domainBadRequest("occurredAt is outside the accepted offline update window", "occurredAt");
      }

      const leadResult = await client.query<DbRow>(`
        select lead.*, lead_status.name as status_name,
          lead_status.is_won as status_is_won, lead_status.is_lost as status_is_lost
        from callora.leads as lead
        join callora.lead_statuses as lead_status
          on lead_status.organization_id = lead.organization_id and lead_status.id = lead.status_id
        where lead.organization_id = $1::uuid and lead.id = $2::uuid
          and lead.assigned_employee_id = $3::uuid and lead.archived_at is null
        for update of lead
      `, [context.organizationId, options.leadId, context.employeeId]);
      const leadRow = leadResult.rows[0];
      if (!leadRow || typeof leadRow.team_id !== "string") return undefined;

      const currentVersion = Number(leadRow.version);
      if (currentVersion !== options.input.expectedLeadVersion) {
        throw domainConflict("The lead changed; refresh and retry");
      }
      if (options.input.followUp?.reminderAt &&
        Date.parse(options.input.followUp.reminderAt) > Date.parse(options.input.followUp.dueAt)) {
        throw domainBadRequest("The follow-up reminder cannot be after its due time", "followUp.reminderAt");
      }

      let nextStatus = leadRow;
      if (options.input.statusId) {
        const status = await client.query<DbRow>(`
          select * from callora.lead_statuses
          where organization_id = $1::uuid and id = $2::uuid and is_active
          limit 1
        `, [context.organizationId, options.input.statusId]);
        if (!status.rows[0]) return undefined;
        nextStatus = status.rows[0];
      }

      const ledger = await client.query<DbRow>(`
        insert into callora.api_idempotency_keys (
          organization_id, scope, idempotency_key, request_fingerprint,
          resource_type, resource_id, expires_at, created_at, updated_at
        ) values (
          $1::uuid, 'mobile.lead.update', $2, $3,
          'lead', $4::uuid, $5::timestamptz + interval '30 days',
          $5::timestamptz, $5::timestamptz
        ) on conflict (organization_id, scope, idempotency_key) do nothing
        returning id
      `, [context.organizationId, idempotencyKey, options.requestFingerprint, options.leadId, options.at]);
      if (!ledger.rows[0]) {
        const collision = await client.query<DbRow>(`
          select request_fingerprint, resource_id, response_body
          from callora.api_idempotency_keys
          where organization_id = $1::uuid and scope = 'mobile.lead.update'
            and idempotency_key = $2
          for update
        `, [context.organizationId, idempotencyKey]);
        const row = collision.rows[0];
        if (!row || row.request_fingerprint !== options.requestFingerprint || row.resource_id !== options.leadId) {
          throw domainConflict("The mobile update request ID was already used with a different payload");
        }
        throw domainConflict("The mobile update is already being processed; retry shortly");
      }

      const metadata = { requestId: options.input.requestId, deviceId: context.deviceId };
      if (options.input.note) {
        const noteId = randomUUID();
        await client.query(`
          insert into callora.lead_notes (
            id, organization_id, lead_id, author_user_id, body, is_pinned,
            created_at, updated_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, false,
            $6::timestamptz, $6::timestamptz
          )
        `, [noteId, context.organizationId, options.leadId, actorUserId,
          options.input.note.body.trim(), options.at]);
        await client.query(`
          insert into callora.lead_activities (
            organization_id, lead_id, actor_employee_id, kind, summary,
            metadata, occurred_at, created_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, 'note_added', 'Mobile note added',
            $4::jsonb, $5::timestamptz, $6::timestamptz
          )
        `, [context.organizationId, options.leadId, context.employeeId,
          JSON.stringify({ ...metadata, noteId }), options.input.occurredAt, options.at]);
      }

      let followUpId: string | undefined;
      if (options.input.followUp) {
        followUpId = randomUUID();
        await client.query(`
          insert into callora.lead_follow_ups (
            id, organization_id, team_id, lead_id, assigned_employee_id,
            created_by_user_id, title, notes, due_at, reminder_at, priority,
            created_at, updated_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            $6::uuid, $7, $8, $9::timestamptz, $10::timestamptz, $11,
            $12::timestamptz, $12::timestamptz
          )
        `, [followUpId, context.organizationId, leadRow.team_id, options.leadId,
          context.employeeId, actorUserId, options.input.followUp.title.trim(),
          options.input.followUp.notes?.trim() ?? null, options.input.followUp.dueAt,
          options.input.followUp.reminderAt ?? null, options.input.followUp.priority ?? "normal", options.at]);
        await client.query(`
          insert into callora.lead_activities (
            organization_id, lead_id, actor_employee_id, kind, summary,
            metadata, occurred_at, created_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, 'follow_up_created',
            'Mobile follow-up scheduled', $4::jsonb,
            $5::timestamptz, $6::timestamptz
          )
        `, [context.organizationId, options.leadId, context.employeeId,
          JSON.stringify({ ...metadata, followUpId }), options.input.occurredAt, options.at]);
      }

      const statusChanged = options.input.statusId !== undefined && options.input.statusId !== leadRow.status_id;
      if (statusChanged) {
        await client.query(`
          insert into callora.lead_activities (
            organization_id, lead_id, actor_employee_id, kind, summary,
            old_values, new_values, metadata, occurred_at, created_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, 'status_changed', $4,
            $5::jsonb, $6::jsonb, $7::jsonb, $8::timestamptz, $9::timestamptz
          )
        `, [context.organizationId, options.leadId, context.employeeId,
          `Status changed to ${String(nextStatus.name)}`,
          JSON.stringify({ statusId: leadRow.status_id, version: currentVersion }),
          JSON.stringify({ statusId: options.input.statusId, version: currentVersion + 1 }),
          JSON.stringify(metadata), options.input.occurredAt, options.at]);
      }

      const nextIsWon = options.input.statusId ? nextStatus.is_won === true : leadRow.status_is_won === true;
      const nextIsLost = options.input.statusId ? nextStatus.is_lost === true : leadRow.status_is_lost === true;
      const updated = await client.query<DbRow>(`
        update callora.leads
        set status_id = $4::uuid,
            converted_at = case when $5::boolean then coalesce(converted_at, $8::timestamptz) else null end,
            lost_at = case when $6::boolean then coalesce(lost_at, $8::timestamptz) else null end,
            next_follow_up_at = case
              when $7::timestamptz is null then next_follow_up_at
              when next_follow_up_at is null then $7::timestamptz
              else least(next_follow_up_at, $7::timestamptz)
            end,
            updated_by_user_id = $9::uuid,
            updated_at = $8::timestamptz,
            version = version + 1
        where organization_id = $1::uuid and id = $2::uuid
          and assigned_employee_id = $3::uuid and version = $10::bigint
        returning version
      `, [context.organizationId, options.leadId, context.employeeId,
        options.input.statusId ?? leadRow.status_id, nextIsWon,
        nextIsLost, options.input.followUp?.dueAt ?? null,
        options.at, actorUserId, currentVersion]);
      const appliedLeadVersion = Number(updated.rows[0]?.version);
      if (!Number.isSafeInteger(appliedLeadVersion)) throw domainConflict("The lead changed; refresh and retry");

      await this.insertOutboxEvent(client, context.organizationId, "lead", options.leadId, "lead.mobile_updated", {
        leadId: options.leadId,
        employeeId: context.employeeId,
        deviceId: context.deviceId,
        requestId: options.input.requestId,
        appliedLeadVersion,
      });
      if (followUpId) {
        await this.insertOutboxEvent(client, context.organizationId, "follow_up", followUpId, "follow_up.created", {
          followUpId,
          leadId: options.leadId,
          employeeId: context.employeeId,
        });
      }
      await client.query(`
        insert into callora.audit_events (
          id, organization_id, actor_device_id, action, entity_type, entity_id,
          request_id, metadata, occurred_at, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 'lead.mobile_updated', 'lead', $4::uuid,
          $5, $6::jsonb, $7::timestamptz, $7::timestamptz
        )
      `, [randomUUID(), context.organizationId, context.deviceId, options.leadId,
        options.input.requestId, JSON.stringify({ employeeId: context.employeeId, appliedLeadVersion }), options.at]);
      await client.query(`
        update callora.api_idempotency_keys
        set response_status = 200, response_body = $3::jsonb
        where organization_id = $1::uuid and scope = 'mobile.lead.update'
          and idempotency_key = $2
      `, [context.organizationId, idempotencyKey,
        JSON.stringify({ requestId: options.input.requestId, appliedLeadVersion })]);

      const detail = await this.findLeadDetailWithClient(
        client,
        context.organizationId,
        { kind: "assigned", employeeId: context.employeeId },
        options.leadId,
        options.at,
      );
      if (!detail) throw new Error("Updated mobile lead disappeared inside its tenant transaction");
      return {
        requestId: options.input.requestId,
        replayed: false,
        appliedLeadVersion,
        detail,
      };
    });
  }

  async getLeadReport(options: LeadReportOptions): Promise<LeadReport> {
    if (!isCanonicalUuid(options.organizationId) ||
      options.filter.employeeId !== undefined && !isCanonicalUuid(options.filter.employeeId) ||
      options.filter.source !== undefined && !isLeadSource(options.filter.source)) {
      throw new Error("Lead report filter is invalid");
    }
    return this.withTenant(options.organizationId, undefined, async (client) => {
      const reportQuery = async (selectSql: string): Promise<DbRow[]> => {
        const values: unknown[] = [
          options.organizationId,
          options.filter.from,
          options.filter.to,
          options.filter.employeeId ?? null,
          options.filter.team ?? null,
          options.filter.source ?? null,
          options.at,
          options.timeZone,
        ];
        const scope = leadScopePredicate(options.scope, values);
        const result = await client.query<DbRow>(`
          with cohort as materialized (
            select lead.*, lead_status.name as status_name,
              lead_status.is_won as status_is_won, lead_status.is_lost as status_is_lost,
              employee.display_name as employee_display_name,
              first_response.first_response_seconds
            from callora.leads as lead
            join callora.lead_statuses as lead_status
              on lead_status.organization_id = lead.organization_id and lead_status.id = lead.status_id
            join callora.teams as lead_team
              on lead_team.organization_id = lead.organization_id and lead_team.id = lead.team_id
            left join callora.employees as employee
              on employee.organization_id = lead.organization_id and employee.id = lead.assigned_employee_id
            -- First response is the earliest answered call on the current
            -- (possibly corrected) active link. Historical unlinked calls and
            -- calls answered before lead creation do not enter the metric.
            left join lateral (
              select extract(epoch from (call_log.answered_at - lead.created_at))::double precision
                as first_response_seconds
              from callora.call_lead_links as active_link
              join callora.call_logs as call_log
                on call_log.organization_id = active_link.organization_id
               and call_log.id = active_link.call_log_id
              where active_link.organization_id = lead.organization_id
                and active_link.lead_id = lead.id
                and active_link.unlinked_at is null
                and call_log.disposition = 'answered'
                and call_log.answered_at is not null
                and call_log.answered_at >= lead.created_at
              order by call_log.answered_at, call_log.id
              limit 1
            ) as first_response on true
            where lead.organization_id = $1::uuid and lead.archived_at is null
              and lead.created_at >= $2::timestamptz and lead.created_at < $3::timestamptz
              and ($4::uuid is null or lead.assigned_employee_id = $4::uuid)
              and ($5::text is null or lead_team.name = $5)
              and ($6::text is null or lead.source = $6)
              and ${scope}
          )
          ${selectSql}
        `, values);
        return result.rows;
      };

      const [kpiRows, pipelineRows, trendRows, ownerRows, sourceRows] = await Promise.all([
        reportQuery(`
          select count(*)::integer as total_leads,
            count(*) filter (where converted_at is not null)::integer as converted_leads,
            round(avg(first_response_seconds))::bigint as average_first_response_seconds,
            coalesce((
              select count(*)::integer
              from callora.lead_follow_ups as follow_up
              join cohort on cohort.organization_id = follow_up.organization_id
                and cohort.id = follow_up.lead_id
              where follow_up.status = 'pending' and follow_up.due_at <= $7::timestamptz
            ), 0)::integer as follow_ups_due
          from cohort
        `),
        reportQuery(`
          select status.id as status_id, status.name as status_name, status.color,
            status.is_won, status.is_lost, count(cohort.id)::integer as lead_count
          from callora.lead_statuses as status
          left join cohort on cohort.organization_id = status.organization_id
            and cohort.status_id = status.id
          where status.organization_id = $1::uuid and status.is_active
          group by status.id
          order by status.position, status.id
        `),
        reportQuery(`
          select (date_trunc('day', created_at at time zone $8) at time zone $8) as bucket_start,
            count(*)::integer as created,
            count(*) filter (where converted_at is not null)::integer as won
          from cohort
          group by bucket_start
          order by bucket_start
        `),
        reportQuery(`
          select assigned_employee_id as employee_id,
            coalesce(max(employee_display_name), 'Unassigned') as display_name,
            count(*)::integer as assigned,
            count(*) filter (where last_contacted_at is not null)::integer as contacted,
            count(*) filter (where converted_at is not null)::integer as won,
            round(avg(first_response_seconds))::bigint as average_response_seconds,
            coalesce(sum((
              select count(*)::integer
              from callora.lead_follow_ups as follow_up
              where follow_up.organization_id = cohort.organization_id
                and follow_up.lead_id = cohort.id
                and follow_up.status = 'pending' and follow_up.due_at < $7::timestamptz
            )), 0)::integer as overdue_follow_ups
          from cohort
          group by assigned_employee_id
          order by lower(coalesce(max(employee_display_name), 'Unassigned')), assigned_employee_id nulls first
        `),
        reportQuery(`
          select source, count(*)::integer as leads,
            count(*) filter (where last_contacted_at is not null)::integer as contacted,
            count(*) filter (where lower(status_name) = 'qualified')::integer as qualified,
            count(*) filter (where converted_at is not null)::integer as won
          from cohort
          group by source
          order by count(*) desc, source
        `),
      ]);
      const kpi = kpiRows[0] ?? {};
      const totalLeads = Number(kpi.total_leads ?? 0);
      const convertedLeads = Number(kpi.converted_leads ?? 0);
      const percentage = (value: number, denominator = totalLeads): number =>
        denominator === 0 ? 0 : Math.round(value * 10_000 / denominator) / 100;
      return {
        filter: options.filter,
        kpis: {
          totalLeads,
          convertedLeads,
          conversionRate: percentage(convertedLeads),
          followUpsDue: Number(kpi.follow_ups_due ?? 0),
          ...(kpi.average_first_response_seconds === null || kpi.average_first_response_seconds === undefined
            ? {}
            : { averageFirstResponseSeconds: Number(kpi.average_first_response_seconds) }),
        },
        pipeline: pipelineRows.map((row) => ({
          statusId: String(row.status_id),
          statusName: String(row.status_name),
          color: String(row.color),
          leadCount: Number(row.lead_count),
          percentageOfTotal: percentage(Number(row.lead_count)),
          isWon: row.is_won === true,
          isLost: row.is_lost === true,
        })),
        trend: trendRows.map((row) => ({
          bucketStart: new Date(String(row.bucket_start)).toISOString(),
          created: Number(row.created),
          won: Number(row.won),
        })),
        owners: ownerRows.map((row) => {
          const assigned = Number(row.assigned);
          const won = Number(row.won);
          return {
            employeeId: typeof row.employee_id === "string" ? row.employee_id : null,
            displayName: String(row.display_name),
            assigned,
            contacted: Number(row.contacted),
            won,
            conversionRate: percentage(won, assigned),
            overdueFollowUps: Number(row.overdue_follow_ups),
            ...(row.average_response_seconds === null || row.average_response_seconds === undefined
              ? {}
              : { averageResponseSeconds: Number(row.average_response_seconds) }),
          };
        }),
        sources: sourceRows.map((row) => {
          const leads = Number(row.leads);
          const won = Number(row.won);
          return {
            source: String(row.source) as LeadSource,
            leads,
            contacted: Number(row.contacted),
            qualified: Number(row.qualified),
            won,
            conversionRate: percentage(won, leads),
            percentageOfTotal: percentage(leads),
          };
        }),
        generatedAt: options.at,
        timeZone: options.timeZone,
        metricDefinitionVersion: "2026-07-15",
      };
    });
  }

  async getReportAutomation(organizationId: OrganizationId, userId: string): Promise<ReportAutomationSnapshot> {
    if (!isCanonicalUuid(organizationId) || !isCanonicalUuid(userId)) return { savedViews: [], schedules: [], preferences: [], jobs: [] };
    return this.withTenant(organizationId, userId, async (client) => {
      const [views, schedules, preferences, jobs] = await Promise.all([
        client.query<DbRow>(`select * from callora.saved_report_views where organization_id=$1::uuid and owner_user_id=$2::uuid order by updated_at desc`, [organizationId, userId]),
        client.query<DbRow>(`select * from callora.report_schedules where organization_id=$1::uuid order by next_run_at, id`, [organizationId]),
        client.query<DbRow>(`select * from callora.notification_preferences where organization_id=$1::uuid and user_id=$2::uuid order by event_key`, [organizationId, userId]),
        client.query<DbRow>(`select * from callora.report_export_jobs where organization_id=$1::uuid and requested_by_user_id=$2::uuid order by requested_at desc limit 25`, [organizationId, userId]),
      ]);
      return {
        savedViews: views.rows.map((row) => ({ id: String(row.id), organizationId: String(row.organization_id), ownerUserId: String(row.owner_user_id), name: String(row.name), kind: String(row.report_kind) as SavedReportView["kind"], filters: row.filters as SavedReportView["filters"], createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() })),
        schedules: schedules.rows.map((row) => ({ id: String(row.id), organizationId: String(row.organization_id), savedViewId: String(row.saved_view_id), name: String(row.name), cadence: String(row.cadence) as ReportSchedule["cadence"], ...(row.week_day === null ? {} : { weekDay: Number(row.week_day) }), localTime: String(row.local_time).slice(0,5), timeZone: String(row.time_zone), format: String(row.format) as ReportSchedule["format"], recipients: row.recipients as string[], status: String(row.status) as ReportSchedule["status"], nextRunAt: new Date(String(row.next_run_at)).toISOString(), ...(row.last_run_at === null ? {} : { lastRunAt: new Date(String(row.last_run_at)).toISOString() }) })),
        preferences: preferences.rows.map((row) => ({ event: String(row.event_key) as NotificationPreference["event"], email: row.email_enabled === true, inApp: row.in_app_enabled === true })),
        jobs: jobs.rows.map((row) => ({ id: String(row.id), kind: String(row.report_kind) as ReportExportJob["kind"], format: String(row.format) as ReportExportJob["format"], status: String(row.status) as ReportExportJob["status"], requestedAt: new Date(String(row.requested_at)).toISOString(), ...(row.completed_at === null ? {} : { completedAt: new Date(String(row.completed_at)).toISOString() }), ...(row.download_expires_at === null ? {} : { expiresAt: new Date(String(row.download_expires_at)).toISOString() }), ...(row.failure_message === null ? {} : { failureMessage: String(row.failure_message) }) })),
      };
    });
  }

  async createSavedReportView(options: { organizationId: OrganizationId; userId: string; name: string; kind: SavedReportView["kind"]; filters: SavedReportView["filters"]; at: string }): Promise<SavedReportView> {
    const id = randomUUID();
    return this.withTenant(options.organizationId, options.userId, async (client) => {
      await client.query(`insert into callora.saved_report_views (organization_id,id,owner_user_id,name,report_kind,filters,created_at,updated_at) values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::timestamptz,$7::timestamptz)`, [options.organizationId,id,options.userId,options.name,options.kind,JSON.stringify(options.filters),options.at]);
      return { id, organizationId: options.organizationId, ownerUserId: options.userId, name: options.name, kind: options.kind, filters: options.filters, createdAt: options.at, updatedAt: options.at };
    });
  }

  async createReportSchedule(options: { organizationId: OrganizationId; userId: string; savedViewId: string; name: string; cadence: ReportSchedule["cadence"]; weekDay?: number; localTime: string; timeZone: string; format: ReportSchedule["format"]; recipients: string[]; nextRunAt: string; at: string }): Promise<ReportSchedule | undefined> {
    if (!isCanonicalUuid(options.savedViewId)) return undefined;
    const id=randomUUID();
    return this.withTenant(options.organizationId, options.userId, async (client) => {
      const result=await client.query<DbRow>(`insert into callora.report_schedules (organization_id,id,saved_view_id,created_by_user_id,name,cadence,week_day,local_time,time_zone,format,recipients,next_run_at,created_at,updated_at) select $1::uuid,$2::uuid,id,$3::uuid,$4,$5,$6::smallint,$7::time,$8,$9,$10::jsonb,$11::timestamptz,$12::timestamptz,$12::timestamptz from callora.saved_report_views where organization_id=$1::uuid and id=$13::uuid returning id`, [options.organizationId,id,options.userId,options.name,options.cadence,options.weekDay??null,options.localTime,options.timeZone,options.format,JSON.stringify(options.recipients),options.nextRunAt,options.at,options.savedViewId]);
      if(result.rows.length!==1) return undefined;
      return { id, organizationId:options.organizationId,savedViewId:options.savedViewId,name:options.name,cadence:options.cadence,...(options.weekDay===undefined?{}:{weekDay:options.weekDay}),localTime:options.localTime,timeZone:options.timeZone,format:options.format,recipients:options.recipients,status:"active",nextRunAt:options.nextRunAt };
    });
  }

  async updateReportSchedule(options: { organizationId: OrganizationId; scheduleId: string; status: ReportSchedule["status"]; at: string }): Promise<ReportSchedule | undefined> {
    if(!isCanonicalUuid(options.scheduleId)) return undefined;
    return this.withTenant(options.organizationId, undefined, async(client)=>{ const result=await client.query<DbRow>(`update callora.report_schedules set status=$3,updated_at=$4::timestamptz where organization_id=$1::uuid and id=$2::uuid returning *`,[options.organizationId,options.scheduleId,options.status,options.at]); const row=result.rows[0]; if(!row)return undefined; return {id:String(row.id),organizationId:String(row.organization_id),savedViewId:String(row.saved_view_id),name:String(row.name),cadence:String(row.cadence) as ReportSchedule["cadence"],...(row.week_day===null?{}:{weekDay:Number(row.week_day)}),localTime:String(row.local_time).slice(0,5),timeZone:String(row.time_zone),format:String(row.format) as ReportSchedule["format"],recipients:row.recipients as string[],status:String(row.status) as ReportSchedule["status"],nextRunAt:new Date(String(row.next_run_at)).toISOString()}; });
  }

  async updateNotificationPreferences(options: { organizationId: OrganizationId; userId: string; preferences: NotificationPreference[]; at: string }): Promise<NotificationPreference[]> {
    return this.withTenant(options.organizationId,options.userId,async(client)=>{ for(const item of options.preferences){await client.query(`insert into callora.notification_preferences (organization_id,user_id,event_key,email_enabled,in_app_enabled,updated_at) values ($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz) on conflict (organization_id,user_id,event_key) do update set email_enabled=excluded.email_enabled,in_app_enabled=excluded.in_app_enabled,updated_at=excluded.updated_at`,[options.organizationId,options.userId,item.event,item.email,item.inApp,options.at]);} return options.preferences; });
  }

  async createReportExportJob(options: { organizationId: OrganizationId; userId: string; kind: ReportExportJob["kind"]; format: ReportExportJob["format"]; parameters: Record<string, unknown>; at: string }): Promise<ReportExportJob> {
    const id=randomUUID(); await this.withTenant(options.organizationId,options.userId,(client)=>client.query(`insert into callora.report_export_jobs (organization_id,id,requested_by_user_id,report_kind,format,parameters,requested_at) values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::timestamptz)`,[options.organizationId,id,options.userId,options.kind,options.format,JSON.stringify(options.parameters),options.at])); return {id,kind:options.kind,format:options.format,status:"queued",requestedAt:options.at};
  }

  async completeReportExportJob(options: { organizationId: OrganizationId; jobId: string; objectKey: string; tokenHash: Uint8Array; expiresAt: string; at: string }): Promise<boolean> {
    if(!isCanonicalUuid(options.jobId)||options.tokenHash.length!==32)return false; return this.withTenant(options.organizationId,undefined,async(client)=>{const result=await client.query<DbRow>(`update callora.report_export_jobs set status='ready',object_key=$3,download_token_hash=$4::bytea,download_expires_at=$5::timestamptz,completed_at=$6::timestamptz,lease_owner=null,lease_expires_at=null where organization_id=$1::uuid and id=$2::uuid and status in ('queued','processing') returning id`,[options.organizationId,options.jobId,options.objectKey,Buffer.from(options.tokenHash),options.expiresAt,options.at]);return result.rows.length===1;});
  }

  async redeemReportDownload(options: { organizationId: OrganizationId; userId: string; jobId: string; tokenHash: Uint8Array; redemptionId: string; at: string }): Promise<{ objectKey: string; expiresAt: string } | undefined> {
    if(!isCanonicalUuid(options.jobId)||!isCanonicalUuid(options.redemptionId)||options.tokenHash.length!==32)return undefined; return this.withTenant(options.organizationId,options.userId,async(client)=>{const result=await client.query<DbRow>(`with eligible as (select object_key,download_expires_at from callora.report_export_jobs j where j.organization_id=$1::uuid and j.id=$2::uuid and j.requested_by_user_id=$3::uuid and j.status='ready' and j.download_expires_at>$4::timestamptz and j.download_token_hash=$5::bytea and not exists (select 1 from callora.report_download_redemptions r where r.organization_id=j.organization_id and r.report_export_job_id=j.id) for update), redeemed as (insert into callora.report_download_redemptions (organization_id,id,report_export_job_id,redeemed_by_user_id,token_fingerprint,redeemed_at) select $1::uuid,$6::uuid,$2::uuid,$3::uuid,$5::bytea,$4::timestamptz from eligible returning id) select object_key,download_expires_at from eligible where exists(select 1 from redeemed)`,[options.organizationId,options.jobId,options.userId,options.at,Buffer.from(options.tokenHash),options.redemptionId]);const row=result.rows[0];return row?{objectKey:String(row.object_key),expiresAt:new Date(String(row.download_expires_at)).toISOString()}:undefined;});
  }

  async listNotificationInbox(organizationId: OrganizationId, userId: string, limit: number): Promise<NotificationInbox> {
    if(!isCanonicalUuid(organizationId)||!isCanonicalUuid(userId))return{items:[],unreadCount:0}; const bounded=boundedInteger(limit,1,100,"limit"); return this.withTenant(organizationId,userId,async(client)=>{const [items,count]=await Promise.all([client.query<DbRow>(`select id,event_key,title,body,action_url,created_at,read_at from callora.in_app_notifications where organization_id=$1::uuid and user_id=$2::uuid order by created_at desc,id desc limit $3::integer`,[organizationId,userId,bounded]),client.query<DbRow>(`select count(*)::integer as count from callora.in_app_notifications where organization_id=$1::uuid and user_id=$2::uuid and read_at is null`,[organizationId,userId])]);return{items:items.rows.map((row)=>({id:String(row.id),event:String(row.event_key) as InAppNotification["event"],title:String(row.title),body:String(row.body),...(row.action_url===null?{}:{actionUrl:String(row.action_url)}),createdAt:new Date(String(row.created_at)).toISOString(),...(row.read_at===null?{}:{readAt:new Date(String(row.read_at)).toISOString()})})),unreadCount:Number(count.rows[0]?.count??0)};});
  }

  async markNotificationRead(options: { organizationId: OrganizationId; userId: string; notificationId: string; at: string }): Promise<InAppNotification | undefined> {
    if(!isCanonicalUuid(options.notificationId))return undefined;return this.withTenant(options.organizationId,options.userId,async(client)=>{const result=await client.query<DbRow>(`update callora.in_app_notifications set read_at=coalesce(read_at,$4::timestamptz) where organization_id=$1::uuid and user_id=$2::uuid and id=$3::uuid returning id,event_key,title,body,action_url,created_at,read_at`,[options.organizationId,options.userId,options.notificationId,options.at]);const row=result.rows[0];return row?{id:String(row.id),event:String(row.event_key) as InAppNotification["event"],title:String(row.title),body:String(row.body),...(row.action_url===null?{}:{actionUrl:String(row.action_url)}),createdAt:new Date(String(row.created_at)).toISOString(),readAt:new Date(String(row.read_at)).toISOString()}:undefined;});
  }

  async findDevice(organizationId: OrganizationId, deviceId: string): Promise<EmployeeDevice | undefined> {
    if (!isCanonicalUuid(organizationId) || !isCanonicalUuid(deviceId)) return undefined;
    return this.withTenant(organizationId, undefined, (client) =>
      this.findDeviceWithClient(client, organizationId, deviceId));
  }

  async revokeDeviceByAdministrator(options: {
    organizationId: OrganizationId;
    deviceId: string;
    actorUserId: string;
    requestId: string;
    requestFingerprint: string;
    reason: string;
    auditEventId: string;
    outboxEventId: string;
    at: string;
  }): Promise<AdminRevokeDeviceResult | undefined> {
    if (!isCanonicalUuid(options.deviceId)) return undefined;
    for (const [name, value] of [
      ["organizationId", options.organizationId],
      ["actorUserId", options.actorUserId],
      ["requestId", options.requestId],
      ["auditEventId", options.auditEventId],
      ["outboxEventId", options.outboxEventId],
    ] as const) assertTrustedUuid(value, name);
    if (!/^[0-9a-f]{64}$/.test(options.requestFingerprint)) {
      throw new Error("requestFingerprint must be a SHA-256 hex digest");
    }

    try {
      return await this.withTenant(options.organizationId, options.actorUserId, async (client) => {
        const transition = await client.query<DbRow>(`
          select * from callora.admin_revoke_device(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            $6::uuid, decode($7, 'hex'), $8, $9::timestamptz
          )
        `, [
          options.requestId,
          options.organizationId,
          options.deviceId,
          options.actorUserId,
          options.auditEventId,
          options.outboxEventId,
          options.requestFingerprint,
          options.reason,
          options.at,
        ]);
        const row = transition.rows[0];
        if (!row) return undefined;
        const stored = parseStoredObject<Record<string, unknown>>(row.response_body);
        if (!stored ||
          stored.deviceId !== options.deviceId ||
          typeof stored.employeeId !== "string" ||
          !isIsoDateTime(stored.revokedAt) ||
          typeof stored.reason !== "string" ||
          typeof stored.revokedCredentialCount !== "number" ||
          !Number.isSafeInteger(stored.revokedCredentialCount) ||
          stored.revokedCredentialCount < 0 ||
          typeof stored.consentWithdrawn !== "boolean") {
          throw new Error("Administrative device revocation returned an invalid response");
        }
        return {
          deviceId: options.deviceId,
          employeeId: stored.employeeId,
          revokedAt: stored.revokedAt,
          reason: stored.reason,
          revokedCredentialCount: stored.revokedCredentialCount,
          consentWithdrawn: stored.consentWithdrawn,
          replayed: row.replayed === true,
        };
      });
    } catch (error) {
      const code = postgresCode(error);
      if (code === "23505") {
        throw domainConflict("The request ID was already used with a different device revocation payload");
      }
      if (code === "23503") return undefined;
      if (code === "42501") throw domainForbidden();
      if (code === "55000") throw domainConflict("The device has already been revoked");
      throw error;
    }
  }

  async countOfflineDevices(organizationId: OrganizationId, employeeId?: string): Promise<number> {
    if (!isCanonicalUuid(organizationId) || (employeeId !== undefined && !isCanonicalUuid(employeeId))) return 0;
    return this.withTenant(organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select count(*)::integer as count
        from callora.employee_devices
        where organization_id = $1::uuid
          and status <> 'connected'
          and ($2::uuid is null or employee_id = $2::uuid)
      `, [organizationId, employeeId ?? null]);
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  async createPairingCode(record: PairingCodeRecord): Promise<void> {
    for (const [name, value] of [
      ["organizationId", record.organizationId],
      ["pairingCodeId", record.id],
      ["employeeId", record.employeeId],
      ["createdByUserId", record.createdByUserId],
    ] as const) assertTrustedUuid(value, name);
    await this.withTenant(record.organizationId, record.createdByUserId, async (client) => {
      await client.query(`
        insert into callora.device_pairing_codes (
          id, organization_id, employee_id, code_hash, code_hint,
          created_by_user_id, collection_mode, expires_at, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, decode($4, 'hex'), $5,
          $6::uuid, $7, $8::timestamptz, $9::timestamptz
        )
      `, [
        record.id,
        record.organizationId,
        record.employeeId,
        record.codeHash,
        record.codeLastFour,
        record.createdByUserId,
        record.collectionMode,
        record.expiresAt,
        record.createdAt,
      ]);
      await this.insertOutboxEvent(
        client,
        record.organizationId,
        "pairing_code",
        record.id,
        "pairing_code.created",
        { pairingCodeId: record.id, employeeId: record.employeeId },
      );
    });
  }

  async revokePairingCode(
    organizationId: OrganizationId,
    pairingCodeId: string,
    at: string,
  ): Promise<PairingCodeRecord | undefined> {
    if (!isCanonicalUuid(organizationId) || !isCanonicalUuid(pairingCodeId)) return undefined;
    return this.withTenant(organizationId, undefined, async (client) => {
      const revoked = await client.query<DbRow>(`
        update callora.device_pairing_codes
        set revoked_at = $3::timestamptz
        where organization_id = $1::uuid
          and id = $2::uuid
          and consumed_at is null
          and revoked_at is null
        returning id, employee_id
      `, [organizationId, pairingCodeId, at]);
      if (revoked.rows[0]) {
        await this.insertOutboxEvent(
          client,
          organizationId,
          "pairing_code",
          pairingCodeId,
          "pairing_code.revoked",
          { pairingCodeId, employeeId: revoked.rows[0].employee_id },
        );
      }
      const result = await client.query<DbRow>(`
        select ${PAIRING_COLUMNS}
        from callora.device_pairing_codes as pairing
        where pairing.organization_id = $1::uuid and pairing.id = $2::uuid
        limit 1
      `, [organizationId, pairingCodeId]);
      return result.rows[0] ? mapPairingCode(result.rows[0]) : undefined;
    });
  }

  async redeemPairingCode(options: {
    codeHash: string;
    registration: DeviceRegistration;
    bootstrapCredential: NewDeviceCredential;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<PairingRedemptionResult> {
    if (!/^[0-9a-f]{64}$/.test(options.codeHash)) return { outcome: "not_found" };
    assertTrustedUuid(options.bootstrapCredential.id, "bootstrapCredentialId");
    assertTrustedUuid(options.requestId, "requestId");
    if (options.bootstrapCredential.credentialType !== "bootstrap" ||
      options.bootstrapCredential.requestId !== options.requestId ||
      options.bootstrapCredential.lifecycleState !== "active" ||
      !/^[0-9a-f]{64}$/.test(options.bootstrapCredential.tokenHash) ||
      !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) {
      throw new Error("bootstrap credential must be a peppered SHA-256 hash");
    }
    const replayResolution = await this.pool.query<DbRow>(`
      select organization_id, device_id, credential_id, response_body
      from callora.resolve_pairing_redemption_replay(
        decode($1, 'hex'), $2::uuid, decode($3, 'hex')
      )
    `, [options.codeHash, options.requestId, options.requestFingerprint]);
    const replayOrganizationId = replayResolution.rows[0]?.organization_id;
    const replayDeviceId = replayResolution.rows[0]?.device_id;
    if (typeof replayOrganizationId === "string" && typeof replayDeviceId === "string" &&
      isCanonicalUuid(replayOrganizationId) && isCanonicalUuid(replayDeviceId)) {
      return this.withTenant(replayOrganizationId, undefined, async (client) => {
        const stored = parseStoredObject<Record<string, unknown>>(replayResolution.rows[0]?.response_body);
        const expiresAt = stored?.expiresAt;
        if (!isIsoDateTime(expiresAt)) {
          throw new Error("Stored pairing redemption response is invalid");
        }
        const pairingResult = await client.query<DbRow>(`
          select ${PAIRING_COLUMNS}
          from callora.device_pairing_codes as pairing
          where pairing.organization_id = $1::uuid and pairing.code_hash = decode($2, 'hex')
          limit 1
        `, [replayOrganizationId, options.codeHash]);
        const record = pairingResult.rows[0] ? mapPairingCode(pairingResult.rows[0]) : undefined;
        const device = await this.findDeviceWithClient(client, replayOrganizationId, replayDeviceId);
        if (!record || !device) throw new Error("Stored pairing redemption resources are unavailable");
        return { outcome: "redeemed", record, device, bootstrapExpiresAt: expiresAt, replayed: true };
      });
    }
    const resolution = await this.pool.query<DbRow>(`
      select callora.resolve_pairing_code_organization(decode($1, 'hex')) as organization_id
    `, [options.codeHash]);
    const organizationId = resolution.rows[0]?.organization_id;
    if (typeof organizationId !== "string" || !isCanonicalUuid(organizationId)) {
      return { outcome: "not_found" };
    }

    return this.withTenant(organizationId, undefined, async (client) => {
      const pairingResult = await client.query<DbRow>(`
        select ${PAIRING_COLUMNS}
        from callora.device_pairing_codes as pairing
        where pairing.organization_id = $1::uuid
          and pairing.code_hash = decode($2, 'hex')
        for update
      `, [organizationId, options.codeHash]);
      const pairingRow = pairingResult.rows[0];
      if (!pairingRow) return { outcome: "not_found" };
      const record = mapPairingCode(pairingRow);
      if (record.revokedAt) return { outcome: "revoked", record };
      if (record.consumedAt) {
        const concurrentReplay = await client.query<DbRow>(`
          select organization_id, device_id, response_body
          from callora.resolve_pairing_redemption_replay(
            decode($1, 'hex'), $2::uuid, decode($3, 'hex')
          )
        `, [options.codeHash, options.requestId, options.requestFingerprint]);
        const replayRow = concurrentReplay.rows[0];
        const stored = parseStoredObject<Record<string, unknown>>(replayRow?.response_body);
        const expiresAt = stored?.expiresAt;
        if (typeof replayRow?.device_id === "string" && isIsoDateTime(expiresAt)) {
          const device = await this.findDeviceWithClient(client, organizationId, replayRow.device_id);
          if (device) return {
            outcome: "redeemed", record, device, bootstrapExpiresAt: expiresAt, replayed: true,
          };
        }
        return { outcome: "consumed", record };
      }
      if (Date.parse(record.expiresAt) <= Date.parse(options.at)) return { outcome: "expired", record };

      const employeeResult = await client.query<DbRow>(`
        select status
        from callora.employees
        where organization_id = $1::uuid and id = $2::uuid
        limit 1
      `, [organizationId, record.employeeId]);
      const employeeStatus = employeeResult.rows[0]?.status;
      if (employeeStatus !== "invited" && employeeStatus !== "active") return { outcome: "not_found" };
      if (record.collectionMode !== options.registration.collectionMode) return { outcome: "not_found" };

      const registration = options.registration;
      const inserted = await client.query<DbRow>(`
        insert into callora.employee_devices (
          organization_id, employee_id, installation_id, platform,
          manufacturer, model, os_version, app_version, status, sync_state,
          collection_mode,
          call_log_permission, phone_state_permission, contacts_permission,
          notifications_permission, recording_files_permission,
          background_execution_permission, registered_at, last_seen_at,
          created_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3, $4,
          $5, $6, $7, $8, 'pending', 'never_synced',
          $9,
          $10, $11, $12, $13, $14, $15,
          $16::timestamptz, $16::timestamptz,
          $16::timestamptz, $16::timestamptz
        )
        on conflict (organization_id, installation_id) do nothing
        returning id
      `, [
        organizationId,
        record.employeeId,
        registration.installationId,
        registration.platform,
        registration.manufacturer ?? null,
        registration.model ?? null,
        registration.osVersion,
        registration.appVersion,
        registration.collectionMode,
        registration.permissions.callLog,
        registration.permissions.phoneState,
        registration.permissions.contacts,
        registration.permissions.notifications,
        registration.permissions.recordingFiles,
        registration.permissions.backgroundExecution,
        options.at,
      ]);
      let deviceId = typeof inserted.rows[0]?.id === "string" ? inserted.rows[0].id : undefined;
      if (deviceId === undefined) {
        const existingDevice = await client.query<DbRow>(`
          select id, employee_id
          from callora.employee_devices
          where organization_id = $1::uuid and installation_id = $2
          for update
        `, [organizationId, registration.installationId]);
        const existingRow = existingDevice.rows[0];
        if (typeof existingRow?.id !== "string" || existingRow.employee_id !== record.employeeId) {
          return { outcome: "installation_conflict", record };
        }
        deviceId = existingRow.id;
        await client.query(`
          update callora.employee_devices
          set platform = $4,
              manufacturer = $5,
              model = $6,
              os_version = $7,
              app_version = $8,
              collection_mode = $9,
              status = 'pending',
              sync_state = 'never_synced',
              call_log_permission = $10,
              phone_state_permission = $11,
              contacts_permission = $12,
              notifications_permission = $13,
              recording_files_permission = $14,
              background_execution_permission = $15,
              last_seen_at = $3::timestamptz,
              last_heartbeat_at = null,
              last_successful_sync_at = null,
              battery_percent = null,
              is_charging = null,
              network_type = null,
              pending_call_count = 0,
              pending_recording_count = 0,
              revoked_at = null,
              updated_at = $3::timestamptz
          where organization_id = $1::uuid and id = $2::uuid
        `, [
          organizationId,
          deviceId,
          options.at,
          registration.platform,
          registration.manufacturer ?? null,
          registration.model ?? null,
          registration.osVersion,
          registration.appVersion,
          registration.collectionMode,
          registration.permissions.callLog,
          registration.permissions.phoneState,
          registration.permissions.contacts,
          registration.permissions.notifications,
          registration.permissions.recordingFiles,
          registration.permissions.backgroundExecution,
        ]);
      }
      if (deviceId === undefined) throw new Error("Pairing did not resolve a device id");

      const transition = await client.query<DbRow>(`
        select * from callora.prepare_device_credential_request(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'redeem', decode($5, 'hex'),
          $6::uuid, decode($7, 'hex'), $8::timestamptz, null::uuid, $9::uuid, $10::timestamptz
        )
      `, [
        options.requestId, organizationId, record.employeeId, deviceId, options.requestFingerprint,
        options.bootstrapCredential.id, options.bootstrapCredential.tokenHash,
        options.bootstrapCredential.expiresAt, record.id, options.at,
      ]);
      const transitionRow = firstRow(transition.rows, "Pairing credential transition returned no result");
      const stored = parseStoredObject<Record<string, unknown>>(transitionRow.response_body);
      const bootstrapExpiresAt = stored?.expiresAt;
      if (!isIsoDateTime(bootstrapExpiresAt)) {
        throw new Error("Pairing credential transition returned an invalid expiry");
      }
      const consumed = await client.query<DbRow>(`
        select ${PAIRING_COLUMNS}
        from callora.device_pairing_codes as pairing
        where pairing.organization_id = $1::uuid and pairing.id = $2::uuid
        limit 1
      `, [organizationId, record.id]);
      const consumedRow = consumed.rows[0];
      if (!consumedRow) throw new Error("Consumed pairing code is unavailable");
      const device = await this.findDeviceWithClient(client, organizationId, deviceId);
      if (!device) throw new Error("Paired device is not visible inside its tenant transaction");
      const response: PairingRedemptionResult = {
        outcome: "redeemed",
        record: mapPairingCode(consumedRow),
        device,
        bootstrapExpiresAt,
        replayed: transitionRow.replayed === true,
      };
      return response;
    });
  }

  async resolveDeviceCredential(options: {
    tokenHash: string;
    credentialType: "bootstrap" | "session";
    at: string;
  }): Promise<MobileDeviceContext | undefined> {
    if (!/^[0-9a-f]{64}$/.test(options.tokenHash)) return undefined;
    const resolution = await this.pool.query<DbRow>(`
      select organization_id, credential_id
      from callora.resolve_device_credential(decode($1, 'hex'), $2)
    `, [options.tokenHash, options.credentialType]);
    const organizationId = resolution.rows[0]?.organization_id;
    const credentialId = resolution.rows[0]?.credential_id;
    if (typeof organizationId !== "string" || typeof credentialId !== "string" ||
      !isCanonicalUuid(organizationId) || !isCanonicalUuid(credentialId)) return undefined;

    return this.withTenant(organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select
          credential.id as credential_id,
          credential.credential_type,
          credential.organization_id,
          credential.employee_id,
          credential.device_id,
          credential.lifecycle_state,
          device.installation_id,
          device.collection_mode,
          device.call_log_permission,
          device.phone_state_permission,
          device.contacts_permission,
          device.notifications_permission,
          device.recording_files_permission,
          device.background_execution_permission,
          callora.device_has_current_collection_consent(
            credential.organization_id, credential.device_id, $5::timestamptz
          ) as consent_current
        from callora.device_credentials as credential
        join callora.employee_devices as device
          on device.organization_id = credential.organization_id
         and device.id = credential.device_id
        join callora.employees as employee
          on employee.organization_id = credential.organization_id
         and employee.id = credential.employee_id
        join callora.organizations as organization
          on organization.id = credential.organization_id
        where credential.organization_id = $1::uuid
          and credential.id = $2::uuid
          and credential.token_hash = decode($3, 'hex')
          and credential.credential_type = $4
          and credential.lifecycle_state = 'active'
          and credential.expires_at > $5::timestamptz
          and credential.consumed_at is null
          and credential.revoked_at is null
          and organization.status in ('trial', 'active')
          and (
            ($4 = 'bootstrap' and device.status = 'pending' and employee.status in ('invited', 'active'))
            or
            ($4 = 'session' and device.status = 'connected' and employee.status = 'active' and exists (
              select 1
              from callora.device_consent_receipts as consent
              where consent.organization_id = credential.organization_id
                and consent.device_id = credential.device_id
                and consent.withdrawn_at is null
            ))
          )
        limit 1
      `, [organizationId, credentialId, options.tokenHash, options.credentialType, options.at]);
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        credentialId: String(row.credential_id),
        credentialType: String(row.credential_type) as MobileDeviceContext["credentialType"],
        organizationId: String(row.organization_id),
        employeeId: String(row.employee_id),
        deviceId: String(row.device_id),
        installationId: String(row.installation_id),
        collectionMode: String(row.collection_mode) as MobileDeviceContext["collectionMode"],
        permissions: permissionsFromRow(row),
        credentialState: String(row.lifecycle_state) as MobileDeviceContext["credentialState"],
        consentCurrent: row.consent_current === true,
      };
    });
  }

  async resolveDeviceCredentialReplay(options: {
    tokenHash: string;
    credentialType: "bootstrap" | "session";
    operation: "activate" | "rotation_prepare" | "rotation_confirm" | "reconsent" | "revoke";
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<MobileDeviceContext | undefined> {
    if (!/^[0-9a-f]{64}$/.test(options.tokenHash) || !isCanonicalUuid(options.requestId) ||
      !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) return undefined;
    const resolution = await this.pool.query<DbRow>(`
      select organization_id, credential_id
      from callora.resolve_device_credential_replay(
        decode($1, 'hex'), $2::uuid, $3, decode($4, 'hex')
      )
    `, [options.tokenHash, options.requestId, options.operation, options.requestFingerprint]);
    const organizationId = resolution.rows[0]?.organization_id;
    const credentialId = resolution.rows[0]?.credential_id;
    if (typeof organizationId !== "string" || typeof credentialId !== "string" ||
      !isCanonicalUuid(organizationId) || !isCanonicalUuid(credentialId)) return undefined;
    const expectedState = options.operation === "activate"
      ? "consumed"
      : options.operation === "revoke" ? "revoked" : "active";
    return this.withTenant(organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select
          credential.id as credential_id, credential.credential_type,
          credential.organization_id, credential.employee_id, credential.device_id,
          credential.lifecycle_state, device.installation_id, device.collection_mode,
          device.call_log_permission, device.phone_state_permission,
          device.contacts_permission, device.notifications_permission,
          device.recording_files_permission, device.background_execution_permission,
          false as consent_current
        from callora.device_credentials as credential
        join callora.employee_devices as device
          on device.organization_id = credential.organization_id and device.id = credential.device_id
        join callora.employees as employee
          on employee.organization_id = credential.organization_id and employee.id = credential.employee_id
        join callora.organizations as organization on organization.id = credential.organization_id
        where credential.organization_id = $1::uuid
          and credential.id = $2::uuid
          and credential.token_hash = decode($3, 'hex')
          and credential.credential_type = $4
          and credential.lifecycle_state = $5
          and organization.status in ('trial', 'active')
        limit 1
      `, [organizationId, credentialId, options.tokenHash, options.credentialType, expectedState]);
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        credentialId: String(row.credential_id),
        credentialType: String(row.credential_type) as MobileDeviceContext["credentialType"],
        organizationId: String(row.organization_id),
        employeeId: String(row.employee_id),
        deviceId: String(row.device_id),
        installationId: String(row.installation_id),
        collectionMode: String(row.collection_mode) as MobileDeviceContext["collectionMode"],
        permissions: permissionsFromRow(row),
        credentialState: expectedState,
        consentCurrent: false,
        authenticatedReplay: true,
      };
    });
  }

  async resolvePendingRotationCredential(options: {
    tokenHash: string;
    prepareRequestId: string;
    confirmRequestId: string;
    confirmRequestFingerprint: string;
    at: string;
  }): Promise<MobileDeviceContext | undefined> {
    if (!/^[0-9a-f]{64}$/.test(options.tokenHash) || !isCanonicalUuid(options.prepareRequestId) ||
      !isCanonicalUuid(options.confirmRequestId) || !/^[0-9a-f]{64}$/.test(options.confirmRequestFingerprint)) {
      return undefined;
    }
    const resolution = await this.pool.query<DbRow>(`
      select organization_id, credential_id
      from callora.resolve_pending_rotation_credential(
        decode($1, 'hex'), $2::uuid, $3::uuid, decode($4, 'hex')
      )
    `, [options.tokenHash, options.prepareRequestId, options.confirmRequestId, options.confirmRequestFingerprint]);
    const organizationId = resolution.rows[0]?.organization_id;
    const credentialId = resolution.rows[0]?.credential_id;
    if (typeof organizationId !== "string" || typeof credentialId !== "string" ||
      !isCanonicalUuid(organizationId) || !isCanonicalUuid(credentialId)) return undefined;
    return this.withTenant(organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select
          credential.id as credential_id, credential.credential_type,
          credential.organization_id, credential.employee_id, credential.device_id,
          credential.lifecycle_state, device.installation_id, device.collection_mode,
          device.call_log_permission, device.phone_state_permission,
          device.contacts_permission, device.notifications_permission,
          device.recording_files_permission, device.background_execution_permission,
          callora.device_has_current_collection_consent(
            credential.organization_id, credential.device_id, $5::timestamptz
          ) as consent_current
        from callora.device_credentials as credential
        join callora.employee_devices as device
          on device.organization_id = credential.organization_id and device.id = credential.device_id
        join callora.employees as employee
          on employee.organization_id = credential.organization_id and employee.id = credential.employee_id
        join callora.organizations as organization on organization.id = credential.organization_id
        where credential.organization_id = $1::uuid
          and credential.id = $2::uuid
          and credential.token_hash = decode($3, 'hex')
          and credential.credential_type = 'session'
          and credential.lifecycle_state = 'pending'
          and credential.request_id = $4::uuid
          and credential.expires_at > $5::timestamptz
          and device.status = 'connected' and employee.status = 'active'
          and organization.status in ('trial', 'active')
        limit 1
      `, [organizationId, credentialId, options.tokenHash, options.prepareRequestId, options.at]);
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        credentialId: String(row.credential_id),
        credentialType: "session",
        organizationId: String(row.organization_id),
        employeeId: String(row.employee_id),
        deviceId: String(row.device_id),
        installationId: String(row.installation_id),
        collectionMode: String(row.collection_mode) as MobileDeviceContext["collectionMode"],
        permissions: permissionsFromRow(row),
        credentialState: "pending",
        consentCurrent: row.consent_current === true,
      };
    });
  }

  async findCurrentMobilePolicy(context: MobileDeviceContext, at: string): Promise<MobilePolicy | undefined> {
    if (!["android_call_log", "synthetic_demo"].includes(context.collectionMode)) return undefined;
    const result = await this.pool.query<DbRow>(`
      select policy.id, policy.policy_version, policy.disclosure_version,
             policy.collection_mode, policy.purpose, policy.title, policy.summary,
             policy.disclosures, encode(policy.content_hash, 'hex') as content_hash,
             policy.effective_at
      from callora.resolve_mobile_collection_policy($1, 'call_metadata', $2::timestamptz) as policy
    `, [context.collectionMode, at]);
    return result.rows[0] ? mobilePolicyFromRow(result.rows[0]) : undefined;
  }

  private async mobilePolicyMatches(
    context: MobileDeviceContext,
    reference: { id: string; contentHash: string },
    at: string,
  ): Promise<boolean> {
    const current = await this.findCurrentMobilePolicy(context, at);
    return current?.id === reference.id && current.contentHash === reference.contentHash;
  }

  private async mobileConsentIsCurrent(context: MobileDeviceContext, at: string): Promise<boolean> {
    return this.withTenant(context.organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select callora.device_has_current_collection_consent(
          $1::uuid, $2::uuid, $3::timestamptz
        ) as consent_current
      `, [context.organizationId, context.deviceId, at]);
      return result.rows[0]?.consent_current === true;
    });
  }

  async activateMobileDevice(options: {
    context: MobileDeviceContext;
    activation: MobileActivationPayload;
    sessionCredential: NewDeviceCredential;
    requestFingerprint: string;
    policy?: MobilePolicy;
    at: string;
  }): Promise<ActivateMobileDeviceResult | undefined> {
    for (const [name, value] of [
      ["organizationId", options.context.organizationId],
      ["employeeId", options.context.employeeId],
      ["deviceId", options.context.deviceId],
      ["bootstrapCredentialId", options.context.credentialId],
      ["sessionCredentialId", options.sessionCredential.id],
      ["requestId", options.activation.requestId],
    ] as const) assertTrustedUuid(value, name);
    if (options.context.credentialType !== "bootstrap" ||
      options.sessionCredential.credentialType !== "session" ||
      options.sessionCredential.requestId !== options.activation.requestId ||
      options.sessionCredential.lifecycleState !== "active" ||
      !/^[0-9a-f]{64}$/.test(options.sessionCredential.tokenHash) ||
      !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) return undefined;

    try {
      return await this.withTenant(options.context.organizationId, undefined, async (client) => {
      const acceptedAt = Date.parse(options.activation.consent.acceptedAt);
      const recordedAt = Date.parse(options.at);
      if (!options.context.authenticatedReplay && options.context.credentialState !== "active") return undefined;
      if (!options.context.authenticatedReplay && (!options.policy ||
        acceptedAt > recordedAt + 5 * 60 * 1_000 || acceptedAt < recordedAt - 15 * 60 * 1_000 ||
        options.activation.policy.id !== options.policy.id ||
        options.activation.policy.contentHash !== options.policy.contentHash)) {
        throw domainConsentRequired("Consent must be refreshed before activation");
      }
      const currentPolicyResult = await client.query<DbRow>(`
        select policy.id, policy.policy_version, policy.disclosure_version,
               policy.collection_mode, policy.purpose, policy.title, policy.summary,
               policy.disclosures, encode(policy.content_hash, 'hex') as content_hash,
               policy.effective_at
        from callora.resolve_mobile_collection_policy($1, 'call_metadata', $2::timestamptz) as policy
      `, [options.context.collectionMode, options.at]);
      const policyRow = currentPolicyResult.rows[0];
      if (!policyRow && !options.context.authenticatedReplay) throw domainConsentRequired();
      const activePolicy = policyRow ? mobilePolicyFromRow(policyRow) : undefined;
      if (!options.context.authenticatedReplay && (!activePolicy || !options.policy ||
        activePolicy.id !== options.policy.id || activePolicy.contentHash !== options.policy.contentHash)) {
        throw domainConsentRequired();
      }
      const transition = await client.query<DbRow>(`
        select * from callora.prepare_device_credential_request(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'activate', decode($5, 'hex'),
          $6::uuid, decode($7, 'hex'), $8::timestamptz, $9::uuid, null::uuid, $10::timestamptz
        )
      `, [
        options.activation.requestId, options.context.organizationId, options.context.employeeId,
        options.context.deviceId, options.requestFingerprint, options.sessionCredential.id,
        options.sessionCredential.tokenHash, options.sessionCredential.expiresAt,
        options.context.credentialId, options.at,
      ]);
      const transitionRow = firstRow(transition.rows, "Activation credential transition returned no result");
      const transitionBody = parseStoredObject<Record<string, unknown>>(transitionRow.response_body);
      const sessionExpiresAt = transitionBody?.expiresAt;
      if (!isIsoDateTime(sessionExpiresAt)) {
        throw new Error("Activation credential transition returned an invalid expiry");
      }
      if (transitionRow.replayed !== true) {
        await client.query(`
          select * from callora.accept_device_collection_policy(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, decode($6, 'hex'),
            $7::uuid, decode($8, 'hex'), $9::jsonb, $10, $11::timestamptz, $12::timestamptz
          )
        `, [
          options.activation.requestId, options.context.organizationId, options.context.employeeId,
          options.context.deviceId, options.sessionCredential.id, options.requestFingerprint,
          options.activation.policy.id, options.activation.policy.contentHash,
          JSON.stringify(options.activation.permissions),
          options.activation.consent.locale ?? null, options.activation.consent.acceptedAt, options.at,
        ]);
      }
      const device = await this.findDeviceWithClient(client, options.context.organizationId, options.context.deviceId);
      if (!device) return undefined;
      const response: ActivateMobileDeviceResult = {
        device,
        sessionExpiresAt,
        policy: options.activation.policy,
        replayed: transitionRow.replayed === true,
      };
      return response;
      });
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw domainConflict("The request ID was already used with a different activation payload");
      }
      if (["23503", "55000"].includes(postgresCode(error) ?? "")) {
        if (!options.context.authenticatedReplay &&
          !(await this.mobilePolicyMatches(options.context, options.activation.policy, options.at))) {
          throw domainConsentRequired();
        }
        return undefined;
      }
      throw error;
    }
  }

  async reconsentMobileDevice(options: {
    context: MobileDeviceContext;
    reconsent: MobileReconsentPayload;
    requestFingerprint: string;
    policy?: MobilePolicy;
    at: string;
  }): Promise<ReconsentMobileDeviceResult | undefined> {
    for (const [name, value] of [
      ["organizationId", options.context.organizationId],
      ["employeeId", options.context.employeeId],
      ["deviceId", options.context.deviceId],
      ["credentialId", options.context.credentialId],
      ["requestId", options.reconsent.requestId],
    ] as const) assertTrustedUuid(value, name);
    if (options.context.credentialType !== "session" || !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) {
      return undefined;
    }
    try {
      return await this.withTenant(options.context.organizationId, undefined, async (client) => {
      const acceptedAt = Date.parse(options.reconsent.consent.acceptedAt);
      const recordedAt = Date.parse(options.at);
      if (!options.context.authenticatedReplay && options.context.credentialState !== "active") return undefined;
      if (!options.context.authenticatedReplay && (!options.policy ||
        acceptedAt > recordedAt + 5 * 60 * 1_000 || acceptedAt < recordedAt - 15 * 60 * 1_000 ||
        options.reconsent.policy.id !== options.policy.id ||
        options.reconsent.policy.contentHash !== options.policy.contentHash)) {
        throw domainConsentRequired("Consent must be refreshed before synchronization resumes");
      }
      const currentPolicyResult = await client.query<DbRow>(`
        select policy.id, policy.policy_version, policy.disclosure_version,
               policy.collection_mode, policy.purpose, policy.title, policy.summary,
               policy.disclosures, encode(policy.content_hash, 'hex') as content_hash,
               policy.effective_at
        from callora.resolve_mobile_collection_policy($1, 'call_metadata', $2::timestamptz) as policy
      `, [options.context.collectionMode, options.at]);
      if (!currentPolicyResult.rows[0] && !options.context.authenticatedReplay) throw domainConsentRequired();
      const activePolicy = currentPolicyResult.rows[0]
        ? mobilePolicyFromRow(currentPolicyResult.rows[0])
        : undefined;
      if (!options.context.authenticatedReplay && (!activePolicy || !options.policy ||
        activePolicy.id !== options.policy.id || activePolicy.contentHash !== options.policy.contentHash)) {
        throw domainConsentRequired();
      }
      const transition = await client.query<DbRow>(`
        select * from callora.reconsent_device_collection_policy(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, decode($6, 'hex'),
          $7::uuid, decode($8, 'hex'), $9::jsonb, $10, $11::timestamptz, $12::timestamptz
        )
      `, [
        options.reconsent.requestId, options.context.organizationId, options.context.employeeId,
        options.context.deviceId, options.context.credentialId, options.requestFingerprint,
        options.reconsent.policy.id, options.reconsent.policy.contentHash,
        JSON.stringify(options.reconsent.permissions), options.reconsent.consent.locale ?? null,
        options.reconsent.consent.acceptedAt, options.at,
      ]);
      const transitionRow = firstRow(transition.rows, "Re-consent transition returned no result");
      const device = await this.findDeviceWithClient(client, options.context.organizationId, options.context.deviceId);
      if (!device) return undefined;
      const response: ReconsentMobileDeviceResult = {
        device,
        policy: options.reconsent.policy,
        consentedAt: options.reconsent.consent.acceptedAt,
        replayed: transitionRow.replayed === true,
      };
      return response;
      });
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw domainConflict("The request ID was already used with a different consent payload");
      }
      if (["23503", "55000"].includes(postgresCode(error) ?? "")) {
        if (!options.context.authenticatedReplay &&
          !(await this.mobilePolicyMatches(options.context, options.reconsent.policy, options.at))) {
          throw domainConsentRequired();
        }
        return undefined;
      }
      throw error;
    }
  }

  async prepareDeviceSessionRotation(options: {
    context: MobileDeviceContext;
    sessionCredential: NewDeviceCredential;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<PrepareMobileSessionRotationResult | undefined> {
    for (const [name, value] of [
      ["organizationId", options.context.organizationId], ["employeeId", options.context.employeeId],
      ["deviceId", options.context.deviceId], ["credentialId", options.context.credentialId],
      ["newCredentialId", options.sessionCredential.id], ["requestId", options.requestId],
    ] as const) assertTrustedUuid(value, name);
    if (options.context.credentialType !== "session" ||
      (!options.context.authenticatedReplay &&
        (options.context.credentialState !== "active" || !options.context.consentCurrent)) ||
      options.sessionCredential.credentialType !== "session" ||
      options.sessionCredential.lifecycleState !== "pending" ||
      options.sessionCredential.requestId !== options.requestId ||
      options.sessionCredential.rotatedFromCredentialId !== options.context.credentialId ||
      !/^[0-9a-f]{64}$/.test(options.sessionCredential.tokenHash) ||
      !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) return undefined;
    try {
      return await this.withTenant(options.context.organizationId, undefined, async (client) => {
        const transition = await client.query<DbRow>(`
          select * from callora.prepare_device_credential_request(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'rotation_prepare', decode($5, 'hex'),
            $6::uuid, decode($7, 'hex'), $8::timestamptz, $9::uuid, null::uuid, $10::timestamptz
          )
        `, [
          options.requestId, options.context.organizationId, options.context.employeeId,
          options.context.deviceId, options.requestFingerprint, options.sessionCredential.id,
          options.sessionCredential.tokenHash, options.sessionCredential.expiresAt,
          options.context.credentialId, options.at,
        ]);
        const transitionRow = firstRow(transition.rows, "Rotation preparation returned no result");
        const stored = parseStoredObject<Record<string, unknown>>(transitionRow.response_body);
        const pendingExpiresAt = stored?.expiresAt;
        const pendingCredentialId = transitionRow.credential_id;
        if (!isIsoDateTime(pendingExpiresAt) || typeof pendingCredentialId !== "string") {
          throw new Error("Rotation preparation returned invalid metadata");
        }
        const credential = await client.query<DbRow>(`
          select created_at
          from callora.device_credentials
          where organization_id = $1::uuid and id = $2::uuid
          limit 1
        `, [options.context.organizationId, pendingCredentialId]);
        const preparedAt = credential.rows[0]?.created_at;
        if (preparedAt === undefined) throw new Error("Pending session credential is unavailable");
        return {
          requestId: options.requestId,
          pendingExpiresAt,
          preparedAt: new Date(String(preparedAt)).toISOString(),
          replayed: transitionRow.replayed === true,
        };
      });
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw domainConflict("The request ID was already used with a different rotation payload");
      }
      if (["23503", "55000"].includes(postgresCode(error) ?? "")) {
        if (!options.context.authenticatedReplay &&
          !(await this.mobileConsentIsCurrent(options.context, options.at))) {
          throw domainConsentRequired();
        }
        return undefined;
      }
      throw error;
    }
  }

  async confirmDeviceSessionRotation(options: {
    context: MobileDeviceContext;
    requestId: string;
    prepareRequestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<ConfirmMobileSessionRotationResult | undefined> {
    for (const [name, value] of [
      ["organizationId", options.context.organizationId], ["employeeId", options.context.employeeId],
      ["deviceId", options.context.deviceId], ["credentialId", options.context.credentialId],
      ["requestId", options.requestId], ["prepareRequestId", options.prepareRequestId],
    ] as const) assertTrustedUuid(value, name);
    if (options.context.credentialType !== "session" || !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) {
      return undefined;
    }
    if (!options.context.authenticatedReplay && options.context.credentialState !== "pending") return undefined;
    try {
      return await this.withTenant(options.context.organizationId, undefined, async (client) => {
        const transition = await client.query<DbRow>(`
          select * from callora.confirm_device_session_rotation(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
            decode($7, 'hex'), $8::timestamptz
          )
        `, [
          options.requestId, options.prepareRequestId, options.context.organizationId,
          options.context.employeeId, options.context.deviceId, options.context.credentialId,
          options.requestFingerprint, options.at,
        ]);
        const transitionRow = firstRow(transition.rows, "Rotation confirmation returned no result");
        const stored = parseStoredObject<Record<string, unknown>>(transitionRow.response_body);
        const activatedAt = stored?.acknowledgedAt;
        if (!isIsoDateTime(activatedAt)) throw new Error("Rotation confirmation returned an invalid timestamp");
        const credential = await client.query<DbRow>(`
          select expires_at
          from callora.device_credentials
          where organization_id = $1::uuid and id = $2::uuid
          limit 1
        `, [options.context.organizationId, options.context.credentialId]);
        if (credential.rows[0]?.expires_at === undefined) {
          throw new Error("Confirmed session credential is unavailable");
        }
        return {
          requestId: options.requestId,
          expiresAt: new Date(String(credential.rows[0].expires_at)).toISOString(),
          activatedAt,
          replayed: transitionRow.replayed === true,
        };
      });
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw domainConflict("The request ID was already used with a different rotation confirmation");
      }
      if (["23503", "55000"].includes(postgresCode(error) ?? "")) return undefined;
      throw error;
    }
  }

  async recordDeviceHeartbeat(options: {
    context: MobileDeviceContext;
    heartbeat: MobileHeartbeatPayload;
    at: string;
  }): Promise<MobileHeartbeatResult | undefined> {
    for (const [name, value] of [
      ["organizationId", options.context.organizationId],
      ["employeeId", options.context.employeeId],
      ["deviceId", options.context.deviceId],
      ["credentialId", options.context.credentialId],
    ] as const) assertTrustedUuid(value, name);
    if (options.context.credentialType !== "session") return undefined;
    return this.withTenant(options.context.organizationId, undefined, async (client) => {
      const trust = await this.lockActiveMobileTrustWithClient(
        client, options.context, options.at, false,
      );
      if (!trust) return undefined;
      const currentPolicy = await client.query<DbRow>(`
        select policy.id as current_policy_id,
          encode(policy.content_hash, 'hex') as current_policy_content_hash
        from callora.resolve_mobile_collection_policy(
          $1, 'call_metadata', $2::timestamptz
        ) as policy
      `, [trust.device.collection_mode, options.at]);
      const currentRow: DbRow = {
        ...trust.device,
        ...currentPolicy.rows[0],
        consent_current: trust.consentCurrent,
      };
      const priorPermissions = permissionsFromRow(currentRow);
      const permissionChanged = JSON.stringify(priorPermissions) !== JSON.stringify(options.heartbeat.permissions);
      const permission = options.heartbeat.permissions;
      await client.query(`
        update callora.employee_devices
        set app_version = $4,
            os_version = $5,
            sync_state = $6,
            call_log_permission = $7,
            phone_state_permission = $8,
            contacts_permission = $9,
            notifications_permission = $10,
            recording_files_permission = $11,
            background_execution_permission = $12,
            last_heartbeat_at = $13::timestamptz,
            battery_percent = $14,
            is_charging = $15,
            network_type = $16,
            pending_call_count = $17,
            pending_recording_count = $18,
            last_seen_at = $3::timestamptz,
            updated_at = $3::timestamptz
        where organization_id = $1::uuid and id = $2::uuid
      `, [
        options.context.organizationId,
        options.context.deviceId,
        options.at,
        options.heartbeat.appVersion,
        options.heartbeat.osVersion,
        options.heartbeat.syncState,
        permission.callLog,
        permission.phoneState,
        permission.contacts,
        permission.notifications,
        permission.recordingFiles,
        permission.backgroundExecution,
        options.heartbeat.observedAt,
        options.heartbeat.batteryPercent ?? null,
        options.heartbeat.isCharging ?? null,
        options.heartbeat.networkType ?? null,
        options.heartbeat.pendingCallCount,
        options.heartbeat.pendingRecordingCount,
      ]);
      await client.query(`
        select callora.touch_active_device_credential($1::uuid, $2::uuid, $3::timestamptz)
      `, [options.context.organizationId, options.context.credentialId, options.at]);
      if (permissionChanged) {
        await this.insertOutboxEvent(
          client,
          options.context.organizationId,
          "device",
          options.context.deviceId,
          "device.permission_changed",
          { deviceId: options.context.deviceId, permissions: permission },
        );
      }
      const directives = currentRow.consent_current === false &&
        typeof currentRow.current_policy_id === "string" &&
        typeof currentRow.current_policy_content_hash === "string"
        ? [{
            type: "consent_required" as const,
            policyId: currentRow.current_policy_id,
            contentHash: currentRow.current_policy_content_hash,
            reason: "The active collection policy has changed",
          }]
        : [];
      return { serverTime: options.at, nextHeartbeatAfterSeconds: 900, directives };
    });
  }

  async ingestMobileCallBatch(options: MobileCallBatchOptions): Promise<MobileCallBatchResult | undefined> {
    for (const [name, value] of [
      ["organizationId", options.context.organizationId],
      ["employeeId", options.context.employeeId],
      ["deviceId", options.context.deviceId],
      ["credentialId", options.context.credentialId],
    ] as const) assertTrustedUuid(value, name);
    if (options.context.credentialType !== "session" || !/^[0-9a-f]{64}$/.test(options.payloadHash)) return undefined;
    const callPiiCrypto = this.requireCallPiiCrypto();
    try {
      return await this.withTenant(options.context.organizationId, undefined, async (client) => {
        const trust = await this.lockActiveMobileTrustWithClient(
          client, options.context, options.at,
        );
        if (!trust ||
          trust.device.call_log_permission !== "granted" && !options.allowWithoutCallLogPermission ||
          trust.device.collection_mode !== options.batch.collectionMode) return undefined;

        const registration = await client.query<DbRow>(`
          select callora.register_call_ingest_batch(
            $1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz,
            $6, $7, $8, decode($9, 'hex')
          ) as batch_id
        `, [
          options.context.organizationId,
          options.context.employeeId,
          options.context.deviceId,
          options.batch.batchId,
          options.batch.sentAt,
          options.batch.items.length,
          options.batch.schemaVersion,
          options.batch.previousCursor ?? null,
          options.payloadHash,
        ]);
        const ingestBatchId = registration.rows[0]?.batch_id;
        if (typeof ingestBatchId !== "string" || !isCanonicalUuid(ingestBatchId)) {
          throw new Error("PostgreSQL returned an invalid ingest batch id");
        }
        const storedBatch = await client.query<DbRow>(`
          select response_body
          from callora.call_ingest_batches
          where organization_id = $1::uuid and id = $2::uuid
          for update
        `, [options.context.organizationId, ingestBatchId]);
        const priorResponse = parseBatchResponse(storedBatch.rows[0]?.response_body);
        if (priorResponse) return priorResponse;

        const existingCalls = await client.query<DbRow>(`
          select external_id, id
          from callora.call_logs
          where organization_id = $1::uuid
            and device_id = $2::uuid
            and external_id = any($3::text[])
        `, [
          options.context.organizationId,
          options.context.deviceId,
          options.batch.items.map((item) => item.localId),
        ]);
        const existingCallIds = new Map<string, string>();
        for (const row of existingCalls.rows) {
          if (typeof row.external_id !== "string" || typeof row.id !== "string" || !isCanonicalUuid(row.id)) {
            throw new Error("PostgreSQL returned an invalid existing mobile call identity");
          }
          existingCallIds.set(row.external_id, row.id);
        }

        const items: CallLogSyncResult["items"] = [];
        for (const item of options.batch.items) {
          const callLogId = existingCallIds.get(item.localId) ?? callPiiCrypto.deriveRowId({
            organizationId: options.context.organizationId,
            source: "mobile_call_log",
            deviceId: options.context.deviceId,
            externalId: item.localId,
          });
          const phone = callPiiCrypto.encryptField({
            organizationId: options.context.organizationId,
            rowId: callLogId,
            field: "phone_number",
          }, item.phoneNumber);
          const contact = item.contactName === undefined ? null : callPiiCrypto.encryptField({
            organizationId: options.context.organizationId,
            rowId: callLogId,
            field: "contact_name",
          }, item.contactName);
          const result = await client.query<DbRow>(`
            select call_log_id, outcome
            from callora.upsert_mobile_call_encrypted(
              $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
              $8::bytea, $9::bytea, $10::bytea, $11::smallint, $12::integer,
              $13::integer, $14::timestamptz, $15::timestamptz, $16::integer,
              $17::uuid, $18::uuid, $19, $20::bytea, $21::bytea, $22::bytea,
              $23::timestamptz, $24::timestamptz, $25::integer, $26::boolean,
              $27::boolean, $28, $29::timestamptz
            )
          `, [
            callLogId,
            options.context.organizationId,
            options.context.employeeId,
            options.context.deviceId,
            item.localId,
            item.direction,
            item.disposition,
            phone.ciphertext,
            phone.nonce,
            phone.blindIndex,
            phone.formatVersion,
            phone.keyVersion,
            phone.blindIndexKeyVersion,
            options.at,
            item.startedAt,
            item.durationSeconds,
            ingestBatchId,
            null,
            item.nativeCallId ?? null,
            contact?.ciphertext ?? null,
            contact?.nonce ?? null,
            contact?.blindIndex ?? null,
            item.answeredAt ?? null,
            item.endedAt ?? null,
            item.ringDurationSeconds ?? null,
            item.isInternal ?? false,
            false,
            "not_expected",
            item.nativeLastModifiedAt ?? null,
          ]);
          const row = firstRow(result.rows, "Mobile call upsert returned no result");
          const storedCallLogId = row.call_log_id;
          const outcome = row.outcome;
          if (storedCallLogId !== callLogId || !isCanonicalUuid(callLogId) ||
            !["created", "updated", "duplicate"].includes(String(outcome))) {
            throw new Error("PostgreSQL returned an invalid mobile call result");
          }
          items.push({
            localId: item.localId,
            outcome: outcome as "created" | "updated" | "duplicate",
            callLogId,
          });
          if (outcome !== "duplicate") {
            await this.linkCallToUniqueLeadWithClient(
              client,
              options.context.organizationId,
              callLogId,
              options.at,
            );
            await this.insertOutboxEvent(
              client,
              options.context.organizationId,
              "call",
              callLogId,
              outcome === "created" ? "call.ingested" : "call.updated",
              {
                callId: callLogId,
                deviceId: options.context.deviceId,
                employeeId: options.context.employeeId,
                batchId: options.batch.batchId,
              },
            );
          }
        }

        const response: CallLogSyncResult = {
          batchId: options.batch.batchId,
          acceptedAt: options.at,
          nextCursor: options.nextCursor,
          items,
          serverTime: options.at,
        };
        await client.query(`
          update callora.call_ingest_batches
          set processed_item_count = $3,
              status = 'completed',
              next_cursor = $4,
              completed_at = $5::timestamptz,
              response_body = $6::jsonb,
              updated_at = $5::timestamptz
          where organization_id = $1::uuid and id = $2::uuid
        `, [
          options.context.organizationId,
          ingestBatchId,
          options.batch.items.length,
          options.nextCursor,
          options.at,
          JSON.stringify(response),
        ]);
        await client.query(`
          update callora.employee_devices
          set sync_state = 'idle',
              last_seen_at = $3::timestamptz,
              last_successful_sync_at = $3::timestamptz,
              updated_at = $3::timestamptz
          where organization_id = $1::uuid and id = $2::uuid
        `, [options.context.organizationId, options.context.deviceId, options.at]);
        await client.query(`
          select callora.touch_active_device_credential($1::uuid, $2::uuid, $3::timestamptz)
        `, [options.context.organizationId, options.context.credentialId, options.at]);
        await this.insertOutboxEvent(
          client,
          options.context.organizationId,
          "device",
          options.context.deviceId,
          "device.sync_completed",
          {
            deviceId: options.context.deviceId,
            employeeId: options.context.employeeId,
            batchId: options.batch.batchId,
            collectionMode: options.batch.collectionMode,
            itemCount: options.batch.items.length,
          },
        );
        return response;
      });
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw domainConflict("The batch ID was already used with a different payload");
      }
      throw error;
    }
  }

  async revokeMobileSession(options: {
    context: MobileDeviceContext;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<RevokeMobileSessionResult | undefined> {
    for (const [name, value] of [
      ["organizationId", options.context.organizationId],
      ["employeeId", options.context.employeeId],
      ["deviceId", options.context.deviceId],
      ["credentialId", options.context.credentialId],
      ["requestId", options.requestId],
    ] as const) assertTrustedUuid(value, name);
    if (options.context.credentialType !== "session" || !/^[0-9a-f]{64}$/.test(options.requestFingerprint)) {
      return undefined;
    }
    if (!options.context.authenticatedReplay && options.context.credentialState !== "active") return undefined;
    try {
      return await this.withTenant(options.context.organizationId, undefined, async (client) => {
        const transition = await client.query<DbRow>(`
          select * from callora.revoke_device_session_request(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            decode($6, 'hex'), $7::timestamptz
          )
        `, [
          options.requestId, options.context.organizationId, options.context.employeeId,
          options.context.deviceId, options.context.credentialId, options.requestFingerprint, options.at,
        ]);
        const transitionRow = firstRow(transition.rows, "Session revocation returned no result");
        const stored = parseStoredObject<Record<string, unknown>>(transitionRow.response_body);
        const revokedAt = stored?.revokedAt;
        if (!isIsoDateTime(revokedAt)) throw new Error("Session revocation returned an invalid timestamp");
        return {
          deviceId: options.context.deviceId,
          revokedAt,
          consentWithdrawnAt: revokedAt,
          replayed: transitionRow.replayed === true,
        };
      });
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw domainConflict("The request ID was already used with a different revocation payload");
      }
      if (["23503", "55000"].includes(postgresCode(error) ?? "")) return undefined;
      throw error;
    }
  }

  async ingestCall(options: {
    organizationId: OrganizationId;
    input: SimulatedCallInput;
    idempotencyKey: string;
    fingerprint: string;
    actorUserId: string;
    at: string;
  }): Promise<IngestCallResult> {
    assertTrustedUuid(options.organizationId, "organizationId");
    assertTrustedUuid(options.input.employeeId, "employeeId");
    assertTrustedUuid(options.actorUserId, "actorUserId");
    if (options.input.deviceId !== undefined) assertTrustedUuid(options.input.deviceId, "deviceId");
    const callPiiCrypto = this.requireCallPiiCrypto();
    return this.withTenant(options.organizationId, options.actorUserId, async (client) => {
      const idempotencyInsert = await client.query<DbRow>(`
        insert into callora.api_idempotency_keys (
          organization_id, scope, idempotency_key, request_fingerprint,
          expires_at, created_at, updated_at
        ) values (
          $1::uuid, 'call.ingest', $2, $3,
          $4::timestamptz + interval '24 hours', $4::timestamptz, $4::timestamptz
        )
        on conflict (organization_id, scope, idempotency_key) do nothing
        returning id, request_fingerprint, resource_id
      `, [options.organizationId, options.idempotencyKey, options.fingerprint, options.at]);

      let idempotencyRow = idempotencyInsert.rows[0];
      if (!idempotencyRow) {
        const existingKey = await client.query<DbRow>(`
          select id, request_fingerprint, resource_id
          from callora.api_idempotency_keys
          where organization_id = $1::uuid
            and scope = 'call.ingest'
            and idempotency_key = $2
          for update
        `, [options.organizationId, options.idempotencyKey]);
        idempotencyRow = firstRow(existingKey.rows, "Committed idempotency row disappeared");
        const resourceId = idempotencyRow.resource_id;
        if (typeof resourceId !== "string") throw new Error("Committed idempotency row has no resource");
        const call = await this.findCallWithClient(client, options.organizationId, resourceId);
        if (!call) throw new Error("Idempotency resource does not exist in its tenant");
        const conflict = idempotencyRow.request_fingerprint !== options.fingerprint;
        return { call, duplicate: !conflict, conflict };
      }

      const input = options.input;
      const proposedCallId = callPiiCrypto.deriveRowId({
        organizationId: options.organizationId,
        source: "manual",
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        externalId: input.externalId,
      });
      const phone = callPiiCrypto.encryptField({
        organizationId: options.organizationId,
        rowId: proposedCallId,
        field: "phone_number",
      }, input.phoneNumber);
      const contact = input.displayName === undefined ? null : callPiiCrypto.encryptField({
        organizationId: options.organizationId,
        rowId: proposedCallId,
        field: "contact_name",
      }, input.displayName);
      const inserted = await client.query<DbRow>(`
        select callora.insert_manual_call_encrypted(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
          $8::smallint, $9::integer, $10::integer, $11::bytea, $12::bytea,
          $13::bytea, $14::bytea, $15::bytea, $16::bytea, $17::timestamptz,
          $18, $19::timestamptz, $20::timestamptz, $21::timestamptz, $22,
          $23, $24, $25, $26::timestamptz
        ) as id
      `, [
        proposedCallId,
        options.organizationId,
        input.employeeId,
        input.deviceId ?? null,
        input.externalId,
        input.direction,
        input.disposition,
        phone.formatVersion,
        phone.keyVersion,
        phone.blindIndexKeyVersion,
        phone.ciphertext,
        phone.nonce,
        phone.blindIndex,
        contact?.ciphertext ?? null,
        contact?.nonce ?? null,
        contact?.blindIndex ?? null,
        options.at,
        input.isInternal,
        input.startedAt,
        input.answeredAt ?? null,
        input.endedAt ?? null,
        input.durationSeconds,
        input.ringDurationSeconds ?? null,
        input.isWithinWorkingHours,
        options.fingerprint,
        options.at,
      ]);

      let callId = typeof inserted.rows[0]?.id === "string" ? inserted.rows[0].id : undefined;
      let duplicate = false;
      let conflict = false;
      if (typeof callId !== "string") {
        const existingCall = await client.query<DbRow>(`
          select id, ingest_fingerprint
          from callora.call_logs
          where organization_id = $1::uuid
            and external_id = $2
            and (
              ($3::uuid is null and device_id is null and source = 'manual')
              or device_id = $3::uuid
            )
          limit 1
        `, [options.organizationId, input.externalId, input.deviceId ?? null]);
        const existingRow = firstRow(existingCall.rows, "Call insert conflicted without a visible external identity");
        callId = typeof existingRow.id === "string" ? existingRow.id : undefined;
        if (!callId) throw new Error("Existing call has an invalid id");
        duplicate = existingRow.ingest_fingerprint === options.fingerprint;
        conflict = !duplicate;
      }

      if (!callId) throw new Error("Call ingest did not resolve a resource id");
      const call = await this.findCallWithClient(client, options.organizationId, callId);
      if (!call) throw new Error("Ingested call is not visible inside its tenant transaction");

      if (conflict) {
        await client.query(`
          delete from callora.api_idempotency_keys
          where organization_id = $1::uuid and id = $2::uuid
        `, [options.organizationId, idempotencyRow.id]);
        return { call, duplicate: false, conflict: true };
      }

      await client.query(`
        update callora.api_idempotency_keys
        set resource_type = 'call', resource_id = $3::uuid,
            response_status = $4, response_body = $5::jsonb
        where organization_id = $1::uuid and id = $2::uuid
      `, [
        options.organizationId,
        idempotencyRow.id,
        call.id,
        duplicate ? 200 : 201,
        JSON.stringify({ callId: call.id, duplicate }),
      ]);
      if (!duplicate) {
        await this.linkCallToUniqueLeadWithClient(client, options.organizationId, call.id, options.at);
        await this.insertOutboxEvent(client, options.organizationId, "call", call.id, "call.ingested", {
          callId: call.id,
          employeeId: call.employeeId,
        });
      }
      return { call, duplicate, conflict: false };
    });
  }

  async listCalls(options: {
    organizationId: OrganizationId;
    filter: CallListFilter;
    after?: CallCursor;
    limit: number;
  }): Promise<{ items: CallLog[]; hasMore: boolean }> {
    if (!isCanonicalUuid(options.organizationId)) return { items: [], hasMore: false };
    if (options.filter.employeeId !== undefined && !isCanonicalUuid(options.filter.employeeId)) {
      return { items: [], hasMore: false };
    }
    if (options.after && !isCanonicalUuid(options.after.id)) return { items: [], hasMore: false };
    return this.withTenant(options.organizationId, undefined, async (client) => {
      const values: unknown[] = [options.organizationId];
      const where = ["call_log.organization_id = $1::uuid"];
      const add = (value: unknown): number => values.push(value);
      if (options.filter.employeeId) where.push(`call_log.employee_id = $${add(options.filter.employeeId)}::uuid`);
      if (options.filter.direction) where.push(`call_log.direction = $${add(options.filter.direction)}`);
      if (options.filter.disposition) where.push(`call_log.disposition = $${add(options.filter.disposition)}`);
      if (options.filter.from) where.push(`call_log.started_at >= $${add(options.filter.from)}::timestamptz`);
      if (options.filter.to) where.push(`call_log.started_at < $${add(options.filter.to)}::timestamptz`);
      if (options.after) {
        const startedIndex = add(options.after.startedAt);
        const idIndex = add(options.after.id);
        where.push(`(call_log.started_at, call_log.id) < ($${startedIndex}::timestamptz, $${idIndex}::uuid)`);
      }
      const limitIndex = add(options.limit + 1);
      const result = await client.query<DbRow>(`
        select ${CALL_COLUMNS}
        from callora.call_logs as call_log
        where ${where.join(" and ")}
        order by call_log.started_at desc, call_log.id desc
        limit $${limitIndex}::integer
      `, values);
      const hasMore = result.rows.length > options.limit;
      return { items: result.rows.slice(0, options.limit).map((row) => this.mapCallRow(row)), hasMore };
    });
  }

  async listCallsInPeriod(options: {
    organizationId: OrganizationId;
    from: string;
    to: string;
    employeeId?: string;
  }): Promise<CallLog[]> {
    if (!isCanonicalUuid(options.organizationId) ||
      (options.employeeId !== undefined && !isCanonicalUuid(options.employeeId))) return [];
    return this.withTenant(options.organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select ${CALL_COLUMNS}
        from callora.call_logs as call_log
        where call_log.organization_id = $1::uuid
          and call_log.started_at >= $2::timestamptz
          and call_log.started_at < $3::timestamptz
          and ($4::uuid is null or call_log.employee_id = $4::uuid)
        order by call_log.started_at desc, call_log.id desc
      `, [options.organizationId, options.from, options.to, options.employeeId ?? null]);
      return result.rows.map((row) => this.mapCallRow(row));
    });
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    for (const [name, value] of [
      ["organizationId", event.organizationId],
      ["auditEventId", event.id],
      ["entityId", event.entityId],
      ...(event.actorUserId === undefined ? [] : [["actorUserId", event.actorUserId] as const]),
      ...(event.actorDeviceId === undefined ? [] : [["actorDeviceId", event.actorDeviceId] as const]),
    ] as ReadonlyArray<readonly [string, string]>) assertTrustedUuid(value, name);
    await this.withTenant(event.organizationId, event.actorUserId, async (client) => {
      await client.query(`
        insert into callora.audit_events (
          id, organization_id, actor_user_id, actor_device_id,
          action, entity_type, entity_id, request_id, metadata, occurred_at, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid,
          $5, $6, $7::uuid, $8, $9::jsonb, $10::timestamptz, $10::timestamptz
        )
      `, [
        event.id,
        event.organizationId,
        event.actorUserId ?? null,
        event.actorDeviceId ?? null,
        event.action,
        event.entityType,
        event.entityId,
        event.requestId ?? null,
        JSON.stringify(event.metadata),
        event.occurredAt,
      ]);
    });
  }

  async listAuditEvents(organizationId: OrganizationId, limit: number): Promise<AuditEvent[]> {
    if (!isCanonicalUuid(organizationId)) return [];
    return this.withTenant(organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        select id, organization_id, actor_user_id, actor_device_id,
               action, entity_type, entity_id, request_id, metadata, occurred_at
        from callora.audit_events
        where organization_id = $1::uuid
        order by occurred_at desc, id desc
        limit $2::integer
      `, [organizationId, limit]);
      return result.rows.map(mapAuditEvent);
    });
  }

  async claimOutboxEvents(options: {
    organizationId: OrganizationId;
    workerId: string;
    at: string;
    limit: number;
    leaseSeconds?: number;
  }): Promise<OutboxEventRecord[]> {
    assertTrustedUuid(options.organizationId, "organizationId");
    const workerId = options.workerId.trim();
    if (workerId.length < 1 || workerId.length > 128) {
      throw new Error("workerId must contain between 1 and 128 characters");
    }
    const limit = boundedInteger(options.limit, 1, 100, "limit");
    const leaseSeconds = boundedInteger(options.leaseSeconds ?? 300, 1, 3_600, "leaseSeconds");
    return this.withTenant(options.organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        with candidates as (
          select id
          from callora.outbox_events
          where organization_id = $1::uuid
            and delivered_at is null
            and available_at <= $2::timestamptz
            and (
              locked_at is null
              or locked_at < $2::timestamptz - ($5::integer * interval '1 second')
            )
          order by available_at, id
          for update skip locked
          limit $3::integer
        )
        update callora.outbox_events as event
        set locked_at = $2::timestamptz,
            locked_by = $4,
            attempt_count = event.attempt_count + 1
        from candidates
        where event.organization_id = $1::uuid
          and event.id = candidates.id
        returning event.*
      `, [
        options.organizationId,
        options.at,
        limit,
        workerId,
        leaseSeconds,
      ]);
      return result.rows.map(mapOutboxEvent);
    });
  }

  async markOutboxDelivered(options: {
    organizationId: OrganizationId;
    eventId: string;
    workerId: string;
    at: string;
  }): Promise<boolean> {
    if (!isCanonicalUuid(options.organizationId) || !isCanonicalUuid(options.eventId)) return false;
    const workerId = options.workerId.trim();
    if (workerId.length < 1 || workerId.length > 128) return false;
    return this.withTenant(options.organizationId, undefined, async (client) => {
      const result = await client.query<DbRow>(`
        update callora.outbox_events
        set delivered_at = $4::timestamptz,
            locked_at = null,
            locked_by = null,
            last_error = null
        where organization_id = $1::uuid
          and id = $2::uuid
          and locked_by = $3
          and delivered_at is null
        returning id
      `, [options.organizationId, options.eventId, workerId, options.at]);
      return result.rows.length === 1;
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
