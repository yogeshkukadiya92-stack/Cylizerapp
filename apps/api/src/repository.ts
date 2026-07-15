import { randomInt, randomUUID } from "node:crypto";
import { isLeadSource } from "@callora/contracts";
import type {
  CallLogSyncResult,
  CallLog,
  CompleteFollowUpInput,
  CreateEmployeeInput,
  CreateLeadInput,
  Employee,
  EmployeeDevice,
  FollowUp,
  Lead,
  LeadActivity,
  LeadDetail,
  LeadListItem,
  LeadNote,
  LeadQueueSummary,
  LeadStatus,
  LeadAssignmentRule,
  LeadImportPreview,
  LeadImportResult,
  LeadImportJob,
  LeadAssignmentDryRun,
  ApplyLeadAssignmentRulesResult,
  CorrectCallLeadLinkResult,
  MobileLeadUpdateReceipt,
  LeadReport,
  ReportAutomationSnapshot,
  SavedReportView,
  ReportSchedule,
  NotificationPreference,
  ReportExportJob,
  InAppNotification,
  NotificationInbox,
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
  LeadAccessScope,
  LeadCursor,
  LeadListFilter,
  LeadListResult,
  CreateLeadOptions,
  UpdateLeadOptions,
  CreateLeadNoteOptions,
  CreateLeadFollowUpOptions,
  CompleteLeadFollowUpOptions,
  PreviewLeadImportOptions,
  LeadImportAccessOptions,
  CommitLeadImportOptions,
  CreateLeadAssignmentRuleOptions,
  UpdateLeadAssignmentRuleOptions,
  LeadAssignmentOperationOptions,
  ApplyLeadAssignmentRulesOptions,
  CorrectCallLeadLinkOptions,
  MobileLeadUpdateOptions,
  LeadReportOptions,
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
import { badRequest, conflict, consentRequired, forbidden } from "./errors.js";
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
  listLeadStatuses(organizationId: OrganizationId): Promise<LeadStatus[]>;
  listLeads(options: {
    organizationId: OrganizationId;
    scope: LeadAccessScope;
    filter: LeadListFilter;
    after?: LeadCursor;
    limit: number;
    at: string;
  }): Promise<LeadListResult>;
  findLeadDetail(options: {
    organizationId: OrganizationId;
    scope: LeadAccessScope;
    leadId: string;
    at: string;
  }): Promise<LeadDetail | undefined>;
  createLead(options: CreateLeadOptions): Promise<LeadDetail | undefined>;
  updateLead(options: UpdateLeadOptions): Promise<LeadDetail | undefined>;
  createLeadNote(options: CreateLeadNoteOptions): Promise<LeadDetail | undefined>;
  createLeadFollowUp(options: CreateLeadFollowUpOptions): Promise<LeadDetail | undefined>;
  completeLeadFollowUp(options: CompleteLeadFollowUpOptions): Promise<LeadDetail | undefined>;
  previewLeadImport(options: PreviewLeadImportOptions): Promise<LeadImportPreview>;
  listLeadImports(options: LeadImportAccessOptions): Promise<LeadImportJob[]>;
  findLeadImport(options: LeadImportAccessOptions & { jobId: string }): Promise<LeadImportPreview | undefined>;
  commitLeadImport(options: CommitLeadImportOptions): Promise<LeadImportResult | undefined>;
  listLeadAssignmentRules(options: LeadAssignmentOperationOptions): Promise<LeadAssignmentRule[]>;
  createLeadAssignmentRule(options: CreateLeadAssignmentRuleOptions): Promise<LeadAssignmentRule | undefined>;
  updateLeadAssignmentRule(options: UpdateLeadAssignmentRuleOptions): Promise<LeadAssignmentRule | undefined>;
  dryRunLeadAssignmentRules(options: LeadAssignmentOperationOptions): Promise<LeadAssignmentDryRun>;
  applyLeadAssignmentRules(options: ApplyLeadAssignmentRulesOptions): Promise<ApplyLeadAssignmentRulesResult>;
  correctCallLeadLink(options: CorrectCallLeadLinkOptions): Promise<CorrectCallLeadLinkResult | undefined>;
  applyMobileLeadUpdate(options: MobileLeadUpdateOptions): Promise<MobileLeadUpdateReceipt | undefined>;
  getLeadReport(options: LeadReportOptions): Promise<LeadReport>;
  getReportAutomation(organizationId: OrganizationId, userId: string): Promise<ReportAutomationSnapshot>;
  createSavedReportView(options: { organizationId: OrganizationId; userId: string; name: string; kind: SavedReportView["kind"]; filters: SavedReportView["filters"]; at: string }): Promise<SavedReportView>;
  createReportSchedule(options: { organizationId: OrganizationId; userId: string; savedViewId: string; name: string; cadence: ReportSchedule["cadence"]; weekDay?: number; localTime: string; timeZone: string; format: ReportSchedule["format"]; recipients: string[]; nextRunAt: string; at: string }): Promise<ReportSchedule | undefined>;
  updateReportSchedule(options: { organizationId: OrganizationId; scheduleId: string; status: ReportSchedule["status"]; at: string }): Promise<ReportSchedule | undefined>;
  updateNotificationPreferences(options: { organizationId: OrganizationId; userId: string; preferences: NotificationPreference[]; at: string }): Promise<NotificationPreference[]>;
  createReportExportJob(options: { organizationId: OrganizationId; userId: string; kind: ReportExportJob["kind"]; format: ReportExportJob["format"]; parameters: Record<string, unknown>; at: string }): Promise<ReportExportJob>;
  completeReportExportJob(options: { organizationId: OrganizationId; jobId: string; objectKey: string; tokenHash: Uint8Array; expiresAt: string; at: string }): Promise<boolean>;
  redeemReportDownload(options: { organizationId: OrganizationId; userId: string; jobId: string; tokenHash: Uint8Array; redemptionId: string; at: string }): Promise<{ objectKey: string; expiresAt: string } | undefined>;
  listNotificationInbox(organizationId: OrganizationId, userId: string, limit: number): Promise<NotificationInbox>;
  markNotificationRead(options: { organizationId: OrganizationId; userId: string; notificationId: string; at: string }): Promise<InAppNotification | undefined>;
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

function zonedDateParts(at: string | number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedDateKey(at: string, timeZone: string): string {
  const { year, month, day } = zonedDateParts(at, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function zonedMidnightIso(dateKey: string, timeZone: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetWallClock = Date.UTC(year!, month! - 1, day!);
  let instant = targetWallClock;
  // Resolve the zone offset at the target date. Repeating handles offset
  // changes close to midnight without relying on the process time zone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedDateParts(instant, timeZone);
    const representedWallClock = Date.UTC(
      parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
    );
    const adjustment = targetWallClock - representedWallClock;
    instant += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(instant).toISOString();
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
  linkedUserId?: string,
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
    ...(linkedUserId === undefined ? {} : { linkedUserId }),
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
  private readonly leadStatuses = new Map<string, LeadStatus>();
  private readonly leads = new Map<string, Lead>();
  private readonly leadTeams = new Map<string, string>();
  private readonly leadNotes = new Map<string, LeadNote>();
  private readonly leadFollowUps = new Map<string, FollowUp>();
  private readonly leadActivities = new Map<string, LeadActivity>();
  private readonly leadIdByCallId = new Map<string, string>();
  private readonly leadImports = new Map<string, LeadImportPreview>();
  private readonly leadImportTeams = new Map<string, Set<string>>();
  private readonly leadImportRowTeams = new Map<string, string>();
  private readonly leadImportRuleIds = new Map<string, string>();
  private readonly leadImportIdByRequest = new Map<string, string>();
  private readonly leadImportFingerprints = new Map<string, string>();
  private readonly leadImportCommitRequests = new Map<string, {
    fingerprint: string;
    jobId: string;
    result: LeadImportResult;
  }>();
  private readonly leadAssignmentRules = new Map<string, LeadAssignmentRule>();
  private readonly leadAssignmentRuleTeams = new Map<string, string>();
  private readonly leadAssignmentRuleCursors = new Map<string, number>();
  private readonly leadAssignmentApplyRequests = new Map<string, { fingerprint: string; result: ApplyLeadAssignmentRulesResult }>();
  private readonly savedReportViews = new Map<string, SavedReportView>();
  private readonly reportSchedules = new Map<string, ReportSchedule>();
  private readonly notificationPreferences = new Map<string, NotificationPreference[]>();
  private readonly reportExportJobs = new Map<string, ReportExportJob>();
  private readonly reportArtifacts = new Map<string, { objectKey: string; tokenHash: Uint8Array; expiresAt: string; redeemedAt?: string }>();
  private readonly inAppNotifications = new Map<string, InAppNotification & { organizationId: OrganizationId; userId: string }>();
  private readonly callLeadCorrectionRequests = new Map<string, { fingerprint: string; result: CorrectCallLeadLinkResult }>();
  private readonly mobileLeadUpdateRequests = new Map<string, {
    fingerprint: string;
    leadId: string;
    receipt: Pick<MobileLeadUpdateReceipt, "requestId" | "appliedLeadVersion">;
  }>();
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
      seededEmployee("emp_alpha_amit", "org_alpha", "Amit Patel", "active", "Sales", ["device_alpha_amit"], "user_org_alpha_employee"),
      seededEmployee("emp_alpha_priya", "org_alpha", "Priya Sharma", "invited", "Sales", [], "user_org_alpha_manager"),
      seededEmployee("emp_beta_riya", "org_beta", "Riya Mehta", "active", "Support", ["device_beta_riya"], "user_org_beta_employee"),
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
    this.seedLeadWorkspace();
  }

  private seedLeadWorkspace(): void {
    const statusRows: LeadStatus[] = [
      { id: "lead_status_alpha_new", organizationId: "org_alpha", name: "New", color: "#2f83ee", position: 1, isInitial: true, isWon: false, isLost: false, isActive: true },
      { id: "lead_status_alpha_contacted", organizationId: "org_alpha", name: "Contacted", color: "#f3942b", position: 2, isInitial: false, isWon: false, isLost: false, isActive: true },
      { id: "lead_status_alpha_qualified", organizationId: "org_alpha", name: "Qualified", color: "#0b9277", position: 3, isInitial: false, isWon: false, isLost: false, isActive: true },
      { id: "lead_status_alpha_won", organizationId: "org_alpha", name: "Won", color: "#08755f", position: 4, isInitial: false, isWon: true, isLost: false, isActive: true },
      { id: "lead_status_alpha_lost", organizationId: "org_alpha", name: "Lost", color: "#f35a46", position: 5, isInitial: false, isWon: false, isLost: true, isActive: true },
      { id: "lead_status_beta_new", organizationId: "org_beta", name: "New", color: "#2f83ee", position: 1, isInitial: true, isWon: false, isLost: false, isActive: true },
      { id: "lead_status_beta_contacted", organizationId: "org_beta", name: "Contacted", color: "#f3942b", position: 2, isInitial: false, isWon: false, isLost: false, isActive: true },
    ];
    statusRows.forEach((status) => this.leadStatuses.set(status.id, status));

    const timestamp = "2026-07-14T10:25:00.000Z";
    const leads: Lead[] = [
      {
        id: "lead_alpha_ramesh", organizationId: "org_alpha", firstName: "Ramesh",
        companyName: "Ramesh Traders", phoneNumber: "+919876543210", source: "manual",
        statusId: "lead_status_alpha_qualified", assignedEmployeeId: "emp_alpha_amit",
        tagIds: [], customFields: {}, lastContactedAt: "2026-07-14T04:51:00.000Z",
        nextFollowUpAt: "2026-07-14T11:00:00.000Z", version: 1,
        createdAt: "2026-07-10T06:00:00.000Z", updatedAt: timestamp,
      },
      {
        id: "lead_alpha_aarav", organizationId: "org_alpha", firstName: "Aarav", lastName: "Shah",
        phoneNumber: "+919123456789", source: "website", statusId: "lead_status_alpha_new",
        assignedEmployeeId: "emp_alpha_amit", tagIds: [], customFields: {},
        nextFollowUpAt: "2026-07-15T05:30:00.000Z", version: 1,
        createdAt: "2026-07-13T06:00:00.000Z", updatedAt: "2026-07-13T06:00:00.000Z",
      },
      {
        id: "lead_alpha_shree", organizationId: "org_alpha", firstName: "Shree",
        companyName: "Shree Enterprises", phoneNumber: "+918765432109", source: "integration",
        statusId: "lead_status_alpha_contacted", assignedEmployeeId: "emp_alpha_amit",
        tagIds: [], customFields: {}, lastContactedAt: "2026-07-13T10:15:00.000Z",
        nextFollowUpAt: "2026-07-16T08:30:00.000Z", version: 1,
        createdAt: "2026-07-11T05:30:00.000Z", updatedAt: "2026-07-13T10:15:00.000Z",
      },
      {
        id: "lead_alpha_meera", organizationId: "org_alpha", firstName: "Meera",
        companyName: "Meera Textiles", phoneNumber: "+919988766554", source: "manual",
        statusId: "lead_status_alpha_won", assignedEmployeeId: "emp_alpha_amit",
        tagIds: [], customFields: {}, lastContactedAt: "2026-07-09T07:40:00.000Z",
        convertedAt: "2026-07-09T07:40:00.000Z", version: 1,
        createdAt: "2026-07-02T04:30:00.000Z", updatedAt: "2026-07-09T07:40:00.000Z",
      },
      {
        id: "lead_alpha_nisha", organizationId: "org_alpha", firstName: "Nisha", lastName: "Patel",
        phoneNumber: "+919345678901", source: "manual", statusId: "lead_status_alpha_new",
        assignedEmployeeId: "emp_alpha_amit", tagIds: [], customFields: {},
        nextFollowUpAt: "2026-07-18T05:00:00.000Z", version: 1,
        createdAt: "2026-07-14T05:20:00.000Z", updatedAt: "2026-07-14T05:20:00.000Z",
      },
      {
        id: "lead_beta_private", organizationId: "org_beta", firstName: "Beta", companyName: "Beta Services",
        phoneNumber: "+919900123456", source: "manual", statusId: "lead_status_beta_new",
        assignedEmployeeId: "emp_beta_riya", tagIds: [], customFields: {}, version: 1,
        createdAt: "2026-07-12T05:20:00.000Z", updatedAt: "2026-07-12T05:20:00.000Z",
      },
    ];
    leads.forEach((lead) => {
      this.leads.set(lead.id, lead);
      const assigned = lead.assignedEmployeeId ? this.employees.get(lead.assignedEmployeeId) : undefined;
      if (assigned?.team) this.leadTeams.set(lead.id, assigned.team);
    });

    const followUps: FollowUp[] = [
      {
        id: "followup_alpha_ramesh", organizationId: "org_alpha", leadId: "lead_alpha_ramesh",
        assignedEmployeeId: "emp_alpha_amit", title: "Discuss annual order", dueAt: "2026-07-14T11:00:00.000Z",
        priority: "high", status: "pending", version: 1,
        createdAt: "2026-07-14T04:52:00.000Z", updatedAt: "2026-07-14T04:52:00.000Z",
      },
      {
        id: "followup_alpha_aarav", organizationId: "org_alpha", leadId: "lead_alpha_aarav",
        assignedEmployeeId: "emp_alpha_amit", title: "First contact", dueAt: "2026-07-15T05:30:00.000Z",
        priority: "normal", status: "pending", version: 1,
        createdAt: "2026-07-13T06:00:00.000Z", updatedAt: "2026-07-13T06:00:00.000Z",
      },
    ];
    followUps.forEach((followUp) => this.leadFollowUps.set(followUp.id, followUp));

    const note: LeadNote = {
      id: "lead_note_alpha_ramesh", organizationId: "org_alpha", leadId: "lead_alpha_ramesh",
      authorUserId: "user_org_alpha_owner", body: "Interested in our premium textile range.",
      isPinned: false, createdAt: timestamp, updatedAt: timestamp,
    };
    this.leadNotes.set(note.id, note);
    const activities: LeadActivity[] = [
      { id: "lead_activity_alpha_1", organizationId: "org_alpha", leadId: "lead_alpha_ramesh", kind: "call_linked", occurredAt: "2026-07-14T04:51:00.000Z", summary: "Missed incoming call" },
      { id: "lead_activity_alpha_2", organizationId: "org_alpha", leadId: "lead_alpha_ramesh", kind: "follow_up_created", actorUserId: "user_org_alpha_owner", occurredAt: "2026-07-14T04:52:00.000Z", summary: "Follow-up scheduled" },
      { id: "lead_activity_alpha_3", organizationId: "org_alpha", leadId: "lead_alpha_ramesh", kind: "status_changed", actorUserId: "user_org_alpha_owner", occurredAt: "2026-07-14T04:53:00.000Z", summary: "Status changed to Qualified" },
      { id: "lead_activity_alpha_4", organizationId: "org_alpha", leadId: "lead_alpha_ramesh", kind: "note_added", actorUserId: "user_org_alpha_owner", occurredAt: timestamp, summary: "Note added" },
    ];
    activities.forEach((activity) => this.leadActivities.set(activity.id, activity));
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
    const linkedEmployee = [...this.employees.values()].find((employee) =>
      employee.organizationId === organizationId && employee.linkedUserId === user.id);
    const leadScope: ActorContext["leadScope"] = primaryRole.systemKey === "manager"
      ? { kind: "teams", teamNames: linkedEmployee?.team ? [linkedEmployee.team] : [] }
      : primaryRole.systemKey === "employee"
        ? { kind: "assigned", employeeId: linkedEmployee?.id ?? "" }
        : { kind: "organization" };
    return clone({
      user,
      organization,
      roles,
      permissions: [...new Set(roles.flatMap((role) => role.permissions))],
      roleKey: primaryRole.systemKey,
      leadScope,
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

  private canAccessLead(scope: LeadAccessScope, lead: Lead): boolean {
    if (scope.kind === "organization") return true;
    if (scope.kind === "assigned") return Boolean(scope.employeeId) && lead.assignedEmployeeId === scope.employeeId;
    if (scope.teamNames.length === 0) return false;
    const team = this.leadTeams.get(lead.id) ??
      (lead.assignedEmployeeId ? this.employees.get(lead.assignedEmployeeId)?.team : undefined);
    return Boolean(team && scope.teamNames.includes(team));
  }

  private statusForLead(lead: Lead): LeadStatus {
    const status = this.leadStatuses.get(lead.statusId);
    if (!status || status.organizationId !== lead.organizationId) {
      throw new Error("Lead status is missing or belongs to another organization");
    }
    return status;
  }

  private followUpsForLead(organizationId: OrganizationId, leadId: string): FollowUp[] {
    return [...this.leadFollowUps.values()]
      .filter((followUp) => followUp.organizationId === organizationId && followUp.leadId === leadId)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id));
  }

  private unreturnedMissedCallCount(lead: Lead): number {
    const calls = [...this.leadActivities.values()].filter((activity) =>
      activity.organizationId === lead.organizationId && activity.leadId === lead.id &&
      activity.kind === "call_linked");
    return calls.filter((activity) => {
      const missed = activity.metadata?.direction === "incoming" && activity.metadata?.disposition === "missed" ||
        activity.summary.toLocaleLowerCase().includes("missed");
      if (!missed) return false;
      return !calls.some((candidate) =>
        candidate.occurredAt > activity.occurredAt &&
        candidate.metadata?.direction === "outgoing" && candidate.metadata?.disposition === "answered");
    }).length;
  }

  private linkCallToUniqueLead(call: CallLog, at: string): void {
    if (call.participant.isInternal) return;
    const employeeTeam = this.employees.get(call.employeeId)?.team;
    if (!employeeTeam) return;
    const existingLeadId = this.leadIdByCallId.get(call.id);
    const candidates = existingLeadId
      ? [this.leads.get(existingLeadId)].filter((lead): lead is Lead => lead !== undefined)
      : [...this.leads.values()].filter((lead) =>
        lead.organizationId === call.organizationId && !lead.archivedAt &&
        this.leadTeams.get(lead.id) === employeeTeam &&
        (lead.phoneNumber === call.participant.phoneNumber ||
          lead.alternatePhoneNumber === call.participant.phoneNumber));
    if (candidates.length !== 1) return;
    const lead = candidates[0];
    if (!lead) return;
    if (call.disposition === "answered" &&
      (lead.lastContactedAt === undefined || lead.lastContactedAt < call.startedAt)) {
      lead.lastContactedAt = call.startedAt;
      lead.updatedAt = at;
      lead.version += 1;
    }
    if (existingLeadId) return;
    this.leadIdByCallId.set(call.id, lead.id);
    const activityId = this.ids.next("lead_activity");
    this.leadActivities.set(activityId, {
      id: activityId,
      organizationId: call.organizationId,
      leadId: lead.id,
      kind: "call_linked",
      callLogId: call.id,
      occurredAt: call.startedAt,
      summary: `${call.direction === "outgoing" ? "Outgoing" : "Incoming"} ${call.disposition} call linked`,
      metadata: {
        direction: call.direction,
        disposition: call.disposition,
        linkSource: "automatic",
        matchConfidence: 1,
      },
    });
  }

  private buildLeadListItem(lead: Lead, at: string): LeadListItem {
    const followUps = this.followUpsForLead(lead.organizationId, lead.id);
    const pending = followUps.filter((followUp) => followUp.status === "pending");
    const assignedEmployee = lead.assignedEmployeeId
      ? this.employees.get(lead.assignedEmployeeId)
      : undefined;
    return {
      lead: clone(lead),
      status: clone(this.statusForLead(lead)),
      ...(assignedEmployee === undefined ? {} : {
        assignedEmployee: {
          id: assignedEmployee.id,
          displayName: assignedEmployee.displayName,
          ...(assignedEmployee.team === undefined ? {} : { team: assignedEmployee.team }),
        },
      }),
      ...(pending[0] === undefined ? {} : { nextFollowUp: clone(pending[0]) }),
      overdueFollowUpCount: pending.filter((followUp) => followUp.dueAt < at).length,
      unreturnedMissedCallCount: this.unreturnedMissedCallCount(lead),
    };
  }

  private buildLeadDetail(lead: Lead, at: string): LeadDetail {
    const notes = [...this.leadNotes.values()]
      .filter((note) => note.organizationId === lead.organizationId && note.leadId === lead.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const activities = [...this.leadActivities.values()]
      .filter((activity) => activity.organizationId === lead.organizationId && activity.leadId === lead.id)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
    return {
      item: this.buildLeadListItem(lead, at),
      notes: clone(notes),
      followUps: clone(this.followUpsForLead(lead.organizationId, lead.id)),
      activities: clone(activities),
    };
  }

  private firstLeadResponseSeconds(lead: Lead): number | undefined {
    const createdAt = Date.parse(lead.createdAt);
    let firstAnsweredAt: number | undefined;
    for (const [callId, linkedLeadId] of this.leadIdByCallId) {
      if (linkedLeadId !== lead.id) continue;
      const call = this.calls.get(callId);
      if (!call || call.organizationId !== lead.organizationId ||
        call.disposition !== "answered" || call.answeredAt === undefined) continue;
      const answeredAt = Date.parse(call.answeredAt);
      // The active map reflects corrected links. Historical unlinked calls
      // and calls answered before the lead existed do not define response.
      if (answeredAt < createdAt) continue;
      if (firstAnsweredAt === undefined || answeredAt < firstAnsweredAt) firstAnsweredAt = answeredAt;
    }
    return firstAnsweredAt === undefined ? undefined : Math.round((firstAnsweredAt - createdAt) / 1_000);
  }

  private defaultLeadStatus(organizationId: OrganizationId): LeadStatus | undefined {
    return [...this.leadStatuses.values()]
      .filter((status) => status.organizationId === organizationId && status.isActive)
      .sort((left, right) => Number(right.isInitial) - Number(left.isInitial) || left.position - right.position)[0];
  }

  private validateLeadAssignment(
    organizationId: OrganizationId,
    scope: LeadAccessScope,
    employeeId: string,
  ): Employee | undefined {
    const employee = this.employees.get(employeeId);
    if (!employee || employee.organizationId !== organizationId || employee.status !== "active") return undefined;
    if (scope.kind === "organization") return employee;
    if (scope.kind === "assigned") return scope.employeeId === employee.id ? employee : undefined;
    return employee.team && scope.teamNames.includes(employee.team) ? employee : undefined;
  }

  async listLeadStatuses(organizationId: OrganizationId): Promise<LeadStatus[]> {
    return clone([...this.leadStatuses.values()]
      .filter((status) => status.organizationId === organizationId && status.isActive)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)));
  }

  async listLeads(options: {
    organizationId: OrganizationId;
    scope: LeadAccessScope;
    filter: LeadListFilter;
    after?: LeadCursor;
    limit: number;
    at: string;
  }): Promise<LeadListResult> {
    const search = options.filter.search?.trim().toLocaleLowerCase();
    let accessible = [...this.leads.values()].filter((lead) =>
      lead.organizationId === options.organizationId && !lead.archivedAt && this.canAccessLead(options.scope, lead));
    const queueMatches = (lead: Lead): boolean => {
      const item = this.buildLeadListItem(lead, options.at);
      if (options.filter.queue === "not_contacted") return lead.lastContactedAt === undefined;
      if (options.filter.queue === "overdue") return item.overdueFollowUpCount > 0;
      if (options.filter.queue === "unreturned_calls") return item.unreturnedMissedCallCount > 0;
      return true;
    };
    const summary: LeadQueueSummary = {
      total: accessible.length,
      notContacted: accessible.filter((lead) => lead.lastContactedAt === undefined).length,
      overdue: accessible.filter((lead) => this.buildLeadListItem(lead, options.at).overdueFollowUpCount > 0).length,
      unreturnedCalls: accessible.filter((lead) => this.unreturnedMissedCallCount(lead) > 0).length,
    };
    accessible = accessible.filter((lead) => {
      if (options.filter.statusId && lead.statusId !== options.filter.statusId) return false;
      if (options.filter.assignedEmployeeId && lead.assignedEmployeeId !== options.filter.assignedEmployeeId) return false;
      if (!queueMatches(lead)) return false;
      if (search) {
        const text = `${lead.firstName} ${lead.lastName ?? ""} ${lead.companyName ?? ""} ${lead.phoneNumber} ${lead.email ?? ""}`.toLocaleLowerCase();
        if (!text.includes(search)) return false;
      }
      return true;
    });
    accessible.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    if (options.after) {
      accessible = accessible.filter((lead) =>
        lead.createdAt < options.after!.createdAt ||
        (lead.createdAt === options.after!.createdAt && lead.id < options.after!.id));
    }
    const page = accessible.slice(0, options.limit + 1);
    return {
      items: page.slice(0, options.limit).map((lead) => this.buildLeadListItem(lead, options.at)),
      summary,
      hasMore: page.length > options.limit,
    };
  }

  async findLeadDetail(options: {
    organizationId: OrganizationId;
    scope: LeadAccessScope;
    leadId: string;
    at: string;
  }): Promise<LeadDetail | undefined> {
    const lead = this.leads.get(options.leadId);
    if (!lead || lead.organizationId !== options.organizationId || !this.canAccessLead(options.scope, lead)) return undefined;
    return clone(this.buildLeadDetail(lead, options.at));
  }

  async createLead(options: CreateLeadOptions): Promise<LeadDetail | undefined> {
    const status = options.input.statusId
      ? this.leadStatuses.get(options.input.statusId)
      : this.defaultLeadStatus(options.organizationId);
    if (!status || status.organizationId !== options.organizationId || !status.isActive) return undefined;
    if (options.input.assignedEmployeeId &&
      !this.validateLeadAssignment(options.organizationId, options.scope, options.input.assignedEmployeeId)) return undefined;
    if (options.scope.kind === "assigned" && options.input.assignedEmployeeId !== options.scope.employeeId) return undefined;
    const lead: Lead = {
      id: this.ids.next("lead"),
      organizationId: options.organizationId,
      firstName: options.input.firstName,
      phoneNumber: options.input.phoneNumber,
      source: options.input.source ?? "manual",
      statusId: status.id,
      tagIds: clone(options.input.tagIds ?? []),
      customFields: clone(options.input.customFields ?? {}),
      version: 1,
      createdAt: options.at,
      updatedAt: options.at,
      createdBy: options.actorUserId,
      updatedBy: options.actorUserId,
      ...(options.input.lastName === undefined ? {} : { lastName: options.input.lastName }),
      ...(options.input.companyName === undefined ? {} : { companyName: options.input.companyName }),
      ...(options.input.alternatePhoneNumber === undefined ? {} : { alternatePhoneNumber: options.input.alternatePhoneNumber }),
      ...(options.input.email === undefined ? {} : { email: options.input.email }),
      ...(options.input.sourceReference === undefined ? {} : { sourceReference: options.input.sourceReference }),
      ...(options.input.temperature === undefined ? {} : { temperature: options.input.temperature }),
      ...(options.input.assignedEmployeeId === undefined ? {} : { assignedEmployeeId: options.input.assignedEmployeeId }),
    };
    this.leads.set(lead.id, lead);
    const assigned = lead.assignedEmployeeId ? this.employees.get(lead.assignedEmployeeId) : undefined;
    const team = assigned?.team ?? (options.scope.kind === "teams"
      ? options.scope.teamNames[0]
      : [...this.employees.values()].find((employee) =>
        employee.organizationId === options.organizationId && employee.team)?.team);
    if (team) this.leadTeams.set(lead.id, team);
    const activityId = this.ids.next("lead_activity");
    this.leadActivities.set(activityId, {
      id: activityId,
      organizationId: options.organizationId,
      leadId: lead.id,
      kind: "created",
      actorUserId: options.actorUserId,
      occurredAt: options.at,
      summary: "Lead created",
    });
    return clone(this.buildLeadDetail(lead, options.at));
  }

  async updateLead(options: UpdateLeadOptions): Promise<LeadDetail | undefined> {
    const lead = this.leads.get(options.leadId);
    if (!lead || lead.organizationId !== options.organizationId || !this.canAccessLead(options.scope, lead)) return undefined;
    if (lead.version !== options.request.expectedVersion) throw conflict("The lead changed; refresh and retry");
    const changes = options.request.changes;
    if (changes.statusId !== undefined) {
      const status = this.leadStatuses.get(changes.statusId);
      if (!status || status.organizationId !== options.organizationId || !status.isActive) return undefined;
    }
    if (changes.assignedEmployeeId !== undefined) {
      if (!options.canAssign) return undefined;
      if (changes.assignedEmployeeId !== null &&
        !this.validateLeadAssignment(options.organizationId, options.scope, changes.assignedEmployeeId)) return undefined;
    }
    const oldStatusId = lead.statusId;
    const oldAssignee = lead.assignedEmployeeId;
    const setOptional = <Key extends keyof Lead>(key: Key, value: Lead[Key] | null | undefined): void => {
      if (value === undefined) return;
      if (value === null) delete lead[key];
      else lead[key] = value;
    };
    if (changes.firstName !== undefined) lead.firstName = changes.firstName;
    if (changes.phoneNumber !== undefined) lead.phoneNumber = changes.phoneNumber;
    if (changes.statusId !== undefined) lead.statusId = changes.statusId;
    if (changes.tagIds !== undefined) lead.tagIds = clone(changes.tagIds);
    if (changes.customFields !== undefined) lead.customFields = clone(changes.customFields);
    setOptional("lastName", changes.lastName);
    setOptional("companyName", changes.companyName);
    setOptional("alternatePhoneNumber", changes.alternatePhoneNumber);
    setOptional("email", changes.email);
    setOptional("temperature", changes.temperature);
    setOptional("assignedEmployeeId", changes.assignedEmployeeId);
    if (changes.assignedEmployeeId) {
      const team = this.employees.get(changes.assignedEmployeeId)?.team;
      if (team) this.leadTeams.set(lead.id, team);
    }
    if (changes.archived === true) lead.archivedAt = options.at;
    if (changes.archived === false) delete lead.archivedAt;
    const newStatus = this.statusForLead(lead);
    if (newStatus.isWon && !lead.convertedAt) lead.convertedAt = options.at;
    if (newStatus.isLost && !lead.lostAt) lead.lostAt = options.at;
    lead.version += 1;
    lead.updatedAt = options.at;
    lead.updatedBy = options.actorUserId;
    const activityKind: LeadActivity["kind"] = oldStatusId !== lead.statusId
      ? "status_changed"
      : oldAssignee !== lead.assignedEmployeeId
        ? lead.assignedEmployeeId ? "assigned" : "unassigned"
        : "updated";
    const summary = activityKind === "status_changed"
      ? `Status changed to ${newStatus.name}`
      : activityKind === "assigned" ? "Lead assigned" : activityKind === "unassigned" ? "Lead unassigned" : "Lead updated";
    const activityId = this.ids.next("lead_activity");
    this.leadActivities.set(activityId, {
      id: activityId,
      organizationId: options.organizationId,
      leadId: lead.id,
      kind: activityKind,
      actorUserId: options.actorUserId,
      occurredAt: options.at,
      summary,
      metadata: {
        oldStatusId: oldStatusId,
        newStatusId: lead.statusId,
        oldAssignedEmployeeId: oldAssignee ?? null,
        newAssignedEmployeeId: lead.assignedEmployeeId ?? null,
      },
    });
    return clone(this.buildLeadDetail(lead, options.at));
  }

  async createLeadNote(options: CreateLeadNoteOptions): Promise<LeadDetail | undefined> {
    const lead = this.leads.get(options.leadId);
    if (!lead || lead.organizationId !== options.organizationId || !this.canAccessLead(options.scope, lead)) return undefined;
    const noteId = this.ids.next("lead_note");
    this.leadNotes.set(noteId, {
      id: noteId,
      organizationId: options.organizationId,
      leadId: lead.id,
      authorUserId: options.actorUserId,
      body: options.input.body,
      isPinned: options.input.isPinned ?? false,
      createdAt: options.at,
      updatedAt: options.at,
      createdBy: options.actorUserId,
      updatedBy: options.actorUserId,
    });
    const activityId = this.ids.next("lead_activity");
    this.leadActivities.set(activityId, {
      id: activityId,
      organizationId: options.organizationId,
      leadId: lead.id,
      kind: "note_added",
      actorUserId: options.actorUserId,
      occurredAt: options.at,
      summary: "Note added",
    });
    return clone(this.buildLeadDetail(lead, options.at));
  }

  async createLeadFollowUp(options: CreateLeadFollowUpOptions): Promise<LeadDetail | undefined> {
    const lead = this.leads.get(options.leadId);
    if (!lead || lead.organizationId !== options.organizationId || !this.canAccessLead(options.scope, lead) ||
      options.input.leadId !== lead.id ||
      !this.validateLeadAssignment(options.organizationId, options.scope, options.input.assignedEmployeeId)) return undefined;
    const followUpId = this.ids.next("follow_up");
    this.leadFollowUps.set(followUpId, {
      id: followUpId,
      organizationId: options.organizationId,
      leadId: lead.id,
      assignedEmployeeId: options.input.assignedEmployeeId,
      title: options.input.title,
      dueAt: options.input.dueAt,
      priority: options.input.priority ?? "normal",
      status: "pending",
      version: 1,
      createdAt: options.at,
      updatedAt: options.at,
      createdBy: options.actorUserId,
      updatedBy: options.actorUserId,
      ...(options.input.notes === undefined ? {} : { notes: options.input.notes }),
      ...(options.input.reminderAt === undefined ? {} : { reminderAt: options.input.reminderAt }),
    });
    const nextDue = this.followUpsForLead(options.organizationId, lead.id)
      .find((followUp) => followUp.status === "pending")?.dueAt;
    if (nextDue) lead.nextFollowUpAt = nextDue;
    lead.updatedAt = options.at;
    lead.updatedBy = options.actorUserId;
    lead.version += 1;
    const activityId = this.ids.next("lead_activity");
    this.leadActivities.set(activityId, {
      id: activityId,
      organizationId: options.organizationId,
      leadId: lead.id,
      kind: "follow_up_created",
      actorUserId: options.actorUserId,
      occurredAt: options.at,
      summary: "Follow-up scheduled",
    });
    return clone(this.buildLeadDetail(lead, options.at));
  }

  async completeLeadFollowUp(options: CompleteLeadFollowUpOptions): Promise<LeadDetail | undefined> {
    const followUp = this.leadFollowUps.get(options.followUpId);
    if (!followUp || followUp.organizationId !== options.organizationId) return undefined;
    const lead = this.leads.get(followUp.leadId);
    if (!lead || !this.canAccessLead(options.scope, lead)) return undefined;
    if (followUp.version !== options.input.expectedVersion) throw conflict("The follow-up changed; refresh and retry");
    if (followUp.status !== "pending") throw conflict("The follow-up is no longer pending");
    followUp.status = "completed";
    followUp.completedAt = options.input.completedAt ?? options.at;
    followUp.completedByUserId = options.actorUserId;
    followUp.updatedAt = options.at;
    followUp.updatedBy = options.actorUserId;
    followUp.version += 1;
    if (options.input.completionNote) {
      const noteId = this.ids.next("lead_note");
      this.leadNotes.set(noteId, {
        id: noteId,
        organizationId: options.organizationId,
        leadId: lead.id,
        authorUserId: options.actorUserId,
        body: options.input.completionNote,
        isPinned: false,
        createdAt: options.at,
        updatedAt: options.at,
        createdBy: options.actorUserId,
        updatedBy: options.actorUserId,
      });
    }
    const nextDue = this.followUpsForLead(options.organizationId, lead.id)
      .find((candidate) => candidate.status === "pending")?.dueAt;
    if (nextDue) lead.nextFollowUpAt = nextDue;
    else delete lead.nextFollowUpAt;
    lead.updatedAt = options.at;
    lead.updatedBy = options.actorUserId;
    lead.version += 1;
    const activityId = this.ids.next("lead_activity");
    this.leadActivities.set(activityId, {
      id: activityId,
      organizationId: options.organizationId,
      leadId: lead.id,
      kind: "follow_up_completed",
      actorUserId: options.actorUserId,
      occurredAt: options.at,
      summary: "Follow-up completed",
    });
    return clone(this.buildLeadDetail(lead, options.at));
  }

  private canAccessTeam(scope: LeadAccessScope, team: string | undefined): boolean {
    if (scope.kind === "organization") return true;
    if (!team) return false;
    if (scope.kind === "teams") return scope.teamNames.includes(team);
    return this.employees.get(scope.employeeId)?.team === team;
  }

  private ruleMatchesLead(rule: LeadAssignmentRule, lead: Lead): boolean {
    const conditions = rule.conditions;
    if (conditions.sources?.length && !conditions.sources.includes(lead.source)) return false;
    if (conditions.temperatures?.length &&
      (!lead.temperature || !conditions.temperatures.includes(lead.temperature))) return false;
    if (conditions.statusIds?.length && !conditions.statusIds.includes(lead.statusId)) return false;
    return true;
  }

  private matchingRules(organizationId: OrganizationId, scope: LeadAccessScope, lead: Lead): LeadAssignmentRule[] {
    const team = this.leadTeams.get(lead.id) ??
      (lead.assignedEmployeeId ? this.employees.get(lead.assignedEmployeeId)?.team : undefined);
    return [...this.leadAssignmentRules.values()]
      .filter((rule) => rule.organizationId === organizationId && rule.active &&
        this.leadAssignmentRuleTeams.get(rule.id) === team && this.canAccessTeam(scope, team) &&
        rule.employeeIds.length > 0 && rule.employeeIds.every((employeeId) => {
          const employee = this.employees.get(employeeId);
          return employee?.organizationId === organizationId && employee.status === "active" && employee.team === team;
        }) &&
        this.ruleMatchesLead(rule, lead))
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  }

  async previewLeadImport(options: PreviewLeadImportOptions): Promise<LeadImportPreview> {
    const requestKey = `${options.organizationId}:${options.input.requestId}`;
    const existingId = this.leadImportIdByRequest.get(requestKey);
    if (existingId) {
      if (this.leadImportFingerprints.get(requestKey) !== options.requestFingerprint) {
        throw conflict("The import request ID was already used with a different payload");
      }
      const existing = this.leadImports.get(existingId);
      if (!existing) throw new Error("In-memory lead import request is corrupt");
      if (!this.canAccessImport(options, existing)) {
        throw forbidden("The lead import is outside your current lead scope");
      }
      return clone({ ...existing, replayed: true });
    }

    const rows: LeadImportPreview["rows"] = [];
    const phones = new Map<string, number>();
    const importTeams = new Set<string>();
    const ruleCursors = new Map<string, number>();
    const rowTeams = new Map<number, string>();
    const rowRuleIds = new Map<number, string>();
    const activeEmployees = [...this.employees.values()].filter((employee) =>
      employee.organizationId === options.organizationId && employee.status === "active" &&
      this.canAccessTeam(options.scope, employee.team));
    const defaultEmployee = activeEmployees
      .filter((employee) => employee.team)
      .sort((left, right) => (left.team ?? "").localeCompare(right.team ?? "") || left.id.localeCompare(right.id))[0];

    for (const [index, rawInput] of options.input.rows.entries()) {
      const input = clone(rawInput);
      const rowNumber = index + 1;
      const issues: LeadImportPreview["rows"][number]["issues"] = [];
      const firstName = typeof input.firstName === "string" ? input.firstName.trim() : "";
      const phoneNumber = typeof input.phoneNumber === "string" ? input.phoneNumber.trim() : "";
      const validPhone = /^\+[1-9]\d{7,14}$/.test(phoneNumber);
      if (!firstName) issues.push({ field: "firstName", code: "required", message: "First name is required" });
      if (!validPhone) issues.push({ field: "phoneNumber", code: "invalid_phone", message: "Phone must use E.164 format" });
      if (input.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
        issues.push({ field: "email", code: "invalid_email", message: "Email is invalid" });
      }
      if (input.source !== undefined && !isLeadSource(input.source)) {
        issues.push({ field: "source", code: "invalid_source", message: "Lead source is invalid" });
      }

      const status = input.statusName
        ? [...this.leadStatuses.values()].find((candidate) => candidate.organizationId === options.organizationId &&
          candidate.isActive && candidate.name.toLocaleLowerCase() === input.statusName!.trim().toLocaleLowerCase())
        : this.defaultLeadStatus(options.organizationId);
      if (!status) issues.push({ field: "statusName", code: "unknown_status", message: "Lead status was not found" });

      const explicitOwner = input.assignedEmployeeCode
        ? activeEmployees.find((employee) => employee.employeeCode?.toLocaleLowerCase() ===
          input.assignedEmployeeCode!.trim().toLocaleLowerCase())
        : undefined;
      if (input.assignedEmployeeCode && !explicitOwner) {
        issues.push({ field: "assignedEmployeeCode", code: "unknown_owner", message: "Active owner was not found" });
      }
      const team = explicitOwner?.team ?? defaultEmployee?.team;
      if (!team) issues.push({ field: "assignedEmployeeCode", code: "unknown_owner", message: "No accessible team is available" });

      const alternatePhoneNumber = input.alternatePhoneNumber?.trim();
      const validAlternatePhone = alternatePhoneNumber !== undefined && /^\+[1-9]\d{7,14}$/.test(alternatePhoneNumber);
      if (alternatePhoneNumber !== undefined && !validAlternatePhone) {
        issues.push({ field: "alternatePhoneNumber", code: "invalid_phone",
          message: "Alternate phone must use E.164 format" });
      }
      let duplicateRow: number | undefined;
      for (const [field, candidate] of [
        ["phoneNumber", validPhone ? phoneNumber : undefined],
        ["alternatePhoneNumber", validAlternatePhone ? alternatePhoneNumber : undefined],
      ] as const) {
        if (!candidate) continue;
        const phoneKey = `${team ?? "unresolved"}:${candidate}`;
        const priorRow = phones.get(phoneKey);
        if (priorRow !== undefined) {
          duplicateRow ??= priorRow;
          issues.push({ field, code: "duplicate_in_file", message: `Duplicates row ${priorRow}` });
        } else if (field === "alternatePhoneNumber" && candidate === phoneNumber) {
          issues.push({ field, code: "duplicate_in_file", message: "Duplicates phoneNumber in this row" });
        }
      }
      const candidatePhones = [validPhone ? phoneNumber : undefined,
        validAlternatePhone ? alternatePhoneNumber : undefined].filter((value): value is string => Boolean(value));
      const invalidBeforeDuplicateLookup = issues.some((issue) =>
        !["duplicate_in_file", "duplicate_existing"].includes(issue.code));
      const duplicateLead = !invalidBeforeDuplicateLookup && duplicateRow === undefined &&
        !issues.some((issue) => issue.code === "duplicate_in_file") &&
        candidatePhones.length > 0 && team ? [...this.leads.values()].find((lead) =>
        lead.organizationId === options.organizationId && !lead.archivedAt &&
        this.leadTeams.get(lead.id) === team &&
        candidatePhones.some((candidate) => lead.phoneNumber === candidate ||
          lead.alternatePhoneNumber === candidate)) : undefined;
      if (duplicateLead) {
        issues.push({ field: "phoneNumber", code: "duplicate_existing", message: "An existing lead has this phone" });
      }

      const duplicate = Boolean(duplicateRow || duplicateLead ||
        issues.some((issue) => issue.code === "duplicate_in_file"));
      const invalid = issues.some((issue) => !["duplicate_in_file", "duplicate_existing"].includes(issue.code));
      if (!invalid && !duplicate) {
        phones.set(`${team ?? "unresolved"}:${phoneNumber}`, rowNumber);
        if (validAlternatePhone && alternatePhoneNumber) {
          phones.set(`${team ?? "unresolved"}:${alternatePhoneNumber}`, rowNumber);
        }
      }
      let proposedOwner = explicitOwner;
      if (!invalid && !duplicate && !proposedOwner && status && team &&
        issues.every((issue) => issue.code !== "unknown_owner")) {
        const proposed: Lead = {
          id: `preview:${rowNumber}`,
          organizationId: options.organizationId,
          firstName: firstName || "Invalid",
          phoneNumber: validPhone ? phoneNumber : "+10000000000",
          source: input.source ?? "csv_import",
          statusId: status.id,
          tagIds: [],
          customFields: {},
          version: 1,
          createdAt: options.at,
          updatedAt: options.at,
        };
        this.leadTeams.set(proposed.id, team);
        const rule = this.matchingRules(options.organizationId, options.scope, proposed)[0];
        this.leadTeams.delete(proposed.id);
        if (rule) {
          const cursor = ruleCursors.get(rule.id) ?? this.leadAssignmentRuleCursors.get(rule.id) ?? 0;
          const position = rule.strategy === "fixed_owner" ? 0 : cursor % rule.employeeIds.length;
          proposedOwner = this.employees.get(rule.employeeIds[position] ?? "");
          if (proposedOwner) {
            rowRuleIds.set(rowNumber, rule.id);
            if (rule.strategy === "round_robin") ruleCursors.set(rule.id, cursor + 1);
          }
        }
      }

      if (team) {
        importTeams.add(team);
        rowTeams.set(rowNumber, team);
      }
      rows.push({
        rowNumber,
        decision: invalid ? "invalid" : duplicate ? "duplicate" : "valid",
        input,
        issues,
        ...(duplicateLead === undefined ? {} : { duplicateLeadId: duplicateLead.id }),
        ...(proposedOwner === undefined ? {} : { proposedAssignedEmployeeId: proposedOwner.id }),
      });
    }

    const job: LeadImportJob = {
      id: this.ids.next("lead_import"),
      organizationId: options.organizationId,
      fileName: options.input.fileName,
      status: "preview_ready",
      totalRows: rows.length,
      validRows: rows.filter((row) => row.decision === "valid").length,
      duplicateRows: rows.filter((row) => row.decision === "duplicate").length,
      errorRows: rows.filter((row) => row.decision === "invalid").length,
      importedRows: 0,
      processedRows: rows.filter((row) => row.decision !== "valid").length,
      createdByUserId: options.actorUserId,
      createdAt: options.at,
      updatedAt: options.at,
      errorDownloadAvailable: rows.some((row) => row.issues.length > 0),
    };
    const preview: LeadImportPreview = { job, rows, replayed: false };
    this.leadImports.set(job.id, clone(preview));
    this.leadImportTeams.set(job.id, importTeams);
    for (const [rowNumber, team] of rowTeams) {
      this.leadImportRowTeams.set(`${job.id}:${rowNumber}`, team);
    }
    for (const [rowNumber, ruleId] of rowRuleIds) {
      this.leadImportRuleIds.set(`${job.id}:${rowNumber}`, ruleId);
    }
    this.leadImportIdByRequest.set(requestKey, job.id);
    this.leadImportFingerprints.set(requestKey, options.requestFingerprint);
    return clone(preview);
  }

  private canAccessImport(options: LeadImportAccessOptions, preview: LeadImportPreview): boolean {
    if (preview.job.organizationId !== options.organizationId) return false;
    if (options.scope.kind === "organization") return true;
    if (preview.job.createdByUserId !== options.actorUserId) return false;
    const teams = this.leadImportTeams.get(preview.job.id) ?? new Set<string>();
    return [...teams].every((team) => this.canAccessTeam(options.scope, team));
  }

  async listLeadImports(options: LeadImportAccessOptions): Promise<LeadImportJob[]> {
    return clone([...this.leadImports.values()]
      .filter((preview) => this.canAccessImport(options, preview))
      .map((preview) => preview.job)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)));
  }

  async findLeadImport(options: LeadImportAccessOptions & { jobId: string }): Promise<LeadImportPreview | undefined> {
    const preview = this.leadImports.get(options.jobId);
    return preview && this.canAccessImport(options, preview) ? clone(preview) : undefined;
  }

  async commitLeadImport(options: CommitLeadImportOptions): Promise<LeadImportResult | undefined> {
    const preview = this.leadImports.get(options.jobId);
    if (!preview || !this.canAccessImport(options, preview)) return undefined;
    const requestKey = `${options.organizationId}:${options.input.requestId}`;
    const prior = this.leadImportCommitRequests.get(requestKey);
    if (prior) {
      if (prior.fingerprint !== options.requestFingerprint || prior.jobId !== options.jobId) {
        throw conflict("The import commit request ID was already used with a different payload");
      }
      return clone({ ...prior.result, replayed: true });
    }
    if (preview.job.status === "completed") {
      const result = { job: clone(preview.job), replayed: true };
      this.leadImportCommitRequests.set(requestKey, {
        fingerprint: options.requestFingerprint,
        jobId: options.jobId,
        result,
      });
      return result;
    }
    preview.job.status = "processing";
    preview.job.updatedAt = options.at;
    const batch = preview.rows.filter((candidate) => candidate.decision === "valid").slice(0, 50);
    const ruleCursors = new Map<string, number>();
    const advancedRuleIds = new Set<string>();
    for (const row of batch) {
      const rowKey = `${preview.job.id}:${row.rowNumber}`;
      const team = this.leadImportRowTeams.get(rowKey);
      const candidatePhones = [row.input.phoneNumber.trim(), row.input.alternatePhoneNumber?.trim()]
        .filter((value): value is string => Boolean(value));
      const duplicateLead = team ? [...this.leads.values()].find((lead) =>
        lead.organizationId === options.organizationId && !lead.archivedAt &&
        this.leadTeams.get(lead.id) === team && candidatePhones.some((phone) =>
          lead.phoneNumber === phone || lead.alternatePhoneNumber === phone)) : undefined;
      if (duplicateLead) {
        row.decision = "duplicate";
        row.duplicateLeadId = duplicateLead.id;
        row.issues.push({
          field: "phoneNumber",
          code: "duplicate_existing",
          message: "An existing lead has this phone",
        });
        preview.job.duplicateRows += 1;
        preview.job.validRows -= 1;
        continue;
      }
      const status = row.input.statusName
        ? [...this.leadStatuses.values()].find((candidate) => candidate.organizationId === options.organizationId &&
          candidate.isActive && candidate.name.toLocaleLowerCase() === row.input.statusName!.trim().toLocaleLowerCase())
        : this.defaultLeadStatus(options.organizationId);
      if (!status) {
        row.decision = "invalid";
        row.issues.push({
          field: "statusName",
          code: "unknown_status",
          message: "The staged lead status is no longer active",
        });
        preview.job.errorRows += 1;
        preview.job.validRows -= 1;
        continue;
      }
      let assignedEmployeeId = row.proposedAssignedEmployeeId;
      const ruleId = this.leadImportRuleIds.get(rowKey);
      let appliedRoundRobinCursor: number | undefined;
      if (ruleId) {
        const rule = this.leadAssignmentRules.get(ruleId);
        const ruleTeam = this.leadAssignmentRuleTeams.get(ruleId);
        const proposed: Lead = {
          id: `commit:${preview.job.id}:${row.rowNumber}`,
          organizationId: options.organizationId,
          firstName: row.input.firstName.trim(),
          phoneNumber: row.input.phoneNumber.trim(),
          source: row.input.source ?? "csv_import",
          statusId: status.id,
          tagIds: [],
          customFields: {},
          version: 1,
          createdAt: options.at,
          updatedAt: options.at,
        };
        const eligible = rule && rule.active && team && ruleTeam === team &&
          this.canAccessTeam(options.scope, team) && this.ruleMatchesLead(rule, proposed) &&
          rule.employeeIds.length > 0 && rule.employeeIds.every((employeeId) => {
            const employee = this.employees.get(employeeId);
            return employee?.organizationId === options.organizationId &&
              employee.status === "active" && employee.team === team;
          });
        if (!eligible || !rule) {
          row.decision = "invalid";
          row.issues.push({
            field: "assignedEmployeeCode",
            code: "unknown_owner",
            message: "The assignment rule no longer has an eligible active owner",
          });
          preview.job.errorRows += 1;
          preview.job.validRows -= 1;
          continue;
        }
        const cursor = ruleCursors.get(ruleId) ?? this.leadAssignmentRuleCursors.get(ruleId) ?? 0;
        assignedEmployeeId = rule.employeeIds[rule.strategy === "fixed_owner" ? 0 : cursor % rule.employeeIds.length];
        if (!assignedEmployeeId) {
          row.decision = "invalid";
          row.issues.push({
            field: "assignedEmployeeCode",
            code: "unknown_owner",
            message: "The assignment rule no longer has an eligible active owner",
          });
          preview.job.errorRows += 1;
          preview.job.validRows -= 1;
          continue;
        }
        if (rule.strategy === "round_robin") appliedRoundRobinCursor = cursor;
      }
      const detail = await this.createLead({
        organizationId: options.organizationId,
        scope: options.scope,
        input: {
          firstName: row.input.firstName.trim(),
          phoneNumber: row.input.phoneNumber.trim(),
          source: row.input.source ?? "csv_import",
          sourceReference: `${preview.job.id}:${row.rowNumber}`,
          ...(row.input.lastName === undefined ? {} : { lastName: row.input.lastName }),
          ...(row.input.companyName === undefined ? {} : { companyName: row.input.companyName }),
          ...(row.input.alternatePhoneNumber === undefined ? {} : { alternatePhoneNumber: row.input.alternatePhoneNumber }),
          ...(row.input.email === undefined ? {} : { email: row.input.email }),
          ...(status === undefined ? {} : { statusId: status.id }),
          ...(assignedEmployeeId === undefined ? {} : { assignedEmployeeId }),
          ...(row.input.tagNames === undefined ? {} : { tagIds: row.input.tagNames.map((tagName) => tagName.trim()) }),
          ...(row.input.customFields === undefined ? {} : { customFields: row.input.customFields }),
        },
        actorUserId: options.actorUserId,
        at: options.at,
      });
      if (!detail) {
        row.decision = "invalid";
        row.issues.push({ field: "assignedEmployeeCode", code: "unknown_owner", message: "Owner is no longer available" });
        preview.job.errorRows += 1;
        preview.job.validRows -= 1;
      } else {
        row.decision = "imported";
        preview.job.importedRows += 1;
        if (ruleId && appliedRoundRobinCursor !== undefined) {
          ruleCursors.set(ruleId, appliedRoundRobinCursor + 1);
          advancedRuleIds.add(ruleId);
        }
      }
    }
    for (const ruleId of advancedRuleIds) {
      const cursor = ruleCursors.get(ruleId);
      if (cursor === undefined) continue;
      this.leadAssignmentRuleCursors.set(ruleId, cursor);
      const rule = this.leadAssignmentRules.get(ruleId);
      if (rule) {
        rule.version += 1;
        rule.updatedByUserId = options.actorUserId;
        rule.updatedAt = options.at;
      }
    }
    preview.job.processedRows = preview.rows.filter((row) => row.decision !== "valid").length;
    const hasRemaining = preview.rows.some((row) => row.decision === "valid");
    preview.job.status = hasRemaining ? "interrupted" : "completed";
    if (!hasRemaining) preview.job.completedAt = options.at;
    preview.job.updatedAt = options.at;
    preview.job.errorDownloadAvailable = preview.rows.some((row) => row.issues.length > 0);
    const result = { job: clone(preview.job), replayed: false };
    this.leadImportCommitRequests.set(requestKey, {
      fingerprint: options.requestFingerprint,
      jobId: options.jobId,
      result: clone(result),
    });
    return result;
  }

  async listLeadAssignmentRules(options: LeadAssignmentOperationOptions): Promise<LeadAssignmentRule[]> {
    return clone([...this.leadAssignmentRules.values()]
      .filter((rule) => rule.organizationId === options.organizationId &&
        this.canAccessTeam(options.scope, this.leadAssignmentRuleTeams.get(rule.id)))
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)));
  }

  async createLeadAssignmentRule(options: CreateLeadAssignmentRuleOptions): Promise<LeadAssignmentRule | undefined> {
    if (new Set(options.input.employeeIds).size !== options.input.employeeIds.length) return undefined;
    const employees = options.input.employeeIds.map((id) => this.employees.get(id));
    if (employees.some((employee) => !employee || employee.organizationId !== options.organizationId ||
      employee.status !== "active" || !this.canAccessTeam(options.scope, employee.team))) return undefined;
    const team = employees[0]?.team;
    if (!team || employees.some((employee) => employee?.team !== team)) return undefined;
    const rule: LeadAssignmentRule = {
      id: this.ids.next("lead_assignment_rule"),
      organizationId: options.organizationId,
      name: options.input.name.trim(),
      priority: options.input.priority,
      active: options.input.active ?? true,
      conditions: clone(options.input.conditions ?? {}),
      strategy: options.input.strategy,
      employeeIds: [...options.input.employeeIds],
      version: 1,
      createdByUserId: options.actorUserId,
      updatedByUserId: options.actorUserId,
      createdAt: options.at,
      updatedAt: options.at,
    };
    this.leadAssignmentRules.set(rule.id, rule);
    this.leadAssignmentRuleTeams.set(rule.id, team);
    this.leadAssignmentRuleCursors.set(rule.id, 0);
    return clone(rule);
  }

  async updateLeadAssignmentRule(options: UpdateLeadAssignmentRuleOptions): Promise<LeadAssignmentRule | undefined> {
    const rule = this.leadAssignmentRules.get(options.ruleId);
    if (!rule || rule.organizationId !== options.organizationId ||
      !this.canAccessTeam(options.scope, this.leadAssignmentRuleTeams.get(rule.id))) return undefined;
    if (rule.version !== options.input.expectedVersion) throw conflict("The assignment rule changed; refresh and retry");
    const employeeIds = options.input.changes.employeeIds ?? rule.employeeIds;
    if (new Set(employeeIds).size !== employeeIds.length) return undefined;
    const employees = employeeIds.map((id) => this.employees.get(id));
    const team = employees[0]?.team;
    if (!team || employees.some((employee) => !employee || employee.organizationId !== options.organizationId ||
      employee.status !== "active" || employee.team !== team || !this.canAccessTeam(options.scope, employee.team))) {
      return undefined;
    }
    const strategy = options.input.changes.strategy ?? rule.strategy;
    if (strategy === "fixed_owner" && employeeIds.length !== 1) return undefined;
    const currentTeam = this.leadAssignmentRuleTeams.get(rule.id);
    if (currentTeam !== team) {
      throw conflict("Assignment rule team is immutable; create a new rule for another team");
    }
    if (options.input.changes.name !== undefined) rule.name = options.input.changes.name.trim();
    if (options.input.changes.priority !== undefined) rule.priority = options.input.changes.priority;
    if (options.input.changes.active !== undefined) rule.active = options.input.changes.active;
    if (options.input.changes.conditions !== undefined) rule.conditions = clone(options.input.changes.conditions);
    rule.strategy = strategy;
    rule.employeeIds = [...employeeIds];
    rule.updatedByUserId = options.actorUserId;
    rule.updatedAt = options.at;
    rule.version += 1;
    this.leadAssignmentRuleTeams.set(rule.id, team);
    return clone(rule);
  }

  async dryRunLeadAssignmentRules(options: LeadAssignmentOperationOptions): Promise<LeadAssignmentDryRun> {
    const distribution = new Map<string, number>();
    const ruleCursors = new Map<string, number>();
    let matchedLeads = 0;
    let unmatchedLeads = 0;
    for (const lead of this.leads.values()) {
      if (lead.organizationId !== options.organizationId || lead.archivedAt || lead.assignedEmployeeId ||
        !this.canAccessLead(options.scope, lead)) continue;
      const rule = this.matchingRules(options.organizationId, options.scope, lead)[0];
      if (!rule) {
        unmatchedLeads += 1;
        continue;
      }
      matchedLeads += 1;
      const cursor = ruleCursors.get(rule.id) ?? this.leadAssignmentRuleCursors.get(rule.id) ?? 0;
      const index = rule.strategy === "fixed_owner" ? 0 : cursor % rule.employeeIds.length;
      const employeeId = rule.employeeIds[index] ?? rule.employeeIds[0];
      if (rule.strategy === "round_robin") ruleCursors.set(rule.id, cursor + 1);
      if (employeeId) distribution.set(employeeId, (distribution.get(employeeId) ?? 0) + 1);
    }
    return {
      matchedLeads,
      unmatchedLeads,
      distribution: [...distribution].map(([employeeId, leadCount]) => ({ employeeId, leadCount })),
    };
  }

  async applyLeadAssignmentRules(options: ApplyLeadAssignmentRulesOptions): Promise<ApplyLeadAssignmentRulesResult> {
    const key = `${options.organizationId}:${options.input.requestId}`;
    const prior = this.leadAssignmentApplyRequests.get(key);
    if (prior) {
      if (prior.fingerprint !== options.requestFingerprint) {
        throw conflict("The assignment request ID was already used with a different payload");
      }
      return clone({ ...prior.result, replayed: true });
    }
    const before = await this.dryRunLeadAssignmentRules(options);
    let appliedLeads = 0;
    const ruleCursors = new Map<string, number>();
    const advancedRuleIds = new Set<string>();
    if (options.input.includeExistingUnassigned) for (const lead of [...this.leads.values()]) {
      if (lead.organizationId !== options.organizationId || lead.archivedAt || lead.assignedEmployeeId ||
        !this.canAccessLead(options.scope, lead)) continue;
      const rule = this.matchingRules(options.organizationId, options.scope, lead)[0];
      if (!rule) continue;
      const cursor = ruleCursors.get(rule.id) ?? this.leadAssignmentRuleCursors.get(rule.id) ?? 0;
      const employeeId = rule.employeeIds[rule.strategy === "fixed_owner" ? 0 : cursor % rule.employeeIds.length];
      if (!employeeId) continue;
      const detail = await this.updateLead({
        organizationId: options.organizationId,
        scope: options.scope,
        leadId: lead.id,
        request: { expectedVersion: lead.version, changes: { assignedEmployeeId: employeeId } },
        actorUserId: options.actorUserId,
        canAssign: true,
        at: options.at,
      });
      if (detail) {
        appliedLeads += 1;
        if (rule.strategy === "round_robin") {
          ruleCursors.set(rule.id, cursor + 1);
          advancedRuleIds.add(rule.id);
        }
      }
    }
    for (const ruleId of advancedRuleIds) {
      const cursor = ruleCursors.get(ruleId);
      if (cursor === undefined) continue;
      this.leadAssignmentRuleCursors.set(ruleId, cursor);
      const rule = this.leadAssignmentRules.get(ruleId);
      if (rule) {
        rule.version += 1;
        rule.updatedByUserId = options.actorUserId;
        rule.updatedAt = options.at;
      }
    }
    const result = { ...before, requestId: options.input.requestId, replayed: false, appliedLeads };
    this.leadAssignmentApplyRequests.set(key, { fingerprint: options.requestFingerprint, result: clone(result) });
    return result;
  }

  async correctCallLeadLink(options: CorrectCallLeadLinkOptions): Promise<CorrectCallLeadLinkResult | undefined> {
    const key = `${options.organizationId}:${options.input.requestId}`;
    const prior = this.callLeadCorrectionRequests.get(key);
    if (prior) {
      if (prior.fingerprint !== options.requestFingerprint) {
        throw conflict("The correction request ID was already used with a different payload");
      }
      return clone({ ...prior.result, replayed: true });
    }
    const call = this.calls.get(options.callId);
    if (!call || call.organizationId !== options.organizationId) return undefined;
    const currentLeadId = this.leadIdByCallId.get(call.id) ?? null;
    if (currentLeadId !== options.input.expectedLeadId) throw conflict("The call link changed; refresh and retry");
    const currentLead = currentLeadId ? this.leads.get(currentLeadId) : undefined;
    const replacement = options.input.replacementLeadId ? this.leads.get(options.input.replacementLeadId) : undefined;
    if (currentLead && !this.canAccessLead(options.scope, currentLead)) return undefined;
    if (options.input.replacementLeadId && (!replacement || replacement.organizationId !== options.organizationId ||
      replacement.archivedAt || !this.canAccessLead(options.scope, replacement))) return undefined;
    const callTeam = this.employees.get(call.employeeId)?.team;
    if (replacement && this.leadTeams.get(replacement.id) !== callTeam) return undefined;
    if (currentLeadId) {
      this.leadIdByCallId.delete(call.id);
      const activityId = this.ids.next("lead_activity");
      this.leadActivities.set(activityId, {
        id: activityId,
        organizationId: options.organizationId,
        leadId: currentLeadId,
        kind: "call_unlinked",
        actorUserId: options.actorUserId,
        callLogId: call.id,
        occurredAt: options.at,
        summary: "Call link corrected",
        metadata: { reason: options.input.reason, requestId: options.input.requestId },
      });
    }
    if (replacement) {
      this.leadIdByCallId.set(call.id, replacement.id);
      const activityId = this.ids.next("lead_activity");
      this.leadActivities.set(activityId, {
        id: activityId,
        organizationId: options.organizationId,
        leadId: replacement.id,
        kind: "call_linked",
        actorUserId: options.actorUserId,
        callLogId: call.id,
        occurredAt: options.at,
        summary: "Call manually linked",
        metadata: { reason: options.input.reason, requestId: options.input.requestId, linkSource: "manual" },
      });
    }
    const result: CorrectCallLeadLinkResult = {
      requestId: options.input.requestId,
      callLogId: call.id,
      previousLeadId: currentLeadId,
      replacementLeadId: replacement?.id ?? null,
      correctedAt: options.at,
      replayed: false,
    };
    this.callLeadCorrectionRequests.set(key, { fingerprint: options.requestFingerprint, result: clone(result) });
    return result;
  }

  async applyMobileLeadUpdate(options: MobileLeadUpdateOptions): Promise<MobileLeadUpdateReceipt | undefined> {
    const key = `${options.context.organizationId}:${options.context.deviceId}:${options.input.requestId}`;
    const current = this.findCurrentMobileCredential(options.context, "session", options.at);
    if (!current || !this.isConsentCurrent(options.context.deviceId)) throw consentRequired();
    const prior = this.mobileLeadUpdateRequests.get(key);
    if (prior) {
      if (prior.fingerprint !== options.requestFingerprint || prior.leadId !== options.leadId) {
        throw conflict("The mobile update request ID was already used with a different payload");
      }
      return clone({
        requestId: prior.receipt.requestId,
        appliedLeadVersion: prior.receipt.appliedLeadVersion,
        replayed: true,
      });
    }
    const occurredAt = Date.parse(options.input.occurredAt);
    const receivedAt = Date.parse(options.at);
    if (occurredAt > receivedAt + 5 * 60 * 1_000 ||
      occurredAt < receivedAt - 7 * 24 * 60 * 60 * 1_000) {
      throw badRequest("occurredAt is outside the accepted offline update window", "occurredAt");
    }
    const lead = this.leads.get(options.leadId);
    if (!lead || lead.organizationId !== options.context.organizationId ||
      lead.archivedAt || lead.assignedEmployeeId !== options.context.employeeId) return undefined;
    if (lead.version !== options.input.expectedLeadVersion) throw conflict("The lead changed; refresh and retry");
    const employee = this.employees.get(options.context.employeeId);
    const actorUserId = employee?.linkedUserId;
    if (!actorUserId) return undefined;
    const status = options.input.statusId ? this.leadStatuses.get(options.input.statusId) : undefined;
    if (options.input.statusId && (!status || status.organizationId !== lead.organizationId || !status.isActive)) return undefined;
    if (options.input.followUp?.reminderAt &&
      Date.parse(options.input.followUp.reminderAt) > Date.parse(options.input.followUp.dueAt)) {
      throw badRequest("The follow-up reminder cannot be after its due time", "followUp.reminderAt");
    }
    if (status) {
      lead.statusId = status.id;
      if (status.isWon) lead.convertedAt = options.at;
      else delete lead.convertedAt;
      if (status.isLost) lead.lostAt = options.at;
      else delete lead.lostAt;
      const activityId = this.ids.next("lead_activity");
      this.leadActivities.set(activityId, {
        id: activityId, organizationId: lead.organizationId, leadId: lead.id,
        kind: "status_changed", actorEmployeeId: options.context.employeeId,
        occurredAt: options.input.occurredAt, summary: `Status changed to ${status.name}`,
        metadata: { requestId: options.input.requestId, deviceId: options.context.deviceId },
      });
    }
    if (options.input.note) {
      const noteId = this.ids.next("lead_note");
      this.leadNotes.set(noteId, {
        id: noteId, organizationId: lead.organizationId, leadId: lead.id,
        authorUserId: actorUserId, body: options.input.note.body, isPinned: false,
        createdAt: options.at, updatedAt: options.at, createdBy: actorUserId, updatedBy: actorUserId,
      });
      const activityId = this.ids.next("lead_activity");
      this.leadActivities.set(activityId, {
        id: activityId, organizationId: lead.organizationId, leadId: lead.id,
        kind: "note_added", actorEmployeeId: options.context.employeeId,
        occurredAt: options.input.occurredAt, summary: "Mobile note added",
        metadata: { requestId: options.input.requestId, deviceId: options.context.deviceId, noteId },
      });
    }
    if (options.input.followUp) {
      const followUpId = this.ids.next("follow_up");
      this.leadFollowUps.set(followUpId, {
        id: followUpId, organizationId: lead.organizationId, leadId: lead.id,
        assignedEmployeeId: options.context.employeeId, title: options.input.followUp.title,
        ...(options.input.followUp.notes === undefined ? {} : { notes: options.input.followUp.notes }),
        dueAt: options.input.followUp.dueAt,
        ...(options.input.followUp.reminderAt === undefined ? {} : { reminderAt: options.input.followUp.reminderAt }),
        priority: options.input.followUp.priority ?? "normal", status: "pending", version: 1,
        createdAt: options.at, updatedAt: options.at, createdBy: actorUserId, updatedBy: actorUserId,
      });
      if (!lead.nextFollowUpAt || options.input.followUp.dueAt < lead.nextFollowUpAt) {
        lead.nextFollowUpAt = options.input.followUp.dueAt;
      }
      const activityId = this.ids.next("lead_activity");
      this.leadActivities.set(activityId, {
        id: activityId, organizationId: lead.organizationId, leadId: lead.id,
        kind: "follow_up_created", actorEmployeeId: options.context.employeeId,
        occurredAt: options.input.occurredAt, summary: "Mobile follow-up scheduled",
        metadata: { requestId: options.input.requestId, deviceId: options.context.deviceId, followUpId },
      });
    }
    lead.version += 1;
    lead.updatedAt = options.at;
    lead.updatedBy = actorUserId;
    const receipt: MobileLeadUpdateReceipt = {
      requestId: options.input.requestId,
      replayed: false,
      appliedLeadVersion: lead.version,
      detail: clone(this.buildLeadDetail(lead, options.at)),
    };
    this.mobileLeadUpdateRequests.set(key, {
      fingerprint: options.requestFingerprint,
      leadId: options.leadId,
      receipt: {
        requestId: receipt.requestId,
        appliedLeadVersion: receipt.appliedLeadVersion,
      },
    });
    return receipt;
  }

  async getLeadReport(options: LeadReportOptions): Promise<LeadReport> {
    const cohort = [...this.leads.values()].filter((lead) => lead.organizationId === options.organizationId &&
      !lead.archivedAt && this.canAccessLead(options.scope, lead) &&
      lead.createdAt >= options.filter.from && lead.createdAt < options.filter.to &&
      (!options.filter.employeeId || lead.assignedEmployeeId === options.filter.employeeId) &&
      (!options.filter.team || this.leadTeams.get(lead.id) === options.filter.team) &&
      (!options.filter.source || lead.source === options.filter.source));
    const total = cohort.length;
    const percentage = (value: number): number => total === 0 ? 0 : Math.round(value * 10_000 / total) / 100;
    const responseSeconds = new Map(cohort.map((lead) => [lead.id, this.firstLeadResponseSeconds(lead)]));
    const averageResponse = (leads: Lead[]): number | undefined => {
      const values = leads.map((lead) => responseSeconds.get(lead.id))
        .filter((value): value is number => value !== undefined);
      return values.length === 0
        ? undefined
        : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    };
    const converted = cohort.filter((lead) => Boolean(lead.convertedAt)).length;
    const pipeline = [...this.leadStatuses.values()]
      .filter((status) => status.organizationId === options.organizationId && status.isActive)
      .sort((left, right) => left.position - right.position)
      .map((status) => {
        const leadCount = cohort.filter((lead) => lead.statusId === status.id).length;
        return { statusId: status.id, statusName: status.name, color: status.color, leadCount,
          percentageOfTotal: percentage(leadCount), isWon: status.isWon, isLost: status.isLost };
      });
    const employeeIds = new Set(cohort.map((lead) => lead.assignedEmployeeId).filter((id): id is string => Boolean(id)));
    const ownerIds: Array<string | null> = [null, ...employeeIds];
    const owners = ownerIds.map((employeeId) => {
      const leads = cohort.filter((lead) => (lead.assignedEmployeeId ?? null) === employeeId);
      const won = leads.filter((lead) => Boolean(lead.convertedAt)).length;
      const employee = employeeId ? this.employees.get(employeeId) : undefined;
      const ownerAverageResponse = averageResponse(leads);
      return {
        employeeId,
        displayName: employee?.displayName ?? "Unassigned",
        assigned: leads.length,
        contacted: leads.filter((lead) => Boolean(lead.lastContactedAt)).length,
        won,
        conversionRate: leads.length === 0 ? 0 : Math.round(won * 10_000 / leads.length) / 100,
        overdueFollowUps: leads.reduce((sum, lead) => sum + this.buildLeadListItem(lead, options.at).overdueFollowUpCount, 0),
        ...(ownerAverageResponse === undefined ? {} : { averageResponseSeconds: ownerAverageResponse }),
      };
    });
    const sourceValues = [...new Set(cohort.map((lead) => lead.source))];
    const sources = sourceValues.map((source) => {
      const leads = cohort.filter((lead) => lead.source === source);
      const won = leads.filter((lead) => Boolean(lead.convertedAt)).length;
      return { source, leads: leads.length, contacted: leads.filter((lead) => Boolean(lead.lastContactedAt)).length,
        qualified: leads.filter((lead) => this.statusForLead(lead).name.toLocaleLowerCase() === "qualified").length,
        won, conversionRate: leads.length === 0 ? 0 : Math.round(won * 10_000 / leads.length) / 100,
        percentageOfTotal: percentage(leads.length) };
    });
    const buckets = new Map<string, { created: number; won: number }>();
    for (const lead of cohort) {
      const day = zonedDateKey(lead.createdAt, options.timeZone);
      const bucket = buckets.get(day) ?? { created: 0, won: 0 };
      bucket.created += 1;
      if (lead.convertedAt) bucket.won += 1;
      buckets.set(day, bucket);
    }
    const cohortAverageResponse = averageResponse(cohort);
    return {
      filter: clone(options.filter),
      kpis: {
        totalLeads: total,
        convertedLeads: converted,
        conversionRate: percentage(converted),
        followUpsDue: cohort.reduce((sum, lead) => sum + this.followUpsForLead(options.organizationId, lead.id)
          .filter((followUp) => followUp.status === "pending" && followUp.dueAt <= options.at).length, 0),
        ...(cohortAverageResponse === undefined
          ? {}
          : { averageFirstResponseSeconds: cohortAverageResponse }),
      },
      pipeline,
      trend: [...buckets].sort(([left], [right]) => left.localeCompare(right)).map(([day, values]) => ({
        bucketStart: zonedMidnightIso(day, options.timeZone), ...values,
      })),
      owners,
      sources,
      generatedAt: options.at,
      timeZone: options.timeZone,
      metricDefinitionVersion: "2026-07-15",
    };
  }

  async getReportAutomation(organizationId: OrganizationId, userId: string): Promise<ReportAutomationSnapshot> {
    const preferences = this.notificationPreferences.get(`${organizationId}:${userId}`) ?? [
      "missed_call", "overdue_follow_up", "device_offline", "import_completed", "export_ready",
    ].map((event) => ({ event: event as NotificationPreference["event"], email: true, inApp: true }));
    return {
      savedViews: clone([...this.savedReportViews.values()].filter((item) => item.organizationId === organizationId && item.ownerUserId === userId)),
      schedules: clone([...this.reportSchedules.values()].filter((item) => item.organizationId === organizationId)),
      preferences: clone(preferences),
      jobs: clone([...this.reportExportJobs.values()].filter((item) => item.id.startsWith(`${organizationId}:`)).map((item) => ({ ...item, id: item.id.split(":").slice(1).join(":") }))),
    };
  }

  async createSavedReportView(options: { organizationId: OrganizationId; userId: string; name: string; kind: SavedReportView["kind"]; filters: SavedReportView["filters"]; at: string }): Promise<SavedReportView> {
    const view: SavedReportView = { id: this.ids.next("report_view"), organizationId: options.organizationId, ownerUserId: options.userId, name: options.name, kind: options.kind, filters: clone(options.filters), createdAt: options.at, updatedAt: options.at };
    this.savedReportViews.set(view.id, view);
    return clone(view);
  }

  async createReportSchedule(options: { organizationId: OrganizationId; userId: string; savedViewId: string; name: string; cadence: ReportSchedule["cadence"]; weekDay?: number; localTime: string; timeZone: string; format: ReportSchedule["format"]; recipients: string[]; nextRunAt: string; at: string }): Promise<ReportSchedule | undefined> {
    const view = this.savedReportViews.get(options.savedViewId);
    if (!view || view.organizationId !== options.organizationId) return undefined;
    const schedule: ReportSchedule = { id: this.ids.next("report_schedule"), organizationId: options.organizationId, savedViewId: options.savedViewId, name: options.name, cadence: options.cadence, ...(options.weekDay === undefined ? {} : { weekDay: options.weekDay }), localTime: options.localTime, timeZone: options.timeZone, format: options.format, recipients: [...options.recipients], status: "active", nextRunAt: options.nextRunAt };
    this.reportSchedules.set(schedule.id, schedule);
    return clone(schedule);
  }

  async updateReportSchedule(options: { organizationId: OrganizationId; scheduleId: string; status: ReportSchedule["status"]; at: string }): Promise<ReportSchedule | undefined> {
    const schedule = this.reportSchedules.get(options.scheduleId);
    if (!schedule || schedule.organizationId !== options.organizationId) return undefined;
    schedule.status = options.status;
    return clone(schedule);
  }

  async updateNotificationPreferences(options: { organizationId: OrganizationId; userId: string; preferences: NotificationPreference[]; at: string }): Promise<NotificationPreference[]> {
    this.notificationPreferences.set(`${options.organizationId}:${options.userId}`, clone(options.preferences));
    return clone(options.preferences);
  }

  async createReportExportJob(options: { organizationId: OrganizationId; userId: string; kind: ReportExportJob["kind"]; format: ReportExportJob["format"]; parameters: Record<string, unknown>; at: string }): Promise<ReportExportJob> {
    const publicId = this.ids.next("report_export");
    const job: ReportExportJob = { id: `${options.organizationId}:${publicId}`, kind: options.kind, format: options.format, status: "queued", requestedAt: options.at };
    this.reportExportJobs.set(job.id, job);
    return { ...clone(job), id: publicId };
  }

  async completeReportExportJob(options: { organizationId: OrganizationId; jobId: string; objectKey: string; tokenHash: Uint8Array; expiresAt: string; at: string }): Promise<boolean> {
    const key=`${options.organizationId}:${options.jobId}`; const job=this.reportExportJobs.get(key); if(!job||job.status!=="queued"&&job.status!=="processing")return false; job.status="ready"; job.completedAt=options.at; job.expiresAt=options.expiresAt; this.reportArtifacts.set(key,{objectKey:options.objectKey,tokenHash:new Uint8Array(options.tokenHash),expiresAt:options.expiresAt}); return true;
  }

  async redeemReportDownload(options: { organizationId: OrganizationId; userId: string; jobId: string; tokenHash: Uint8Array; redemptionId: string; at: string }): Promise<{ objectKey: string; expiresAt: string } | undefined> {
    const artifact=this.reportArtifacts.get(`${options.organizationId}:${options.jobId}`); if(!artifact||artifact.redeemedAt||artifact.expiresAt<=options.at||artifact.tokenHash.length!==options.tokenHash.length)return undefined; let difference=0; for(let i=0;i<artifact.tokenHash.length;i+=1)difference|=artifact.tokenHash[i]!^options.tokenHash[i]!; if(difference!==0)return undefined; artifact.redeemedAt=options.at; return {objectKey:artifact.objectKey,expiresAt:artifact.expiresAt};
  }

  async listNotificationInbox(organizationId: OrganizationId, userId: string, limit: number): Promise<NotificationInbox> {
    const all=[...this.inAppNotifications.values()].filter((item)=>item.organizationId===organizationId&&item.userId===userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); return {items:clone(all.slice(0,limit).map(({organizationId:_o,userId:_u,...item})=>item)),unreadCount:all.filter((item)=>!item.readAt).length};
  }

  async markNotificationRead(options: { organizationId: OrganizationId; userId: string; notificationId: string; at: string }): Promise<InAppNotification | undefined> {
    const item=this.inAppNotifications.get(options.notificationId); if(!item||item.organizationId!==options.organizationId||item.userId!==options.userId)return undefined; item.readAt??=options.at; const {organizationId:_o,userId:_u,...notification}=item; return clone(notification);
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
        this.linkCallToUniqueLead(call, options.at);
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
      this.linkCallToUniqueLead(call, options.at);
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
    this.linkCallToUniqueLead(call, options.at);
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
