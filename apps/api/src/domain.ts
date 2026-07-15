import type {
  AuthenticatedActor,
  AdminDeviceRevocationResult,
  CallDirection,
  CallDisposition,
  CallLog,
  CallLogSyncBatch,
  CallLogSyncResult,
  CompleteFollowUpInput,
  CreateFollowUpInput,
  CreateLeadInput,
  CreateLeadNoteInput,
  DevicePermissions,
  DeviceHeartbeat,
  EmployeeDevice,
  HeartbeatAcknowledgement,
  IsoDateTime,
  JsonValue,
  LeadDetail,
  LeadListItem,
  LeadQueueKey,
  LeadQueueSummary,
  LeadStatus,
  OrganizationId,
  Permission,
  SystemRoleKey,
  UserId,
  MobileActivationInput,
  MobileCollectionMode,
  MobileCollectionPolicy,
  MobilePolicyReference,
  MobileReconsentInput,
  UpdateLeadRequest,
} from "@callora/contracts";
import type { DeviceCredentialType } from "./security.js";

export interface ActorContext extends AuthenticatedActor {
  roleKey: SystemRoleKey;
  leadScope: LeadAccessScope;
}

export type LeadAccessScope =
  | { kind: "organization" }
  | { kind: "teams"; teamNames: string[] }
  | { kind: "assigned"; employeeId: string };

export interface AuditEvent {
  id: string;
  organizationId: OrganizationId;
  actorUserId?: UserId;
  actorDeviceId?: string;
  requestId?: string;
  action: string;
  entityType: "employee" | "device" | "pairing_code" | "call" | "session" | "lead" | "follow_up";
  entityId: string;
  occurredAt: IsoDateTime;
  metadata: Record<string, JsonValue>;
}

export interface AdminRevokeDeviceResult extends AdminDeviceRevocationResult {
  replayed: boolean;
}

export interface PairingCodeRecord {
  id: string;
  codeHash: string;
  codeLastFour: string;
  organizationId: OrganizationId;
  employeeId: string;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  createdByUserId: UserId;
  collectionMode: MobileCollectionMode;
  consumedAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

export interface DeviceRegistration {
  installationId: string;
  platform: "android" | "ios";
  manufacturer?: string;
  model?: string;
  osVersion: string;
  appVersion: string;
  collectionMode: MobileCollectionMode;
  permissions: DevicePermissions;
}

export interface SimulatedCallInput {
  externalId: string;
  employeeId: string;
  deviceId?: string;
  direction: CallDirection;
  disposition: CallDisposition;
  phoneNumber: string;
  displayName?: string;
  isInternal: boolean;
  startedAt: IsoDateTime;
  answeredAt?: IsoDateTime;
  endedAt?: IsoDateTime;
  durationSeconds: number;
  ringDurationSeconds?: number;
  isWithinWorkingHours: boolean;
}

export interface CallCursor {
  startedAt: IsoDateTime;
  id: string;
}

export interface EmployeeCursor {
  displayName: string;
  id: string;
}

export interface LeadCursor {
  createdAt: IsoDateTime;
  id: string;
}

export interface LeadListFilter {
  search?: string;
  statusId?: string;
  assignedEmployeeId?: string;
  queue: LeadQueueKey;
}

export interface LeadListResult {
  items: LeadListItem[];
  summary: LeadQueueSummary;
  hasMore: boolean;
}

export interface CreateLeadOptions {
  organizationId: OrganizationId;
  scope: LeadAccessScope;
  input: CreateLeadInput;
  actorUserId: string;
  at: IsoDateTime;
}

export interface UpdateLeadOptions {
  organizationId: OrganizationId;
  scope: LeadAccessScope;
  leadId: string;
  request: UpdateLeadRequest;
  actorUserId: string;
  canAssign: boolean;
  at: IsoDateTime;
}

export interface CreateLeadNoteOptions {
  organizationId: OrganizationId;
  scope: LeadAccessScope;
  leadId: string;
  input: CreateLeadNoteInput;
  actorUserId: string;
  at: IsoDateTime;
}

export interface CreateLeadFollowUpOptions {
  organizationId: OrganizationId;
  scope: LeadAccessScope;
  leadId: string;
  input: CreateFollowUpInput;
  actorUserId: string;
  at: IsoDateTime;
}

export interface CompleteLeadFollowUpOptions {
  organizationId: OrganizationId;
  scope: LeadAccessScope;
  followUpId: string;
  input: CompleteFollowUpInput;
  actorUserId: string;
  at: IsoDateTime;
}

export type LeadWorkspaceDetail = LeadDetail;
export type LeadPipelineStatus = LeadStatus;

export interface EmployeeListFilter {
  search?: string;
  status?: "invited" | "active" | "paused" | "deactivated";
  team?: string;
}

export interface CallListFilter {
  employeeId?: string;
  direction?: CallDirection;
  disposition?: CallDisposition;
  from?: IsoDateTime;
  to?: IsoDateTime;
}

export interface IngestCallResult {
  call: CallLog;
  duplicate: boolean;
  conflict: boolean;
}

export interface PairingRedemptionResult {
  outcome: "redeemed" | "not_found" | "expired" | "revoked" | "consumed" | "installation_conflict";
  record?: PairingCodeRecord;
  device?: EmployeeDevice;
  bootstrapExpiresAt?: IsoDateTime;
  replayed?: boolean;
}

export type DeviceCredentialState = "active" | "pending" | "consumed" | "revoked";

export interface NewDeviceCredential {
  id: string;
  tokenHash: string;
  expiresAt: IsoDateTime;
  credentialType: DeviceCredentialType;
  rotatedFromCredentialId?: string;
  requestId: string;
  lifecycleState: DeviceCredentialState;
}

export interface MobileDeviceContext {
  credentialId: string;
  credentialType: DeviceCredentialType;
  organizationId: OrganizationId;
  employeeId: string;
  deviceId: string;
  installationId: string;
  collectionMode: MobileCollectionMode;
  permissions: DevicePermissions;
  credentialState: DeviceCredentialState;
  consentCurrent: boolean;
  /** Set only when authentication matched an immutable completed request replay. */
  authenticatedReplay?: boolean;
}

export interface ActivateMobileDeviceResult {
  device: EmployeeDevice;
  sessionExpiresAt: IsoDateTime;
  policy: MobilePolicyReference;
  replayed: boolean;
}

export interface ReconsentMobileDeviceResult {
  device: EmployeeDevice;
  policy: MobilePolicyReference;
  consentedAt: IsoDateTime;
  replayed: boolean;
}

export interface PrepareMobileSessionRotationResult {
  requestId: string;
  pendingExpiresAt: IsoDateTime;
  preparedAt: IsoDateTime;
  replayed: boolean;
}

export interface ConfirmMobileSessionRotationResult {
  requestId: string;
  expiresAt: IsoDateTime;
  activatedAt: IsoDateTime;
  replayed: boolean;
}

export interface RevokeMobileSessionResult {
  deviceId: string;
  revokedAt: IsoDateTime;
  consentWithdrawnAt: IsoDateTime;
  replayed: boolean;
}

export interface MobileCallBatchOptions {
  context: MobileDeviceContext;
  batch: CallLogSyncBatch;
  payloadHash: string;
  nextCursor: string;
  at: IsoDateTime;
  /** Trusted route decision; never copied from the request without an environment gate. */
  allowWithoutCallLogPermission: boolean;
}

export type MobileCallBatchResult = CallLogSyncResult;
export type MobileHeartbeatResult = HeartbeatAcknowledgement;
export type MobileActivationPayload = MobileActivationInput;
export type MobileReconsentPayload = MobileReconsentInput;
export type MobileHeartbeatPayload = DeviceHeartbeat;
export type MobilePolicy = MobileCollectionPolicy;

export const ROLE_PERMISSIONS: Readonly<Record<SystemRoleKey, readonly Permission[]>> = {
  owner: [
    "organization.read", "organization.manage", "billing.read", "billing.manage",
    "users.read", "users.manage", "employees.read", "employees.manage", "devices.manage",
    "calls.read", "calls.export", "calls.annotate", "recordings.listen", "recordings.manage",
    "leads.read", "leads.manage", "leads.assign", "reports.read", "reports.export",
    "integrations.read", "integrations.manage", "audit.read",
  ],
  admin: [
    "organization.read", "organization.manage", "users.read", "users.manage", "employees.read",
    "employees.manage", "devices.manage", "calls.read", "calls.export", "calls.annotate",
    "recordings.listen", "recordings.manage", "leads.read", "leads.manage", "leads.assign",
    "reports.read", "reports.export", "integrations.read", "integrations.manage", "audit.read",
  ],
  // Organization-wide employee/call routes remain fail-closed; lead routes apply
  // the manager's explicit membership_team_scopes inside the repository.
  manager: ["organization.read", "employees.read", "calls.read", "leads.read", "leads.manage", "leads.assign"],
  analyst: ["organization.read", "employees.read", "calls.read", "reports.read", "reports.export"],
  // Lead routes restrict this role to the linked employee assignment.
  employee: ["organization.read", "leads.read", "leads.manage"],
};
