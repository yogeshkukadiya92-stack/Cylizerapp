import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type preHandlerHookHandler,
} from "fastify";
import cors from "@fastify/cors";
import {
  isAdminDeviceRevocationInput,
  isCallDirection,
  isCallDisposition,
  isCallLogSyncBatch,
  isDeviceHeartbeat,
  isFollowUpPriority,
  isIsoDateTime,
  isLeadQueueKey,
  isLeadReportFilter,
  isLeadSource,
  isApplyLeadAssignmentRulesInput,
  isCommitLeadImportInput,
  isCorrectCallLeadLinkInput,
  isCreateLeadAssignmentRuleInput,
  isMobileLeadUpdateInput,
  isPreviewLeadImportInput,
  isUpdateLeadAssignmentRuleInput,
  isMobileActivationInput,
  isMobileCollectionMode,
  isMobileReconsentInput,
  isMobileSessionRevocationInput,
  isMobileSessionRotationConfirmInput,
  isMobileSessionRotationPrepareInput,
  isMobilePlatform,
  isNonEmptyString,
  isRecord,
  isRequestId,
  isProposedDeviceCredential,
  type CallLog,
  type CompleteFollowUpInput,
  type CreateEmployeeInput,
  type CreateFollowUpInput,
  type CreateLeadInput,
  type CreateLeadNoteInput,
  type DevicePermissionState,
  type DevicePermissions,
  type Employee,
  type EmployeeStatus,
  type JsonValue,
  type LeadImportPreview,
  type LeadReportFilter,
  type LeadTemperature,
  type Permission,
  type SystemRoleKey,
  type UpdateLeadInput,
  type UpdateLeadRequest,
} from "@callora/contracts";
import { buildDashboardOverview, type DashboardPreset, type DashboardQuery } from "./analytics.js";
import {
  OidcBearerVerificationError,
  type OidcBearerVerifier,
} from "./auth/index.js";
import { loadConfig, type ApiConfig } from "./config.js";
import type {
  ActorContext,
  AuditEvent,
  DeviceRegistration,
  MobileDeviceContext,
  SimulatedCallInput,
} from "./domain.js";
import { ApiDomainError, badRequest, conflict, consentRequired, forbidden, notFound, unauthenticated } from "./errors.js";
import {
  createDevelopmentRepository,
  type CalloraRepository,
  type IdGenerator,
  type PairingCodeGenerator,
  RandomIdGenerator,
  SecurePairingCodeGenerator,
  SequentialIdGenerator,
} from "./repository.js";
import {
  AccessTokenService,
  type Clock,
  CursorCodec,
  fingerprint,
  fingerprintLeadImport,
  fingerprintMobileCallBatch,
  fingerprintMobileLeadUpdate,
  hashDeviceCredential,
  hashPairingCode,
  hashPairingRateLimitDimension,
  isOpaqueDeviceCredential,
  PairingAttemptLimiter,
  type SharedAttemptLimiter,
  SystemClock,
} from "./security.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: ActorContext | null;
    mobileDevice: MobileDeviceContext | null;
  }
}

export interface BuildAppOptions {
  config?: ApiConfig;
  repository?: CalloraRepository;
  clock?: Clock;
  idGenerator?: IdGenerator;
  pairingCodeGenerator?: PairingCodeGenerator;
  oidcVerifier?: OidcBearerVerifier;
  pairingLimiter?: SharedAttemptLimiter;
  logger?: boolean;
}

function success<T>(request: FastifyRequest, data: T): { ok: true; data: T; requestId: string } {
  return { ok: true, data, requestId: request.id };
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  if (!isRecord(request.body)) throw badRequest("Request body must be a JSON object");
  return request.body;
}

function queryRecord(request: FastifyRequest): Record<string, unknown> {
  return isRecord(request.query) ? request.query : {};
}

function requiredString(value: unknown, field: string, maximumLength = 255): string {
  if (!isNonEmptyString(value)) throw badRequest(`${field} is required`, field);
  const normalized = value.trim();
  if (normalized.length > maximumLength) throw badRequest(`${field} must not exceed ${maximumLength} characters`, field);
  return normalized;
}

function optionalString(value: unknown, field: string, maximumLength = 255): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maximumLength);
}

function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw badRequest(`${field} must be supplied once`, field);
  return requiredString(value, field);
}

function integerQuery(value: unknown, field: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const stringValue = optionalQueryString(value, field);
  const parsed = Number(stringValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw badRequest(`${field} must be an integer between 1 and ${maximum}`, field);
  }
  return parsed;
}

function currentActor(request: FastifyRequest): ActorContext {
  if (!request.actor) throw unauthenticated();
  return request.actor;
}

function currentMobileDevice(request: FastifyRequest): MobileDeviceContext {
  if (!request.mobileDevice) throw unauthenticated("The device credential is invalid");
  return request.mobileDevice;
}

function parseBearerToken(header: string | undefined): string {
  if (!header) throw unauthenticated();
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match?.[1]) throw unauthenticated("Authorization must use a Bearer token");
  return match[1];
}

function asRole(value: unknown): SystemRoleKey {
  if (["owner", "admin", "manager", "analyst", "employee"].includes(value as string)) {
    return value as SystemRoleKey;
  }
  throw badRequest("role must be a supported system role", "role");
}

function asEmployeeStatus(value: unknown): EmployeeStatus | undefined {
  if (value === undefined) return undefined;
  if (["invited", "active", "paused", "deactivated"].includes(value as string)) return value as EmployeeStatus;
  throw badRequest("status is invalid", "status");
}

function asTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    !isIsoDateTime(value) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw badRequest(`${field} must be an RFC 3339 timestamp with an explicit Z or UTC offset`, field);
  }
  return new Date(value).toISOString();
}

function parseCreateEmployeeInput(body: Record<string, unknown>): CreateEmployeeInput {
  const displayName = requiredString(body.displayName, "displayName", 120);
  const email = optionalString(body.email, "email", 254)?.toLocaleLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("email is invalid", "email");
  const primaryPhone = optionalString(body.primaryPhone, "primaryPhone", 20);
  if (primaryPhone && !/^\+[1-9]\d{7,14}$/.test(primaryPhone)) throw badRequest("primaryPhone must be in E.164 format", "primaryPhone");
  const managerEmployeeId = optionalString(body.managerEmployeeId, "managerEmployeeId", 100);
  return {
    displayName,
    ...(email === undefined ? {} : { email }),
    ...(primaryPhone === undefined ? {} : { primaryPhone }),
    ...(optionalString(body.employeeCode, "employeeCode", 50) === undefined ? {} : { employeeCode: optionalString(body.employeeCode, "employeeCode", 50) as string }),
    ...(optionalString(body.jobTitle, "jobTitle", 100) === undefined ? {} : { jobTitle: optionalString(body.jobTitle, "jobTitle", 100) as string }),
    ...(optionalString(body.team, "team", 100) === undefined ? {} : { team: optionalString(body.team, "team", 100) as string }),
    ...(managerEmployeeId === undefined ? {} : { managerEmployeeId }),
  };
}

function nullableOptionalString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredString(value, field, maximumLength);
}

function e164Phone(value: unknown, field: string): string {
  const phoneNumber = requiredString(value, field, 20);
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw badRequest(`${field} must be in E.164 format`, field);
  }
  return phoneNumber;
}

function optionalEmail(value: unknown, field: string): string | undefined {
  const email = optionalString(value, field, 320)?.toLocaleLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest(`${field} is invalid`, field);
  }
  return email;
}

function nullableOptionalEmail(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return optionalEmail(value, field);
}

function leadTemperature(value: unknown, field: string): LeadTemperature | undefined {
  if (value === undefined) return undefined;
  if (["cold", "warm", "hot"].includes(value as string)) return value as LeadTemperature;
  throw badRequest(`${field} must be cold, warm, or hot`, field);
}

function leadTagIds(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) {
    throw badRequest(`${field} must be an array containing at most 50 IDs`, field);
  }
  const tags = value.map((tag, index) => requiredString(tag, `${field}.${index}`, 100));
  if (new Set(tags).size !== tags.length) throw badRequest(`${field} must not contain duplicates`, field);
  return tags;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 8) return false;
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 100 &&
    Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function leadCustomFields(value: unknown, field: string): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 100 ||
    Object.keys(value).some((key) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) ||
    !Object.values(value).every((item) => isJsonValue(item))) {
    throw badRequest(`${field} must be a JSON object with valid field keys and values`, field);
  }
  if (JSON.stringify(value).length > 65_536) throw badRequest(`${field} is too large`, field);
  return value as Record<string, JsonValue>;
}

function parseCreateLeadInput(body: Record<string, unknown>): CreateLeadInput {
  const lastName = optionalString(body.lastName, "lastName", 200);
  const companyName = optionalString(body.companyName, "companyName", 300);
  const alternatePhoneNumber = body.alternatePhoneNumber === undefined
    ? undefined
    : e164Phone(body.alternatePhoneNumber, "alternatePhoneNumber");
  const email = optionalEmail(body.email, "email");
  const source = body.source ?? "manual";
  if (!isLeadSource(source)) throw badRequest("source is invalid", "source");
  const sourceReference = optionalString(body.sourceReference, "sourceReference", 255);
  const statusId = optionalString(body.statusId, "statusId", 100);
  const temperature = leadTemperature(body.temperature, "temperature");
  const assignedEmployeeId = optionalString(body.assignedEmployeeId, "assignedEmployeeId", 100);
  const tagIds = leadTagIds(body.tagIds, "tagIds");
  const customFields = leadCustomFields(body.customFields, "customFields");
  return {
    firstName: requiredString(body.firstName, "firstName", 200),
    phoneNumber: e164Phone(body.phoneNumber, "phoneNumber"),
    source,
    ...(lastName === undefined ? {} : { lastName }),
    ...(companyName === undefined ? {} : { companyName }),
    ...(alternatePhoneNumber === undefined ? {} : { alternatePhoneNumber }),
    ...(email === undefined ? {} : { email }),
    ...(sourceReference === undefined ? {} : { sourceReference }),
    ...(statusId === undefined ? {} : { statusId }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(assignedEmployeeId === undefined ? {} : { assignedEmployeeId }),
    ...(tagIds === undefined ? {} : { tagIds }),
    ...(customFields === undefined ? {} : { customFields }),
  };
}

function parseUpdateLeadRequest(body: Record<string, unknown>): UpdateLeadRequest {
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
    throw badRequest("expectedVersion must be a positive integer", "expectedVersion");
  }
  if (!isRecord(body.changes) || Object.keys(body.changes).length === 0) {
    throw badRequest("changes must contain at least one lead update", "changes");
  }
  const allowed = new Set([
    "firstName", "lastName", "companyName", "phoneNumber", "alternatePhoneNumber", "email",
    "statusId", "temperature", "assignedEmployeeId", "tagIds", "customFields", "archived",
  ]);
  const unknown = Object.keys(body.changes).find((key) => !allowed.has(key));
  if (unknown) throw badRequest(`changes.${unknown} is not supported`, `changes.${unknown}`);
  const value = body.changes;
  const changes: UpdateLeadInput = {};
  if (value.firstName !== undefined) changes.firstName = requiredString(value.firstName, "changes.firstName", 200);
  const lastName = nullableOptionalString(value.lastName, "changes.lastName", 200);
  if (lastName !== undefined) changes.lastName = lastName;
  const companyName = nullableOptionalString(value.companyName, "changes.companyName", 300);
  if (companyName !== undefined) changes.companyName = companyName;
  if (value.phoneNumber !== undefined) changes.phoneNumber = e164Phone(value.phoneNumber, "changes.phoneNumber");
  if (value.alternatePhoneNumber !== undefined) {
    changes.alternatePhoneNumber = value.alternatePhoneNumber === null
      ? null
      : e164Phone(value.alternatePhoneNumber, "changes.alternatePhoneNumber");
  }
  const email = nullableOptionalEmail(value.email, "changes.email");
  if (email !== undefined) changes.email = email;
  if (value.statusId !== undefined) changes.statusId = requiredString(value.statusId, "changes.statusId", 100);
  if (value.temperature !== undefined) {
    changes.temperature = value.temperature === null
      ? null
      : leadTemperature(value.temperature, "changes.temperature") as LeadTemperature;
  }
  if (value.assignedEmployeeId !== undefined) {
    changes.assignedEmployeeId = value.assignedEmployeeId === null
      ? null
      : requiredString(value.assignedEmployeeId, "changes.assignedEmployeeId", 100);
  }
  const tagIds = leadTagIds(value.tagIds, "changes.tagIds");
  if (tagIds !== undefined) changes.tagIds = tagIds;
  const customFields = leadCustomFields(value.customFields, "changes.customFields");
  if (customFields !== undefined) changes.customFields = customFields;
  if (value.archived !== undefined) {
    if (typeof value.archived !== "boolean") throw badRequest("changes.archived must be a boolean", "changes.archived");
    changes.archived = value.archived;
  }
  return { expectedVersion: body.expectedVersion as number, changes };
}

function parseCreateLeadNoteInput(body: Record<string, unknown>): CreateLeadNoteInput {
  if (body.isPinned !== undefined && typeof body.isPinned !== "boolean") {
    throw badRequest("isPinned must be a boolean", "isPinned");
  }
  return {
    body: requiredString(body.body, "body", 10_000),
    ...(body.isPinned === undefined ? {} : { isPinned: body.isPinned }),
  };
}

function parseCreateFollowUpInput(body: Record<string, unknown>): CreateFollowUpInput {
  const dueAt = asTimestamp(body.dueAt, "dueAt");
  if (!dueAt) throw badRequest("dueAt is required", "dueAt");
  const reminderAt = asTimestamp(body.reminderAt, "reminderAt");
  if (reminderAt && reminderAt > dueAt) throw badRequest("reminderAt cannot be after dueAt", "reminderAt");
  const priority = body.priority ?? "normal";
  if (!isFollowUpPriority(priority)) throw badRequest("priority is invalid", "priority");
  const notes = optionalString(body.notes, "notes", 10_000);
  return {
    leadId: requiredString(body.leadId, "leadId", 100),
    assignedEmployeeId: requiredString(body.assignedEmployeeId, "assignedEmployeeId", 100),
    title: requiredString(body.title, "title", 300),
    dueAt,
    priority,
    ...(notes === undefined ? {} : { notes }),
    ...(reminderAt === undefined ? {} : { reminderAt }),
  };
}

function parseCompleteFollowUpInput(body: Record<string, unknown>): CompleteFollowUpInput {
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
    throw badRequest("expectedVersion must be a positive integer", "expectedVersion");
  }
  const completionNote = optionalString(body.completionNote, "completionNote", 10_000);
  const completedAt = asTimestamp(body.completedAt, "completedAt");
  return {
    expectedVersion: body.expectedVersion as number,
    ...(completionNote === undefined ? {} : { completionNote }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

const PERMISSION_STATES: readonly DevicePermissionState[] = ["unknown", "granted", "denied", "restricted"];

function parsePermissions(value: unknown): DevicePermissions {
  if (!isRecord(value)) throw badRequest("permissions must be an object", "permissions");
  const permission = (key: keyof DevicePermissions): DevicePermissionState => {
    const candidate = value[key];
    if (!PERMISSION_STATES.includes(candidate as DevicePermissionState)) {
      throw badRequest(`permissions.${key} is invalid`, `permissions.${key}`);
    }
    return candidate as DevicePermissionState;
  };
  return {
    callLog: permission("callLog"),
    phoneState: permission("phoneState"),
    contacts: permission("contacts"),
    notifications: permission("notifications"),
    recordingFiles: permission("recordingFiles"),
    backgroundExecution: permission("backgroundExecution"),
  };
}

function parseDeviceRegistration(body: Record<string, unknown>): DeviceRegistration {
  if (!isMobilePlatform(body.platform)) throw badRequest("platform must be android or ios", "platform");
  const manufacturer = optionalString(body.manufacturer, "manufacturer", 100);
  const model = optionalString(body.model, "model", 100);
  const collectionMode = body.collectionMode ?? "android_call_log";
  if (!isMobileCollectionMode(collectionMode)) {
    throw badRequest("collectionMode must be android_call_log or synthetic_demo", "collectionMode");
  }
  return {
    installationId: requiredString(body.installationId, "installationId", 160),
    platform: body.platform,
    osVersion: requiredString(body.osVersion, "osVersion", 50),
    appVersion: requiredString(body.appVersion, "appVersion", 50),
    collectionMode,
    permissions: parsePermissions(body.permissions),
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(model === undefined ? {} : { model }),
  };
}

function nonNegativeInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw badRequest(`${field} must be a non-negative integer no greater than ${maximum}`, field);
  }
  return value as number;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw badRequest(`${field} must be a boolean`, field);
  return value;
}

function maskPhoneNumber(phoneNumber: string): string {
  return `•••• ${phoneNumber.replace(/\D/g, "").slice(-4)}`;
}

function presentCalls(actor: ActorContext, calls: CallLog[]): CallLog[] {
  if (actor.roleKey !== "analyst" || !actor.organization.settings.maskPhoneNumbersForRestrictedUsers) {
    return calls;
  }
  return calls.map((call) => ({
    ...call,
    participant: {
      ...call.participant,
      phoneNumber: maskPhoneNumber(call.participant.phoneNumber),
    },
  }));
}

function presentEmployees(actor: ActorContext, employees: Employee[]): Employee[] {
  if (actor.roleKey !== "analyst" || !actor.organization.settings.maskPhoneNumbersForRestrictedUsers) {
    return employees;
  }
  return employees.map((employee) => ({
    ...employee,
    ...(employee.primaryPhone === undefined ? {} : { primaryPhone: maskPhoneNumber(employee.primaryPhone) }),
  }));
}

function parseSimulatedCall(body: Record<string, unknown>): SimulatedCallInput {
  if (!isCallDirection(body.direction)) throw badRequest("direction is invalid", "direction");
  if (!isCallDisposition(body.disposition)) throw badRequest("disposition is invalid", "disposition");
  const startedAt = asTimestamp(body.startedAt, "startedAt");
  if (!startedAt) throw badRequest("startedAt is required", "startedAt");
  const answeredAt = asTimestamp(body.answeredAt, "answeredAt");
  const endedAt = asTimestamp(body.endedAt, "endedAt");
  if (answeredAt && answeredAt < startedAt) throw badRequest("answeredAt cannot precede startedAt", "answeredAt");
  if (endedAt && endedAt < (answeredAt ?? startedAt)) throw badRequest("endedAt cannot precede the call start or answer", "endedAt");
  const phoneNumber = requiredString(body.phoneNumber, "phoneNumber", 20);
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw badRequest("phoneNumber must be in E.164 format", "phoneNumber");
  const displayName = optionalString(body.displayName, "displayName", 160);
  const deviceId = optionalString(body.deviceId, "deviceId", 100);
  const ringDurationSeconds = body.ringDurationSeconds === undefined
    ? undefined
    : nonNegativeInteger(body.ringDurationSeconds, "ringDurationSeconds", 86_400);
  return {
    externalId: requiredString(body.externalId, "externalId", 160),
    employeeId: requiredString(body.employeeId, "employeeId", 100),
    direction: body.direction,
    disposition: body.disposition,
    phoneNumber,
    startedAt,
    durationSeconds: nonNegativeInteger(body.durationSeconds, "durationSeconds", 7 * 86_400),
    isInternal: requiredBoolean(body.isInternal, "isInternal"),
    isWithinWorkingHours: requiredBoolean(body.isWithinWorkingHours, "isWithinWorkingHours"),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(answeredAt === undefined ? {} : { answeredAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(ringDurationSeconds === undefined ? {} : { ringDurationSeconds }),
  };
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (Array.isArray(value) || !value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw badRequest("Idempotency-Key must contain 8-128 safe characters", "Idempotency-Key");
  }
  return value;
}

function operationRequest(request: FastifyRequest, body: unknown): {
  requestId: string;
  requestFingerprint: string;
} {
  if (!isRecord(body) || !isRequestId(body.requestId)) throw badRequest("requestId must be a UUID", "requestId");
  const key = idempotencyKey(request);
  if (key !== body.requestId) {
    throw badRequest("Idempotency-Key must exactly match requestId", "Idempotency-Key");
  }
  return { requestId: body.requestId, requestFingerprint: fingerprint(body) };
}

function leadImportErrorCsv(preview: LeadImportPreview): string {
  const cell = (value: string | number): string => {
    let text = String(value).replace(/\r?\n/g, " ");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows: Array<Array<string | number>> = [["rowNumber", "decision", "field", "code", "message"]];
  for (const row of preview.rows) {
    for (const issue of row.issues) {
      rows.push([row.rowNumber, row.decision, issue.field, issue.code, issue.message]);
    }
  }
  return `${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  if (config.environment === "production" && options.repository === undefined) {
    throw new Error("A durable production CalloraRepository must be provided in production");
  }
  if (config.environment === "production" && options.oidcVerifier === undefined) {
    throw new Error("A production OIDC bearer verifier must be provided in production");
  }
  if (config.environment === "production" &&
    (options.pairingLimiter === undefined || !options.pairingLimiter.isReplicaSafe)) {
    throw new Error("A replica-safe shared pairing limiter must be provided in production");
  }
  const repository: CalloraRepository = options.repository ?? createDevelopmentRepository();
  const clock = options.clock ?? new SystemClock();
  const ids = options.idGenerator ?? (config.environment === "production" ? new RandomIdGenerator() : new SequentialIdGenerator());
  const codeGenerator = options.pairingCodeGenerator ?? new SecurePairingCodeGenerator();
  const oidcVerifier = options.oidcVerifier;
  const tokens = new AccessTokenService(config.authSecret, clock, config.tokenTtlSeconds);
  const cursors = new CursorCodec(config.authSecret);
  const pairingLimiter = options.pairingLimiter ??
    new PairingAttemptLimiter(clock, config.pairingAttemptLimit, config.pairingAttemptWindowSeconds);
  const app = Fastify({
    logger: options.logger ?? config.environment === "production",
    bodyLimit: 512 * 1_024,
    requestIdHeader: "x-request-id",
    trustProxy: config.trustedProxyCidrs.length === 0 ? false : config.trustedProxyCidrs,
  });
  app.decorateRequest("actor", null);
  app.decorateRequest("mobileDevice", null);
  void app.register(cors, {
    origin(origin, callback) {
      if (origin === undefined || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id"],
    maxAge: 600,
    strictPreflight: true,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("cache-control", "no-store");
    return payload;
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      ok: false,
      error: { code: "NOT_FOUND", message: "Route not found", requestId: request.id },
      requestId: request.id,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiDomainError) {
      if (error.retryAfterSeconds !== undefined) void reply.header("retry-after", String(error.retryAfterSeconds));
      return reply.status(error.statusCode).send({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details === undefined ? {} : { details: error.details }),
          ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
        },
        requestId: request.id,
      });
    }
    if (isRecord(error) && error.statusCode === 413) {
      return reply.status(413).send({
        ok: false,
        error: { code: "VALIDATION_FAILED", message: "Request body exceeds the 512KiB limit", requestId: request.id },
        requestId: request.id,
      });
    }
    request.log.error({ err: error }, "Unhandled API error");
    return reply.status(500).send({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId: request.id },
      requestId: request.id,
    });
  });

  const authenticate: preHandlerHookHandler = async (request) => {
    const token = parseBearerToken(request.headers.authorization);
    let actor: ActorContext | undefined;

    if (config.environment === "production") {
      let identity;
      try {
        identity = await (oidcVerifier as OidcBearerVerifier).verify(token);
      } catch (error) {
        request.log.warn(
          error instanceof OidcBearerVerificationError
            ? { reason: error.reason }
            : { errorType: error instanceof Error ? error.name : typeof error },
          "OIDC bearer token rejected",
        );
        throw unauthenticated("The bearer token is invalid");
      }
      actor = await repository.resolveActorByExternalIdentity(identity);
    } else {
      const payload = tokens.verify(token);
      actor = await repository.findActor(payload.organizationId, payload.subject);
    }

    if (!actor) {
      throw unauthenticated(
        config.environment === "production"
          ? "The bearer token is invalid"
          : "The authenticated membership is no longer active",
      );
    }
    request.actor = actor;
  };
  const requirePermission = (permission: Permission): preHandlerHookHandler => async (request) => {
    const actor = currentActor(request);
    if (!actor.permissions.includes(permission)) throw forbidden();
  };
  const authenticateMobile = (credentialType: "bootstrap" | "session"): preHandlerHookHandler => async (request) => {
    let token: string;
    try {
      token = parseBearerToken(request.headers.authorization);
    } catch {
      throw unauthenticated("The device credential is invalid");
    }
    if (!isOpaqueDeviceCredential(token, credentialType)) {
      throw unauthenticated("The device credential is invalid");
    }
    const context = await repository.resolveDeviceCredential({
      tokenHash: hashDeviceCredential(token, config.authSecret, credentialType),
      credentialType,
      at: clock.now().toISOString(),
    });
    if (!context) throw unauthenticated("The device credential is invalid");
    request.mobileDevice = context;
  };
  const authenticateMobileEither: preHandlerHookHandler = async (request) => {
    let token: string;
    try {
      token = parseBearerToken(request.headers.authorization);
    } catch {
      throw unauthenticated("The device credential is invalid");
    }
    const credentialType = isOpaqueDeviceCredential(token, "bootstrap")
      ? "bootstrap"
      : isOpaqueDeviceCredential(token, "session") ? "session" : undefined;
    if (!credentialType) throw unauthenticated("The device credential is invalid");
    const context = await repository.resolveDeviceCredential({
      tokenHash: hashDeviceCredential(token, config.authSecret, credentialType),
      credentialType,
      at: clock.now().toISOString(),
    });
    if (!context) throw unauthenticated("The device credential is invalid");
    request.mobileDevice = context;
  };
  const authenticateMobileWithReplay = (
    credentialType: "bootstrap" | "session",
    operation: "activate" | "rotation_prepare" | "rotation_confirm" | "reconsent" | "revoke",
  ): preHandlerHookHandler => async (request) => {
    let token: string;
    try {
      token = parseBearerToken(request.headers.authorization);
    } catch {
      throw unauthenticated("The device credential is invalid");
    }
    if (!isOpaqueDeviceCredential(token, credentialType) || !isRecord(request.body)) {
      throw unauthenticated("The device credential is invalid");
    }
    const { requestId, requestFingerprint } = operationRequest(request, request.body);
    const tokenHash = hashDeviceCredential(token, config.authSecret, credentialType);
    const replay = await repository.resolveDeviceCredentialReplay({
      tokenHash,
      credentialType,
      operation,
      requestId,
      requestFingerprint,
      at: clock.now().toISOString(),
    });
    const context = replay ?? await repository.resolveDeviceCredential({
      tokenHash,
      credentialType,
      at: clock.now().toISOString(),
    });
    if (!context) throw unauthenticated("The device credential is invalid");
    request.mobileDevice = context;
  };
  const authenticateRotationConfirmation: preHandlerHookHandler = async (request) => {
    let token: string;
    try {
      token = parseBearerToken(request.headers.authorization);
    } catch {
      throw unauthenticated("The device credential is invalid");
    }
    if (!isOpaqueDeviceCredential(token, "session") || !isRecord(request.body)) {
      throw unauthenticated("The device credential is invalid");
    }
    const { requestId, requestFingerprint } = operationRequest(request, request.body);
    if (!isRequestId(request.body.prepareRequestId)) {
      throw unauthenticated("The device credential is invalid");
    }
    const tokenHash = hashDeviceCredential(token, config.authSecret, "session");
    const replay = await repository.resolveDeviceCredentialReplay({
      tokenHash,
      credentialType: "session",
      operation: "rotation_confirm",
      requestId,
      requestFingerprint,
      at: clock.now().toISOString(),
    });
    const context = replay ?? await repository.resolvePendingRotationCredential({
      tokenHash,
      prepareRequestId: request.body.prepareRequestId,
      confirmRequestId: requestId,
      confirmRequestFingerprint: requestFingerprint,
      at: clock.now().toISOString(),
    });
    if (!context) throw unauthenticated("The device credential is invalid");
    request.mobileDevice = context;
  };
  const requireMatchingMobileContext = (
    context: MobileDeviceContext,
    value: { organizationId: string; employeeId: string; deviceId: string },
  ): void => {
    if (value.organizationId !== context.organizationId || value.employeeId !== context.employeeId ||
      value.deviceId !== context.deviceId) {
      throw forbidden("The mobile device context does not match the credential");
    }
  };
  const protect = (permission: Permission): preHandlerHookHandler[] => [authenticate, requirePermission(permission)];
  const requireFullOrganizationReadScope: preHandlerHookHandler = async (request) => {
    const actor = currentActor(request);
    if (!["owner", "admin", "analyst"].includes(actor.roleKey)) {
      throw forbidden("Team and self data scopes are not implemented for this role");
    }
  };
  const requireFullOrganizationAdminScope: preHandlerHookHandler = async (request) => {
    const actor = currentActor(request);
    if (!["owner", "admin"].includes(actor.roleKey)) {
      throw forbidden("This action requires an owner or admin organization scope");
    }
  };
  const protectOrganizationRead = (permission: Permission): preHandlerHookHandler[] => [
    authenticate,
    requirePermission(permission),
    requireFullOrganizationReadScope,
  ];
  const protectOrganizationAdmin = (permission: Permission): preHandlerHookHandler[] => [
    authenticate,
    requirePermission(permission),
    requireFullOrganizationAdminScope,
  ];
  const audit = async (event: Omit<AuditEvent, "id" | "occurredAt">, at = clock.now().toISOString()): Promise<void> => {
    await repository.appendAuditEvent({ ...event, id: ids.next("audit"), occurredAt: at });
  };

  app.get("/health", async (request) => success(request, { status: "ok", time: clock.now().toISOString() }));
  app.get("/ready", async (request, reply) => {
    if (!(await repository.ping())) {
      return reply.status(503).send({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "Repository is not ready", requestId: request.id },
        requestId: request.id,
      });
    }
    return success(request, { status: "ready", time: clock.now().toISOString() });
  });

  if (config.environment !== "production" && config.enableDevAuth) {
    app.post("/v1/dev/session", async (request) => {
      const body = bodyRecord(request);
      const organizationId = requiredString(body.organizationId, "organizationId", 100);
      const role = asRole(body.role);
      const actor = await repository.findDevelopmentActor(organizationId, role);
      if (!actor) throw notFound("Development actor not found");
      const issued = tokens.issue(actor.user.id, actor.organization.id);
      return success(request, {
        accessToken: issued.accessToken,
        tokenType: "Bearer" as const,
        expiresAt: issued.expiresAt,
        actor: {
          userId: actor.user.id,
          displayName: actor.user.displayName,
          email: actor.user.email,
          organizationId: actor.organization.id,
          organizationName: actor.organization.name,
          role: actor.roleKey,
          permissions: actor.permissions,
        },
      });
    });
  }

  app.get("/v1/session", { preHandler: authenticate }, async (request) => {
    const actor = currentActor(request);
    return success(request, {
      userId: actor.user.id,
      displayName: actor.user.displayName,
      email: actor.user.email,
      organizationId: actor.organization.id,
      organizationName: actor.organization.name,
      role: actor.roleKey,
      permissions: actor.permissions,
    });
  });

  app.get("/v1/employees", { preHandler: protectOrganizationRead("employees.read") }, async (request) => {
    const actor = currentActor(request);
    const query = queryRecord(request);
    const limit = integerQuery(query.limit, "limit", 50, 100);
    const cursor = optionalQueryString(query.cursor, "cursor");
    const after = cursor === undefined ? undefined : cursors.decode<{ displayName: string; id: string }>(cursor, "employees", actor.organization.id);
    if (after && (!isNonEmptyString(after.displayName) || !isNonEmptyString(after.id))) throw badRequest("The cursor payload is invalid", "cursor");
    const search = optionalQueryString(query.search, "search");
    const team = optionalQueryString(query.team, "team");
    const result = await repository.listEmployees({
      organizationId: actor.organization.id,
      filter: {
        ...(search === undefined ? {} : { search }),
        ...(team === undefined ? {} : { team }),
        ...(query.status === undefined ? {} : { status: asEmployeeStatus(optionalQueryString(query.status, "status")) as EmployeeStatus }),
      },
      ...(after === undefined ? {} : { after }),
      limit,
    });
    const last = result.items.at(-1);
    const nextCursor = result.hasMore && last
      ? cursors.encode("employees", actor.organization.id, { displayName: last.displayName, id: last.id })
      : undefined;
    return success(request, {
      items: presentEmployees(actor, result.items),
      cursorInfo: { hasMore: result.hasMore, ...(nextCursor === undefined ? {} : { nextCursor }) },
    });
  });

  app.post("/v1/employees", { preHandler: protectOrganizationAdmin("employees.manage") }, async (request, reply) => {
    const actor = currentActor(request);
    const input = parseCreateEmployeeInput(bodyRecord(request));
    if (input.managerEmployeeId && !(await repository.findEmployee(actor.organization.id, input.managerEmployeeId))) {
      throw badRequest("managerEmployeeId does not belong to this organization", "managerEmployeeId");
    }
    const at = clock.now().toISOString();
    const employee = await repository.createEmployee(actor.organization.id, input, actor.user.id, at);
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "employee.created",
      entityType: "employee",
      entityId: employee.id,
      metadata: { displayName: employee.displayName },
    }, at);
    return reply.status(201).send(success(request, employee));
  });

  app.post("/v1/employees/:employeeId/suspend", { preHandler: protectOrganizationAdmin("employees.manage") }, async (request) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const employeeId = requiredString(params.employeeId, "employeeId", 100);
    const at = clock.now().toISOString();
    const employee = await repository.suspendEmployee(actor.organization.id, employeeId, actor.user.id, at);
    if (!employee) throw notFound("Employee not found");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "employee.suspended",
      entityType: "employee",
      entityId: employee.id,
      metadata: {},
    }, at);
    return success(request, employee);
  });

  app.get("/v1/lead-statuses", { preHandler: protect("leads.read") }, async (request) => {
    const actor = currentActor(request);
    const items = await repository.listLeadStatuses(actor.organization.id);
    return success(request, { items });
  });

  app.get("/v1/lead-owners", { preHandler: protect("leads.read") }, async (request) => {
    const actor = currentActor(request);
    let employees: Employee[] = [];
    if (actor.leadScope.kind === "organization") {
      employees = (await repository.listEmployees({
        organizationId: actor.organization.id,
        filter: { status: "active" },
        limit: 100,
      })).items;
    } else if (actor.leadScope.kind === "teams") {
      const pages = await Promise.all(actor.leadScope.teamNames.map((team) => repository.listEmployees({
        organizationId: actor.organization.id,
        filter: { status: "active", team },
        limit: 100,
      })));
      employees = pages.flatMap((page) => page.items);
    } else if (actor.leadScope.employeeId) {
      const employee = await repository.findEmployee(actor.organization.id, actor.leadScope.employeeId);
      if (employee?.status === "active") employees = [employee];
    }
    const unique = [...new Map(employees.map((employee) => [employee.id, employee])).values()]
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
    return success(request, {
      items: unique.map((employee) => ({
        id: employee.id,
        displayName: employee.displayName,
        ...(employee.team === undefined ? {} : { team: employee.team }),
      })),
    });
  });

  app.get("/v1/leads", { preHandler: protect("leads.read") }, async (request) => {
    const actor = currentActor(request);
    const query = queryRecord(request);
    const limit = integerQuery(query.limit, "limit", 50, 100);
    const cursorValue = optionalQueryString(query.cursor, "cursor");
    const after = cursorValue === undefined
      ? undefined
      : cursors.decode<{ createdAt: string; id: string }>(cursorValue, "leads", actor.organization.id);
    if (after && (!isIsoDateTime(after.createdAt) || !isNonEmptyString(after.id))) {
      throw badRequest("The cursor payload is invalid", "cursor");
    }
    const queue = optionalQueryString(query.queue, "queue") ?? "all";
    if (!isLeadQueueKey(queue)) throw badRequest("queue is invalid", "queue");
    const search = optionalQueryString(query.search, "search");
    if (search && search.length > 160) throw badRequest("search must not exceed 160 characters", "search");
    const statusId = optionalQueryString(query.statusId, "statusId");
    const assignedEmployeeId = optionalQueryString(query.assignedEmployeeId, "assignedEmployeeId");
    const generatedAt = clock.now().toISOString();
    const result = await repository.listLeads({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      filter: {
        queue,
        ...(search === undefined ? {} : { search }),
        ...(statusId === undefined ? {} : { statusId }),
        ...(assignedEmployeeId === undefined ? {} : { assignedEmployeeId }),
      },
      ...(after === undefined ? {} : { after }),
      limit,
      at: generatedAt,
    });
    const last = result.items.at(-1)?.lead;
    const nextCursor = result.hasMore && last
      ? cursors.encode("leads", actor.organization.id, { createdAt: last.createdAt, id: last.id })
      : undefined;
    return success(request, {
      items: result.items,
      summary: result.summary,
      generatedAt,
      timeZone: actor.organization.settings.timeZone,
      cursorInfo: { hasMore: result.hasMore, ...(nextCursor === undefined ? {} : { nextCursor }) },
    });
  });

  app.get("/v1/leads/:leadId", { preHandler: protect("leads.read") }, async (request) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const leadId = requiredString(params.leadId, "leadId", 100);
    const detail = await repository.findLeadDetail({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      leadId,
      at: clock.now().toISOString(),
    });
    if (!detail) throw notFound("Lead not found");
    return success(request, detail);
  });

  app.post("/v1/leads", { preHandler: protect("leads.manage") }, async (request, reply) => {
    const actor = currentActor(request);
    let input = parseCreateLeadInput(bodyRecord(request));
    if (actor.leadScope.kind === "assigned") {
      if (!actor.leadScope.employeeId) throw forbidden("No active employee profile is linked to this user");
      if (input.assignedEmployeeId && input.assignedEmployeeId !== actor.leadScope.employeeId) throw forbidden();
      input = { ...input, assignedEmployeeId: actor.leadScope.employeeId };
    } else if (actor.leadScope.kind === "teams" && !input.assignedEmployeeId) {
      throw badRequest("assignedEmployeeId is required for a team-scoped lead", "assignedEmployeeId");
    }
    const at = clock.now().toISOString();
    const detail = await repository.createLead({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      input,
      actorUserId: actor.user.id,
      at,
    });
    if (!detail) throw badRequest("The status or assigned employee is not available in your lead scope");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "lead.created",
      entityType: "lead",
      entityId: detail.item.lead.id,
      metadata: {
        source: detail.item.lead.source,
        statusId: detail.item.lead.statusId,
        assignedEmployeeId: detail.item.lead.assignedEmployeeId ?? null,
      },
    }, at);
    return reply.status(201).send(success(request, detail));
  });

  app.patch("/v1/leads/:leadId", { preHandler: protect("leads.manage") }, async (request) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const leadId = requiredString(params.leadId, "leadId", 100);
    const update = parseUpdateLeadRequest(bodyRecord(request));
    const canAssign = actor.permissions.includes("leads.assign");
    if (update.changes.assignedEmployeeId !== undefined && !canAssign) throw forbidden("Lead assignment permission is required");
    const at = clock.now().toISOString();
    const before = await repository.findLeadDetail({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      leadId,
      at,
    });
    if (!before) throw notFound("Lead not found");
    const detail = await repository.updateLead({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      leadId,
      request: update,
      actorUserId: actor.user.id,
      canAssign,
      at,
    });
    if (!detail) throw notFound("Lead not found");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "lead.updated",
      entityType: "lead",
      entityId: leadId,
      metadata: {
        oldVersion: before.item.lead.version,
        newVersion: detail.item.lead.version,
        oldStatusId: before.item.lead.statusId,
        newStatusId: detail.item.lead.statusId,
        oldAssignedEmployeeId: before.item.lead.assignedEmployeeId ?? null,
        newAssignedEmployeeId: detail.item.lead.assignedEmployeeId ?? null,
      },
    }, at);
    return success(request, detail);
  });

  app.post("/v1/leads/:leadId/notes", { preHandler: protect("leads.manage") }, async (request, reply) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const leadId = requiredString(params.leadId, "leadId", 100);
    const input = parseCreateLeadNoteInput(bodyRecord(request));
    const at = clock.now().toISOString();
    const detail = await repository.createLeadNote({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      leadId,
      input,
      actorUserId: actor.user.id,
      at,
    });
    if (!detail) throw notFound("Lead not found");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "lead.note_added",
      entityType: "lead",
      entityId: leadId,
      metadata: { isPinned: input.isPinned ?? false },
    }, at);
    return reply.status(201).send(success(request, detail));
  });

  app.post("/v1/leads/:leadId/follow-ups", { preHandler: protect("leads.manage") }, async (request, reply) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const leadId = requiredString(params.leadId, "leadId", 100);
    const input = parseCreateFollowUpInput(bodyRecord(request));
    if (input.leadId !== leadId) throw badRequest("leadId must match the route", "leadId");
    const at = clock.now().toISOString();
    const detail = await repository.createLeadFollowUp({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      leadId,
      input,
      actorUserId: actor.user.id,
      at,
    });
    if (!detail) throw notFound("Lead or assigned employee not found");
    const createdFollowUp = detail.followUps.find((followUp) =>
      followUp.createdAt === at && followUp.assignedEmployeeId === input.assignedEmployeeId &&
      followUp.dueAt === input.dueAt);
    if (!createdFollowUp) throw new Error("Created follow-up is missing from the lead detail");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "follow_up.created",
      entityType: "follow_up",
      entityId: createdFollowUp.id,
      metadata: { leadId, assignedEmployeeId: createdFollowUp.assignedEmployeeId, priority: createdFollowUp.priority },
    }, at);
    return reply.status(201).send(success(request, detail));
  });

  app.post("/v1/follow-ups/:followUpId/complete", { preHandler: protect("leads.manage") }, async (request) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const followUpId = requiredString(params.followUpId, "followUpId", 100);
    const input = parseCompleteFollowUpInput(bodyRecord(request));
    const at = clock.now().toISOString();
    const detail = await repository.completeLeadFollowUp({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      followUpId,
      input,
      actorUserId: actor.user.id,
      at,
    });
    if (!detail) throw notFound("Follow-up not found");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "follow_up.completed",
      entityType: "follow_up",
      entityId: followUpId,
      metadata: { leadId: detail.item.lead.id, newVersion: input.expectedVersion + 1 },
    }, at);
    return success(request, detail);
  });

  app.post("/v1/lead-imports/preview", { preHandler: protect("leads.assign") }, async (request, reply) => {
    const actor = currentActor(request);
    if (!isPreviewLeadImportInput(request.body)) throw badRequest("The lead import preview payload is invalid");
    operationRequest(request, request.body);
    const at = clock.now().toISOString();
    const preview = await repository.previewLeadImport({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      input: request.body,
      actorUserId: actor.user.id,
      requestFingerprint: fingerprintLeadImport(request.body, config.authSecret),
      at,
    });
    if (!preview.replayed) {
      await audit({
        organizationId: actor.organization.id,
        actorUserId: actor.user.id,
        requestId: request.body.requestId,
        action: "lead_import.previewed",
        entityType: "lead_import",
        entityId: preview.job.id,
        metadata: {
          totalRows: preview.job.totalRows,
          validRows: preview.job.validRows,
          duplicateRows: preview.job.duplicateRows,
          errorRows: preview.job.errorRows,
        },
      }, at);
    }
    return reply.status(201).send(success(request, preview));
  });

  app.get("/v1/lead-imports", { preHandler: protect("leads.assign") }, async (request) => {
    const actor = currentActor(request);
    const items = await repository.listLeadImports({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      actorUserId: actor.user.id,
    });
    return success(request, { items });
  });

  app.get("/v1/lead-imports/:jobId", { preHandler: protect("leads.assign") }, async (request) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const jobId = requiredString(params.jobId, "jobId", 100);
    const preview = await repository.findLeadImport({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      actorUserId: actor.user.id,
      jobId,
    });
    if (!preview) throw notFound("Lead import not found");
    return success(request, preview);
  });

  app.get("/v1/lead-imports/:jobId/errors", { preHandler: protect("leads.assign") }, async (request, reply) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const jobId = requiredString(params.jobId, "jobId", 100);
    const preview = await repository.findLeadImport({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      actorUserId: actor.user.id,
      jobId,
    });
    if (!preview) throw notFound("Lead import not found");
    void reply.header("content-disposition", `attachment; filename="lead-import-${jobId}-errors.csv"`);
    return reply.type("text/csv; charset=utf-8").send(leadImportErrorCsv(preview));
  });

  app.post("/v1/lead-imports/:jobId/commit", { preHandler: protect("leads.assign") }, async (request) => {
    const actor = currentActor(request);
    if (!isCommitLeadImportInput(request.body)) throw badRequest("The lead import commit payload is invalid");
    const params = isRecord(request.params) ? request.params : {};
    const jobId = requiredString(params.jobId, "jobId", 100);
    const { requestFingerprint } = operationRequest(request, request.body);
    const at = clock.now().toISOString();
    const result = await repository.commitLeadImport({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      actorUserId: actor.user.id,
      jobId,
      input: request.body,
      requestFingerprint,
      at,
    });
    if (!result) throw notFound("Lead import not found");
    if (!result.replayed) {
      await audit({
        organizationId: actor.organization.id,
        actorUserId: actor.user.id,
        requestId: request.body.requestId,
        action: "lead_import.committed",
        entityType: "lead_import",
        entityId: jobId,
        metadata: { status: result.job.status, importedRows: result.job.importedRows },
      }, at);
    }
    return success(request, result);
  });

  app.get("/v1/lead-assignment-rules", { preHandler: protect("leads.assign") }, async (request) => {
    const actor = currentActor(request);
    const items = await repository.listLeadAssignmentRules({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      actorUserId: actor.user.id,
      at: clock.now().toISOString(),
    });
    return success(request, { items });
  });

  app.post("/v1/lead-assignment-rules", { preHandler: protect("leads.assign") }, async (request, reply) => {
    const actor = currentActor(request);
    if (!isCreateLeadAssignmentRuleInput(request.body)) throw badRequest("The assignment rule payload is invalid");
    const at = clock.now().toISOString();
    const rule = await repository.createLeadAssignmentRule({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      input: request.body,
      actorUserId: actor.user.id,
      at,
    });
    if (!rule) throw badRequest("Rule employees or statuses are outside your active lead scope");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "assignment_rule.created",
      entityType: "assignment_rule",
      entityId: rule.id,
      metadata: { strategy: rule.strategy, employeeCount: rule.employeeIds.length },
    }, at);
    return reply.status(201).send(success(request, rule));
  });

  app.patch("/v1/lead-assignment-rules/:ruleId", { preHandler: protect("leads.assign") }, async (request) => {
    const actor = currentActor(request);
    if (!isUpdateLeadAssignmentRuleInput(request.body)) throw badRequest("The assignment rule update is invalid");
    const params = isRecord(request.params) ? request.params : {};
    const ruleId = requiredString(params.ruleId, "ruleId", 100);
    const at = clock.now().toISOString();
    const rule = await repository.updateLeadAssignmentRule({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      ruleId,
      input: request.body,
      actorUserId: actor.user.id,
      at,
    });
    if (!rule) throw notFound("Assignment rule not found");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "assignment_rule.updated",
      entityType: "assignment_rule",
      entityId: rule.id,
      metadata: { version: rule.version, active: rule.active },
    }, at);
    return success(request, rule);
  });

  app.post("/v1/lead-assignment-rules/dry-run", { preHandler: protect("leads.assign") }, async (request) => {
    const actor = currentActor(request);
    if (request.body !== undefined && (!isRecord(request.body) || Object.keys(request.body).length > 0)) {
      throw badRequest("The dry-run body must be an empty JSON object");
    }
    const result = await repository.dryRunLeadAssignmentRules({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      actorUserId: actor.user.id,
      at: clock.now().toISOString(),
    });
    return success(request, result);
  });

  app.post("/v1/lead-assignment-rules/apply", { preHandler: protect("leads.assign") }, async (request) => {
    const actor = currentActor(request);
    if (!isApplyLeadAssignmentRulesInput(request.body)) throw badRequest("The assignment apply payload is invalid");
    const { requestFingerprint } = operationRequest(request, request.body);
    const at = clock.now().toISOString();
    const result = await repository.applyLeadAssignmentRules({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      actorUserId: actor.user.id,
      input: request.body,
      requestFingerprint,
      at,
    });
    if (!result.replayed && result.appliedLeads > 0) {
      await audit({
        organizationId: actor.organization.id,
        actorUserId: actor.user.id,
        requestId: request.body.requestId,
        action: "assignment_rule.applied",
        entityType: "assignment_rule",
        entityId: actor.organization.id,
        metadata: { appliedLeads: result.appliedLeads, matchedLeads: result.matchedLeads },
      }, at);
    }
    return success(request, result);
  });

  app.get("/v1/lead-reports", { preHandler: protect("reports.read") }, async (request) => {
    const actor = currentActor(request);
    const query = queryRecord(request);
    const from = optionalQueryString(query.from, "from");
    const to = optionalQueryString(query.to, "to");
    if (!from || !to) throw badRequest("from and to are required", from ? "to" : "from");
    const employeeId = optionalQueryString(query.employeeId, "employeeId");
    const team = optionalQueryString(query.team, "team");
    const source = optionalQueryString(query.source, "source");
    if (team && team.length > 100) throw badRequest("team must not exceed 100 characters", "team");
    if (source !== undefined && !isLeadSource(source)) throw badRequest("source is invalid", "source");
    const filter: LeadReportFilter = {
      from,
      to,
      ...(employeeId === undefined ? {} : { employeeId }),
      ...(team === undefined ? {} : { team }),
      ...(source === undefined ? {} : { source }),
    };
    if (!isLeadReportFilter(filter)) {
      throw badRequest("Report timestamps must be explicit RFC3339 values and employeeId must be a canonical UUID");
    }
    const duration = Date.parse(to) - Date.parse(from);
    if (duration <= 0 || duration > 366 * 24 * 60 * 60 * 1_000) {
      throw badRequest("The report range must be positive and no longer than 366 days");
    }
    const report = await repository.getLeadReport({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      filter,
      timeZone: actor.organization.settings.timeZone,
      at: clock.now().toISOString(),
    });
    return success(request, report);
  });

  app.post("/v1/employees/:employeeId/pairing-codes", { preHandler: protectOrganizationAdmin("devices.manage") }, async (request, reply) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const employeeId = requiredString(params.employeeId, "employeeId", 100);
    const employee = await repository.findEmployee(actor.organization.id, employeeId);
    if (!employee) throw notFound("Employee not found");
    if (employee.status === "paused" || employee.status === "deactivated") throw conflict("A suspended employee cannot pair a device");
    const body = request.body === undefined ? {} : bodyRecord(request);
    const ttlSeconds = body.ttlSeconds === undefined
      ? config.pairingCodeTtlSeconds
      : nonNegativeInteger(body.ttlSeconds, "ttlSeconds", 3_600);
    if (ttlSeconds < 60) throw badRequest("ttlSeconds must be an integer between 60 and 3600", "ttlSeconds");
    const collectionMode = body.collectionMode ?? "android_call_log";
    if (!isMobileCollectionMode(collectionMode)) {
      throw badRequest("collectionMode must be android_call_log or synthetic_demo", "collectionMode");
    }
    if (collectionMode === "synthetic_demo" && config.environment === "production") {
      throw forbidden("Synthetic demo pairing is not available in production");
    }
    const code = codeGenerator.next().toUpperCase();
    const at = clock.now();
    const record = {
      id: ids.next("pairing"),
      codeHash: hashPairingCode(code, config.authSecret),
      codeLastFour: code.slice(-4),
      organizationId: actor.organization.id,
      employeeId,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + ttlSeconds * 1_000).toISOString(),
      createdByUserId: actor.user.id,
      collectionMode,
    };
    await repository.createPairingCode(record);
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "pairing_code.created",
      entityType: "pairing_code",
      entityId: record.id,
      metadata: { employeeId, expiresAt: record.expiresAt, collectionMode },
    }, record.createdAt);
    return reply.status(201).send(success(request, {
      id: record.id,
      code,
      organizationId: record.organizationId,
      employeeId: record.employeeId,
      collectionMode: record.collectionMode,
      expiresAt: record.expiresAt,
    }));
  });

  app.delete("/v1/pairing-codes/:pairingCodeId", { preHandler: protectOrganizationAdmin("devices.manage") }, async (request) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const pairingCodeId = requiredString(params.pairingCodeId, "pairingCodeId", 100);
    const at = clock.now().toISOString();
    const record = await repository.revokePairingCode(actor.organization.id, pairingCodeId, at);
    if (!record) throw notFound("Pairing code not found");
    if (record.consumedAt) throw conflict("A consumed pairing code cannot be revoked");
    await audit({
      organizationId: actor.organization.id,
      actorUserId: actor.user.id,
      action: "pairing_code.revoked",
      entityType: "pairing_code",
      entityId: record.id,
      metadata: { employeeId: record.employeeId },
    }, at);
    return success(request, { id: record.id, revokedAt: record.revokedAt ?? at });
  });

  app.post("/v1/devices/:deviceId/revoke", { preHandler: protectOrganizationAdmin("devices.manage") }, async (request) => {
    const actor = currentActor(request);
    const params = isRecord(request.params) ? request.params : {};
    const deviceId = requiredString(params.deviceId, "deviceId", 160);
    const body = bodyRecord(request);
    const { requestId, requestFingerprint } = operationRequest(request, body);
    if (!isAdminDeviceRevocationInput(body)) {
      throw badRequest("reason must be a single-line explanation containing 8-500 characters", "reason");
    }
    const result = await repository.revokeDeviceByAdministrator({
      organizationId: actor.organization.id,
      deviceId,
      actorUserId: actor.user.id,
      requestId,
      requestFingerprint,
      reason: body.reason.trim(),
      auditEventId: ids.next("audit"),
      outboxEventId: ids.next("outbox"),
      at: clock.now().toISOString(),
    });
    if (!result) throw notFound("Device not found");
    return success(request, {
      deviceId: result.deviceId,
      employeeId: result.employeeId,
      revokedAt: result.revokedAt,
      reason: result.reason,
      revokedCredentialCount: result.revokedCredentialCount,
      consentWithdrawn: result.consentWithdrawn,
    });
  });

  app.post("/v1/device-pairings/redeem", async (request, reply) => {
    const body = bodyRecord(request);
    const { requestId, requestFingerprint } = operationRequest(request, body);
    const code = requiredString(body.code, "code", 32).toUpperCase();
    if (!isProposedDeviceCredential(body.proposedBootstrapCredential, "bootstrap")) {
      throw badRequest("proposedBootstrapCredential must be a 256-bit clb_ credential", "proposedBootstrapCredential");
    }
    const registration = parseDeviceRegistration(body);
    if (registration.collectionMode === "synthetic_demo" && config.environment === "production") {
      throw forbidden("Synthetic demo pairing is not available in production");
    }
    const codeHash = hashPairingCode(code, config.authSecret);
    const rateLimitKeys = [
      hashPairingRateLimitDimension("ip", request.ip, config.authSecret),
      hashPairingRateLimitDimension("code", codeHash, config.authSecret),
      hashPairingRateLimitDimension("installation", registration.installationId, config.authSecret),
    ];
    for (const rateLimitKey of rateLimitKeys) {
      await pairingLimiter.consumeAttempt(rateLimitKey);
    }
    const now = clock.now();
    const at = now.toISOString();
    const bootstrapExpiresAt = new Date(now.getTime() + config.deviceBootstrapTtlSeconds * 1_000).toISOString();
    const result = await repository.redeemPairingCode({
      codeHash,
      registration,
      bootstrapCredential: {
        id: ids.next("device_credential"),
        credentialType: "bootstrap",
        tokenHash: hashDeviceCredential(body.proposedBootstrapCredential, config.authSecret, "bootstrap"),
        expiresAt: bootstrapExpiresAt,
        requestId,
        lifecycleState: "active",
      },
      requestId,
      requestFingerprint,
      at,
    });
    if (result.outcome !== "redeemed" || !result.record || !result.device) {
      if (result.outcome === "not_found") throw notFound("Pairing code is invalid");
      if (result.outcome === "expired") throw conflict("Pairing code has expired");
      if (result.outcome === "revoked") throw conflict("Pairing code has been revoked");
      if (result.outcome === "consumed") throw conflict("Pairing code has already been used");
      throw conflict("This installation is already paired");
    }
    if (!result.replayed) {
      for (const rateLimitKey of rateLimitKeys) {
        await pairingLimiter.reset(rateLimitKey);
      }
    }
    if (!result.replayed && !repository.mobileTransitionEvidenceAtomic) {
      await audit({
        organizationId: result.record.organizationId,
        actorDeviceId: result.device.id,
        action: "pairing_code.redeemed",
        entityType: "device",
        entityId: result.device.id,
        metadata: { employeeId: result.record.employeeId, pairingCodeId: result.record.id },
      }, at);
    }
    return reply.status(201).send(success(request, {
      device: result.device,
      pairing: { id: result.record.id, consumedAt: result.record.consumedAt ?? at },
      bootstrapCredential: {
        tokenType: "Bearer" as const,
        expiresAt: result.bootstrapExpiresAt ?? bootstrapExpiresAt,
      },
    }));
  });

  app.get("/v1/mobile/collection-policy", { preHandler: authenticateMobileEither }, async (request) => {
    const context = currentMobileDevice(request);
    const policy = await repository.findCurrentMobilePolicy(context, clock.now().toISOString());
    if (!policy) throw consentRequired("No active collection policy is available for this device");
    return success(request, { policy });
  });

  app.post("/v1/mobile/activate", {
    preHandler: authenticateMobileWithReplay("bootstrap", "activate"),
  }, async (request, reply) => {
    if (!isMobileActivationInput(request.body)) throw badRequest("The mobile activation payload is invalid");
    const context = currentMobileDevice(request);
    const { requestFingerprint } = operationRequest(request, request.body);
    const now = clock.now();
    const acceptedAt = Date.parse(request.body.consent.acceptedAt);
    const at = now.toISOString();
    const policy = await repository.findCurrentMobilePolicy(context, at);
    const sessionExpiresAt = new Date(now.getTime() + config.deviceSessionTtlSeconds * 1_000).toISOString();
    const activated = await repository.activateMobileDevice({
      context,
      activation: request.body,
      sessionCredential: {
        id: ids.next("device_credential"),
        credentialType: "session",
        tokenHash: hashDeviceCredential(request.body.proposedSessionCredential, config.authSecret, "session"),
        expiresAt: sessionExpiresAt,
        requestId: request.body.requestId,
        lifecycleState: "active",
      },
      requestFingerprint,
      ...(policy === undefined ? {} : { policy }),
      at,
    });
    if (!activated) {
      if (acceptedAt > now.getTime() + 5 * 60 * 1_000) {
        throw badRequest("consent.acceptedAt cannot be more than five minutes in the future", "consent.acceptedAt");
      }
      if (acceptedAt < now.getTime() - 15 * 60 * 1_000) {
        throw badRequest("consent.acceptedAt is too old for this pairing session", "consent.acceptedAt");
      }
      if (!policy || request.body.policy.id !== policy.id || request.body.policy.contentHash !== policy.contentHash) {
        throw consentRequired("The referenced collection policy is stale or unknown");
      }
      throw unauthenticated("The device credential is invalid");
    }
    if (!activated.replayed && !repository.mobileTransitionEvidenceAtomic) {
      await audit({
        organizationId: context.organizationId,
        actorDeviceId: context.deviceId,
        action: "device.activated",
        entityType: "device",
        entityId: context.deviceId,
        metadata: {
          employeeId: context.employeeId,
          policyId: activated.policy.id,
          policyContentHash: activated.policy.contentHash,
          ...(policy === undefined ? {} : {
            policyVersion: policy.policyVersion,
            disclosureVersion: policy.disclosureVersion,
          }),
        },
      }, at);
    }
    return reply.status(201).send(success(request, {
      device: activated.device,
      sessionCredential: {
        tokenType: "Bearer" as const,
        expiresAt: activated.sessionExpiresAt,
      },
      policy: activated.policy,
    }));
  });

  app.post("/v1/mobile/reconsent", {
    preHandler: authenticateMobileWithReplay("session", "reconsent"),
  }, async (request) => {
    if (!isMobileReconsentInput(request.body)) throw badRequest("The mobile re-consent payload is invalid");
    const { requestFingerprint } = operationRequest(request, request.body);
    const context = currentMobileDevice(request);
    const now = clock.now();
    const acceptedAt = Date.parse(request.body.consent.acceptedAt);
    const at = now.toISOString();
    const policy = await repository.findCurrentMobilePolicy(context, at);
    const result = await repository.reconsentMobileDevice({
      context,
      reconsent: request.body,
      requestFingerprint,
      ...(policy === undefined ? {} : { policy }),
      at,
    });
    if (!result) {
      if (acceptedAt > now.getTime() + 5 * 60 * 1_000 || acceptedAt < now.getTime() - 15 * 60 * 1_000) {
        throw badRequest("consent.acceptedAt is outside the accepted consent window", "consent.acceptedAt");
      }
      if (!policy || request.body.policy.id !== policy.id || request.body.policy.contentHash !== policy.contentHash) {
        throw consentRequired("The referenced collection policy is stale or unknown");
      }
      throw unauthenticated("The device credential is invalid");
    }
    if (!result.replayed && !repository.mobileTransitionEvidenceAtomic) {
      await audit({
        organizationId: context.organizationId,
        actorDeviceId: context.deviceId,
        action: "device.consent_renewed",
        entityType: "device",
        entityId: context.deviceId,
        metadata: { employeeId: context.employeeId, policyId: result.policy.id, policyContentHash: result.policy.contentHash },
      }, at);
    }
    return success(request, {
      device: result.device,
      policy: result.policy,
      consentedAt: result.consentedAt,
    });
  });

  app.get("/v1/mobile/leads", { preHandler: authenticateMobile("session") }, async (request) => {
    const context = currentMobileDevice(request);
    if (!context.consentCurrent) throw consentRequired();
    const query = queryRecord(request);
    const limit = integerQuery(query.limit, "limit", 50, 100);
    const cursorValue = optionalQueryString(query.cursor, "cursor");
    const after = cursorValue === undefined
      ? undefined
      : cursors.decode<{ createdAt: string; id: string }>(cursorValue, "mobile-leads", context.organizationId);
    if (after && (!isIsoDateTime(after.createdAt) || !isNonEmptyString(after.id))) {
      throw badRequest("The cursor payload is invalid", "cursor");
    }
    const queue = optionalQueryString(query.queue, "queue") ?? "all";
    if (!isLeadQueueKey(queue)) throw badRequest("queue is invalid", "queue");
    const search = optionalQueryString(query.search, "search");
    if (search && search.length > 160) throw badRequest("search must not exceed 160 characters", "search");
    const statusId = optionalQueryString(query.statusId, "statusId");
    const generatedAt = clock.now().toISOString();
    const result = await repository.listLeads({
      organizationId: context.organizationId,
      scope: { kind: "assigned", employeeId: context.employeeId },
      filter: {
        queue,
        ...(search === undefined ? {} : { search }),
        ...(statusId === undefined ? {} : { statusId }),
      },
      ...(after === undefined ? {} : { after }),
      limit,
      at: generatedAt,
    });
    const last = result.items.at(-1)?.lead;
    const nextCursor = result.hasMore && last
      ? cursors.encode("mobile-leads", context.organizationId, { createdAt: last.createdAt, id: last.id })
      : undefined;
    return success(request, {
      items: result.items,
      summary: result.summary,
      generatedAt,
      cursorInfo: { hasMore: result.hasMore, ...(nextCursor === undefined ? {} : { nextCursor }) },
    });
  });

  app.get("/v1/mobile/leads/:leadId", { preHandler: authenticateMobile("session") }, async (request) => {
    const context = currentMobileDevice(request);
    if (!context.consentCurrent) throw consentRequired();
    const params = isRecord(request.params) ? request.params : {};
    const leadId = requiredString(params.leadId, "leadId", 100);
    const detail = await repository.findLeadDetail({
      organizationId: context.organizationId,
      scope: { kind: "assigned", employeeId: context.employeeId },
      leadId,
      at: clock.now().toISOString(),
    });
    if (!detail) throw notFound("Lead not found");
    return success(request, detail);
  });

  app.get("/v1/mobile/lead-statuses", { preHandler: authenticateMobile("session") }, async (request) => {
    const context = currentMobileDevice(request);
    if (!context.consentCurrent) throw consentRequired();
    const items = await repository.listLeadStatuses(context.organizationId);
    return success(request, { items });
  });

  app.post("/v1/mobile/leads/:leadId/updates", {
    preHandler: authenticateMobile("session"),
  }, async (request) => {
    const context = currentMobileDevice(request);
    if (!context.consentCurrent) throw consentRequired();
    if (!isMobileLeadUpdateInput(request.body)) {
      throw badRequest("The mobile lead update payload is invalid");
    }
    const params = isRecord(request.params) ? request.params : {};
    const leadId = requiredString(params.leadId, "leadId", 100);
    operationRequest(request, request.body);
    const now = clock.now();
    if (request.body.followUp?.reminderAt &&
      Date.parse(request.body.followUp.reminderAt) > Date.parse(request.body.followUp.dueAt)) {
      throw badRequest("followUp.reminderAt cannot be after followUp.dueAt", "followUp.reminderAt");
    }
    const receipt = await repository.applyMobileLeadUpdate({
      context,
      leadId,
      input: request.body,
      requestFingerprint: fingerprintMobileLeadUpdate(request.body, config.authSecret),
      at: now.toISOString(),
    });
    if (!receipt) throw notFound("Lead not found");
    return success(request, receipt);
  });

  app.post("/v1/mobile/heartbeat", { preHandler: authenticateMobile("session") }, async (request) => {
    if (!isDeviceHeartbeat(request.body)) throw badRequest("The device heartbeat payload is invalid");
    const context = currentMobileDevice(request);
    requireMatchingMobileContext(context, request.body);
    const now = clock.now();
    const observedAt = Date.parse(request.body.observedAt);
    if (observedAt > now.getTime() + 5 * 60 * 1_000 || observedAt < now.getTime() - 24 * 60 * 60 * 1_000) {
      throw badRequest("observedAt is outside the accepted clock window", "observedAt");
    }
    const acknowledgement = await repository.recordDeviceHeartbeat({
      context,
      heartbeat: request.body,
      at: now.toISOString(),
    });
    if (!acknowledgement) throw unauthenticated("The device credential is invalid");
    return success(request, acknowledgement);
  });

  app.post("/v1/mobile/call-batches", { preHandler: authenticateMobile("session") }, async (request) => {
    if (!isCallLogSyncBatch(request.body)) throw badRequest("The call sync batch payload is invalid");
    const batchIdempotencyKey = idempotencyKey(request);
    if (batchIdempotencyKey !== request.body.batchId) {
      throw badRequest("Idempotency-Key must exactly match batchId", "Idempotency-Key");
    }
    const context = currentMobileDevice(request);
    requireMatchingMobileContext(context, request.body);
    if (!context.consentCurrent) throw consentRequired();
    if (request.body.collectionMode !== context.collectionMode) {
      throw forbidden("The collection mode does not match the paired device configuration");
    }
    const allowSyntheticDemo = context.collectionMode === "synthetic_demo" && config.environment !== "production";
    if (request.body.collectionMode === "synthetic_demo" && config.environment === "production") {
      throw forbidden("Synthetic call batches are not available in production");
    }
    if (context.permissions.callLog !== "granted" && !allowSyntheticDemo) {
      throw forbidden("Call-log synchronization requires an active call-log permission grant");
    }
    if (request.body.items.some((item) => item.simCardId !== undefined || item.recordingLocalId !== undefined)) {
      throw badRequest("SIM-card and recording identifiers are not supported in the technical alpha");
    }
    const now = clock.now();
    const sentAt = Date.parse(request.body.sentAt);
    if (sentAt > now.getTime() + 5 * 60 * 1_000 || sentAt < now.getTime() - 30 * 24 * 60 * 60 * 1_000) {
      throw badRequest("sentAt is outside the accepted synchronization window", "sentAt");
    }
    const result = await repository.ingestMobileCallBatch({
      context,
      batch: request.body,
      payloadHash: fingerprintMobileCallBatch(request.body, config.authSecret),
      nextCursor: cursors.encode("mobile-sync", context.organizationId, {
        deviceId: context.deviceId,
        batchId: request.body.batchId,
      }),
      at: now.toISOString(),
      allowWithoutCallLogPermission: allowSyntheticDemo,
    });
    if (!result) throw unauthenticated("The device credential is invalid");
    return success(request, result);
  });

  app.post("/v1/mobile/session/rotation/prepare", {
    preHandler: authenticateMobileWithReplay("session", "rotation_prepare"),
  }, async (request) => {
    if (!isMobileSessionRotationPrepareInput(request.body)) {
      throw badRequest("The session rotation preparation payload is invalid");
    }
    const { requestId, requestFingerprint } = operationRequest(request, request.body);
    const context = currentMobileDevice(request);
    if (!context.consentCurrent && !context.authenticatedReplay) throw consentRequired();
    const now = clock.now();
    const at = now.toISOString();
    const expiresAt = new Date(now.getTime() + config.deviceSessionTtlSeconds * 1_000).toISOString();
    const prepared = await repository.prepareDeviceSessionRotation({
      context,
      sessionCredential: {
        id: ids.next("device_credential"),
        credentialType: "session",
        tokenHash: hashDeviceCredential(request.body.proposedSessionCredential, config.authSecret, "session"),
        expiresAt,
        rotatedFromCredentialId: context.credentialId,
        requestId,
        lifecycleState: "pending",
      },
      requestId,
      requestFingerprint,
      at,
    });
    if (!prepared) throw unauthenticated("The device credential is invalid");
    if (!prepared.replayed && !repository.mobileTransitionEvidenceAtomic) {
      await audit({
        organizationId: context.organizationId,
        actorDeviceId: context.deviceId,
        action: "device.session_rotation_prepared",
        entityType: "session",
        entityId: context.deviceId,
        metadata: { employeeId: context.employeeId, requestId },
      }, at);
    }
    return success(request, {
      requestId,
      pendingCredential: {
        tokenType: "Bearer" as const,
        expiresAt: prepared.pendingExpiresAt,
      },
      preparedAt: prepared.preparedAt,
    });
  });

  app.post("/v1/mobile/session/rotation/confirm", {
    preHandler: authenticateRotationConfirmation,
  }, async (request) => {
    if (!isMobileSessionRotationConfirmInput(request.body)) {
      throw badRequest("The session rotation confirmation payload is invalid");
    }
    const { requestId, requestFingerprint } = operationRequest(request, request.body);
    const context = currentMobileDevice(request);
    const at = clock.now().toISOString();
    const confirmed = await repository.confirmDeviceSessionRotation({
      context,
      requestId,
      prepareRequestId: request.body.prepareRequestId,
      requestFingerprint,
      at,
    });
    if (!confirmed) throw unauthenticated("The device credential is invalid");
    if (!confirmed.replayed && !repository.mobileTransitionEvidenceAtomic) {
      await audit({
        organizationId: context.organizationId,
        actorDeviceId: context.deviceId,
        action: "device.session_rotation_confirmed",
        entityType: "session",
        entityId: context.deviceId,
        metadata: { employeeId: context.employeeId, requestId },
      }, at);
    }
    return success(request, {
      requestId,
      credential: { tokenType: "Bearer" as const, expiresAt: confirmed.expiresAt },
      activatedAt: confirmed.activatedAt,
    });
  });

  app.delete("/v1/mobile/session", {
    preHandler: authenticateMobileWithReplay("session", "revoke"),
  }, async (request) => {
    if (!isMobileSessionRevocationInput(request.body)) {
      throw badRequest("The session revocation payload is invalid");
    }
    const { requestId, requestFingerprint } = operationRequest(request, request.body);
    const context = currentMobileDevice(request);
    const at = clock.now().toISOString();
    const revoked = await repository.revokeMobileSession({ context, requestId, requestFingerprint, at });
    if (!revoked) throw unauthenticated("The device credential is invalid");
    if (!revoked.replayed && !repository.mobileTransitionEvidenceAtomic) {
      await audit({
        organizationId: context.organizationId,
        actorDeviceId: context.deviceId,
        action: "device.session_revoked",
        entityType: "session",
        entityId: context.deviceId,
        metadata: { employeeId: context.employeeId, consentWithdrawn: true, requestId },
      }, at);
    }
    return success(request, {
      deviceId: revoked.deviceId,
      revokedAt: revoked.revokedAt,
      consentWithdrawnAt: revoked.consentWithdrawnAt,
    });
  });

  if (config.environment !== "production") {
    app.post("/v1/calls/ingest/simulated", { preHandler: protectOrganizationAdmin("calls.annotate") }, async (request, reply) => {
      const actor = currentActor(request);
      const key = idempotencyKey(request);
      const input = parseSimulatedCall(bodyRecord(request));
      const employee = await repository.findEmployee(actor.organization.id, input.employeeId);
      if (!employee) throw badRequest("employeeId does not belong to this organization", "employeeId");
      if (input.deviceId) {
        const device = await repository.findDevice(actor.organization.id, input.deviceId);
        if (!device || device.employeeId !== input.employeeId) throw badRequest("deviceId does not belong to this employee", "deviceId");
      }
      const at = clock.now().toISOString();
      const result = await repository.ingestCall({
        organizationId: actor.organization.id,
        input,
        idempotencyKey: key,
        fingerprint: fingerprint(input),
        actorUserId: actor.user.id,
        at,
      });
      if (result.conflict) throw conflict("The idempotency key or device-scoped externalId was already used with a different payload");
      if (!result.duplicate) {
        await audit({
          organizationId: actor.organization.id,
          actorUserId: actor.user.id,
          action: "call.ingested",
          entityType: "call",
          entityId: result.call.id,
          metadata: { employeeId: result.call.employeeId, externalId: input.externalId },
        }, at);
      }
      const response = success(request, { call: result.call, duplicate: result.duplicate });
      return result.duplicate ? response : reply.status(201).send(response);
    });
  }

  app.get("/v1/calls", { preHandler: protectOrganizationRead("calls.read") }, async (request) => {
    const actor = currentActor(request);
    const query = queryRecord(request);
    const limit = integerQuery(query.limit, "limit", 50, 100);
    const cursorValue = optionalQueryString(query.cursor, "cursor");
    const after = cursorValue === undefined ? undefined : cursors.decode<{ startedAt: string; id: string }>(cursorValue, "calls", actor.organization.id);
    if (after && (!isIsoDateTime(after.startedAt) || !isNonEmptyString(after.id))) throw badRequest("The cursor payload is invalid", "cursor");
    const direction = optionalQueryString(query.direction, "direction");
    if (direction !== undefined && !isCallDirection(direction)) throw badRequest("direction is invalid", "direction");
    const disposition = optionalQueryString(query.disposition, "disposition");
    if (disposition !== undefined && !isCallDisposition(disposition)) throw badRequest("disposition is invalid", "disposition");
    const from = asTimestamp(optionalQueryString(query.from, "from"), "from");
    const to = asTimestamp(optionalQueryString(query.to, "to"), "to");
    const employeeId = optionalQueryString(query.employeeId, "employeeId");
    const result = await repository.listCalls({
      organizationId: actor.organization.id,
      filter: {
        ...(employeeId === undefined ? {} : { employeeId }),
        ...(direction === undefined ? {} : { direction }),
        ...(disposition === undefined ? {} : { disposition }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      },
      ...(after === undefined ? {} : { after }),
      limit,
    });
    const last = result.items.at(-1);
    const nextCursor = result.hasMore && last
      ? cursors.encode("calls", actor.organization.id, { startedAt: last.startedAt, id: last.id })
      : undefined;
    return success(request, {
      items: presentCalls(actor, result.items),
      cursorInfo: { hasMore: result.hasMore, ...(nextCursor === undefined ? {} : { nextCursor }) },
    });
  });

  app.post("/v1/calls/:callId/lead-link/correct", {
    preHandler: [authenticate, requirePermission("calls.annotate"), requirePermission("leads.assign")],
  }, async (request) => {
    const actor = currentActor(request);
    if (!isCorrectCallLeadLinkInput(request.body)) throw badRequest("The call-link correction payload is invalid");
    const params = isRecord(request.params) ? request.params : {};
    const callId = requiredString(params.callId, "callId", 100);
    const { requestFingerprint } = operationRequest(request, request.body);
    const result = await repository.correctCallLeadLink({
      organizationId: actor.organization.id,
      scope: actor.leadScope,
      callId,
      input: request.body,
      actorUserId: actor.user.id,
      requestFingerprint,
      at: clock.now().toISOString(),
    });
    if (!result) throw notFound("Call or replacement lead not found in your scope");
    return success(request, result);
  });

  app.get("/v1/dashboard/overview", { preHandler: protectOrganizationRead("calls.read") }, async (request) => {
    const actor = currentActor(request);
    const query = queryRecord(request);
    const preset = optionalQueryString(query.preset, "preset");
    if (preset !== undefined && !["today", "yesterday", "last_7_days"].includes(preset)) {
      throw badRequest("preset must be today, yesterday, or last_7_days", "preset");
    }
    const from = asTimestamp(optionalQueryString(query.from, "from"), "from");
    const to = asTimestamp(optionalQueryString(query.to, "to"), "to");
    const employeeId = optionalQueryString(query.employeeId, "employeeId");
    const dashboardQuery: DashboardQuery = {
      ...(preset === undefined ? {} : { preset: preset as DashboardPreset }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(employeeId === undefined ? {} : { employeeId }),
    };
    if (dashboardQuery.employeeId && !(await repository.findEmployee(actor.organization.id, dashboardQuery.employeeId))) {
      throw notFound("Employee not found");
    }
    const overview = await buildDashboardOverview({ repository, organization: actor.organization, query: dashboardQuery, clock });
    return success(request, overview);
  });

  app.get("/v1/audit-events", { preHandler: protect("audit.read") }, async (request) => {
    const actor = currentActor(request);
    const limit = integerQuery(queryRecord(request).limit, "limit", 50, 100);
    const events = await repository.listAuditEvents(actor.organization.id, limit);
    return success(request, { items: events });
  });

  return app;
}
