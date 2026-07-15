import { randomInt, randomUUID } from "node:crypto";
import type {
  CallLogSyncResult,
  CallLog,
  CreateEmployeeInput,
  Employee,
  EmployeeDevice,
  Organization,
  OrganizationId,
  Role,
  SystemRoleKey,
  User,
} from "@callora/contracts";
import type {
  ActorContext,
  AdminRevokeDeviceResult,
  AuditEvent,
  CallCursor,
  CallListFilter,
  DeviceRegistration,
  EmployeeCursor,
  EmployeeListFilter,
  IngestCallResult,
  MobileActivationPayload,
  MobileCallBatchOptions,
  MobileCallBatchResult,
  MobilePolicy,
  MobileDeviceContext,
  MobileHeartbeatPayload,
  MobileHeartbeatResult,
  MobileReconsentPayload,
  NewDeviceCredential,
  ActivateMobileDeviceResult,
  ReconsentMobileDeviceResult,
  PrepareMobileSessionRotationResult,
  ConfirmMobileSessionRotationResult,
  RevokeMobileSessionResult,
  PairingCodeRecord,
  PairingRedemptionResult,
  SimulatedCallInput,
} from "./domain.js";
import { ROLE_PERMISSIONS } from "./domain.js";
import { conflict, consentRequired } from "./errors.js";
import { fingerprint, type Clock } from "./security.js";

export interface IdGenerator {
  next(prefix: string): string;
}

export interface PairingCodeGenerator {
  next(): string;
}

export interface ExternalIdentityLookup {
  issuer: string;
  subject: string;
  organizationId: OrganizationId;
}

export class SequentialIdGenerator implements IdGenerator {
  private value = 0;

  next(prefix: string): string {
    this.value += 1;
    return `${prefix}_${String(this.value).padStart(6, "0")}`;
  }
}

export class SequentialPairingCodeGenerator implements PairingCodeGenerator {
  private value = 0;

  next(): string {
    this.value += 1;
    return `CL${String(this.value).padStart(6, "0")}`;
  }
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class SecurePairingCodeGenerator implements PairingCodeGenerator {
  next(): string {
    return Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join("");
  }
}

export interface CalloraRepository {
  readonly mobileTransitionEvidenceAtomic?: boolean;
  ping(): Promise<boolean>;
  findActor(organizationId: OrganizationId, userId: string): Promise<ActorContext | undefined>;
  resolveActorByExternalIdentity(identity: ExternalIdentityLookup): Promise<ActorContext | undefined>;
  findDevelopmentActor(organizationId: OrganizationId, role: SystemRoleKey): Promise<ActorContext | undefined>;
  listEmployees(options: {
    organizationId: OrganizationId;
    filter: EmployeeListFilter;
    after?: EmployeeCursor;
    limit: number;
  }): Promise<{ items: Employee[]; hasMore: boolean }>;
  findEmployee(organizationId: OrganizationId, employeeId: string): Promise<Employee | undefined>;
  createEmployee(organizationId: OrganizationId, input: CreateEmployeeInput, actorUserId: string, at: string): Promise<Employee>;
  suspendEmployee(organizationId: OrganizationId, employeeId: string, actorUserId: string, at: string): Promise<Employee | undefined>;
  findDevice(organizationId: OrganizationId, deviceId: string): Promise<EmployeeDevice | undefined>;
  revokeDeviceByAdministrator(options: {
    organizationId: OrganizationId;
    deviceId: string;
    actorUserId: string;
    requestId: string;
    requestFingerprint: string;
    reason: string;
    auditEventId: string;
    outboxEventId: string;
    at: string;
  }): Promise<AdminRevokeDeviceResult | undefined>;
  countOfflineDevices(organizationId: OrganizationId, employeeId?: string): Promise<number>;
  createPairingCode(record: PairingCodeRecord): Promise<void>;
  revokePairingCode(organizationId: OrganizationId, pairingCodeId: string, at: string): Promise<PairingCodeRecord | undefined>;
  redeemPairingCode(options: {
    codeHash: string;
    registration: DeviceRegistration;
    bootstrapCredential: NewDeviceCredential;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<PairingRedemptionResult>;
  resolveDeviceCredential(options: {
    tokenHash: string;
    credentialType: "bootstrap" | "session";
    at: string;
  }): Promise<MobileDeviceContext | undefined>;
  resolveDeviceCredentialReplay(options: {
    tokenHash: string;
    credentialType: "bootstrap" | "session";
    operation: "activate" | "rotation_prepare" | "rotation_confirm" | "reconsent" | "revoke";
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<MobileDeviceContext | undefined>;
  resolvePendingRotationCredential(options: {
    tokenHash: string;
    prepareRequestId: string;
    confirmRequestId: string;
    confirmRequestFingerprint: string;
    at: string;
  }): Promise<MobileDeviceContext | undefined>;
  findCurrentMobilePolicy(context: MobileDeviceContext, at: string): Promise<MobilePolicy | undefined>;
  activateMobileDevice(options: {
    context: MobileDeviceContext;
    activation: MobileActivationPayload;
    sessionCredential: NewDeviceCredential;
    requestFingerprint: string;
    policy?: MobilePolicy;
    at: string;
  }): Promise<ActivateMobileDeviceResult | undefined>;
  reconsentMobileDevice(options: {
    context: MobileDeviceContext;
    reconsent: MobileReconsentPayload;
    requestFingerprint: string;
    policy?: MobilePolicy;
    at: string;
  }): Promise<ReconsentMobileDeviceResult | undefined>;
  prepareDeviceSessionRotation(options: {
    context: MobileDeviceContext;
    sessionCredential: NewDeviceCredential;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<PrepareMobileSessionRotationResult | undefined>;
  confirmDeviceSessionRotation(options: {
    context: MobileDeviceContext;
    requestId: string;
    prepareRequestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<ConfirmMobileSessionRotationResult | undefined>;
  recordDeviceHeartbeat(options: {
    context: MobileDeviceContext;
    heartbeat: MobileHeartbeatPayload;
    at: string;
  }): Promise<MobileHeartbeatResult | undefined>;
  ingestMobileCallBatch(options: MobileCallBatchOptions): Promise<MobileCallBatchResult | undefined>;
  revokeMobileSession(options: {
    context: MobileDeviceContext;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<RevokeMobileSessionResult | undefined>;
  ingestCall(options: {
    organizationId: OrganizationId;
    input: SimulatedCallInput;
    idempotencyKey: string;
    fingerprint: string;
    actorUserId: string;
    at: string;
  }): Promise<IngestCallResult>;
  listCalls(options: {
    organizationId: OrganizationId;
    filter: CallListFilter;
    after?: CallCursor;
    limit: number;
  }): Promise<{ items: CallLog[]; hasMore: boolean }>;
  listCallsInPeriod(options: {
    organizationId: OrganizationId;
    from: string;
    to: string;
    employeeId?: string;
  }): Promise<CallLog[]>;
  appendAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(organizationId: OrganizationId, limit: number): Promise<AuditEvent[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function seededOrganization(id: "org_alpha" | "org_beta", name: string, slug: string): Organization {
  const timestamp = "2026-07-14T00:00:00.000Z";
  return {
    id,
    name,
    slug,
    status: "active",
    plan: "growth",
    settings: {
      timeZone: "Asia/Kolkata",
      defaultCountryCode: "IN",
      workingWeekDays: [1, 2, 3, 4, 5, 6],
      workingDayStartsAt: "09:00",
      workingDayEndsAt: "19:00",
      recordingRetentionDays: 90,
      callLogRetentionDays: 365,
      requireRecordingConsent: true,
      maskPhoneNumbersForRestrictedUsers: true,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function seededEmployee(
  id: string,
  organizationId: OrganizationId,
  displayName: string,
  status: Employee["status"],
  team: string,
  deviceIds: string[],
): Employee {
  const timestamp = "2026-07-14T00:00:00.000Z";
  return {
    id,
    organizationId,
    displayName,
    email: `${id}@example.test`,
    primaryPhone: organizationId === "org_alpha" ? "+919800000001" : "+919900000001",
    team,
    status,
    deviceIds,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultPermissions(): EmployeeDevice["permissions"] {
  return {
    callLog: "granted",
    phoneState: "granted",
    contacts: "denied",
    notifications: "granted",
    recordingFiles: "unknown",
    backgroundExecution: "granted",
  };
}

interface StoredDeviceCredential extends NewDeviceCredential {
  organizationId: OrganizationId;
  employeeId: string;
  deviceId: string;
  createdAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

interface StoredConsentReceipt {
  organizationId: OrganizationId;
  employeeId: string;
  deviceId: string;
  policyId: string;
  policyContentHash: string;
  policyVersion: string;
  disclosureVersion: string;
  purpose: "call_metadata";
  permissions: EmployeeDevice["permissions"];
  acceptedAt: string;
  recordedAt: string;
  locale?: string;
  withdrawnAt?: string;
}

type MobileCredentialOperation = "activate" | "reconsent" | "rotation_prepare" | "rotation_confirm" | "revoke";

interface StoredMobileCredentialRequest {
  requestId: string;
  organizationId: OrganizationId;
  employeeId: string;
  deviceId: string;
  credentialId: string;
  operation: MobileCredentialOperation;
  requestFingerprint: string;
  proposedTokenHash?: string;
  response: unknown;
  completedAt: string;
}

interface StoredPairingRedemption {
  requestId: string;
  codeHash: string;
  requestFingerprint: string;
  result: PairingRedemptionResult;
}

interface StoredAdminDeviceRevocation {
  organizationId: OrganizationId;
  deviceId: string;
  actorUserId: string;
  requestFingerprint: string;
  result: AdminRevokeDeviceResult;
}

interface StoredAdminRecoveryOutboxEvent {
  id: string;
  organizationId: OrganizationId;
  requestId: string;
  deviceId: string;
  eventType: "device.admin_revoked";
}

function seededDevice(
  id: string,
  organizationId: OrganizationId,
  employeeId: string,
  installationId: string,
): EmployeeDevice {
  const timestamp = "2026-07-14T00:00:00.000Z";
  return {
    id,
    organizationId,
    employeeId,
    installationId,
    platform: "android",
    manufacturer: "Google",
    model: "Pixel",
    osVersion: "16",
    appVersion: "0.1.0",
    status: "connected",
    syncState: "idle",
    permissions: defaultPermissions(),
    simCards: [],
    registeredAt: timestamp,
    lastSeenAt: timestamp,
    lastSuccessfulSyncAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class InMemoryCalloraRepository implements CalloraRepository {
  private readonly organizations = new Map<OrganizationId, Organization>();
  private readonly roles = new Map<string, Role>();
  private readonly users = new Map<string, User>();
  private readonly developmentActors = new Map<string, string>();
  private readonly externalIdentityUsers = new Map<string, string>();
  private readonly employees = new Map<string, Employee>();
  private readonly devices = new Map<string, EmployeeDevice>();
  private readonly devicesByInstallation = new Map<string, string>();
  private readonly pairingCodesById = new Map<string, PairingCodeRecord>();
  private readonly pairingCodeIdByHash = new Map<string, string>();
  private readonly calls = new Map<string, CallLog>();
  private readonly callIdByExternalId = new Map<string, string>();
  private readonly callFingerprintByExternalId = new Map<string, string>();
  private readonly idempotency = new Map<string, { fingerprint: string; callId: string }>();
  private readonly deviceCredentialsByHash = new Map<string, StoredDeviceCredential>();
  private readonly deviceCredentialHashById = new Map<string, string>();
  private readonly activeConsentByDevice = new Map<string, StoredConsentReceipt>();
  private readonly credentialRequests = new Map<string, StoredMobileCredentialRequest>();
  private readonly pairingRedemptions = new Map<string, StoredPairingRedemption>();
  private readonly adminDeviceRevocations = new Map<string, StoredAdminDeviceRevocation>();
  private readonly adminRecoveryOutboxEvents = new Map<string, StoredAdminRecoveryOutboxEvent>();
  private readonly deviceCollectionModes = new Map<string, "android_call_log" | "synthetic_demo">();
  private readonly mobilePolicies = new Map<"android_call_log" | "synthetic_demo", MobilePolicy>();
  private readonly mobileBatches = new Map<string, { payloadHash: string; result: CallLogSyncResult }>();
  private readonly audits = new Map<OrganizationId, AuditEvent[]>();
  private ready = true;

  constructor(
    private readonly ids: IdGenerator = new SequentialIdGenerator(),
  ) {
    this.seed();
  }

  private seed(): void {
    const androidPolicySource = {
      policyVersion: "2026.1-enterprise-call-metadata",
      disclosureVersion: "2026.1-enterprise-disclosure",
      collectionMode: "android_call_log" as const,
      purpose: "call_metadata" as const,
      title: "Callora enterprise call metadata",
      summary: "With employee consent and Android permission, reads call-history metadata and synchronizes it to the organization workspace.",
      disclosures: [
        "Reads Android call-history metadata only after prominent disclosure, consent, and READ_CALL_LOG permission.",
        "Includes phone number, direction, start time, duration, disposition, SIM-slot reference, and device-scoped external ID.",
        "Synchronizes the metadata to the employee organization workspace.",
        "Does not collect call audio, microphone audio, SMS content, or the contacts address book.",
      ],
      effectiveAt: "2026-01-01T00:00:00.000Z",
    };
    const demoPolicySource = {
      policyVersion: "2026.1-demo-call-metadata",
      disclosureVersion: "2026.1-demo-disclosure",
      collectionMode: "synthetic_demo" as const,
      purpose: "call_metadata" as const,
      title: "Callora demo call metadata",
      summary: "Uses generated demonstration calls only. It does not read the device call log.",
      disclosures: [
        "Uses synthetic demonstration data generated inside the app.",
        "Includes phone number, direction, start time, duration, disposition, and device-scoped external ID.",
        "Requires no Android call-log permission.",
        "Does not collect call audio, microphone audio, SMS content, or the contacts address book.",
      ],
      effectiveAt: "2026-01-01T00:00:00.000Z",
    };
    this.mobilePolicies.set("android_call_log", {
      id: "30000000-0000-4000-8000-000000000002",
      // Same SHA-256 produced by 0009's PostgreSQL jsonb policy trigger.
      contentHash: "31124ef8f171f23b6adc6d5e96bb5e3b3907a9bf5461c216c383cafe7d749941",
      ...androidPolicySource,
    });
    this.mobilePolicies.set("synthetic_demo", {
      id: "30000000-0000-4000-8000-000000000001",
      contentHash: "a00aad253c906bc2e9d93d3ea393f49b2580d3ac7b1e724e96fb3ff6408dce1a",
      ...demoPolicySource,
    });
    const organizations = [
      seededOrganization("org_alpha", "Callora Alpha", "callora-alpha"),
      seededOrganization("org_beta", "Callora Beta", "callora-beta"),
    ];
    for (const organization of organizations) {
      this.organizations.set(organization.id, organization);
      this.audits.set(organization.id, []);
      for (const roleKey of Object.keys(ROLE_PERMISSIONS) as SystemRoleKey[]) {
        const roleId = `role_${organization.id}_${roleKey}`;
        const userId = `user_${organization.id}_${roleKey}`;
        const timestamp = "2026-07-14T00:00:00.000Z";
        this.roles.set(roleId, {
          id: roleId,
          organizationId: organization.id,
          name: roleKey.charAt(0).toUpperCase() + roleKey.slice(1),
          systemKey: roleKey,
          permissions: [...ROLE_PERMISSIONS[roleKey]],
          isEditable: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        this.users.set(userId, {
          id: userId,
          organizationId: organization.id,
          email: `${roleKey}@${organization.slug}.test`,
          displayName: `${organization.name} ${roleKey}`,
          status: "active",
          roleIds: [roleId],
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        this.developmentActors.set(`${organization.id}:${roleKey}`, userId);
      }
    }

    const employees = [
      seededEmployee("emp_alpha_amit", "org_alpha", "Amit Patel", "active", "Sales", ["device_alpha_amit"]),
      seededEmployee("emp_alpha_priya", "org_alpha", "Priya Sharma", "invited", "Sales", []),
      seededEmployee("emp_beta_riya", "org_beta", "Riya Mehta", "active", "Support", ["device_beta_riya"]),
    ];
    for (const employee of employees) {
      this.employees.set(employee.id, employee);
    }

    const devices = [
      seededDevice("device_alpha_amit", "org_alpha", "emp_alpha_amit", "install-alpha-amit"),
      seededDevice("device_beta_riya", "org_beta", "emp_beta_riya", "install-beta-riya"),
    ];
    for (const device of devices) {
      this.devices.set(device.id, device);
      this.devicesByInstallation.set(`${device.organizationId}:${device.installationId}`, device.id);
      this.deviceCollectionModes.set(device.id, "android_call_log");
    }
  }

  setReady(ready: boolean): void {
    this.ready = ready;
  }

  setUserStatus(userId: string, status: User["status"]): void {
    const user = this.users.get(userId);
    if (user) user.status = status;
  }

  /** Deterministic policy rollover hook used by trust-protocol regression tests. */
  setMobilePolicyForTesting(policy: MobilePolicy): void {
    this.mobilePolicies.set(policy.collectionMode, clone(policy));
  }

  private findCurrentMobileCredential(
    context: MobileDeviceContext,
    credentialType: "bootstrap" | "session",
    at: string,
  ): {
    credential: StoredDeviceCredential;
    device: EmployeeDevice;
    employee: Employee;
    consent?: StoredConsentReceipt;
  } | undefined {
    if (context.credentialType !== credentialType) return undefined;
    const credential = [...this.deviceCredentialsByHash.values()].find((candidate) =>
      candidate.id === context.credentialId &&
      candidate.credentialType === credentialType &&
      candidate.organizationId === context.organizationId &&
      candidate.employeeId === context.employeeId &&
      candidate.deviceId === context.deviceId);
    if (!credential || credential.lifecycleState !== "active" || credential.revokedAt || credential.consumedAt ||
      Date.parse(credential.expiresAt) <= Date.parse(at)) return undefined;

    const organization = this.organizations.get(context.organizationId);
    const employee = this.employees.get(context.employeeId);
    const device = this.devices.get(context.deviceId);
    if (!organization || !["trial", "active"].includes(organization.status) ||
      !employee || employee.organizationId !== context.organizationId ||
      !device || device.organizationId !== context.organizationId ||
      device.employeeId !== context.employeeId || device.installationId !== context.installationId ||
      this.deviceCollectionModes.get(device.id) !== context.collectionMode) return undefined;

    const consent = this.activeConsentByDevice.get(device.id);
    if (credentialType === "bootstrap") {
      if (device.status !== "pending" || !["invited", "active"].includes(employee.status) || consent) return undefined;
    } else if (device.status !== "connected" || employee.status !== "active" || !consent || consent.withdrawnAt) {
      return undefined;
    }
    return { credential, device, employee, ...(consent === undefined ? {} : { consent }) };
  }

  private isConsentCurrent(deviceId: string): boolean {
    const consent = this.activeConsentByDevice.get(deviceId);
    const mode = this.deviceCollectionModes.get(deviceId);
    const policy = mode ? this.mobilePolicies.get(mode) : undefined;
    return Boolean(consent && !consent.withdrawnAt && policy &&
      consent.policyId === policy.id && consent.policyContentHash === policy.contentHash);
  }

  private credentialRequestKey(deviceId: string, operation: MobileCredentialOperation, requestId: string): string {
    return `${deviceId}:${operation}:${requestId}`;
  }

  private contextForCredential(credential: StoredDeviceCredential): MobileDeviceContext | undefined {
    const device = this.devices.get(credential.deviceId);
    const collectionMode = this.deviceCollectionModes.get(credential.deviceId);
    if (!device || !collectionMode) return undefined;
    return {
      credentialId: credential.id,
      credentialType: credential.credentialType,
      organizationId: credential.organizationId,
      employeeId: credential.employeeId,
      deviceId: credential.deviceId,
      installationId: device.installationId,
      collectionMode,
      permissions: clone(device.permissions),
      credentialState: credential.lifecycleState,
      consentCurrent: this.isConsentCurrent(device.id),
    };
  }

  async ping(): Promise<boolean> {
    return this.ready;
  }

  async findActor(organizationId: OrganizationId, userId: string): Promise<ActorContext | undefined> {
    const organization = this.organizations.get(organizationId);
    const user = this.users.get(userId);
    if (!organization || !user || user.organizationId !== organizationId || user.status !== "active") {
      return undefined;
    }
    const roles = user.roleIds
      .map((roleId) => this.roles.get(roleId))
      .filter((role): role is Role => role !== undefined && role.organizationId === organizationId);
    const primaryRole = roles.find((role) => role.systemKey !== undefined);
    if (!primaryRole?.systemKey) {
      return undefined;
    }
    return clone({
      user,
      organization,
      roles,
      permissions: [...new Set(roles.flatMap((role) => role.permissions))],
      roleKey: primaryRole.systemKey,
    });
  }

  linkExternalIdentity(identity: ExternalIdentityLookup & {
    userId: string;
  }): void {
    this.externalIdentityUsers.set(
      JSON.stringify([identity.organizationId, identity.issuer, identity.subject]),
      identity.userId,
    );
  }

  async resolveActorByExternalIdentity(identity: ExternalIdentityLookup): Promise<ActorContext | undefined> {
    const userId = this.externalIdentityUsers.get(
      JSON.stringify([identity.organizationId, identity.issuer, identity.subject]),
    );
    return userId ? this.findActor(identity.organizationId, userId) : undefined;
  }

  async findDevelopmentActor(organizationId: OrganizationId, role: SystemRoleKey): Promise<ActorContext | undefined> {
    const userId = this.developmentActors.get(`${organizationId}:${role}`);
    return userId ? this.findActor(organizationId, userId) : undefined;
  }

  async listEmployees(options: {
    organizationId: OrganizationId;
    filter: EmployeeListFilter;
    after?: EmployeeCursor;
    limit: number;
  }): Promise<{ items: Employee[]; hasMore: boolean }> {
    const search = options.filter.search?.trim().toLocaleLowerCase();
    let items = [...this.employees.values()].filter((employee) => {
      if (employee.organizationId !== options.organizationId) return false;
      if (options.filter.status && employee.status !== options.filter.status) return false;
      if (options.filter.team && employee.team !== options.filter.team) return false;
      if (search && !`${employee.displayName} ${employee.email ?? ""} ${employee.employeeCode ?? ""}`.toLocaleLowerCase().includes(search)) return false;
      return true;
    });
    items.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
    if (options.after) {
      const after = options.after;
      items = items.filter((employee) =>
        employee.displayName.localeCompare(after.displayName) > 0 ||
        (employee.displayName === after.displayName && employee.id.localeCompare(after.id) > 0));
    }
    const page = items.slice(0, options.limit + 1);
    const hasMore = page.length > options.limit;
    return { items: clone(page.slice(0, options.limit)), hasMore };
  }

  async findEmployee(organizationId: OrganizationId, employeeId: string): Promise<Employee | undefined> {
    const employee = this.employees.get(employeeId);
    return employee?.organizationId === organizationId ? clone(employee) : undefined;
  }

  async createEmployee(organizationId: OrganizationId, input: CreateEmployeeInput, actorUserId: string, at: string): Promise<Employee> {
    const employee: Employee = {
      id: this.ids.next("employee"),
      organizationId,
      displayName: input.displayName,
      status: "invited",
      deviceIds: [],
      createdAt: at,
      updatedAt: at,
      createdBy: actorUserId,
      updatedBy: actorUserId,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.primaryPhone === undefined ? {} : { primaryPhone: input.primaryPhone }),
      ...(input.employeeCode === undefined ? {} : { employeeCode: input.employeeCode }),
      ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }),
      ...(input.team === undefined ? {} : { team: input.team }),
      ...(input.managerEmployeeId === undefined ? {} : { managerEmployeeId: input.managerEmployeeId }),
      ...(input.workingHours === undefined ? {} : { workingHours: input.workingHours }),
    };
    this.employees.set(employee.id, employee);
    return clone(employee);
  }

  async suspendEmployee(organizationId: OrganizationId, employeeId: string, actorUserId: string, at: string): Promise<Employee | undefined> {
    const employee = this.employees.get(employeeId);
    if (!employee || employee.organizationId !== organizationId) {
      return undefined;
    }
    employee.status = "paused";
    employee.updatedAt = at;
    employee.updatedBy = actorUserId;
    for (const deviceId of employee.deviceIds) {
      const device = this.devices.get(deviceId);
      if (device && device.organizationId === organizationId) {
        device.status = "revoked";
        device.revokedAt = at;
        device.updatedAt = at;
        device.updatedBy = actorUserId;
        for (const credential of this.deviceCredentialsByHash.values()) {
          if (credential.deviceId === deviceId && !credential.revokedAt) credential.revokedAt = at;
        }
      }
    }
    return clone(employee);
  }

  async findDevice(organizationId: OrganizationId, deviceId: string): Promise<EmployeeDevice | undefined> {
    const device = this.devices.get(deviceId);
    return device?.organizationId === organizationId ? clone(device) : undefined;
  }

  async revokeDeviceByAdministrator(options: {
    organizationId: OrganizationId;
    deviceId: string;
    actorUserId: string;
    requestId: string;
    requestFingerprint: string;
    reason: string;
    auditEventId: string;
    outboxEventId: string;
    at: string;
  }): Promise<AdminRevokeDeviceResult | undefined> {
    const requestKey = `${options.organizationId}:${options.requestId}`;
    const prior = this.adminDeviceRevocations.get(requestKey);
    if (prior) {
      if (prior.deviceId !== options.deviceId ||
        prior.actorUserId !== options.actorUserId ||
        prior.requestFingerprint !== options.requestFingerprint) {
        throw conflict("The request ID was already used with a different device revocation payload");
      }
      return clone({ ...prior.result, replayed: true });
    }

    const device = this.devices.get(options.deviceId);
    if (!device || device.organizationId !== options.organizationId) return undefined;
    if (device.status === "revoked" || device.revokedAt) {
      throw conflict("The device has already been revoked");
    }
    const actor = this.users.get(options.actorUserId);
    if (!actor || actor.organizationId !== options.organizationId || actor.status !== "active") {
      return undefined;
    }
    const events = this.audits.get(options.organizationId);
    if (!events) throw new Error("Unknown organization for device revocation");
    if (events.some((event) => event.id === options.auditEventId) ||
      this.adminRecoveryOutboxEvents.has(options.outboxEventId)) {
      throw new Error("Administrative device revocation evidence ID was already used");
    }

    let revokedCredentialCount = 0;
    for (const credential of this.deviceCredentialsByHash.values()) {
      if (credential.deviceId === device.id &&
        (credential.lifecycleState === "active" || credential.lifecycleState === "pending")) {
        credential.lifecycleState = "revoked";
        credential.revokedAt = options.at;
        revokedCredentialCount += 1;
      }
    }
    const activeConsent = this.activeConsentByDevice.get(device.id);
    const consentWithdrawn = Boolean(activeConsent && !activeConsent.withdrawnAt);
    if (activeConsent && !activeConsent.withdrawnAt) activeConsent.withdrawnAt = options.at;
    device.status = "revoked";
    device.revokedAt = options.at;
    device.updatedAt = options.at;

    const result: AdminRevokeDeviceResult = {
      deviceId: device.id,
      employeeId: device.employeeId,
      revokedAt: options.at,
      reason: options.reason,
      revokedCredentialCount,
      consentWithdrawn,
      replayed: false,
    };
    events.push({
      id: options.auditEventId,
      organizationId: options.organizationId,
      actorUserId: options.actorUserId,
      requestId: options.requestId,
      action: "device.admin_revoked",
      entityType: "device",
      entityId: device.id,
      occurredAt: options.at,
      metadata: {
        requestId: options.requestId,
        employeeId: device.employeeId,
        reason: options.reason,
        revokedCredentialCount,
        consentWithdrawn,
      },
    });
    this.adminRecoveryOutboxEvents.set(options.outboxEventId, {
      id: options.outboxEventId,
      organizationId: options.organizationId,
      requestId: options.requestId,
      deviceId: device.id,
      eventType: "device.admin_revoked",
    });
    this.adminDeviceRevocations.set(requestKey, {
      organizationId: options.organizationId,
      deviceId: device.id,
      actorUserId: options.actorUserId,
      requestFingerprint: options.requestFingerprint,
      result: clone(result),
    });
    return clone(result);
  }

  /** Deterministic in-memory evidence inspection for integration tests. */
  countAdminRecoveryOutboxEvents(organizationId: OrganizationId, requestId: string): number {
    return [...this.adminRecoveryOutboxEvents.values()].filter((event) =>
      event.organizationId === organizationId && event.requestId === requestId).length;
  }

  async countOfflineDevices(organizationId: OrganizationId, employeeId?: string): Promise<number> {
    return [...this.devices.values()].filter((device) =>
      device.organizationId === organizationId &&
      (employeeId === undefined || device.employeeId === employeeId) &&
      device.status !== "connected").length;
  }

  async createPairingCode(record: PairingCodeRecord): Promise<void> {
    this.pairingCodesById.set(record.id, clone(record));
    this.pairingCodeIdByHash.set(record.codeHash, record.id);
  }

  async revokePairingCode(organizationId: OrganizationId, pairingCodeId: string, at: string): Promise<PairingCodeRecord | undefined> {
    const record = this.pairingCodesById.get(pairingCodeId);
    if (!record || record.organizationId !== organizationId) {
      return undefined;
    }
    if (!record.consumedAt && !record.revokedAt) {
      record.revokedAt = at;
    }
    return clone(record);
  }

  async redeemPairingCode(options: {
    codeHash: string;
    registration: DeviceRegistration;
    bootstrapCredential: NewDeviceCredential;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<PairingRedemptionResult> {
    const priorRedemption = this.pairingRedemptions.get(options.requestId);
    if (priorRedemption) {
      if (priorRedemption.codeHash !== options.codeHash ||
        priorRedemption.requestFingerprint !== options.requestFingerprint ||
        priorRedemption.result.device?.installationId !== options.registration.installationId) {
        throw conflict("The request ID was already used with a different pairing payload");
      }
      return clone({ ...priorRedemption.result, replayed: true });
    }
    const id = this.pairingCodeIdByHash.get(options.codeHash);
    const record = id ? this.pairingCodesById.get(id) : undefined;
    if (!record) return { outcome: "not_found" };
    if (record.revokedAt) return { outcome: "revoked", record: clone(record) };
    if (record.consumedAt) return { outcome: "consumed", record: clone(record) };
    if (Date.parse(record.expiresAt) <= Date.parse(options.at)) return { outcome: "expired", record: clone(record) };
    const employee = this.employees.get(record.employeeId);
    if (!employee || employee.organizationId !== record.organizationId || employee.status === "paused" || employee.status === "deactivated") {
      return { outcome: "not_found" };
    }
    if (record.collectionMode !== options.registration.collectionMode) {
      return { outcome: "not_found" };
    }

    const installationKey = `${record.organizationId}:${options.registration.installationId}`;
    const existingDeviceId = this.devicesByInstallation.get(installationKey);
    const existingDevice = existingDeviceId ? this.devices.get(existingDeviceId) : undefined;
    if (existingDevice && existingDevice.employeeId !== record.employeeId) {
      return { outcome: "installation_conflict", record: clone(record) };
    }
    const device: EmployeeDevice = existingDevice ?? {
      id: this.ids.next("device"),
      organizationId: record.organizationId,
      employeeId: record.employeeId,
      installationId: options.registration.installationId,
      platform: options.registration.platform,
      osVersion: options.registration.osVersion,
      appVersion: options.registration.appVersion,
      status: "pending",
      syncState: "never_synced",
      permissions: clone(options.registration.permissions),
      simCards: [],
      pendingCallCount: 0,
      pendingRecordingCount: 0,
      registeredAt: options.at,
      lastSeenAt: options.at,
      createdAt: options.at,
      updatedAt: options.at,
      ...(options.registration.manufacturer === undefined ? {} : { manufacturer: options.registration.manufacturer }),
      ...(options.registration.model === undefined ? {} : { model: options.registration.model }),
    };
    if (existingDevice) {
      device.platform = options.registration.platform;
      device.osVersion = options.registration.osVersion;
      device.appVersion = options.registration.appVersion;
      device.status = "pending";
      device.syncState = "never_synced";
      device.permissions = clone(options.registration.permissions);
      device.lastSeenAt = options.at;
      device.updatedAt = options.at;
      if (options.registration.manufacturer === undefined) delete device.manufacturer;
      else device.manufacturer = options.registration.manufacturer;
      if (options.registration.model === undefined) delete device.model;
      else device.model = options.registration.model;
      delete device.revokedAt;
      delete device.lastSuccessfulSyncAt;
      delete device.lastHeartbeatAt;
      delete device.batteryPercent;
      delete device.isCharging;
      delete device.networkType;
      device.pendingCallCount = 0;
      device.pendingRecordingCount = 0;
      for (const credential of this.deviceCredentialsByHash.values()) {
        if (credential.deviceId === device.id && !credential.revokedAt) {
          credential.revokedAt = options.at;
          credential.lifecycleState = "revoked";
        }
      }
      const activeConsent = this.activeConsentByDevice.get(device.id);
      if (activeConsent && !activeConsent.withdrawnAt) activeConsent.withdrawnAt = options.at;
      this.activeConsentByDevice.delete(device.id);
    }
    record.consumedAt = options.at;
    this.devices.set(device.id, device);
    this.deviceCollectionModes.set(device.id, record.collectionMode);
    this.devicesByInstallation.set(installationKey, device.id);
    if (!employee.deviceIds.includes(device.id)) employee.deviceIds.push(device.id);
    employee.updatedAt = options.at;
    const storedBootstrap: StoredDeviceCredential = {
      ...clone(options.bootstrapCredential),
      organizationId: record.organizationId,
      employeeId: record.employeeId,
      deviceId: device.id,
      createdAt: options.at,
    };
    this.deviceCredentialsByHash.set(options.bootstrapCredential.tokenHash, storedBootstrap);
    this.deviceCredentialHashById.set(storedBootstrap.id, options.bootstrapCredential.tokenHash);
    const result: PairingRedemptionResult = {
      outcome: "redeemed",
      record: clone(record),
      device: clone(device),
      bootstrapExpiresAt: options.bootstrapCredential.expiresAt,
      replayed: false,
    };
    this.pairingRedemptions.set(options.requestId, {
      requestId: options.requestId,
      codeHash: options.codeHash,
      requestFingerprint: options.requestFingerprint,
      result: clone(result),
    });
    return result;
  }

  async resolveDeviceCredential(options: {
    tokenHash: string;
    credentialType: "bootstrap" | "session";
    at: string;
  }): Promise<MobileDeviceContext | undefined> {
    const credential = this.deviceCredentialsByHash.get(options.tokenHash);
    if (!credential || credential.credentialType !== options.credentialType) return undefined;
    const context = this.contextForCredential(credential);
    if (!context) return undefined;
    return this.findCurrentMobileCredential(context, options.credentialType, options.at) ? clone(context) : undefined;
  }

  async resolveDeviceCredentialReplay(options: {
    tokenHash: string;
    credentialType: "bootstrap" | "session";
    operation: "activate" | "rotation_prepare" | "rotation_confirm" | "reconsent" | "revoke";
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<MobileDeviceContext | undefined> {
    const credential = this.deviceCredentialsByHash.get(options.tokenHash);
    if (!credential || credential.credentialType !== options.credentialType) return undefined;
    const expectedState = options.operation === "activate"
      ? "consumed"
      : options.operation === "revoke" ? "revoked" : "active";
    if (credential.lifecycleState !== expectedState) return undefined;
    const request = this.credentialRequests.get(
      this.credentialRequestKey(credential.deviceId, options.operation, options.requestId),
    );
    if (!request || request.credentialId !== credential.id ||
      request.requestFingerprint !== options.requestFingerprint) return undefined;
    const context = this.contextForCredential(credential);
    return context ? { ...context, authenticatedReplay: true } : undefined;
  }

  async resolvePendingRotationCredential(options: {
    tokenHash: string;
    prepareRequestId: string;
    confirmRequestId: string;
    confirmRequestFingerprint: string;
    at: string;
  }): Promise<MobileDeviceContext | undefined> {
    const credential = this.deviceCredentialsByHash.get(options.tokenHash);
    if (!credential || credential.credentialType !== "session" || credential.lifecycleState !== "pending" ||
      credential.requestId !== options.prepareRequestId || Date.parse(credential.expiresAt) <= Date.parse(options.at)) {
      return undefined;
    }
    const request = this.credentialRequests.get(
      this.credentialRequestKey(credential.deviceId, "rotation_prepare", options.prepareRequestId),
    );
    if (!request || request.proposedTokenHash !== options.tokenHash) return undefined;
    return this.contextForCredential(credential);
  }

  async findCurrentMobilePolicy(context: MobileDeviceContext, at: string): Promise<MobilePolicy | undefined> {
    if (Date.parse(at) < 0) return undefined;
    const policy = this.mobilePolicies.get(context.collectionMode);
    return policy && Date.parse(policy.effectiveAt) <= Date.parse(at) ? clone(policy) : undefined;
  }

  async activateMobileDevice(options: {
    context: MobileDeviceContext;
    activation: MobileActivationPayload;
    sessionCredential: NewDeviceCredential;
    requestFingerprint: string;
    policy: MobilePolicy;
    at: string;
  }): Promise<ActivateMobileDeviceResult | undefined> {
    const requestKey = this.credentialRequestKey(
      options.context.deviceId,
      "activate",
      options.activation.requestId,
    );
    const prior = this.credentialRequests.get(requestKey);
    if (prior) {
      if (prior.credentialId !== options.context.credentialId ||
        prior.requestFingerprint !== options.requestFingerprint ||
        prior.proposedTokenHash !== options.sessionCredential.tokenHash) {
        throw conflict("The request ID was already used with a different activation payload");
      }
      return clone({ ...(prior.response as ActivateMobileDeviceResult), replayed: true });
    }
    const current = this.findCurrentMobileCredential(options.context, "bootstrap", options.at);
    if (!current || options.sessionCredential.credentialType !== "session" ||
      options.sessionCredential.lifecycleState !== "active" ||
      options.sessionCredential.requestId !== options.activation.requestId ||
      !/^[0-9a-f]{64}$/.test(options.sessionCredential.tokenHash) ||
      this.deviceCredentialsByHash.has(options.sessionCredential.tokenHash)) return undefined;
    const { credential: bootstrap, device, employee } = current;

    const activePolicy = this.mobilePolicies.get(options.context.collectionMode);
    const acceptedAt = Date.parse(options.activation.consent.acceptedAt);
    const recordedAt = Date.parse(options.at);
    if (acceptedAt > recordedAt + 5 * 60 * 1_000 || acceptedAt < recordedAt - 15 * 60 * 1_000) {
      throw consentRequired("Consent must be refreshed before activation");
    }
    if (!activePolicy || !options.policy ||
      activePolicy.id !== options.policy.id || activePolicy.contentHash !== options.policy.contentHash ||
      options.activation.policy.id !== activePolicy.id ||
      options.activation.policy.contentHash !== activePolicy.contentHash) throw consentRequired();

    const consent: StoredConsentReceipt = {
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      policyId: activePolicy.id,
      policyContentHash: activePolicy.contentHash,
      policyVersion: activePolicy.policyVersion,
      disclosureVersion: activePolicy.disclosureVersion,
      purpose: options.activation.consent.purpose,
      permissions: clone(options.activation.permissions),
      acceptedAt: options.activation.consent.acceptedAt,
      recordedAt: options.at,
      ...(options.activation.consent.locale === undefined ? {} : { locale: options.activation.consent.locale }),
    };
    bootstrap.consumedAt = options.at;
    bootstrap.lifecycleState = "consumed";
    this.activeConsentByDevice.set(device.id, consent);
    const storedSession: StoredDeviceCredential = {
      ...clone(options.sessionCredential),
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      createdAt: options.at,
    };
    this.deviceCredentialsByHash.set(options.sessionCredential.tokenHash, storedSession);
    this.deviceCredentialHashById.set(storedSession.id, options.sessionCredential.tokenHash);
    device.status = "connected";
    device.permissions = clone(options.activation.permissions);
    device.lastSeenAt = options.at;
    device.updatedAt = options.at;
    employee.status = "active";
    employee.updatedAt = options.at;
    const result: ActivateMobileDeviceResult = {
      device: clone(device),
      sessionExpiresAt: options.sessionCredential.expiresAt,
      policy: { id: activePolicy.id, contentHash: activePolicy.contentHash },
      replayed: false,
    };
    this.credentialRequests.set(requestKey, {
      requestId: options.activation.requestId,
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      credentialId: bootstrap.id,
      operation: "activate",
      requestFingerprint: options.requestFingerprint,
      proposedTokenHash: options.sessionCredential.tokenHash,
      response: clone(result),
      completedAt: options.at,
    });
    return result;
  }

  async reconsentMobileDevice(options: {
    context: MobileDeviceContext;
    reconsent: MobileReconsentPayload;
    requestFingerprint: string;
    policy: MobilePolicy;
    at: string;
  }): Promise<ReconsentMobileDeviceResult | undefined> {
    const key = this.credentialRequestKey(options.context.deviceId, "reconsent", options.reconsent.requestId);
    const prior = this.credentialRequests.get(key);
    if (prior) {
      if (prior.credentialId !== options.context.credentialId ||
        prior.requestFingerprint !== options.requestFingerprint) {
        throw conflict("The request ID was already used with a different consent payload");
      }
      return clone({ ...(prior.response as ReconsentMobileDeviceResult), replayed: true });
    }
    const current = this.findCurrentMobileCredential(options.context, "session", options.at);
    const activePolicy = this.mobilePolicies.get(options.context.collectionMode);
    const acceptedAt = Date.parse(options.reconsent.consent.acceptedAt);
    const recordedAt = Date.parse(options.at);
    if (!current) return undefined;
    if (acceptedAt > recordedAt + 5 * 60 * 1_000 || acceptedAt < recordedAt - 15 * 60 * 1_000) {
      throw consentRequired("Consent must be refreshed before synchronization resumes");
    }
    if (!activePolicy || !options.policy ||
      activePolicy.id !== options.policy.id ||
      activePolicy.contentHash !== options.policy.contentHash ||
      options.reconsent.policy.id !== activePolicy.id ||
      options.reconsent.policy.contentHash !== activePolicy.contentHash) throw consentRequired();
    if (current.consent && !current.consent.withdrawnAt) current.consent.withdrawnAt = options.at;
    const consent: StoredConsentReceipt = {
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      policyId: activePolicy.id,
      policyContentHash: activePolicy.contentHash,
      policyVersion: activePolicy.policyVersion,
      disclosureVersion: activePolicy.disclosureVersion,
      purpose: options.reconsent.consent.purpose,
      permissions: clone(options.reconsent.permissions),
      acceptedAt: options.reconsent.consent.acceptedAt,
      recordedAt: options.at,
      ...(options.reconsent.consent.locale === undefined ? {} : { locale: options.reconsent.consent.locale }),
    };
    this.activeConsentByDevice.set(options.context.deviceId, consent);
    current.device.permissions = clone(options.reconsent.permissions);
    current.device.updatedAt = options.at;
    const result: ReconsentMobileDeviceResult = {
      device: clone(current.device),
      policy: { id: activePolicy.id, contentHash: activePolicy.contentHash },
      consentedAt: options.reconsent.consent.acceptedAt,
      replayed: false,
    };
    this.credentialRequests.set(key, {
      requestId: options.reconsent.requestId,
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      credentialId: options.context.credentialId,
      operation: "reconsent",
      requestFingerprint: options.requestFingerprint,
      response: clone(result),
      completedAt: options.at,
    });
    return result;
  }

  async prepareDeviceSessionRotation(options: {
    context: MobileDeviceContext;
    sessionCredential: NewDeviceCredential;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<PrepareMobileSessionRotationResult | undefined> {
    const key = this.credentialRequestKey(options.context.deviceId, "rotation_prepare", options.requestId);
    const prior = this.credentialRequests.get(key);
    if (prior) {
      if (prior.credentialId !== options.context.credentialId ||
        prior.requestFingerprint !== options.requestFingerprint ||
        prior.proposedTokenHash !== options.sessionCredential.tokenHash) {
        throw conflict("The request ID was already used with a different rotation payload");
      }
      return clone({ ...(prior.response as PrepareMobileSessionRotationResult), replayed: true });
    }
    const current = this.findCurrentMobileCredential(options.context, "session", options.at);
    if (!current || options.sessionCredential.credentialType !== "session" ||
      options.sessionCredential.lifecycleState !== "pending" ||
      options.sessionCredential.requestId !== options.requestId ||
      options.sessionCredential.rotatedFromCredentialId !== options.context.credentialId ||
      !/^[0-9a-f]{64}$/.test(options.sessionCredential.tokenHash) ||
      this.deviceCredentialsByHash.has(options.sessionCredential.tokenHash)) return undefined;
    if (!this.isConsentCurrent(options.context.deviceId)) throw consentRequired();
    const storedPending: StoredDeviceCredential = {
      ...clone(options.sessionCredential),
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      createdAt: options.at,
    };
    this.deviceCredentialsByHash.set(options.sessionCredential.tokenHash, storedPending);
    this.deviceCredentialHashById.set(storedPending.id, options.sessionCredential.tokenHash);
    const result: PrepareMobileSessionRotationResult = {
      requestId: options.requestId,
      pendingExpiresAt: options.sessionCredential.expiresAt,
      preparedAt: options.at,
      replayed: false,
    };
    this.credentialRequests.set(key, {
      requestId: options.requestId,
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      credentialId: options.context.credentialId,
      operation: "rotation_prepare",
      requestFingerprint: options.requestFingerprint,
      proposedTokenHash: options.sessionCredential.tokenHash,
      response: clone(result),
      completedAt: options.at,
    });
    return result;
  }

  async confirmDeviceSessionRotation(options: {
    context: MobileDeviceContext;
    requestId: string;
    prepareRequestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<ConfirmMobileSessionRotationResult | undefined> {
    const confirmKey = this.credentialRequestKey(options.context.deviceId, "rotation_confirm", options.requestId);
    const priorConfirm = this.credentialRequests.get(confirmKey);
    if (priorConfirm) {
      if (priorConfirm.credentialId !== options.context.credentialId ||
        priorConfirm.requestFingerprint !== options.requestFingerprint) {
        throw conflict("The request ID was already used with a different rotation confirmation");
      }
      return clone({ ...(priorConfirm.response as ConfirmMobileSessionRotationResult), replayed: true });
    }
    const pendingHash = this.deviceCredentialHashById.get(options.context.credentialId);
    const pending = pendingHash ? this.deviceCredentialsByHash.get(pendingHash) : undefined;
    if (!pending || pending.lifecycleState !== "pending" || pending.requestId !== options.prepareRequestId ||
      !pending.rotatedFromCredentialId || Date.parse(pending.expiresAt) <= Date.parse(options.at)) return undefined;
    const prepare = this.credentialRequests.get(
      this.credentialRequestKey(options.context.deviceId, "rotation_prepare", options.prepareRequestId),
    );
    const oldHash = this.deviceCredentialHashById.get(pending.rotatedFromCredentialId);
    const oldCredential = oldHash ? this.deviceCredentialsByHash.get(oldHash) : undefined;
    if (!prepare || prepare.proposedTokenHash !== pendingHash || !oldCredential ||
      oldCredential.lifecycleState !== "active" || oldCredential.revokedAt) return undefined;
    pending.lifecycleState = "active";
    oldCredential.lifecycleState = "revoked";
    oldCredential.revokedAt = options.at;
    const result: ConfirmMobileSessionRotationResult = {
      requestId: options.requestId,
      expiresAt: pending.expiresAt,
      activatedAt: options.at,
      replayed: false,
    };
    this.credentialRequests.set(confirmKey, {
      requestId: options.requestId,
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      credentialId: pending.id,
      operation: "rotation_confirm",
      requestFingerprint: options.requestFingerprint,
      ...(pendingHash === undefined ? {} : { proposedTokenHash: pendingHash }),
      response: clone(result),
      completedAt: options.at,
    });
    return result;
  }

  async recordDeviceHeartbeat(options: {
    context: MobileDeviceContext;
    heartbeat: MobileHeartbeatPayload;
    at: string;
  }): Promise<MobileHeartbeatResult | undefined> {
    const current = this.findCurrentMobileCredential(options.context, "session", options.at);
    if (!current) return undefined;
    const { device } = current;
    device.appVersion = options.heartbeat.appVersion;
    device.osVersion = options.heartbeat.osVersion;
    device.syncState = options.heartbeat.syncState;
    device.permissions = clone(options.heartbeat.permissions);
    device.lastSeenAt = options.at;
    device.lastHeartbeatAt = options.heartbeat.observedAt;
    device.updatedAt = options.at;
    if (options.heartbeat.batteryPercent === undefined) delete device.batteryPercent;
    else device.batteryPercent = options.heartbeat.batteryPercent;
    if (options.heartbeat.isCharging === undefined) delete device.isCharging;
    else device.isCharging = options.heartbeat.isCharging;
    if (options.heartbeat.networkType === undefined) delete device.networkType;
    else device.networkType = options.heartbeat.networkType;
    device.pendingCallCount = options.heartbeat.pendingCallCount;
    device.pendingRecordingCount = options.heartbeat.pendingRecordingCount;
    const policy = this.mobilePolicies.get(options.context.collectionMode);
    const directives = !this.isConsentCurrent(options.context.deviceId) && policy
      ? [{
          type: "consent_required" as const,
          policyId: policy.id,
          contentHash: policy.contentHash,
          reason: "The active collection policy has changed",
        }]
      : [];
    return { serverTime: options.at, nextHeartbeatAfterSeconds: 900, directives };
  }

  async ingestMobileCallBatch(options: MobileCallBatchOptions): Promise<MobileCallBatchResult | undefined> {
    const current = this.findCurrentMobileCredential(options.context, "session", options.at);
    if (!current) return undefined;
    if (!this.isConsentCurrent(options.context.deviceId)) throw consentRequired();
    if (current.device.permissions.callLog !== "granted" && !options.allowWithoutCallLogPermission) return undefined;
    const { device } = current;
    const key = `${options.context.organizationId}:${options.context.deviceId}:${options.batch.batchId}`;
    const prior = this.mobileBatches.get(key);
    if (prior) {
      if (prior.payloadHash !== options.payloadHash) throw conflict("The batch ID was already used with a different payload");
      return clone(prior.result);
    }

    const results: CallLogSyncResult["items"] = [];
    for (const item of options.batch.items) {
      const externalKey = `${options.context.organizationId}:${options.context.deviceId}:${item.localId}`;
      const itemFingerprint = fingerprint(item);
      const priorCallId = this.callIdByExternalId.get(externalKey);
      if (priorCallId) {
        const call = this.calls.get(priorCallId);
        if (!call) throw new Error("In-memory mobile external ID record is corrupt");
        const priorFingerprint = this.callFingerprintByExternalId.get(externalKey);
        if (priorFingerprint === itemFingerprint) {
          results.push({ localId: item.localId, outcome: "duplicate", callLogId: call.id });
          continue;
        }
        call.direction = item.direction;
        call.disposition = item.disposition;
        call.participant = {
          phoneNumber: item.phoneNumber,
          isInternal: item.isInternal ?? false,
          ...(item.contactName === undefined ? {} : { displayName: item.contactName }),
        };
        call.startedAt = item.startedAt;
        call.durationSeconds = item.durationSeconds;
        call.updatedAt = options.at;
        if (item.answeredAt === undefined) delete call.answeredAt;
        else call.answeredAt = item.answeredAt;
        if (item.endedAt === undefined) delete call.endedAt;
        else call.endedAt = item.endedAt;
        if (item.ringDurationSeconds === undefined) delete call.ringDurationSeconds;
        else call.ringDurationSeconds = item.ringDurationSeconds;
        this.callFingerprintByExternalId.set(externalKey, itemFingerprint);
        results.push({ localId: item.localId, outcome: "updated", callLogId: call.id });
        continue;
      }

      const call: CallLog = {
        id: this.ids.next("call"),
        organizationId: options.context.organizationId,
        employeeId: options.context.employeeId,
        deviceId: options.context.deviceId,
        ...(item.simCardId === undefined ? {} : { simCardId: item.simCardId }),
        externalId: item.localId,
        source: "mobile_call_log",
        direction: item.direction,
        disposition: item.disposition,
        participant: {
          phoneNumber: item.phoneNumber,
          isInternal: item.isInternal ?? false,
          ...(item.contactName === undefined ? {} : { displayName: item.contactName }),
        },
        startedAt: item.startedAt,
        ...(item.answeredAt === undefined ? {} : { answeredAt: item.answeredAt }),
        ...(item.endedAt === undefined ? {} : { endedAt: item.endedAt }),
        durationSeconds: item.durationSeconds,
        ...(item.ringDurationSeconds === undefined ? {} : { ringDurationSeconds: item.ringDurationSeconds }),
        isWithinWorkingHours: false,
        recordingStatus: "not_expected",
        noteCount: 0,
        isPinned: false,
        createdAt: options.at,
        updatedAt: options.at,
      };
      this.calls.set(call.id, call);
      this.callIdByExternalId.set(externalKey, call.id);
      this.callFingerprintByExternalId.set(externalKey, itemFingerprint);
      results.push({ localId: item.localId, outcome: "created", callLogId: call.id });
    }

    device.lastSuccessfulSyncAt = options.at;
    device.lastSeenAt = options.at;
    device.syncState = "idle";
    device.updatedAt = options.at;
    const result: CallLogSyncResult = {
      batchId: options.batch.batchId,
      acceptedAt: options.at,
      nextCursor: options.nextCursor,
      items: results,
      serverTime: options.at,
    };
    this.mobileBatches.set(key, { payloadHash: options.payloadHash, result: clone(result) });
    return clone(result);
  }

  async revokeMobileSession(options: {
    context: MobileDeviceContext;
    requestId: string;
    requestFingerprint: string;
    at: string;
  }): Promise<RevokeMobileSessionResult | undefined> {
    const key = this.credentialRequestKey(options.context.deviceId, "revoke", options.requestId);
    const prior = this.credentialRequests.get(key);
    if (prior) {
      if (prior.credentialId !== options.context.credentialId ||
        prior.requestFingerprint !== options.requestFingerprint) {
        throw conflict("The request ID was already used with a different revocation payload");
      }
      return clone({ ...(prior.response as RevokeMobileSessionResult), replayed: true });
    }
    const current = this.findCurrentMobileCredential(options.context, "session", options.at);
    if (!current || !current.consent) return undefined;
    const { device, consent } = current;
    for (const credential of this.deviceCredentialsByHash.values()) {
      if (credential.deviceId === device.id && !credential.revokedAt) {
        credential.revokedAt = options.at;
        credential.lifecycleState = "revoked";
      }
    }
    consent.withdrawnAt = options.at;
    device.status = "revoked";
    device.revokedAt = options.at;
    device.updatedAt = options.at;
    const result: RevokeMobileSessionResult = {
      deviceId: device.id,
      revokedAt: options.at,
      consentWithdrawnAt: options.at,
      replayed: false,
    };
    this.credentialRequests.set(key, {
      requestId: options.requestId,
      organizationId: options.context.organizationId,
      employeeId: options.context.employeeId,
      deviceId: options.context.deviceId,
      credentialId: options.context.credentialId,
      operation: "revoke",
      requestFingerprint: options.requestFingerprint,
      response: clone(result),
      completedAt: options.at,
    });
    return result;
  }

  async ingestCall(options: {
    organizationId: OrganizationId;
    input: SimulatedCallInput;
    idempotencyKey: string;
    fingerprint: string;
    actorUserId: string;
    at: string;
  }): Promise<IngestCallResult> {
    const idempotencyMapKey = `${options.organizationId}:${options.idempotencyKey}`;
    const priorIdempotency = this.idempotency.get(idempotencyMapKey);
    if (priorIdempotency) {
      const call = this.calls.get(priorIdempotency.callId);
      if (!call) throw new Error("In-memory idempotency record is corrupt");
      return { call: clone(call), duplicate: priorIdempotency.fingerprint === options.fingerprint, conflict: priorIdempotency.fingerprint !== options.fingerprint };
    }

    const externalDeviceIdentity = options.input.deviceId ?? "simulated";
    const externalMapKey = `${options.organizationId}:${externalDeviceIdentity}:${options.input.externalId}`;
    const priorExternalId = this.callIdByExternalId.get(externalMapKey);
    if (priorExternalId) {
      const call = this.calls.get(priorExternalId);
      if (!call) throw new Error("In-memory external ID record is corrupt");
      const existingFingerprint = this.callFingerprintByExternalId.get(externalMapKey);
      const isConflict = existingFingerprint !== undefined && existingFingerprint !== options.fingerprint;
      if (!isConflict) {
        this.idempotency.set(idempotencyMapKey, { fingerprint: options.fingerprint, callId: call.id });
      }
      return { call: clone(call), duplicate: !isConflict, conflict: isConflict };
    }

    const call: CallLog = {
      id: this.ids.next("call"),
      organizationId: options.organizationId,
      employeeId: options.input.employeeId,
      externalId: options.input.externalId,
      source: "manual",
      direction: options.input.direction,
      disposition: options.input.disposition,
      participant: {
        phoneNumber: options.input.phoneNumber,
        isInternal: options.input.isInternal,
        ...(options.input.displayName === undefined ? {} : { displayName: options.input.displayName }),
      },
      startedAt: options.input.startedAt,
      durationSeconds: options.input.durationSeconds,
      isWithinWorkingHours: options.input.isWithinWorkingHours,
      recordingStatus: "not_expected",
      noteCount: 0,
      isPinned: false,
      createdAt: options.at,
      updatedAt: options.at,
      createdBy: options.actorUserId,
      updatedBy: options.actorUserId,
      ...(options.input.deviceId === undefined ? {} : { deviceId: options.input.deviceId }),
      ...(options.input.answeredAt === undefined ? {} : { answeredAt: options.input.answeredAt }),
      ...(options.input.endedAt === undefined ? {} : { endedAt: options.input.endedAt }),
      ...(options.input.ringDurationSeconds === undefined ? {} : { ringDurationSeconds: options.input.ringDurationSeconds }),
    };
    this.calls.set(call.id, call);
    this.callIdByExternalId.set(externalMapKey, call.id);
    this.callFingerprintByExternalId.set(externalMapKey, options.fingerprint);
    this.idempotency.set(idempotencyMapKey, { fingerprint: options.fingerprint, callId: call.id });
    return { call: clone(call), duplicate: false, conflict: false };
  }

  async listCalls(options: {
    organizationId: OrganizationId;
    filter: CallListFilter;
    after?: CallCursor;
    limit: number;
  }): Promise<{ items: CallLog[]; hasMore: boolean }> {
    let calls = [...this.calls.values()].filter((call) => {
      if (call.organizationId !== options.organizationId) return false;
      if (options.filter.employeeId && call.employeeId !== options.filter.employeeId) return false;
      if (options.filter.direction && call.direction !== options.filter.direction) return false;
      if (options.filter.disposition && call.disposition !== options.filter.disposition) return false;
      if (options.filter.from && call.startedAt < options.filter.from) return false;
      if (options.filter.to && call.startedAt >= options.filter.to) return false;
      return true;
    });
    calls.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id));
    if (options.after) {
      const after = options.after;
      calls = calls.filter((call) =>
        call.startedAt.localeCompare(after.startedAt) < 0 ||
        (call.startedAt === after.startedAt && call.id.localeCompare(after.id) < 0));
    }
    const page = calls.slice(0, options.limit + 1);
    const hasMore = page.length > options.limit;
    return { items: clone(page.slice(0, options.limit)), hasMore };
  }

  async listCallsInPeriod(options: {
    organizationId: OrganizationId;
    from: string;
    to: string;
    employeeId?: string;
  }): Promise<CallLog[]> {
    return clone([...this.calls.values()].filter((call) =>
      call.organizationId === options.organizationId &&
      call.startedAt >= options.from &&
      call.startedAt < options.to &&
      (options.employeeId === undefined || call.employeeId === options.employeeId)));
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    const events = this.audits.get(event.organizationId);
    if (!events) throw new Error("Unknown organization for audit event");
    events.push(clone(event));
  }

  async listAuditEvents(organizationId: OrganizationId, limit: number): Promise<AuditEvent[]> {
    const events = [...(this.audits.get(organizationId) ?? [])];
    events.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
    return clone(events.slice(0, limit));
  }
}

export function createDevelopmentRepository(): InMemoryCalloraRepository {
  return new InMemoryCalloraRepository();
}
