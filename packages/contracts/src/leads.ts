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
export type LeadActivityKind =
  | "created"
  | "assigned"
  | "status_changed"
  | "tag_added"
  | "tag_removed"
  | "note_added"
  | "call_linked"
  | "follow_up_created"
  | "follow_up_completed";

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
  completionNote?: string;
  completedAt?: IsoDateTime;
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

export function isCreateFollowUpInput(value: unknown): value is CreateFollowUpInput {
  return (
    isRecord(value) &&
    isNonEmptyString(value.leadId) &&
    isNonEmptyString(value.assignedEmployeeId) &&
    isNonEmptyString(value.title) &&
    isIsoDateTime(value.dueAt)
  );
}
