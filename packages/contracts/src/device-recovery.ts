import type { IsoDateTime } from "./common.js";
import { isRecord } from "./common.js";
import type { DeviceId, EmployeeId } from "./employees.js";

export const DEVICE_REVOCATION_REASON_MIN_LENGTH = 8;
export const DEVICE_REVOCATION_REASON_MAX_LENGTH = 500;

export interface AdminDeviceRevocationInput {
  requestId: string;
  reason: string;
}

export interface AdminDeviceRevocationResult {
  deviceId: DeviceId;
  employeeId: EmployeeId;
  revokedAt: IsoDateTime;
  reason: string;
  revokedCredentialCount: number;
  consentWithdrawn: boolean;
}

export function isDeviceRevocationReason(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const reason = value.trim();
  const characterCount = Array.from(reason).length;
  return characterCount >= DEVICE_REVOCATION_REASON_MIN_LENGTH &&
    characterCount <= DEVICE_REVOCATION_REASON_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(reason);
}

export function isAdminDeviceRevocationInput(value: unknown): value is AdminDeviceRevocationInput {
  return isRecord(value) &&
    typeof value.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId) &&
    isDeviceRevocationReason(value.reason);
}
