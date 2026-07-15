import type {
  AuditFields,
  EmailAddress,
  EntityId,
  IsoDateTime,
  JsonValue,
  PhoneNumber,
} from "./common.js";
import { isIsoDateTime, isNonEmptyString, isRecord } from "./common.js";
import type { CallLogId } from "./calls.js";
import type { EmployeeId } from "./employees.js";
import type { OrganizationId, UserId } from "./organizations.js";

export type LeadId = EntityId;
export type LeadStatusId = EntityId;
export type LeadTagId = EntityId;
export type FollowUpId = EntityId;

export type LeadTemperature = "cold" | "warm" | "hot";
export type LeadSource =
  | "manual"
  | "csv_import"
  | "website"
  | "facebook"
  | "instagram"
  | "google_ads"
  | "india_mart"
  | "api"
  | "integration"
  | "unknown";
export type FollowUpStatus = "pending" | "completed" | "cancelled" | "overdue";
export type FollowUpPriority = "low" | "normal" | "high" | "urgent";
export type LeadQueueKey = "all" | "not_contacted" | "overdue" | "unreturned_calls";
export type LeadActivityKind =
  | "created"
  | "updated"
  | "assigned"
  | "unassigned"
  | "status_changed"
  | "custom_fields_changed"
  | "tag_added"
  | "tag_removed"
  | "note_added"
  | "call_linked"
  | "call_unlinked"
  | "follow_up_created"
  | "follow_up_completed"
  | "follow_up_cancelled";

export interface LeadStatus {
  id: LeadStatusId;
  organizationId: OrganizationId;
  name: string;
  color: string;
  position: number;
  isInitial: boolean;
  isWon: boolean;
  isLost: boolean;
  isActive: boolean;
}

export interface LeadTag {
  id: LeadTagId;
  organizationId: OrganizationId;
  name: string;
  color: string;
}

export type LeadCustomFieldType = "text" | "number" | "date" | "boolean" | "single_select" | "multi_select";

export interface LeadCustomFieldDefinition {
  id: EntityId;
  organizationId: OrganizationId;
  key: string;
  label: string;
  type: LeadCustomFieldType;
  required: boolean;
  options?: string[];
  position: number;
  isActive: boolean;
}

export interface Lead extends AuditFields {
  id: LeadId;
  organizationId: OrganizationId;
  firstName: string;
  lastName?: string;
  companyName?: string;
  phoneNumber: PhoneNumber;
  alternatePhoneNumber?: PhoneNumber;
  email?: EmailAddress;
  source: LeadSource;
  sourceReference?: string;
  statusId: LeadStatusId;
  temperature?: LeadTemperature;
  assignedEmployeeId?: EmployeeId;
  tagIds: LeadTagId[];
  customFields: Record<string, JsonValue>;
  lastContactedAt?: IsoDateTime;
  nextFollowUpAt?: IsoDateTime;
  convertedAt?: IsoDateTime;
  lostAt?: IsoDateTime;
  archivedAt?: IsoDateTime;
  /** Compare-and-swap revision. Every successful mutation increments it once. */
  version: number;
}

export interface LeadNote extends AuditFields {
  id: EntityId;
  organizationId: OrganizationId;
  leadId: LeadId;
  authorUserId: UserId;
  body: string;
  isPinned: boolean;
}

export interface FollowUp extends AuditFields {
  id: FollowUpId;
  organizationId: OrganizationId;
  leadId: LeadId;
  assignedEmployeeId: EmployeeId;
  title: string;
  notes?: string;
  dueAt: IsoDateTime;
  reminderAt?: IsoDateTime;
  priority: FollowUpPriority;
  status: FollowUpStatus;
  completedAt?: IsoDateTime;
  completedByUserId?: UserId;
  /** Compare-and-swap revision. Every successful mutation increments it once. */
  version: number;
}

export interface LeadActivity {
  id: EntityId;
  organizationId: OrganizationId;
  leadId: LeadId;
  kind: LeadActivityKind;
  actorUserId?: UserId;
  actorEmployeeId?: EmployeeId;
  callLogId?: CallLogId;
  occurredAt: IsoDateTime;
  summary: string;
  metadata?: Record<string, JsonValue>;
}

export interface CreateLeadInput {
  firstName: string;
  lastName?: string;
  companyName?: string;
  phoneNumber: PhoneNumber;
  alternatePhoneNumber?: PhoneNumber;
  email?: EmailAddress;
  source?: LeadSource;
  sourceReference?: string;
  statusId?: LeadStatusId;
  temperature?: LeadTemperature;
  assignedEmployeeId?: EmployeeId;
  tagIds?: LeadTagId[];
  customFields?: Record<string, JsonValue>;
}

export interface UpdateLeadInput {
  firstName?: string;
  lastName?: string | null;
  companyName?: string | null;
  phoneNumber?: PhoneNumber;
  alternatePhoneNumber?: PhoneNumber | null;
  email?: EmailAddress | null;
  statusId?: LeadStatusId;
  temperature?: LeadTemperature | null;
  assignedEmployeeId?: EmployeeId | null;
  tagIds?: LeadTagId[];
  customFields?: Record<string, JsonValue>;
  archived?: boolean;
}

export interface UpdateLeadRequest {
  expectedVersion: number;
  changes: UpdateLeadInput;
}

export interface CreateLeadNoteInput {
  body: string;
  isPinned?: boolean;
}

export interface CreateFollowUpInput {
  leadId: LeadId;
  assignedEmployeeId: EmployeeId;
  title: string;
  notes?: string;
  dueAt: IsoDateTime;
  reminderAt?: IsoDateTime;
  priority?: FollowUpPriority;
}

export interface CompleteFollowUpInput {
  expectedVersion: number;
  completionNote?: string;
  completedAt?: IsoDateTime;
}

export interface LeadOwnerSummary {
  id: EmployeeId;
  displayName: string;
  team?: string;
}

export interface LeadListItem {
  lead: Lead;
  status: LeadStatus;
  assignedEmployee?: LeadOwnerSummary;
  nextFollowUp?: FollowUp;
  overdueFollowUpCount: number;
  unreturnedMissedCallCount: number;
}

export interface LeadQueueSummary {
  total: number;
  notContacted: number;
  overdue: number;
  unreturnedCalls: number;
}

export interface LeadDetail {
  item: LeadListItem;
  notes: LeadNote[];
  followUps: FollowUp[];
  activities: LeadActivity[];
}

export interface LeadImportRow {
  firstName: string;
  lastName?: string;
  companyName?: string;
  phoneNumber: PhoneNumber;
  alternatePhoneNumber?: PhoneNumber;
  email?: EmailAddress;
  source?: LeadSource;
  statusName?: string;
  assignedEmployeeCode?: string;
  tagNames?: string[];
  customFields?: Record<string, JsonValue>;
}

export function isLeadSource(value: unknown): value is LeadSource {
  return [
    "manual",
    "csv_import",
    "website",
    "facebook",
    "instagram",
    "google_ads",
    "india_mart",
    "api",
    "integration",
    "unknown",
  ].includes(value as LeadSource);
}

export function isLeadQueueKey(value: unknown): value is LeadQueueKey {
  return ["all", "not_contacted", "overdue", "unreturned_calls"].includes(value as LeadQueueKey);
}

export function isFollowUpPriority(value: unknown): value is FollowUpPriority {
  return ["low", "normal", "high", "urgent"].includes(value as FollowUpPriority);
}

export function isCreateLeadInput(value: unknown): value is CreateLeadInput {
  if (!isRecord(value) || !isNonEmptyString(value.firstName) ||
    !isNonEmptyString(value.phoneNumber) || !/^\+[1-9]\d{7,14}$/.test(value.phoneNumber)) {
    return false;
  }
  if (value.source !== undefined && !isLeadSource(value.source)) return false;
  if (value.email !== undefined &&
    (!isNonEmptyString(value.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email))) return false;
  if (value.assignedEmployeeId !== undefined && !isNonEmptyString(value.assignedEmployeeId)) return false;
  if (value.statusId !== undefined && !isNonEmptyString(value.statusId)) return false;
  return value.tagIds === undefined ||
    (Array.isArray(value.tagIds) && value.tagIds.every(isNonEmptyString));
}

export function isUpdateLeadRequest(value: unknown): value is UpdateLeadRequest {
  if (!isRecord(value) || !Number.isSafeInteger(value.expectedVersion) ||
    (value.expectedVersion as number) < 1 || !isRecord(value.changes)) return false;
  const changes = value.changes;
  if (Object.keys(changes).length === 0) return false;
  if (changes.phoneNumber !== undefined &&
    (!isNonEmptyString(changes.phoneNumber) || !/^\+[1-9]\d{7,14}$/.test(changes.phoneNumber))) return false;
  if (changes.email !== undefined && changes.email !== null &&
    (!isNonEmptyString(changes.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.email))) return false;
  if (changes.assignedEmployeeId !== undefined && changes.assignedEmployeeId !== null &&
    !isNonEmptyString(changes.assignedEmployeeId)) return false;
  return true;
}

export function isCreateLeadNoteInput(value: unknown): value is CreateLeadNoteInput {
  return isRecord(value) && isNonEmptyString(value.body) &&
    (value.isPinned === undefined || typeof value.isPinned === "boolean");
}

export function isCreateFollowUpInput(value: unknown): value is CreateFollowUpInput {
  return (
    isRecord(value) &&
    isNonEmptyString(value.leadId) &&
    isNonEmptyString(value.assignedEmployeeId) &&
    isNonEmptyString(value.title) &&
    isIsoDateTime(value.dueAt) &&
    (value.priority === undefined || isFollowUpPriority(value.priority))
  );
}

export function isCompleteFollowUpInput(value: unknown): value is CompleteFollowUpInput {
  return isRecord(value) && Number.isSafeInteger(value.expectedVersion) &&
    (value.expectedVersion as number) >= 1 &&
    (value.completedAt === undefined || isIsoDateTime(value.completedAt)) &&
    (value.completionNote === undefined || isNonEmptyString(value.completionNote));
}
