import type {
  AuditFields,
  EntityId,
  IsoDateTime,
  PhoneNumber,
} from "./common.js";
import { isNonEmptyString, isRecord } from "./common.js";
import type { OrganizationId, UserId } from "./organizations.js";

export type EmployeeId = EntityId;
export type DeviceId = EntityId;
export type SimCardId = EntityId;

export type EmployeeStatus = "invited" | "active" | "paused" | "deactivated";
export type MobilePlatform = "android" | "ios";
export type DeviceStatus = "pending" | "connected" | "stale" | "revoked";
export type DevicePermissionState = "unknown" | "granted" | "denied" | "restricted";
export type DeviceSyncState = "never_synced" | "idle" | "syncing" | "degraded" | "failed";

export interface WorkingHours {
  timeZone: string;
  weekDays: number[];
  startsAt: string;
  endsAt: string;
}

export interface Employee extends AuditFields {
  id: EmployeeId;
  organizationId: OrganizationId;
  linkedUserId?: UserId;
  employeeCode?: string;
  displayName: string;
  email?: string;
  primaryPhone?: PhoneNumber;
  jobTitle?: string;
  team?: string;
  status: EmployeeStatus;
  managerEmployeeId?: EmployeeId;
  workingHours?: WorkingHours;
  deviceIds: DeviceId[];
}

export interface DevicePermissions {
  callLog: DevicePermissionState;
  phoneState: DevicePermissionState;
  contacts: DevicePermissionState;
  notifications: DevicePermissionState;
  recordingFiles: DevicePermissionState;
  backgroundExecution: DevicePermissionState;
}

export interface SimCard {
  id: SimCardId;
  deviceId: DeviceId;
  slotIndex: number;
  carrierName?: string;
  phoneNumber?: PhoneNumber;
  subscriptionId?: string;
  isEnabled: boolean;
}

/** A physical phone registered by an employee for collection and synchronization. */
export interface EmployeeDevice extends AuditFields {
  id: DeviceId;
  organizationId: OrganizationId;
  employeeId: EmployeeId;
  installationId: string;
  platform: MobilePlatform;
  manufacturer?: string;
  model?: string;
  osVersion: string;
  appVersion: string;
  status: DeviceStatus;
  syncState: DeviceSyncState;
  permissions: DevicePermissions;
  simCards: SimCard[];
  registeredAt: IsoDateTime;
  lastSeenAt?: IsoDateTime;
  lastHeartbeatAt?: IsoDateTime;
  lastSuccessfulSyncAt?: IsoDateTime;
  batteryPercent?: number;
  isCharging?: boolean;
  networkType?: "offline" | "wifi" | "cellular" | "ethernet" | "unknown";
  pendingCallCount?: number;
  pendingRecordingCount?: number;
  revokedAt?: IsoDateTime;
}

/** Short-lived code used to attach a mobile installation to an employee record. */
export interface DevicePairingCode {
  code: string;
  organizationId: OrganizationId;
  employeeId: EmployeeId;
  expiresAt: IsoDateTime;
  consumedAt?: IsoDateTime;
}

export interface CreateEmployeeInput {
  displayName: string;
  email?: string;
  primaryPhone?: PhoneNumber;
  employeeCode?: string;
  jobTitle?: string;
  team?: string;
  managerEmployeeId?: EmployeeId;
  workingHours?: WorkingHours;
}

export interface UpdateEmployeeInput {
  displayName?: string;
  email?: string | null;
  primaryPhone?: PhoneNumber | null;
  employeeCode?: string | null;
  jobTitle?: string | null;
  team?: string | null;
  managerEmployeeId?: EmployeeId | null;
  workingHours?: WorkingHours | null;
  status?: Exclude<EmployeeStatus, "invited">;
}

export interface RegisterDeviceInput {
  code: string;
  installationId: string;
  platform: MobilePlatform;
  manufacturer?: string;
  model?: string;
  osVersion: string;
  appVersion: string;
  permissions: DevicePermissions;
}

export interface UpdateDevicePermissionsInput {
  permissions: Partial<DevicePermissions>;
  observedAt: IsoDateTime;
}

export function isMobilePlatform(value: unknown): value is MobilePlatform {
  return value === "android" || value === "ios";
}

export function isRegisterDeviceInput(value: unknown): value is RegisterDeviceInput {
  return (
    isRecord(value) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.installationId) &&
    isMobilePlatform(value.platform) &&
    isNonEmptyString(value.osVersion) &&
    isNonEmptyString(value.appVersion) &&
    isDevicePermissions(value.permissions)
  );
}

const DEVICE_PERMISSION_STATES: readonly DevicePermissionState[] = [
  "unknown",
  "granted",
  "denied",
  "restricted",
];

export function isDevicePermissions(value: unknown): value is DevicePermissions {
  if (!isRecord(value)) return false;
  return [
    "callLog",
    "phoneState",
    "contacts",
    "notifications",
    "recordingFiles",
    "backgroundExecution",
  ].every((key) => DEVICE_PERMISSION_STATES.includes(value[key] as DevicePermissionState));
}
