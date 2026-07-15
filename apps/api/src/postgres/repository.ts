import { randomUUID } from "node:crypto";
import {
  isIsoDateTime,
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
      const current = await client.query<DbRow>(`
        select
          device.call_log_permission,
          device.phone_state_permission,
          device.contacts_permission,
          device.notifications_permission,
          device.recording_files_permission,
          device.background_execution_permission,
          current_policy.id as current_policy_id,
          encode(current_policy.content_hash, 'hex') as current_policy_content_hash,
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
        join callora.device_consent_receipts as consent
          on consent.organization_id = credential.organization_id
         and consent.device_id = credential.device_id
         and consent.withdrawn_at is null
        left join lateral callora.resolve_mobile_collection_policy(
          device.collection_mode, 'call_metadata', $5::timestamptz
        ) as current_policy on true
        where credential.organization_id = $1::uuid
          and credential.id = $2::uuid
          and credential.device_id = $3::uuid
          and credential.employee_id = $4::uuid
          and credential.credential_type = 'session'
          and credential.lifecycle_state = 'active'
          and credential.consumed_at is null
          and credential.revoked_at is null
          and credential.expires_at > $5::timestamptz
          and device.status = 'connected'
          and employee.status = 'active'
          and organization.status in ('trial', 'active')
        for update of credential, device, employee, organization, consent
      `, [
        options.context.organizationId,
        options.context.credentialId,
        options.context.deviceId,
        options.context.employeeId,
        options.at,
      ]);
      const currentRow = current.rows[0];
      if (!currentRow) return undefined;
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
        const authenticated = await client.query<DbRow>(`
          select
            credential.id,
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
          join callora.device_consent_receipts as consent
            on consent.organization_id = credential.organization_id
           and consent.device_id = credential.device_id
           and consent.withdrawn_at is null
          where credential.organization_id = $1::uuid
            and credential.id = $2::uuid
            and credential.device_id = $3::uuid
            and credential.employee_id = $4::uuid
            and credential.credential_type = 'session'
            and credential.lifecycle_state = 'active'
            and credential.consumed_at is null
            and credential.revoked_at is null
            and credential.expires_at > $5::timestamptz
            and device.status = 'connected'
            and employee.status = 'active'
            and organization.status in ('trial', 'active')
            and (device.call_log_permission = 'granted' or $6::boolean = true)
            and device.collection_mode = $7
          for update of credential, device, employee, organization, consent
        `, [
          options.context.organizationId,
          options.context.credentialId,
          options.context.deviceId,
          options.context.employeeId,
          options.at,
          options.allowWithoutCallLogPermission,
          options.batch.collectionMode,
        ]);
        const authenticatedRow = authenticated.rows[0];
        if (!authenticatedRow) return undefined;
        if (authenticatedRow.consent_current !== true) throw domainConsentRequired();

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
