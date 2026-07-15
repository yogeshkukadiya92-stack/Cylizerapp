import type {
  CallLog,
  Employee,
  EmployeeDevice,
  JsonValue,
  Organization,
  Permission,
  Role,
  SimCard,
  SystemRoleKey,
  User,
} from "@callora/contracts";
import type { ActorContext, AuditEvent, PairingCodeRecord } from "../domain.js";
import type { OutboxEventRecord } from "./types.js";

export type DbRow = Record<string, unknown>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return number;
}

function dateTime(value: unknown, field: string): string {
  const candidate = value instanceof Date ? value : new Date(requiredString(value, field));
  if (Number.isNaN(candidate.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return candidate.toISOString();
}

function optionalDateTime(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return dateTime(value, "timestamp");
}

function optionalField<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<never, never> {
  return value === undefined
    ? {}
    : { [key]: value } as Record<Key, Value>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => requiredNumber(item, "number array item"));
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return objectValue(parsed);
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function timeValue(value: unknown): string {
  return requiredString(value, "time").slice(0, 5);
}

export function mapOrganization(row: DbRow): Organization {
  return {
    id: requiredString(row.organization_id ?? row.id, "organization id"),
    name: requiredString(row.organization_name ?? row.name, "organization name"),
    slug: requiredString(row.organization_slug ?? row.slug, "organization slug"),
    status: requiredString(row.organization_status ?? row.status, "organization status") as Organization["status"],
    plan: requiredString(row.organization_plan ?? row.plan, "organization plan") as Organization["plan"],
    settings: {
      timeZone: requiredString(row.time_zone, "organization time zone"),
      defaultCountryCode: requiredString(row.default_country_code, "organization country code"),
      workingWeekDays: numberArray(row.working_week_days),
      workingDayStartsAt: timeValue(row.working_day_starts_at),
      workingDayEndsAt: timeValue(row.working_day_ends_at),
      recordingRetentionDays: requiredNumber(row.recording_retention_days, "recording retention"),
      callLogRetentionDays: requiredNumber(row.call_log_retention_days, "call-log retention"),
      requireRecordingConsent: row.require_recording_consent === true,
      maskPhoneNumbersForRestrictedUsers: row.mask_phone_numbers_for_restricted_users === true,
    },
    createdAt: dateTime(row.organization_created_at ?? row.created_at, "organization created_at"),
    updatedAt: dateTime(row.organization_updated_at ?? row.updated_at, "organization updated_at"),
    ...optionalField("industry", optionalString(row.industry)),
    ...optionalField("logoUrl", optionalString(row.logo_url)),
    ...optionalField("supportEmail", optionalString(row.support_email)),
    ...optionalField("primaryPhone", optionalString(row.primary_phone)),
    ...optionalField("trialEndsAt", optionalDateTime(row.trial_ends_at)),
  };
}

export function mapUser(row: DbRow, roleIds: string[]): User {
  return {
    id: requiredString(row.user_id ?? row.id, "user id"),
    organizationId: requiredString(row.organization_id, "user organization id"),
    email: requiredString(row.user_email ?? row.email, "user email"),
    displayName: requiredString(row.user_display_name ?? row.display_name, "user display name"),
    status: requiredString(row.user_status ?? row.status, "user status") as User["status"],
    roleIds,
    createdAt: dateTime(row.user_created_at ?? row.created_at, "user created_at"),
    updatedAt: dateTime(row.user_updated_at ?? row.updated_at, "user updated_at"),
    ...optionalField("phoneNumber", optionalString(row.phone_number)),
    ...optionalField("avatarUrl", optionalString(row.avatar_url)),
    ...optionalField("lastSignedInAt", optionalDateTime(row.last_signed_in_at)),
  };
}

export function mapRole(row: DbRow): Role {
  return {
    id: requiredString(row.id, "role id"),
    organizationId: requiredString(row.organization_id, "role organization id"),
    name: requiredString(row.name, "role name"),
    permissions: stringArray(row.permissions) as Permission[],
    isEditable: row.is_editable === true,
    createdAt: dateTime(row.created_at, "role created_at"),
    updatedAt: dateTime(row.updated_at, "role updated_at"),
    ...optionalField("description", optionalString(row.description)),
    ...optionalField("systemKey", optionalString(row.system_key) as SystemRoleKey | undefined),
  };
}

export function makeActor(row: DbRow, roles: Role[]): ActorContext | undefined {
  const priority: readonly SystemRoleKey[] = ["owner", "admin", "manager", "analyst", "employee"];
  const primaryRole = priority
    .map((systemKey) => roles.find((role) => role.systemKey === systemKey))
    .find((role) => role !== undefined);
  if (!primaryRole?.systemKey) return undefined;
  return {
    user: mapUser(row, roles.map((role) => role.id)),
    organization: mapOrganization(row),
    roles,
    permissions: [...new Set(roles.flatMap((role) => role.permissions))],
    roleKey: primaryRole.systemKey,
  };
}

export function mapEmployee(row: DbRow): Employee {
  const workingTimeZone = optionalString(row.working_time_zone);
  const workingDays = numberArray(row.working_week_days);
  const workingStartsAt = optionalString(row.working_day_starts_at);
  const workingEndsAt = optionalString(row.working_day_ends_at);
  const hasWorkingHours = workingTimeZone !== undefined && workingDays.length > 0 &&
    workingStartsAt !== undefined && workingEndsAt !== undefined;
  return {
    id: requiredString(row.id, "employee id"),
    organizationId: requiredString(row.organization_id, "employee organization id"),
    displayName: requiredString(row.display_name, "employee display name"),
    status: requiredString(row.status, "employee status") as Employee["status"],
    deviceIds: stringArray(row.device_ids),
    createdAt: dateTime(row.created_at, "employee created_at"),
    updatedAt: dateTime(row.updated_at, "employee updated_at"),
    ...optionalField("linkedUserId", optionalString(row.linked_user_id)),
    ...optionalField("employeeCode", optionalString(row.employee_code)),
    ...optionalField("email", optionalString(row.email)),
    ...optionalField("primaryPhone", optionalString(row.primary_phone)),
    ...optionalField("jobTitle", optionalString(row.job_title)),
    ...optionalField("team", optionalString(row.team_name)),
    ...optionalField("managerEmployeeId", optionalString(row.manager_employee_id)),
    ...(hasWorkingHours ? {
      workingHours: {
        timeZone: workingTimeZone,
        weekDays: workingDays,
        startsAt: timeValue(workingStartsAt),
        endsAt: timeValue(workingEndsAt),
      },
    } : {}),
  };
}

function mapSimCard(value: unknown): SimCard | undefined {
  const row = objectValue(value);
  const id = optionalString(row.id);
  const deviceId = optionalString(row.device_id);
  if (!id || !deviceId) return undefined;
  return {
    id,
    deviceId,
    slotIndex: requiredNumber(row.slot_index, "SIM slot index"),
    isEnabled: row.is_enabled === true,
    ...optionalField("carrierName", optionalString(row.carrier_name)),
    ...optionalField("phoneNumber", optionalString(row.phone_number)),
    ...optionalField("subscriptionId", optionalString(row.subscription_id)),
  };
}

export function mapDevice(row: DbRow): EmployeeDevice {
  const simCards = Array.isArray(row.sim_cards)
    ? row.sim_cards.map(mapSimCard).filter((card): card is SimCard => card !== undefined)
    : [];
  return {
    id: requiredString(row.id, "device id"),
    organizationId: requiredString(row.organization_id, "device organization id"),
    employeeId: requiredString(row.employee_id, "device employee id"),
    installationId: requiredString(row.installation_id, "device installation id"),
    platform: requiredString(row.platform, "device platform") as EmployeeDevice["platform"],
    osVersion: requiredString(row.os_version, "device OS version"),
    appVersion: requiredString(row.app_version, "device app version"),
    status: requiredString(row.status, "device status") as EmployeeDevice["status"],
    syncState: requiredString(row.sync_state, "device sync state") as EmployeeDevice["syncState"],
    permissions: {
      callLog: requiredString(row.call_log_permission, "call log permission") as EmployeeDevice["permissions"]["callLog"],
      phoneState: requiredString(row.phone_state_permission, "phone state permission") as EmployeeDevice["permissions"]["phoneState"],
      contacts: requiredString(row.contacts_permission, "contacts permission") as EmployeeDevice["permissions"]["contacts"],
      notifications: requiredString(row.notifications_permission, "notifications permission") as EmployeeDevice["permissions"]["notifications"],
      recordingFiles: requiredString(row.recording_files_permission, "recording permission") as EmployeeDevice["permissions"]["recordingFiles"],
      backgroundExecution: requiredString(row.background_execution_permission, "background permission") as EmployeeDevice["permissions"]["backgroundExecution"],
    },
    simCards,
    registeredAt: dateTime(row.registered_at, "device registered_at"),
    createdAt: dateTime(row.created_at, "device created_at"),
    updatedAt: dateTime(row.updated_at, "device updated_at"),
    ...optionalField("manufacturer", optionalString(row.manufacturer)),
    ...optionalField("model", optionalString(row.model)),
    ...optionalField("lastSeenAt", optionalDateTime(row.last_seen_at)),
    ...optionalField("lastHeartbeatAt", optionalDateTime(row.last_heartbeat_at)),
    ...optionalField("lastSuccessfulSyncAt", optionalDateTime(row.last_successful_sync_at)),
    ...(row.battery_percent === null || row.battery_percent === undefined
      ? {}
      : { batteryPercent: requiredNumber(row.battery_percent, "device battery percent") }),
    ...(typeof row.is_charging === "boolean" ? { isCharging: row.is_charging } : {}),
    ...optionalField("networkType", optionalString(row.network_type) as EmployeeDevice["networkType"] | undefined),
    ...(row.pending_call_count === null || row.pending_call_count === undefined
      ? {}
      : { pendingCallCount: requiredNumber(row.pending_call_count, "device pending call count") }),
    ...(row.pending_recording_count === null || row.pending_recording_count === undefined
      ? {}
      : { pendingRecordingCount: requiredNumber(row.pending_recording_count, "device pending recording count") }),
    ...optionalField("revokedAt", optionalDateTime(row.revoked_at)),
  };
}

export function mapPairingCode(row: DbRow): PairingCodeRecord {
  return {
    id: requiredString(row.id, "pairing code id"),
    codeHash: requiredString(row.code_hash, "pairing code hash"),
    codeLastFour: requiredString(row.code_hint, "pairing code hint"),
    organizationId: requiredString(row.organization_id, "pairing organization id"),
    employeeId: requiredString(row.employee_id, "pairing employee id"),
    createdAt: dateTime(row.created_at, "pairing created_at"),
    expiresAt: dateTime(row.expires_at, "pairing expires_at"),
    createdByUserId: requiredString(row.created_by_user_id, "pairing creator id"),
    collectionMode: requiredString(row.collection_mode, "pairing collection mode") as PairingCodeRecord["collectionMode"],
    ...optionalField("consumedAt", optionalDateTime(row.consumed_at)),
    ...optionalField("revokedAt", optionalDateTime(row.revoked_at)),
  };
}

export function mapCall(row: DbRow): CallLog {
  return {
    id: requiredString(row.id, "call id"),
    organizationId: requiredString(row.organization_id, "call organization id"),
    employeeId: requiredString(row.employee_id, "call employee id"),
    source: requiredString(row.source, "call source") as CallLog["source"],
    direction: requiredString(row.direction, "call direction") as CallLog["direction"],
    disposition: requiredString(row.disposition, "call disposition") as CallLog["disposition"],
    participant: {
      phoneNumber: requiredString(row.phone_number, "call phone number"),
      isInternal: row.is_internal === true,
      ...optionalField("displayName", optionalString(row.contact_name)),
    },
    startedAt: dateTime(row.started_at, "call started_at"),
    durationSeconds: requiredNumber(row.duration_seconds, "call duration"),
    isWithinWorkingHours: row.is_within_working_hours === true,
    recordingStatus: requiredString(row.recording_status, "recording status") as CallLog["recordingStatus"],
    noteCount: requiredNumber(row.note_count ?? 0, "call note count"),
    isPinned: row.is_pinned === true,
    createdAt: dateTime(row.created_at, "call created_at"),
    updatedAt: dateTime(row.updated_at, "call updated_at"),
    ...optionalField("deviceId", optionalString(row.device_id)),
    ...optionalField("simCardId", optionalString(row.sim_card_id)),
    ...optionalField("externalId", optionalString(row.external_id)),
    ...optionalField("answeredAt", optionalDateTime(row.answered_at)),
    ...optionalField("endedAt", optionalDateTime(row.ended_at)),
    ...(row.ring_duration_seconds === null || row.ring_duration_seconds === undefined
      ? {}
      : { ringDurationSeconds: requiredNumber(row.ring_duration_seconds, "call ring duration") }),
  };
}

export function mapAuditEvent(row: DbRow): AuditEvent {
  return {
    id: requiredString(row.id, "audit id"),
    organizationId: requiredString(row.organization_id, "audit organization id"),
    action: requiredString(row.action, "audit action"),
    entityType: requiredString(row.entity_type, "audit entity type") as AuditEvent["entityType"],
    entityId: requiredString(row.entity_id, "audit entity id"),
    occurredAt: dateTime(row.occurred_at, "audit occurred_at"),
    metadata: objectValue(row.metadata) as Record<string, JsonValue>,
    ...optionalField("actorUserId", optionalString(row.actor_user_id)),
    ...optionalField("actorDeviceId", optionalString(row.actor_device_id)),
    ...optionalField("requestId", optionalString(row.request_id)),
  };
}

export function mapOutboxEvent(row: DbRow): OutboxEventRecord {
  return {
    id: requiredString(row.id, "outbox id"),
    organizationId: requiredString(row.organization_id, "outbox organization id"),
    aggregateType: requiredString(row.aggregate_type, "outbox aggregate type"),
    aggregateId: requiredString(row.aggregate_id, "outbox aggregate id"),
    eventType: requiredString(row.event_type, "outbox event type"),
    payload: objectValue(row.payload),
    availableAt: dateTime(row.available_at, "outbox available_at"),
    attemptCount: requiredNumber(row.attempt_count, "outbox attempt count"),
    createdAt: dateTime(row.created_at, "outbox created_at"),
    updatedAt: dateTime(row.updated_at, "outbox updated_at"),
    ...optionalField("lockedAt", optionalDateTime(row.locked_at)),
    ...optionalField("lockedBy", optionalString(row.locked_by)),
    ...optionalField("deliveredAt", optionalDateTime(row.delivered_at)),
    ...optionalField("lastError", optionalString(row.last_error)),
  };
}
