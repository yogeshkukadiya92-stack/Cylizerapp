import type { CallLogId } from "./calls.js";
import type { EntityId, IsoDateTime } from "./common.js";
import { isNonEmptyString, isRecord } from "./common.js";
import type { EmployeeId } from "./employees.js";
import type {
  FollowUpPriority,
  LeadDetail,
  LeadId,
  LeadImportRow,
  LeadSource,
  LeadStatusId,
  LeadTemperature,
} from "./leads.js";
import { isFollowUpPriority, isLeadSource } from "./leads.js";
import type { OrganizationId, UserId } from "./organizations.js";

export const MAX_LEAD_IMPORT_ROWS = 1_000;
export const MAX_LEAD_IMPORT_FILE_NAME_LENGTH = 255;
export const MAX_LEAD_IMPORT_TAGS = 100;

export type LeadImportJobStatus =
  | "preview_ready"
  | "processing"
  | "completed"
  | "interrupted"
  | "failed";

export type LeadImportRowDecision = "valid" | "duplicate" | "invalid" | "imported";
export type LeadImportIssueCode =
  | "required"
  | "invalid_phone"
  | "invalid_email"
  | "invalid_source"
  | "unknown_status"
  | "unknown_owner"
  | "duplicate_in_file"
  | "duplicate_existing";

export interface LeadImportIssue {
  field: string;
  code: LeadImportIssueCode;
  message: string;
}

export interface LeadImportPreviewRow {
  rowNumber: number;
  decision: LeadImportRowDecision;
  input: LeadImportRow;
  issues: LeadImportIssue[];
  duplicateLeadId?: LeadId;
  proposedAssignedEmployeeId?: EmployeeId;
}

export interface LeadImportJob {
  id: EntityId;
  organizationId: OrganizationId;
  fileName: string;
  status: LeadImportJobStatus;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  errorRows: number;
  importedRows: number;
  processedRows: number;
  createdByUserId: UserId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt?: IsoDateTime;
  lastError?: string;
  errorDownloadAvailable: boolean;
}

export interface PreviewLeadImportInput {
  requestId: string;
  fileName: string;
  rows: LeadImportRow[];
}

export interface LeadImportPreview {
  job: LeadImportJob;
  rows: LeadImportPreviewRow[];
  /** True only when preview creation replayed the same request ID and payload. */
  replayed: boolean;
}

export interface CommitLeadImportInput {
  requestId: string;
}

export interface LeadImportResult {
  job: LeadImportJob;
  replayed: boolean;
}

export type LeadAssignmentStrategy = "fixed_owner" | "round_robin";

export interface LeadAssignmentConditions {
  sources?: LeadSource[];
  temperatures?: LeadTemperature[];
  statusIds?: LeadStatusId[];
}

export interface LeadAssignmentRule {
  id: EntityId;
  organizationId: OrganizationId;
  name: string;
  priority: number;
  active: boolean;
  conditions: LeadAssignmentConditions;
  strategy: LeadAssignmentStrategy;
  employeeIds: EmployeeId[];
  version: number;
  createdByUserId: UserId;
  updatedByUserId: UserId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CreateLeadAssignmentRuleInput {
  name: string;
  priority: number;
  active?: boolean;
  conditions?: LeadAssignmentConditions;
  strategy: LeadAssignmentStrategy;
  employeeIds: EmployeeId[];
}

export interface UpdateLeadAssignmentRuleInput {
  expectedVersion: number;
  changes: Partial<Omit<CreateLeadAssignmentRuleInput, "active">> & { active?: boolean };
}

export interface LeadAssignmentDistribution {
  employeeId: EmployeeId;
  leadCount: number;
}

export interface LeadAssignmentDryRun {
  matchedLeads: number;
  unmatchedLeads: number;
  distribution: LeadAssignmentDistribution[];
}

export interface ApplyLeadAssignmentRulesInput {
  requestId: string;
  includeExistingUnassigned: boolean;
}

export interface ApplyLeadAssignmentRulesResult extends LeadAssignmentDryRun {
  requestId: string;
  replayed: boolean;
  appliedLeads: number;
}

export interface CorrectCallLeadLinkInput {
  requestId: string;
  expectedLeadId: LeadId | null;
  replacementLeadId: LeadId | null;
  reason: string;
}

export interface CorrectCallLeadLinkResult {
  requestId: string;
  callLogId: CallLogId;
  previousLeadId: LeadId | null;
  replacementLeadId: LeadId | null;
  correctedAt: IsoDateTime;
  replayed: boolean;
}

export interface MobileLeadUpdateNote {
  body: string;
}

export interface MobileLeadUpdateFollowUp {
  title: string;
  notes?: string;
  dueAt: IsoDateTime;
  reminderAt?: IsoDateTime;
  priority?: FollowUpPriority;
}

export interface MobileLeadUpdateInput {
  schemaVersion: 1;
  requestId: string;
  expectedLeadVersion: number;
  occurredAt: IsoDateTime;
  statusId?: LeadStatusId;
  note?: MobileLeadUpdateNote;
  followUp?: MobileLeadUpdateFollowUp;
}

export interface MobileLeadUpdateReceipt {
  requestId: string;
  replayed: boolean;
  appliedLeadVersion: number;
  /** Present on the initial mutation. A replay may omit PII-bearing detail. */
  detail?: LeadDetail;
}

export interface LeadReportFilter {
  from: IsoDateTime;
  to: IsoDateTime;
  employeeId?: EmployeeId;
  team?: string;
  source?: LeadSource;
}

export interface LeadReportKpis {
  totalLeads: number;
  convertedLeads: number;
  conversionRate: number;
  followUpsDue: number;
  averageFirstResponseSeconds?: number;
}

export interface LeadReportPipelineRow {
  statusId: LeadStatusId;
  statusName: string;
  color: string;
  leadCount: number;
  percentageOfTotal: number;
  isWon: boolean;
  isLost: boolean;
}

export interface LeadReportTrendRow {
  bucketStart: IsoDateTime;
  created: number;
  won: number;
}

export interface LeadReportOwnerRow {
  employeeId: EmployeeId | null;
  displayName: string;
  assigned: number;
  contacted: number;
  won: number;
  conversionRate: number;
  overdueFollowUps: number;
  averageResponseSeconds?: number;
}

export interface LeadReportSourceRow {
  source: LeadSource;
  leads: number;
  contacted: number;
  qualified: number;
  won: number;
  conversionRate: number;
  percentageOfTotal: number;
}

export interface LeadReport {
  filter: LeadReportFilter;
  kpis: LeadReportKpis;
  pipeline: LeadReportPipelineRow[];
  trend: LeadReportTrendRow[];
  owners: LeadReportOwnerRow[];
  sources: LeadReportSourceRow[];
  generatedAt: IsoDateTime;
  timeZone: string;
  metricDefinitionVersion: "2026-07-15";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isCanonicalRfc3339DateTime(value: unknown): value is IsoDateTime {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth && !Number.isNaN(Date.parse(value));
}

function isBoundedLeadJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 8) return false;
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => isBoundedLeadJsonValue(item, depth + 1));
  }
  return isRecord(value) && Object.keys(value).length <= 100 &&
    Object.values(value).every((item) => isBoundedLeadJsonValue(item, depth + 1));
}

export function isLeadImportCustomFields(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 100 ||
    Object.keys(value).some((key) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) ||
    !Object.values(value).every((item) => isBoundedLeadJsonValue(item))) return false;
  return JSON.stringify(value).length <= 65_536;
}

function hasOnlyKnownLeadImportRowValues(value: Record<string, unknown>): boolean {
  // Import preview accepts syntactically bounded strings, including empty or
  // malformed values. Row-level validation must produce visible decisions;
  // rejecting the whole file would make an error report impossible.
  if (typeof value.firstName !== "string" || value.firstName.length > 200 ||
    typeof value.phoneNumber !== "string" || value.phoneNumber.length > 64) return false;
  if (!isOptionalString(value.lastName) || !isOptionalString(value.companyName) ||
    !isOptionalString(value.alternatePhoneNumber) || !isOptionalString(value.email) ||
    !isOptionalString(value.statusName) ||
    !isOptionalString(value.assignedEmployeeCode)) return false;
  if (typeof value.lastName === "string" && value.lastName.length > 200) return false;
  if (typeof value.companyName === "string" && value.companyName.length > 240) return false;
  if (typeof value.alternatePhoneNumber === "string" && value.alternatePhoneNumber.length > 64) return false;
  if (typeof value.email === "string" && value.email.length > 320) return false;
  if (typeof value.statusName === "string" && value.statusName.length > 120) return false;
  if (typeof value.assignedEmployeeCode === "string" && value.assignedEmployeeCode.length > 120) return false;
  // Unknown source text is also a row-level validation outcome. Known values
  // keep their LeadSource transport type; a bounded unknown value must not
  // reject the entire file before the server can report it.
  if (value.source !== undefined &&
    (typeof value.source !== "string" || value.source.length > 60)) return false;
  if (value.tagNames !== undefined && (!isStringArray(value.tagNames) ||
    value.tagNames.length > MAX_LEAD_IMPORT_TAGS ||
    value.tagNames.some((tagName) => tagName.length > 120))) return false;
  return value.customFields === undefined || isLeadImportCustomFields(value.customFields);
}

export function isLeadImportRow(value: unknown): value is LeadImportRow {
  return isRecord(value) && hasOnlyKnownLeadImportRowValues(value);
}

export function isPreviewLeadImportInput(value: unknown): value is PreviewLeadImportInput {
  return isRecord(value) && isNonEmptyString(value.requestId) &&
    value.requestId.trim().length >= 8 && value.requestId.length <= 100 &&
    isNonEmptyString(value.fileName) && value.fileName.length <= MAX_LEAD_IMPORT_FILE_NAME_LENGTH &&
    Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= MAX_LEAD_IMPORT_ROWS &&
    value.rows.every(isLeadImportRow);
}

export function isCommitLeadImportInput(value: unknown): value is CommitLeadImportInput {
  return isRecord(value) && isNonEmptyString(value.requestId) && value.requestId.length <= 100;
}

export function isLeadAssignmentStrategy(value: unknown): value is LeadAssignmentStrategy {
  return value === "fixed_owner" || value === "round_robin";
}

function isLeadTemperature(value: unknown): value is LeadTemperature {
  return value === "cold" || value === "warm" || value === "hot";
}

function isLeadAssignmentConditions(value: unknown): value is LeadAssignmentConditions {
  if (!isRecord(value)) return false;
  if (value.sources !== undefined && (!Array.isArray(value.sources) || !value.sources.every(isLeadSource))) return false;
  if (value.temperatures !== undefined && (!Array.isArray(value.temperatures) || !value.temperatures.every(isLeadTemperature))) return false;
  return value.statusIds === undefined || isStringArray(value.statusIds);
}

function hasValidRuleShape(value: Record<string, unknown>): boolean {
  if (!isNonEmptyString(value.name) || value.name.length > 120 ||
    !Number.isSafeInteger(value.priority) || (value.priority as number) < 1 || (value.priority as number) > 10_000 ||
    !isLeadAssignmentStrategy(value.strategy) || !isStringArray(value.employeeIds) || value.employeeIds.length === 0 ||
    value.employeeIds.length > 100) return false;
  if (value.active !== undefined && typeof value.active !== "boolean") return false;
  if (value.conditions !== undefined && !isLeadAssignmentConditions(value.conditions)) return false;
  return value.strategy !== "fixed_owner" || value.employeeIds.length === 1;
}

export function isCreateLeadAssignmentRuleInput(value: unknown): value is CreateLeadAssignmentRuleInput {
  return isRecord(value) && hasValidRuleShape(value);
}

export function isUpdateLeadAssignmentRuleInput(value: unknown): value is UpdateLeadAssignmentRuleInput {
  if (!isRecord(value) || !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 1 ||
    !isRecord(value.changes) || Object.keys(value.changes).length === 0) return false;
  const changes = value.changes;
  if (changes.name !== undefined && (!isNonEmptyString(changes.name) || changes.name.length > 120)) return false;
  if (changes.priority !== undefined && (!Number.isSafeInteger(changes.priority) ||
    (changes.priority as number) < 1 || (changes.priority as number) > 10_000)) return false;
  if (changes.active !== undefined && typeof changes.active !== "boolean") return false;
  if (changes.conditions !== undefined && !isLeadAssignmentConditions(changes.conditions)) return false;
  if (changes.strategy !== undefined && !isLeadAssignmentStrategy(changes.strategy)) return false;
  if (changes.employeeIds !== undefined && (!isStringArray(changes.employeeIds) || changes.employeeIds.length === 0 ||
    changes.employeeIds.length > 100)) return false;
  return true;
}

export function isApplyLeadAssignmentRulesInput(value: unknown): value is ApplyLeadAssignmentRulesInput {
  return isRecord(value) && isNonEmptyString(value.requestId) && value.requestId.length <= 100 &&
    typeof value.includeExistingUnassigned === "boolean";
}

export function isCorrectCallLeadLinkInput(value: unknown): value is CorrectCallLeadLinkInput {
  return isRecord(value) && isNonEmptyString(value.requestId) && value.requestId.length <= 100 &&
    (value.expectedLeadId === null || isNonEmptyString(value.expectedLeadId)) &&
    (value.replacementLeadId === null || isNonEmptyString(value.replacementLeadId)) &&
    isNonEmptyString(value.reason) && value.reason.trim().length >= 3 && value.reason.length <= 500 &&
    value.expectedLeadId !== value.replacementLeadId;
}

export function isMobileLeadUpdateInput(value: unknown): value is MobileLeadUpdateInput {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isNonEmptyString(value.requestId) || value.requestId.length > 100 ||
    !Number.isSafeInteger(value.expectedLeadVersion) || (value.expectedLeadVersion as number) < 1 ||
    !isCanonicalRfc3339DateTime(value.occurredAt)) return false;
  const hasStatus = isNonEmptyString(value.statusId);
  const hasNote = isRecord(value.note) && isNonEmptyString(value.note.body) && value.note.body.length <= 5_000;
  const followUp = value.followUp;
  const hasFollowUp = isRecord(followUp) && isNonEmptyString(followUp.title) && followUp.title.length <= 200 &&
    isCanonicalRfc3339DateTime(followUp.dueAt) && (followUp.notes === undefined ||
      (isNonEmptyString(followUp.notes) && followUp.notes.length <= 5_000)) &&
    (followUp.reminderAt === undefined || isCanonicalRfc3339DateTime(followUp.reminderAt)) &&
    (followUp.priority === undefined || isFollowUpPriority(followUp.priority));
  if (value.statusId !== undefined && !hasStatus) return false;
  if (value.note !== undefined && !hasNote) return false;
  if (value.followUp !== undefined && !hasFollowUp) return false;
  if (hasFollowUp && followUp.reminderAt !== undefined &&
    Date.parse(followUp.reminderAt as string) > Date.parse(followUp.dueAt as string)) return false;
  return hasStatus || hasNote || hasFollowUp;
}

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runtime boundary validator for the report query contract. */
export function isLeadReportFilter(value: unknown): value is LeadReportFilter {
  if (!isRecord(value) || !isCanonicalRfc3339DateTime(value.from) ||
    !isCanonicalRfc3339DateTime(value.to)) return false;
  if (value.employeeId !== undefined &&
    (typeof value.employeeId !== "string" || !CANONICAL_UUID_PATTERN.test(value.employeeId))) return false;
  if (value.team !== undefined &&
    (typeof value.team !== "string" || value.team.length === 0 || value.team.length > 100)) return false;
  return value.source === undefined || isLeadSource(value.source);
}
