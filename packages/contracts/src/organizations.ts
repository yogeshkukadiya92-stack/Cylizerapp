import type {
  Address,
  AuditFields,
  EmailAddress,
  EntityId,
  IsoDateTime,
  PhoneNumber,
  TimeZone,
} from "./common.js";
import { isNonEmptyString, isRecord } from "./common.js";

export type OrganizationId = EntityId;
export type UserId = EntityId;
export type RoleId = EntityId;

export type OrganizationStatus = "trial" | "active" | "past_due" | "suspended" | "closed";
export type UserStatus = "invited" | "active" | "suspended" | "deactivated";
export type OrganizationPlan = "trial" | "starter" | "growth" | "business" | "enterprise";

/** Stable permission keys shared by API authorization and frontend route guards. */
export type Permission =
  | "organization.read"
  | "organization.manage"
  | "billing.read"
  | "billing.manage"
  | "users.read"
  | "users.manage"
  | "employees.read"
  | "employees.manage"
  | "devices.manage"
  | "calls.read"
  | "calls.export"
  | "calls.annotate"
  | "recordings.listen"
  | "recordings.manage"
  | "leads.read"
  | "leads.manage"
  | "leads.assign"
  | "reports.read"
  | "reports.export"
  | "integrations.read"
  | "integrations.manage"
  | "audit.read";

export type SystemRoleKey = "owner" | "admin" | "manager" | "analyst" | "employee";

export interface OrganizationSettings {
  timeZone: TimeZone;
  defaultCountryCode: string;
  workingWeekDays: number[];
  workingDayStartsAt: string;
  workingDayEndsAt: string;
  recordingRetentionDays: number;
  callLogRetentionDays: number;
  requireRecordingConsent: boolean;
  maskPhoneNumbersForRestrictedUsers: boolean;
}

export interface Organization extends AuditFields {
  id: OrganizationId;
  name: string;
  slug: string;
  status: OrganizationStatus;
  plan: OrganizationPlan;
  industry?: string;
  logoUrl?: string;
  supportEmail?: EmailAddress;
  primaryPhone?: PhoneNumber;
  billingAddress?: Address;
  settings: OrganizationSettings;
  trialEndsAt?: IsoDateTime;
}

export interface Role extends AuditFields {
  id: RoleId;
  organizationId: OrganizationId;
  name: string;
  description?: string;
  systemKey?: SystemRoleKey;
  permissions: Permission[];
  isEditable: boolean;
}

export interface User extends AuditFields {
  id: UserId;
  organizationId: OrganizationId;
  email: EmailAddress;
  displayName: string;
  phoneNumber?: PhoneNumber;
  avatarUrl?: string;
  status: UserStatus;
  roleIds: RoleId[];
  lastSignedInAt?: IsoDateTime;
}

export interface OrganizationMembership {
  organizationId: OrganizationId;
  userId: UserId;
  roleIds: RoleId[];
  joinedAt?: IsoDateTime;
}

export interface AuthenticatedActor {
  user: User;
  organization: Organization;
  roles: Role[];
  permissions: Permission[];
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  industry?: string;
  supportEmail?: EmailAddress;
  primaryPhone?: PhoneNumber;
  timeZone: TimeZone;
  defaultCountryCode: string;
}

export interface UpdateOrganizationInput {
  name?: string;
  industry?: string | null;
  logoUrl?: string | null;
  supportEmail?: EmailAddress | null;
  primaryPhone?: PhoneNumber | null;
  billingAddress?: Address | null;
  settings?: Partial<OrganizationSettings>;
}

export interface InviteUserInput {
  email: EmailAddress;
  displayName: string;
  roleIds: RoleId[];
  phoneNumber?: PhoneNumber;
}

export interface UpdateUserInput {
  displayName?: string;
  phoneNumber?: PhoneNumber | null;
  avatarUrl?: string | null;
  status?: Exclude<UserStatus, "invited">;
  roleIds?: RoleId[];
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions: Permission[];
}

export function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return ["trial", "active", "past_due", "suspended", "closed"].includes(
    value as OrganizationStatus,
  );
}

export function isInviteUserInput(value: unknown): value is InviteUserInput {
  return (
    isRecord(value) &&
    isNonEmptyString(value.email) &&
    isNonEmptyString(value.displayName) &&
    Array.isArray(value.roleIds) &&
    value.roleIds.every(isNonEmptyString)
  );
}
