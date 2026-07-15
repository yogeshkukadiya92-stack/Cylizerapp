import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { InMemoryCalloraRepository, SequentialIdGenerator, SequentialPairingCodeGenerator } from "../src/repository.js";
import type { Clock } from "../src/security.js";

class FixedClock implements Clock {
  private value = new Date("2026-07-14T12:00:00.000Z");

  now(): Date {
    return new Date(this.value);
  }

  advanceMinutes(minutes: number): void {
    this.value = new Date(this.value.getTime() + minutes * 60 * 1_000);
  }
}

const config: ApiConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4100,
  authSecret: "phase-four-test-secret-with-more-than-thirty-two-characters",
  enableDevAuth: true,
  tokenTtlSeconds: 3_600,
  pairingCodeTtlSeconds: 600,
  deviceBootstrapTtlSeconds: 600,
  deviceSessionTtlSeconds: 604_800,
  pairingAttemptLimit: 5,
  pairingAttemptWindowSeconds: 60,
  trustedProxyCidrs: [],
  allowedOrigins: ["http://localhost:4173"],
};

interface Success<T> {
  ok: true;
  data: T;
}

interface Failure {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; code: string; message: string }>;
  };
}

interface LeadSnapshot {
  id: string;
  organizationId: string;
  firstName: string;
  lastName?: string;
  companyName?: string;
  phoneNumber: string;
  email?: string;
  source: string;
  statusId: string;
  assignedEmployeeId?: string;
  customFields: Record<string, unknown>;
  lastContactedAt?: string;
  version: number;
  createdAt: string;
}

interface FollowUpSnapshot {
  id: string;
  leadId: string;
  assignedEmployeeId: string;
  title: string;
  priority: string;
  status: string;
  version: number;
  completedAt?: string;
}

interface LeadDetail {
  item: {
    lead: LeadSnapshot;
    status: { id: string; name: string };
    assignedEmployee?: { id: string; displayName: string; team?: string };
    overdueFollowUpCount: number;
    unreturnedMissedCallCount: number;
  };
  notes: Array<{ id: string; body: string; isPinned: boolean }>;
  followUps: FollowUpSnapshot[];
  activities: Array<{
    kind: string;
    summary: string;
    callLogId?: string;
    occurredAt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

interface LeadList {
  items: LeadDetail["item"][];
  summary: { total: number; notContacted: number; overdue: number; unreturnedCalls: number };
  generatedAt: string;
  timeZone: string;
  cursorInfo: { hasMore: boolean; nextCursor?: string };
}

interface MobileLeadList {
  items: LeadDetail["item"][];
  summary: LeadList["summary"];
  generatedAt: string;
  cursorInfo: LeadList["cursorInfo"];
}

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function deviceCredential(prefix: "clb" | "cls", seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("base64url")}`;
}

const mobilePermissions = {
  callLog: "granted",
  phoneState: "granted",
  contacts: "denied",
  notifications: "granted",
  recordingFiles: "unknown",
  backgroundExecution: "granted",
} as const;

describe("Phase 4A lead workspace API", () => {
  let app: FastifyInstance;
  let repository: InMemoryCalloraRepository;
  let clock: FixedClock;

  beforeEach(() => {
    repository = new InMemoryCalloraRepository(new SequentialIdGenerator());
    clock = new FixedClock();
    app = buildApp({
      config,
      repository,
      clock,
      idGenerator: new SequentialIdGenerator(),
      pairingCodeGenerator: new SequentialPairingCodeGenerator(),
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function token(
    role: "owner" | "admin" | "manager" | "analyst" | "employee" = "owner",
    organizationId = "org_alpha",
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { organizationId, role },
    });
    expect(response.statusCode).toBe(200);
    return json<Success<{ accessToken: string }>>(response).data.accessToken;
  }

  async function createLead(
    accessToken: string,
    overrides: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: auth(accessToken),
      payload: {
        firstName: "Kavya",
        lastName: "Desai",
        companyName: "Kavya Foods",
        phoneNumber: "+919811223344",
        email: "KAVYA@EXAMPLE.TEST",
        source: "website",
        temperature: "hot",
        customFields: { annualValue: 250000, segment: "growth" },
        ...overrides,
      },
    });
  }

  async function activateMobileEmployee(
    employeeId: string,
    installationId: string,
  ): Promise<{ deviceId: string; session: string }> {
    const owner = await token("owner");
    const pairingResponse = await app.inject({
      method: "POST",
      url: `/v1/employees/${employeeId}/pairing-codes`,
      headers: auth(owner),
      payload: { ttlSeconds: 120, collectionMode: "android_call_log" },
    });
    expect(pairingResponse.statusCode).toBe(201);
    const pairingCode = json<Success<{ code: string }>>(pairingResponse).data.code;

    const bootstrap = deviceCredential("clb", `${employeeId}:${installationId}:bootstrap`);
    const redeemRequestId = randomUUID();
    const redeemResponse = await app.inject({
      method: "POST",
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": redeemRequestId },
      payload: {
        requestId: redeemRequestId,
        proposedBootstrapCredential: bootstrap,
        code: pairingCode,
        installationId,
        collectionMode: "android_call_log",
        platform: "android",
        osVersion: "16",
        appVersion: "0.4.0",
        permissions: mobilePermissions,
      },
    });
    expect(redeemResponse.statusCode).toBe(201);
    const deviceId = json<Success<{ device: { id: string } }>>(redeemResponse).data.device.id;

    const policyResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(bootstrap),
    });
    expect(policyResponse.statusCode).toBe(200);
    const policy = json<Success<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;

    const session = deviceCredential("cls", `${employeeId}:${installationId}:session`);
    const activationRequestId = randomUUID();
    const activationResponse = await app.inject({
      method: "POST",
      url: "/v1/mobile/activate",
      headers: { ...auth(bootstrap), "idempotency-key": activationRequestId },
      payload: {
        requestId: activationRequestId,
        proposedSessionCredential: session,
        policy,
        consent: {
          acceptedAt: "2026-07-14T12:00:00.000Z",
          purpose: "call_metadata",
          locale: "en-IN",
        },
        permissions: mobilePermissions,
      },
    });
    expect(activationResponse.statusCode).toBe(201);
    return { deviceId, session };
  }

  it("lists owner-visible statuses, queues, filters, pages, and lead detail", async () => {
    const owner = await token();
    const statusesResponse = await app.inject({
      method: "GET",
      url: "/v1/lead-statuses",
      headers: auth(owner),
    });
    expect(statusesResponse.statusCode).toBe(200);
    const statuses = json<Success<{ items: Array<{
      id: string;
      organizationId: string;
      name: string;
      position: number;
      isInitial: boolean;
    }> }>>(statusesResponse).data.items;
    expect(statuses.map((status) => status.name)).toEqual(["New", "Contacted", "Qualified", "Won", "Lost"]);
    expect(statuses.every((status) => status.organizationId === "org_alpha")).toBe(true);
    expect(statuses[0]).toMatchObject({ id: "lead_status_alpha_new", position: 1, isInitial: true });

    const firstPageResponse = await app.inject({
      method: "GET",
      url: "/v1/leads?limit=2",
      headers: auth(owner),
    });
    expect(firstPageResponse.statusCode).toBe(200);
    const firstPage = json<Success<LeadList>>(firstPageResponse).data;
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.summary).toEqual({ total: 5, notContacted: 2, overdue: 1, unreturnedCalls: 1 });
    expect(firstPage).toMatchObject({
      generatedAt: "2026-07-14T12:00:00.000Z",
      timeZone: "Asia/Kolkata",
      cursorInfo: { hasMore: true },
    });
    expect(firstPage.cursorInfo.nextCursor).toEqual(expect.any(String));

    const secondPageResponse = await app.inject({
      method: "GET",
      url: `/v1/leads?limit=2&cursor=${encodeURIComponent(firstPage.cursorInfo.nextCursor!)}`,
      headers: auth(owner),
    });
    expect(secondPageResponse.statusCode).toBe(200);
    const secondPage = json<Success<LeadList>>(secondPageResponse).data;
    expect(secondPage.items).toHaveLength(2);
    const firstPageIds = new Set(firstPage.items.map((item) => item.lead.id));
    expect(secondPage.items.some((item) => firstPageIds.has(item.lead.id))).toBe(false);

    const searchResponse = await app.inject({
      method: "GET",
      url: "/v1/leads?search=Ramesh&queue=unreturned_calls&statusId=lead_status_alpha_qualified",
      headers: auth(owner),
    });
    expect(searchResponse.statusCode).toBe(200);
    const search = json<Success<LeadList>>(searchResponse).data;
    expect(search.items).toHaveLength(1);
    expect(search.items[0]?.lead.id).toBe("lead_alpha_ramesh");
    expect(search.items[0]).toMatchObject({
      overdueFollowUpCount: 1,
      unreturnedMissedCallCount: 1,
      assignedEmployee: { id: "emp_alpha_amit", team: "Sales" },
    });

    const detailResponse = await app.inject({
      method: "GET",
      url: "/v1/leads/lead_alpha_ramesh",
      headers: auth(owner),
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = json<Success<LeadDetail>>(detailResponse).data;
    expect(detail.item.lead).toMatchObject({
      id: "lead_alpha_ramesh",
      organizationId: "org_alpha",
      companyName: "Ramesh Traders",
      version: 1,
    });
    expect(detail.notes.map((note) => note.body)).toContain("Interested in our premium textile range.");
    expect(detail.followUps).toContainEqual(expect.objectContaining({ id: "followup_alpha_ramesh", status: "pending" }));
    expect(detail.activities.map((activity) => activity.kind)).toEqual(expect.arrayContaining([
      "call_linked",
      "follow_up_created",
      "status_changed",
      "note_added",
    ]));
  });

  it("runs the owner create, update, note, follow-up, and completion lifecycle", async () => {
    const owner = await token();
    const createdResponse = await createLead(owner, {
      statusId: "lead_status_alpha_new",
      assignedEmployeeId: "emp_alpha_amit",
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = json<Success<LeadDetail>>(createdResponse).data;
    const leadId = created.item.lead.id;
    expect(created.item.lead).toMatchObject({
      organizationId: "org_alpha",
      firstName: "Kavya",
      email: "kavya@example.test",
      source: "website",
      statusId: "lead_status_alpha_new",
      assignedEmployeeId: "emp_alpha_amit",
      customFields: { annualValue: 250000, segment: "growth" },
      version: 1,
    });
    expect(created.activities).toContainEqual(expect.objectContaining({ kind: "created" }));

    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/v1/leads/${leadId}`,
      headers: auth(owner),
      payload: {
        expectedVersion: 1,
        changes: {
          companyName: "Kavya Foods Pvt Ltd",
          statusId: "lead_status_alpha_contacted",
          temperature: "warm",
        },
      },
    });
    expect(updatedResponse.statusCode).toBe(200);
    const updated = json<Success<LeadDetail>>(updatedResponse).data;
    expect(updated.item.lead).toMatchObject({
      companyName: "Kavya Foods Pvt Ltd",
      statusId: "lead_status_alpha_contacted",
      version: 2,
    });
    expect(updated.activities).toContainEqual(expect.objectContaining({
      kind: "status_changed",
      summary: "Status changed to Contacted",
    }));

    const noteResponse = await app.inject({
      method: "POST",
      url: `/v1/leads/${leadId}/notes`,
      headers: auth(owner),
      payload: { body: "Send revised enterprise proposal.", isPinned: true },
    });
    expect(noteResponse.statusCode).toBe(201);
    const withNote = json<Success<LeadDetail>>(noteResponse).data;
    expect(withNote.notes).toContainEqual(expect.objectContaining({
      body: "Send revised enterprise proposal.",
      isPinned: true,
    }));

    const followUpResponse = await app.inject({
      method: "POST",
      url: `/v1/leads/${leadId}/follow-ups`,
      headers: auth(owner),
      payload: {
        leadId,
        assignedEmployeeId: "emp_alpha_amit",
        title: "Review proposal with Kavya",
        notes: "Confirm annual volume.",
        dueAt: "2026-07-16T06:30:00.000Z",
        reminderAt: "2026-07-16T05:30:00.000Z",
        priority: "urgent",
      },
    });
    expect(followUpResponse.statusCode).toBe(201);
    const withFollowUp = json<Success<LeadDetail>>(followUpResponse).data;
    const followUp = withFollowUp.followUps.find((item) => item.title === "Review proposal with Kavya");
    expect(followUp).toMatchObject({
      leadId,
      assignedEmployeeId: "emp_alpha_amit",
      priority: "urgent",
      status: "pending",
      version: 1,
    });

    const completionResponse = await app.inject({
      method: "POST",
      url: `/v1/follow-ups/${followUp!.id}/complete`,
      headers: auth(owner),
      payload: {
        expectedVersion: 1,
        completedAt: "2026-07-14T11:55:00.000Z",
        completionNote: "Proposal reviewed and accepted for internal approval.",
      },
    });
    expect(completionResponse.statusCode).toBe(200);
    const completed = json<Success<LeadDetail>>(completionResponse).data;
    expect(completed.followUps.find((item) => item.id === followUp!.id)).toMatchObject({
      status: "completed",
      version: 2,
      completedAt: "2026-07-14T11:55:00.000Z",
    });
    expect(completed.notes).toContainEqual(expect.objectContaining({
      body: "Proposal reviewed and accepted for internal approval.",
    }));
    expect(completed.activities).toContainEqual(expect.objectContaining({ kind: "follow_up_completed" }));

    const reloadedResponse = await app.inject({
      method: "GET",
      url: `/v1/leads/${leadId}`,
      headers: auth(owner),
    });
    expect(reloadedResponse.statusCode).toBe(200);
    expect(json<Success<LeadDetail>>(reloadedResponse).data).toEqual(completed);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/v1/audit-events",
      headers: auth(owner),
    });
    const audits = json<Success<{ items: Array<{ action: string; metadata: Record<string, unknown> }> }>>(auditResponse).data.items;
    expect(audits.map((event) => event.action)).toEqual(expect.arrayContaining([
      "lead.created",
      "lead.updated",
      "lead.note_added",
      "follow_up.created",
      "follow_up.completed",
    ]));
    expect(JSON.stringify(audits)).not.toContain("Send revised enterprise proposal");
    expect(JSON.stringify(audits)).not.toContain("Review proposal with Kavya");
  });

  it("automatically links same-team calls and reconciles the unreturned-call lead queue", async () => {
    const owner = await token("owner");
    const phoneNumber = "+919855501234";
    const createdResponse = await createLead(owner, {
      firstName: "Automatic match",
      phoneNumber,
      assignedEmployeeId: "emp_alpha_amit",
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = json<Success<LeadDetail>>(createdResponse).data;
    const leadId = created.item.lead.id;
    expect(created.item.lead).toMatchObject({ version: 1, assignedEmployeeId: "emp_alpha_amit" });
    expect(created.item.lead.lastContactedAt).toBeUndefined();

    async function ingest(
      idempotencyKey: string,
      payload: Record<string, unknown>,
    ): Promise<LightMyRequestResponse> {
      return app.inject({
        method: "POST",
        url: "/v1/calls/ingest/simulated",
        headers: { ...auth(owner), "idempotency-key": idempotencyKey },
        payload,
      });
    }

    clock.advanceMinutes(5);
    const missedStartedAt = clock.now().toISOString();
    const missedResponse = await ingest("phase4-auto-match-missed", {
      externalId: "phase4-auto-match-missed-call",
      employeeId: "emp_alpha_amit",
      direction: "incoming",
      disposition: "missed",
      phoneNumber,
      startedAt: missedStartedAt,
      durationSeconds: 0,
      isInternal: false,
      isWithinWorkingHours: true,
    });
    expect(missedResponse.statusCode).toBe(201);
    const missedCallId = json<Success<{ call: { id: string } }>>(missedResponse).data.call.id;

    const afterMissedResponse = await app.inject({
      method: "GET",
      url: `/v1/leads/${leadId}`,
      headers: auth(owner),
    });
    const afterMissed = json<Success<LeadDetail>>(afterMissedResponse).data;
    expect(afterMissed.item.lead).toMatchObject({ version: 1 });
    expect(afterMissed.item.lead.lastContactedAt).toBeUndefined();
    expect(afterMissed.item.unreturnedMissedCallCount).toBe(1);
    expect(afterMissed.activities).toContainEqual(expect.objectContaining({
      kind: "call_linked",
      callLogId: missedCallId,
      occurredAt: missedStartedAt,
      summary: "Incoming missed call linked",
      metadata: expect.objectContaining({
        direction: "incoming",
        disposition: "missed",
        linkSource: "automatic",
        matchConfidence: 1,
      }),
    }));

    const missedQueueResponse = await app.inject({
      method: "GET",
      url: `/v1/leads?queue=unreturned_calls&search=${encodeURIComponent(phoneNumber)}`,
      headers: auth(owner),
    });
    const missedQueue = json<Success<LeadList>>(missedQueueResponse).data;
    expect(missedQueue.summary.unreturnedCalls).toBe(2);
    expect(missedQueue.items).toHaveLength(1);
    expect(missedQueue.items[0]).toMatchObject({
      lead: { id: leadId },
      unreturnedMissedCallCount: 1,
    });

    clock.advanceMinutes(10);
    const answeredStartedAt = clock.now().toISOString();
    const answeredAt = new Date(clock.now().getTime() + 5_000).toISOString();
    const endedAt = new Date(clock.now().getTime() + 120_000).toISOString();
    const answeredResponse = await ingest("phase4-auto-match-answered", {
      externalId: "phase4-auto-match-answered-call",
      employeeId: "emp_alpha_amit",
      direction: "outgoing",
      disposition: "answered",
      phoneNumber,
      startedAt: answeredStartedAt,
      answeredAt,
      endedAt,
      durationSeconds: 120,
      isInternal: false,
      isWithinWorkingHours: true,
    });
    expect(answeredResponse.statusCode).toBe(201);
    const answeredCallId = json<Success<{ call: { id: string } }>>(answeredResponse).data.call.id;

    const afterAnswerResponse = await app.inject({
      method: "GET",
      url: `/v1/leads/${leadId}`,
      headers: auth(owner),
    });
    const afterAnswer = json<Success<LeadDetail>>(afterAnswerResponse).data;
    expect(afterAnswer.item.lead).toMatchObject({
      version: 2,
      lastContactedAt: answeredStartedAt,
    });
    expect(afterAnswer.item.unreturnedMissedCallCount).toBe(0);
    expect(afterAnswer.activities).toContainEqual(expect.objectContaining({
      kind: "call_linked",
      callLogId: answeredCallId,
      occurredAt: answeredStartedAt,
      summary: "Outgoing answered call linked",
      metadata: expect.objectContaining({
        direction: "outgoing",
        disposition: "answered",
        linkSource: "automatic",
      }),
    }));

    const clearedQueueResponse = await app.inject({
      method: "GET",
      url: `/v1/leads?queue=unreturned_calls&search=${encodeURIComponent(phoneNumber)}`,
      headers: auth(owner),
    });
    const clearedQueue = json<Success<LeadList>>(clearedQueueResponse).data;
    expect(clearedQueue.summary.unreturnedCalls).toBe(1);
    expect(clearedQueue.items).toHaveLength(0);
  });

  it("rejects stale lead and follow-up versions without applying a second mutation", async () => {
    const owner = await token();
    const firstUpdate = await app.inject({
      method: "PATCH",
      url: "/v1/leads/lead_alpha_ramesh",
      headers: auth(owner),
      payload: { expectedVersion: 1, changes: { temperature: "hot" } },
    });
    expect(firstUpdate.statusCode).toBe(200);
    expect(json<Success<LeadDetail>>(firstUpdate).data.item.lead.version).toBe(2);

    const staleUpdate = await app.inject({
      method: "PATCH",
      url: "/v1/leads/lead_alpha_ramesh",
      headers: auth(owner),
      payload: { expectedVersion: 1, changes: { firstName: "Stale write" } },
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(json<Failure>(staleUpdate).error).toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/lead changed/i),
    });

    const firstCompletion = await app.inject({
      method: "POST",
      url: "/v1/follow-ups/followup_alpha_ramesh/complete",
      headers: auth(owner),
      payload: { expectedVersion: 1 },
    });
    expect(firstCompletion.statusCode).toBe(200);
    expect(json<Success<LeadDetail>>(firstCompletion).data.followUps.find((item) =>
      item.id === "followup_alpha_ramesh")).toMatchObject({ status: "completed", version: 2 });

    const staleCompletion = await app.inject({
      method: "POST",
      url: "/v1/follow-ups/followup_alpha_ramesh/complete",
      headers: auth(owner),
      payload: { expectedVersion: 1 },
    });
    expect(staleCompletion.statusCode).toBe(409);
    expect(json<Failure>(staleCompletion).error).toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/follow-up changed/i),
    });

    const detailResponse = await app.inject({
      method: "GET",
      url: "/v1/leads/lead_alpha_ramesh",
      headers: auth(owner),
    });
    const detail = json<Success<LeadDetail>>(detailResponse).data;
    expect(detail.item.lead).toMatchObject({ firstName: "Ramesh", version: 3 });
    expect(detail.followUps.find((item) => item.id === "followup_alpha_ramesh"))
      .toMatchObject({ status: "completed", version: 2 });
  });

  it("returns not-found across tenant boundaries for lead reads and mutations", async () => {
    const alphaOwner = await token("owner", "org_alpha");
    const betaOwner = await token("owner", "org_beta");

    const betaListResponse = await app.inject({
      method: "GET",
      url: "/v1/leads",
      headers: auth(betaOwner),
    });
    const betaList = json<Success<LeadList>>(betaListResponse).data;
    expect(betaList.items.map((item) => item.lead.id)).toEqual(["lead_beta_private"]);
    expect(betaList.items.every((item) => item.lead.organizationId === "org_beta")).toBe(true);

    const betaStatusesResponse = await app.inject({
      method: "GET",
      url: "/v1/lead-statuses",
      headers: auth(betaOwner),
    });
    const betaStatuses = json<Success<{ items: Array<{ organizationId: string }> }>>(betaStatusesResponse).data.items;
    expect(betaStatuses).toHaveLength(2);
    expect(betaStatuses.every((status) => status.organizationId === "org_beta")).toBe(true);

    const betaRequests = [
      app.inject({ method: "GET", url: "/v1/leads/lead_alpha_ramesh", headers: auth(betaOwner) }),
      app.inject({
        method: "PATCH",
        url: "/v1/leads/lead_alpha_ramesh",
        headers: auth(betaOwner),
        payload: { expectedVersion: 1, changes: { firstName: "Cross tenant" } },
      }),
      app.inject({
        method: "POST",
        url: "/v1/leads/lead_alpha_ramesh/notes",
        headers: auth(betaOwner),
        payload: { body: "Cross tenant note" },
      }),
      app.inject({
        method: "POST",
        url: "/v1/leads/lead_alpha_ramesh/follow-ups",
        headers: auth(betaOwner),
        payload: {
          leadId: "lead_alpha_ramesh",
          assignedEmployeeId: "emp_beta_riya",
          title: "Cross tenant follow-up",
          dueAt: "2026-07-16T06:30:00.000Z",
        },
      }),
      app.inject({
        method: "POST",
        url: "/v1/follow-ups/followup_alpha_ramesh/complete",
        headers: auth(betaOwner),
        payload: { expectedVersion: 1 },
      }),
      app.inject({ method: "GET", url: "/v1/leads/lead_beta_private", headers: auth(alphaOwner) }),
    ];
    for (const response of await Promise.all(betaRequests)) {
      expect(response.statusCode).toBe(404);
      expect(json<Failure>(response).error.code).toBe("NOT_FOUND");
    }

    const foreignReferences = await createLead(alphaOwner, {
      statusId: "lead_status_beta_new",
      assignedEmployeeId: "emp_beta_riya",
    });
    expect(foreignReferences.statusCode).toBe(400);
    expect(json<Failure>(foreignReferences).error.code).toBe("VALIDATION_FAILED");
  });

  it("includes unassigned same-team leads in manager scope while hiding cross-team leads", async () => {
    const owner = await token("owner");
    const unassignedResponse = await createLead(owner, {
      firstName: "Owner",
      phoneNumber: "+919822334455",
      assignedEmployeeId: undefined,
    });
    expect(unassignedResponse.statusCode).toBe(201);
    const unassignedId = json<Success<LeadDetail>>(unassignedResponse).data.item.lead.id;
    const crossTeam = await repository.createLead({
      organizationId: "org_alpha",
      scope: { kind: "teams", teamNames: ["Support"] },
      input: {
        firstName: "Support team",
        phoneNumber: "+919800112233",
        source: "manual",
      },
      actorUserId: "user_org_alpha_owner",
      at: "2026-07-14T12:00:00.000Z",
    });
    expect(crossTeam).toBeDefined();

    const manager = await token("manager");
    const listResponse = await app.inject({ method: "GET", url: "/v1/leads", headers: auth(manager) });
    expect(listResponse.statusCode).toBe(200);
    const list = json<Success<LeadList>>(listResponse).data;
    expect(list.summary.total).toBe(6);
    expect(list.items.map((item) => item.lead.id)).toContain(unassignedId);
    expect(list.items.map((item) => item.lead.id)).not.toContain(crossTeam!.item.lead.id);
    expect(list.items.every((item) => !item.assignedEmployee || item.assignedEmployee.team === "Sales")).toBe(true);

    const sameTeamDetail = await app.inject({
      method: "GET",
      url: `/v1/leads/${unassignedId}`,
      headers: auth(manager),
    });
    expect(sameTeamDetail.statusCode).toBe(200);

    const hiddenDetail = await app.inject({
      method: "GET",
      url: `/v1/leads/${crossTeam!.item.lead.id}`,
      headers: auth(manager),
    });
    expect(hiddenDetail.statusCode).toBe(404);

    const managerCreatedResponse = await createLead(manager, {
      firstName: "Managed",
      phoneNumber: "+919833445566",
      assignedEmployeeId: "emp_alpha_amit",
    });
    expect(managerCreatedResponse.statusCode).toBe(201);
    const managerCreated = json<Success<LeadDetail>>(managerCreatedResponse).data;
    expect(managerCreated.item.assignedEmployee).toMatchObject({ id: "emp_alpha_amit", team: "Sales" });

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/v1/leads/${managerCreated.item.lead.id}`,
      headers: auth(manager),
      payload: { expectedVersion: 1, changes: { statusId: "lead_status_alpha_contacted" } },
    });
    expect(updateResponse.statusCode).toBe(200);

    const missingAssignment = await createLead(manager, {
      firstName: "No assignment",
      phoneNumber: "+919844556677",
      assignedEmployeeId: undefined,
    });
    expect(missingAssignment.statusCode).toBe(400);
    expect(json<Failure>(missingAssignment).error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/assignedEmployeeId is required/i),
    });

    const foreignTeamAssignment = await createLead(manager, {
      firstName: "Foreign team",
      phoneNumber: "+919855667788",
      assignedEmployeeId: "emp_beta_riya",
    });
    expect(foreignTeamAssignment.statusCode).toBe(400);
  });

  it("limits employees to self-assigned leads and auto-assigns their creations", async () => {
    const owner = await token("owner");
    const hiddenResponse = await createLead(owner, {
      firstName: "Unassigned",
      phoneNumber: "+919866778899",
      assignedEmployeeId: undefined,
    });
    const hiddenId = json<Success<LeadDetail>>(hiddenResponse).data.item.lead.id;

    const employee = await token("employee");
    const listResponse = await app.inject({ method: "GET", url: "/v1/leads", headers: auth(employee) });
    expect(listResponse.statusCode).toBe(200);
    const list = json<Success<LeadList>>(listResponse).data;
    expect(list.summary.total).toBe(5);
    expect(list.items.map((item) => item.lead.id)).not.toContain(hiddenId);
    expect(list.items.every((item) => item.lead.assignedEmployeeId === "emp_alpha_amit")).toBe(true);

    const employeeCreatedResponse = await createLead(employee, {
      firstName: "Self owned",
      phoneNumber: "+919877889900",
      assignedEmployeeId: undefined,
    });
    expect(employeeCreatedResponse.statusCode).toBe(201);
    const employeeCreated = json<Success<LeadDetail>>(employeeCreatedResponse).data;
    expect(employeeCreated.item.lead.assignedEmployeeId).toBe("emp_alpha_amit");

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/v1/leads/${employeeCreated.item.lead.id}`,
      headers: auth(employee),
      payload: { expectedVersion: 1, changes: { temperature: "warm" } },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(json<Success<LeadDetail>>(updateResponse).data.item.lead.version).toBe(2);

    const explicitOtherOwner = await createLead(employee, {
      firstName: "Not mine",
      phoneNumber: "+919888990011",
      assignedEmployeeId: "emp_alpha_priya",
    });
    expect(explicitOtherOwner.statusCode).toBe(403);
    expect(json<Failure>(explicitOtherOwner).error.code).toBe("FORBIDDEN");

    const assignmentChange = await app.inject({
      method: "PATCH",
      url: `/v1/leads/${employeeCreated.item.lead.id}`,
      headers: auth(employee),
      payload: { expectedVersion: 2, changes: { assignedEmployeeId: null } },
    });
    expect(assignmentChange.statusCode).toBe(403);
    expect(json<Failure>(assignmentChange).error).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/assignment permission/i),
    });

    const hiddenDetail = await app.inject({ method: "GET", url: `/v1/leads/${hiddenId}`, headers: auth(employee) });
    expect(hiddenDetail.statusCode).toBe(404);
  });

  it("limits mobile lead list and detail reads to the paired device employee", async () => {
    const amitDevice = await activateMobileEmployee("emp_alpha_amit", "phase4-amit-leads");
    await activateMobileEmployee("emp_alpha_priya", "phase4-priya-leads");

    const owner = await token("owner");
    const priyaLeadResponse = await createLead(owner, {
      firstName: "Priya owned",
      phoneNumber: "+919899001122",
      assignedEmployeeId: "emp_alpha_priya",
    });
    expect(priyaLeadResponse.statusCode).toBe(201);
    const priyaLeadId = json<Success<LeadDetail>>(priyaLeadResponse).data.item.lead.id;

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/leads?limit=100",
      headers: auth(amitDevice.session),
    });
    expect(listResponse.statusCode).toBe(200);
    const list = json<Success<MobileLeadList>>(listResponse).data;
    expect(list.summary.total).toBe(5);
    expect(list.items).toHaveLength(5);
    expect(list.items.every((item) => item.lead.organizationId === "org_alpha")).toBe(true);
    expect(list.items.every((item) => item.lead.assignedEmployeeId === "emp_alpha_amit")).toBe(true);
    expect(list.items.map((item) => item.lead.id)).not.toContain(priyaLeadId);
    expect(list.items.map((item) => item.lead.id)).not.toContain("lead_beta_private");

    const assignedDetail = await app.inject({
      method: "GET",
      url: "/v1/mobile/leads/lead_alpha_ramesh",
      headers: auth(amitDevice.session),
    });
    expect(assignedDetail.statusCode).toBe(200);
    expect(json<Success<LeadDetail>>(assignedDetail).data.item.lead).toMatchObject({
      id: "lead_alpha_ramesh",
      assignedEmployeeId: "emp_alpha_amit",
    });

    const inaccessibleDetails = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/mobile/leads/${priyaLeadId}`,
        headers: auth(amitDevice.session),
      }),
      app.inject({
        method: "GET",
        url: "/v1/mobile/leads/lead_beta_private",
        headers: auth(amitDevice.session),
      }),
    ]);
    for (const response of inaccessibleDetails) {
      expect(response.statusCode).toBe(404);
      expect(json<Failure>(response).error.code).toBe("NOT_FOUND");
    }
  });

  it("requires current consent before mobile lead list or detail access", async () => {
    const active = await activateMobileEmployee("emp_alpha_amit", "phase4-stale-consent");
    repository.setMobilePolicyForTesting({
      id: "40000000-0000-4000-8000-000000000001",
      contentHash: "a".repeat(64),
      policyVersion: "2026.2-enterprise-call-metadata",
      disclosureVersion: "2026.2-enterprise-disclosure",
      collectionMode: "android_call_log",
      purpose: "call_metadata",
      title: "Updated Callora enterprise call metadata",
      summary: "Updated authoritative disclosure.",
      disclosures: ["Consent must be renewed before protected mobile data is shown."],
      effectiveAt: "2026-07-14T12:00:00.000Z",
    });

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/v1/mobile/leads", headers: auth(active.session) }),
      app.inject({
        method: "GET",
        url: "/v1/mobile/leads/lead_alpha_ramesh",
        headers: auth(active.session),
      }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(json<Failure>(response).error.code).toBe("CONSENT_REQUIRED");
    }
  });

  it("scopes lead-owner choices to active employees visible to each actor", async () => {
    const cases = [
      { organizationId: "org_alpha", role: "owner" as const, expectedIds: ["emp_alpha_amit"] },
      { organizationId: "org_alpha", role: "manager" as const, expectedIds: ["emp_alpha_amit"] },
      { organizationId: "org_alpha", role: "employee" as const, expectedIds: ["emp_alpha_amit"] },
      { organizationId: "org_beta", role: "owner" as const, expectedIds: ["emp_beta_riya"] },
    ];

    for (const testCase of cases) {
      const accessToken = await token(testCase.role, testCase.organizationId);
      const response = await app.inject({ method: "GET", url: "/v1/lead-owners", headers: auth(accessToken) });
      expect(response.statusCode).toBe(200);
      const items = json<Success<{ items: Array<{ id: string; displayName: string; team?: string }> }>>(response).data.items;
      expect(items.map((item) => item.id), `${testCase.organizationId}/${testCase.role}`).toEqual(testCase.expectedIds);
      expect(items.every((item) => item.displayName.length > 0)).toBe(true);
    }
  });

  it("denies lead endpoints when the role lacks lead permissions", async () => {
    const analyst = await token("analyst");
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/v1/lead-statuses", headers: auth(analyst) }),
      app.inject({ method: "GET", url: "/v1/lead-owners", headers: auth(analyst) }),
      app.inject({ method: "GET", url: "/v1/leads", headers: auth(analyst) }),
      app.inject({ method: "GET", url: "/v1/leads/lead_alpha_ramesh", headers: auth(analyst) }),
      createLead(analyst),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(json<Failure>(response).error.code).toBe("FORBIDDEN");
    }

    const anonymous = await app.inject({ method: "GET", url: "/v1/leads" });
    expect(anonymous.statusCode).toBe(401);
    expect(json<Failure>(anonymous).error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects malformed lead, query, note, and follow-up inputs", async () => {
    const owner = await token();
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/v1/leads?queue=everything", headers: auth(owner) }),
      app.inject({ method: "GET", url: "/v1/leads?cursor=not-a-valid-cursor", headers: auth(owner) }),
      createLead(owner, { phoneNumber: "9876543210" }),
      createLead(owner, { email: "not-an-email" }),
      app.inject({
        method: "PATCH",
        url: "/v1/leads/lead_alpha_ramesh",
        headers: auth(owner),
        payload: { expectedVersion: 0, changes: { firstName: "Invalid" } },
      }),
      app.inject({
        method: "PATCH",
        url: "/v1/leads/lead_alpha_ramesh",
        headers: auth(owner),
        payload: { expectedVersion: 1, changes: { unsupported: true } },
      }),
      app.inject({
        method: "POST",
        url: "/v1/leads/lead_alpha_ramesh/notes",
        headers: auth(owner),
        payload: { body: "   " },
      }),
      app.inject({
        method: "POST",
        url: "/v1/leads/lead_alpha_ramesh/follow-ups",
        headers: auth(owner),
        payload: {
          leadId: "lead_alpha_aarav",
          assignedEmployeeId: "emp_alpha_amit",
          title: "Wrong route",
          dueAt: "2026-07-16T06:30:00.000Z",
        },
      }),
      app.inject({
        method: "POST",
        url: "/v1/leads/lead_alpha_ramesh/follow-ups",
        headers: auth(owner),
        payload: {
          leadId: "lead_alpha_ramesh",
          assignedEmployeeId: "emp_alpha_amit",
          title: "Bad reminder",
          dueAt: "2026-07-16T06:30:00.000Z",
          reminderAt: "2026-07-16T07:30:00.000Z",
        },
      }),
      app.inject({
        method: "POST",
        url: "/v1/follow-ups/followup_alpha_ramesh/complete",
        headers: auth(owner),
        payload: { expectedVersion: 0 },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(json<Failure>(response).error.code).toBe("VALIDATION_FAILED");
    }
    expect(json<Failure>(responses[0]!).error.details?.[0]?.field).toBe("queue");
    expect(json<Failure>(responses[2]!).error.details?.[0]?.field).toBe("phoneNumber");
    expect(json<Failure>(responses[4]!).error.details?.[0]?.field).toBe("expectedVersion");
    expect(json<Failure>(responses[7]!).error.details?.[0]?.field).toBe("leadId");
    expect(json<Failure>(responses[8]!).error.details?.[0]?.field).toBe("reminderAt");
  });
});
