import type {
  AuditFields,
  DurationSeconds,
  EntityId,
  IsoDateTime,
  PhoneNumber,
} from "./common.js";
import { isFiniteNumber, isIsoDateTime, isNonEmptyString, isRecord } from "./common.js";
import type { DeviceId, EmployeeId, SimCardId } from "./employees.js";
import type { OrganizationId, UserId } from "./organizations.js";

export type CallLogId = EntityId;
export type CallRecordingId = EntityId;
export type CallNoteId = EntityId;

export type CallDirection = "incoming" | "outgoing";
export type CallDisposition =
  | "answered"
  | "missed"
  | "rejected"
  | "busy"
  | "blocked"
  | "voicemail"
  | "unknown";
export type CallSource = "mobile_call_log" | "manual" | "telephony_provider" | "import";
export type RecordingStatus =
  | "not_expected"
  | "pending"
  | "uploading"
  | "available"
  | "failed"
  | "deleted";
export type TranscriptionStatus = "not_requested" | "queued" | "processing" | "complete" | "failed";

export interface CallParticipant {
  phoneNumber: PhoneNumber;
  displayName?: string;
  contactId?: EntityId;
  isInternal: boolean;
}

/** A normalized call event. `externalId` makes mobile retry operations idempotent. */
export interface CallLog extends AuditFields {
  id: CallLogId;
  organizationId: OrganizationId;
  employeeId: EmployeeId;
  deviceId?: DeviceId;
  simCardId?: SimCardId;
  externalId?: string;
  source: CallSource;
  direction: CallDirection;
  disposition: CallDisposition;
  participant: CallParticipant;
  startedAt: IsoDateTime;
  answeredAt?: IsoDateTime;
  endedAt?: IsoDateTime;
  durationSeconds: DurationSeconds;
  ringDurationSeconds?: DurationSeconds;
  isWithinWorkingHours: boolean;
  recordingStatus: RecordingStatus;
  recordingId?: CallRecordingId;
  leadId?: EntityId;
  noteCount: number;
  isPinned: boolean;
}

export interface CallNote extends AuditFields {
  id: CallNoteId;
  organizationId: OrganizationId;
  callLogId: CallLogId;
  authorUserId: UserId;
  body: string;
  isPinned: boolean;
}

export interface RecordingTranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker?: "employee" | "customer" | "unknown";
  confidence?: number;
}

export interface CallRecording extends AuditFields {
  id: CallRecordingId;
  organizationId: OrganizationId;
  callLogId: CallLogId;
  status: RecordingStatus;
  storageKey?: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  durationSeconds?: DurationSeconds;
  checksumSha256?: string;
  uploadedAt?: IsoDateTime;
  deletedAt?: IsoDateTime;
  transcriptionStatus: TranscriptionStatus;
  transcriptLanguage?: string;
  transcriptText?: string;
  transcriptSegments?: RecordingTranscriptSegment[];
}

export interface CreateCallNoteInput {
  body: string;
  isPinned?: boolean;
}

export interface UpdateCallLogInput {
  isPinned?: boolean;
  leadId?: EntityId | null;
}

export interface CallLogImportRow {
  employeeId: EmployeeId;
  phoneNumber: PhoneNumber;
  displayName?: string;
  direction: CallDirection;
  disposition: CallDisposition;
  startedAt: IsoDateTime;
  durationSeconds: DurationSeconds;
}

export function isCallDirection(value: unknown): value is CallDirection {
  return value === "incoming" || value === "outgoing";
}

export function isCallDisposition(value: unknown): value is CallDisposition {
  return ["answered", "missed", "rejected", "busy", "blocked", "voicemail", "unknown"].includes(
    value as CallDisposition,
  );
}

export function isCallLogImportRow(value: unknown): value is CallLogImportRow {
  return (
    isRecord(value) &&
    isNonEmptyString(value.employeeId) &&
    isNonEmptyString(value.phoneNumber) &&
    isCallDirection(value.direction) &&
    isCallDisposition(value.disposition) &&
    isIsoDateTime(value.startedAt) &&
    isFiniteNumber(value.durationSeconds) &&
    value.durationSeconds >= 0
  );
}
