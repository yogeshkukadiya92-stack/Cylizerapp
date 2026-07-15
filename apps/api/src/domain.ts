import type {
  AuthenticatedActor,
  AdminDeviceRevocationResult,
  CallDirection,
  CallDisposition,
  CallLog,
  CallLogSyncBatch,
  CallLogSyncResult,
  DevicePermissions,
  DeviceHeartbeat,
  EmployeeDevice,
  HeartbeatAcknowledgement,
  IsoDateTime,
  JsonValue,
  OrganizationId,
  Permission,
  SystemRoleKey,
  UserId,
  MobileActivationInput,
  MobileCollectionMode,
  MobileCollectionPolicy,
  MobilePolicyReference,
  MobileReconsentInput,
} from "@callora/contracts";
import type { DeviceCredentialType } from "./security.js";

export interface ActorContext extends AuthenticatedActor {
  roleKey: SystemRoleKey;
}

export interface AuditEvent {
  id: string;
  organizationId: OrganizationId;
  actorUserId?: UserId;
  actorDeviceId?: string;
  requestId?: string;
  action: string;
  entityType: "employee" | "device" | "pairing_code" | "call" | "session";
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
  // Team-scoped authorization is not implemented yet. Keep this role fail-closed
  // so a future permission-only route cannot accidentally expose organization data.
  manager: ["organization.read"],
  analyst: ["organization.read", "employees.read", "calls.read", "reports.read", "reports.export"],
  // Self-scoped authorization is not implemented yet; see the manager note above.
  employee: ["organization.read"],
};
