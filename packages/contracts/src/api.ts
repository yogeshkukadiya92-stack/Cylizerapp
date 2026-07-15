import type {
  DateTimeRange,
  EntityId,
  IsoDateTime,
  JsonValue,
  SortDirection,
} from "./common.js";
import { isNonEmptyString, isRecord } from "./common.js";
import type { CallDirection, CallDisposition, RecordingStatus } from "./calls.js";
import type { DeviceStatus, EmployeeId, EmployeeStatus } from "./employees.js";
import type { FollowUpStatus, LeadId, LeadSource, LeadStatusId, LeadTagId } from "./leads.js";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONSENT_REQUIRED"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "PAYMENT_REQUIRED"
  | "STORAGE_LIMIT_REACHED"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

export interface ApiErrorDetail {
  field?: string;
  code: string;
  message: string;
  value?: JsonValue;
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: ApiErrorDetail[];
  requestId?: string;
  retryAfterSeconds?: number;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId?: string;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
  requestId?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface PageRequest {
  /** One-based page number. */
  page?: number;
  /** Requested page size. Servers should enforce an upper bound. */
  pageSize?: number;
}

export interface CursorRequest {
  cursor?: string;
  limit?: number;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface CursorInfo {
  nextCursor?: string;
  previousCursor?: string;
  hasMore: boolean;
}

export interface PaginatedData<T> {
  items: T[];
  pageInfo: PageInfo;
}

export interface CursorData<T> {
  items: T[];
  cursorInfo: CursorInfo;
}

export type PaginatedResponse<T> = ApiResponse<PaginatedData<T>>;
export type CursorResponse<T> = ApiResponse<CursorData<T>>;

export interface SortSpec<TField extends string = string> {
  field: TField;
  direction: SortDirection;
}

export interface BaseListFilters {
  search?: string;
  period?: DateTimeRange;
}

export interface CallLogFilters extends BaseListFilters {
  employeeIds?: EmployeeId[];
  directions?: CallDirection[];
  dispositions?: CallDisposition[];
  recordingStatuses?: RecordingStatus[];
  leadId?: LeadId;
  phoneNumber?: string;
  connectedOnly?: boolean;
  workingHoursOnly?: boolean;
  pinnedOnly?: boolean;
  hasRecording?: boolean;
}

export interface LeadFilters extends BaseListFilters {
  statusIds?: LeadStatusId[];
  assignedEmployeeIds?: EmployeeId[];
  tagIds?: LeadTagId[];
  sources?: LeadSource[];
  followUpStatuses?: FollowUpStatus[];
  contacted?: boolean;
  archived?: boolean;
}

export interface EmployeeFilters extends BaseListFilters {
  statuses?: EmployeeStatus[];
  deviceStatuses?: DeviceStatus[];
  teams?: string[];
  managerEmployeeIds?: EmployeeId[];
}

export interface ListRequest<TFilters, TSortField extends string = string> extends PageRequest {
  filters?: TFilters;
  sort?: SortSpec<TSortField>[];
}

export interface BulkActionRequest<TId extends EntityId = EntityId> {
  ids: TId[];
  idempotencyKey?: string;
}

export interface BulkActionResult<TId extends EntityId = EntityId> {
  succeededIds: TId[];
  failed: Array<{ id: TId; error: ApiError }>;
}

export interface DeleteResult {
  id: EntityId;
  deletedAt: IsoDateTime;
}

export function isApiFailure(value: unknown): value is ApiFailure {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) {
    return false;
  }

  return isNonEmptyString(value.error.code) && isNonEmptyString(value.error.message);
}

export function isApiSuccess<T>(
  value: unknown,
  isData: (candidate: unknown) => candidate is T,
): value is ApiSuccess<T> {
  return isRecord(value) && value.ok === true && isData(value.data);
}

export function getApiDataOrThrow<T>(response: ApiResponse<T>): T {
  if (response.ok) {
    return response.data;
  }

  throw new Error(`${response.error.code}: ${response.error.message}`);
}
