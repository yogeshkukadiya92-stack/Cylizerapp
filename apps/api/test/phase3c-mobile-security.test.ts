import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { InMemoryCalloraRepository, SequentialIdGenerator, SequentialPairingCodeGenerator } from "../src/repository.js";
import {
  fingerprintMobileCallBatch,
  hashPairingCode,
  hashPairingRateLimitDimension,
  PairingAttemptLimiter,
  type Clock,
  type SharedAttemptLimiter,
} from "../src/security.js";

describe("mobile call-batch payload protection", () => {
  it("uses a secret-keyed domain-separated digest instead of raw body SHA-256", () => {
    const body = {
      batchId: "batch-guess-resistance",
      items: [{ phoneNumber: "+919876543210", contactName: "Asha Patel" }],
    };
    const first = fingerprintMobileCallBatch(body, "a".repeat(32));
    const second = fingerprintMobileCallBatch(body, "b".repeat(32));
    const rawBodyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(first).not.toBe(rawBodyHash);
  });
});

class FixedClock implements Clock {
  private value = new Date("2026-07-14T12:00:00.000Z");

  now(): Date {
    return new Date(this.value);
  }

  advanceMinutes(minutes: number): void {
    this.value = new Date(this.value.getTime() + minutes * 60 * 1_000);
  }
}

class RecordingAttemptLimiter implements SharedAttemptLimiter {
  readonly isReplicaSafe = true;
  readonly consumed: string[] = [];
  readonly resetKeys: string[] = [];

  consumeAttempt(key: string): void {
    this.consumed.push(key);
  }

  reset(key: string): void {
    this.resetKeys.push(key);
  }
}

const config: ApiConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4100,
  authSecret: "phase-3c-test-secret-with-more-than-thirty-two-characters",
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
  error: { code: string; message: string };
}

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

function credential(prefix: "clb" | "cls", seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("base64url")}`;
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("Phase 3C mobile trust protocol", () => {
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

  async function ownerToken(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { organizationId: "org_alpha", role: "owner" },
    });
    return json<Success<{ accessToken: string }>>(response).data.accessToken;
  }

  async function pairingCode(collectionMode: "android_call_log" | "synthetic_demo" = "android_call_log"): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/employees/emp_alpha_priya/pairing-codes",
      headers: auth(await ownerToken()),
      payload: { ttlSeconds: 120, collectionMode },
    });
    expect(response.statusCode).toBe(201);
    return json<Success<{ code: string }>>(response).data.code;
  }

  async function redeem(installationId: string): Promise<{
    bootstrap: string;
    deviceId: string;
    responseData: unknown;
  }> {
    const bootstrap = credential("clb", installationId);
    const requestId = randomUUID();
    const payload = {
      requestId,
      proposedBootstrapCredential: bootstrap,
      code: await pairingCode(),
      installationId,
      collectionMode: "android_call_log",
      platform: "android",
      osVersion: "16",
      appVersion: "0.3.0",
      permissions: {
        callLog: "unknown",
        phoneState: "unknown",
        contacts: "unknown",
        notifications: "granted",
        recordingFiles: "unknown",
        backgroundExecution: "granted",
      },
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": requestId },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const data = json<Success<{
      device: { id: string };
      bootstrapCredential: { tokenType: string; expiresAt: string; token?: string };
    }>>(first).data;
    expect(data.bootstrapCredential).not.toHaveProperty("token");

    const retry = await app.inject({
      method: "POST",
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": requestId },
      payload,
    });
    expect(retry.statusCode).toBe(201);
    expect(json<Success<unknown>>(retry).data).toEqual(data);
    return { bootstrap, deviceId: data.device.id, responseData: data };
  }

  async function activate(installationId: string): Promise<{
    deviceId: string;
    bootstrap: string;
    session: string;
  }> {
    const paired = await redeem(installationId);
    const policyResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(paired.bootstrap),
    });
    expect(policyResponse.statusCode).toBe(200);
    const policy = json<Success<{
      policy: { id: string; contentHash: string; collectionMode: string };
    }>>(policyResponse).data.policy;
    expect(policy).toMatchObject({
      id: "30000000-0000-4000-8000-000000000002",
      contentHash: "31124ef8f171f23b6adc6d5e96bb5e3b3907a9bf5461c216c383cafe7d749941",
      collectionMode: "android_call_log",
    });

    const session = credential("cls", `${installationId}:session`);
    const requestId = randomUUID();
    const payload = {
      requestId,
      proposedSessionCredential: session,
      policy: { id: policy.id, contentHash: policy.contentHash },
      consent: {
        acceptedAt: "2026-07-14T12:00:00.000Z",
        purpose: "call_metadata",
        locale: "en-IN",
      },
      permissions: {
        callLog: "granted",
        phoneState: "granted",
        contacts: "denied",
        notifications: "granted",
        recordingFiles: "unknown",
        backgroundExecution: "granted",
      },
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/mobile/activate",
      headers: { ...auth(paired.bootstrap), "idempotency-key": requestId },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstData = json<Success<{
      sessionCredential: { tokenType: string; expiresAt: string; token?: string };
    }>>(first).data;
    expect(firstData.sessionCredential).not.toHaveProperty("token");

    const retry = await app.inject({
      method: "POST",
      url: "/v1/mobile/activate",
      headers: { ...auth(paired.bootstrap), "idempotency-key": requestId },
      payload,
    });
    expect(retry.statusCode).toBe(201);
    expect(json<Success<unknown>>(retry).data).toEqual(firstData);
    return { deviceId: paired.deviceId, bootstrap: paired.bootstrap, session };
  }

  function heartbeatPayload(deviceId: string, callLog: "unknown" | "granted" | "denied" = "granted") {
    return {
      schemaVersion: 1,
      organizationId: "org_alpha",
      employeeId: "emp_alpha_priya",
      deviceId,
      observedAt: "2026-07-14T12:00:00.000Z",
      appVersion: "0.3.0",
      osVersion: "16",
      pendingCallCount: 0,
      pendingRecordingCount: 0,
      syncState: "idle",
      permissions: {
        callLog,
        phoneState: callLog,
        contacts: "denied",
        notifications: "granted",
        recordingFiles: "unknown",
        backgroundExecution: "granted",
      },
    };
  }

  function callBatch(deviceId: string) {
    return {
      schemaVersion: 1,
      collectionMode: "android_call_log",
      batchId: "phase3c-batch-0001",
      organizationId: "org_alpha",
      employeeId: "emp_alpha_priya",
      deviceId,
      sentAt: "2026-07-14T12:00:00.000Z",
      items: [{
        localId: "phase3c-call-0001",
        phoneNumber: "+919811112222",
        direction: "incoming",
        disposition: "answered",
        startedAt: "2026-07-14T11:59:00.000Z",
        durationSeconds: 60,
      }],
    };
  }

  function rollPolicy(id: string, contentHash: string, version: string): void {
    repository.setMobilePolicyForTesting({
      id,
      contentHash,
      policyVersion: `call-metadata-${version}`,
      disclosureVersion: `prominent-disclosure-${version}`,
      collectionMode: "android_call_log",
      purpose: "call_metadata",
      title: `Policy ${version}`,
      summary: `Authoritative policy ${version}`,
      disclosures: [`Disclosure ${version}`],
      effectiveAt: clock.now().toISOString(),
    });
  }

  it("stores client-proposed bootstrap/session digests and replays lost responses without returning a secret", async () => {
    const active = await activate("phase3c-replay-installation");
    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/mobile/heartbeat",
      headers: auth(active.session),
      payload: heartbeatPayload(active.deviceId),
    });
    expect(heartbeat.statusCode).toBe(200);
  });

  it("fails closed for a stale or unknown policy instead of trusting client policy text", async () => {
    const paired = await redeem("phase3c-policy-installation");
    const requestId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/v1/mobile/activate",
      headers: { ...auth(paired.bootstrap), "idempotency-key": requestId },
      payload: {
        requestId,
        proposedSessionCredential: credential("cls", "unknown-policy-session"),
        policy: { id: randomUUID(), contentHash: "f".repeat(64) },
        consent: { acceptedAt: "2026-07-14T12:00:00.000Z", purpose: "call_metadata" },
        permissions: {
          callLog: "granted",
          phoneState: "granted",
          contacts: "denied",
          notifications: "granted",
          recordingFiles: "unknown",
          backgroundExecution: "granted",
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(json<Failure>(response).error.code).toBe("CONSENT_REQUIRED");
  });

  it("replays activation after bootstrap consumption even when consent time and current policy later change", async () => {
    const paired = await redeem("phase3c-late-activation-replay");
    const policyResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(paired.bootstrap),
    });
    const policy = json<Success<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
    const requestId = randomUUID();
    const payload = {
      requestId,
      proposedSessionCredential: credential("cls", "late-activation-session"),
      policy,
      consent: { acceptedAt: "2026-07-14T12:00:00.000Z", purpose: "call_metadata" },
      permissions: heartbeatPayload("unused").permissions,
    };
    const options = {
      method: "POST" as const,
      url: "/v1/mobile/activate",
      headers: { ...auth(paired.bootstrap), "idempotency-key": requestId },
      payload,
    };
    const first = await app.inject(options);
    expect(first.statusCode).toBe(201);
    repository.setMobilePolicyForTesting({
      id: "44444444-4444-4444-8444-444444444444",
      contentHash: "b".repeat(64),
      policyVersion: "call-metadata-v4",
      disclosureVersion: "prominent-disclosure-v4",
      collectionMode: "android_call_log",
      purpose: "call_metadata",
      title: "Later policy",
      summary: "Later policy summary",
      disclosures: ["Later disclosure"],
      effectiveAt: "2026-07-14T12:00:00.000Z",
    });
    clock.advanceMinutes(30);
    const replay = await app.inject(options);
    expect(replay.statusCode).toBe(201);
    expect(json<Success<unknown>>(replay).data).toEqual(json<Success<unknown>>(first).data);
  });

  it("requires consent refresh for delayed first delivery before either flow mutates trust state", async () => {
    const paired = await redeem("phase3c-stale-fresh-activation");
    const policyResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(paired.bootstrap),
    });
    const policy = json<Success<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
    const staleActivationId = randomUUID();
    const rejectedActivation = await app.inject({
      method: "POST",
      url: "/v1/mobile/activate",
      headers: { ...auth(paired.bootstrap), "idempotency-key": staleActivationId },
      payload: {
        requestId: staleActivationId,
        proposedSessionCredential: credential("cls", "stale-fresh-activation"),
        policy,
        consent: { acceptedAt: "2026-07-14T11:40:00.000Z", purpose: "call_metadata" },
        permissions: heartbeatPayload("unused").permissions,
      },
    });
    expect(rejectedActivation.statusCode).toBe(409);
    expect(json<Failure>(rejectedActivation).error.code).toBe("CONSENT_REQUIRED");
    expect((await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(credential("cls", "stale-fresh-activation")),
    })).statusCode).toBe(401);

    const active = await activate("phase3c-stale-fresh-reconsent");
    const staleReconsentId = randomUUID();
    const rejectedReconsent = await app.inject({
      method: "POST",
      url: "/v1/mobile/reconsent",
      headers: { ...auth(active.session), "idempotency-key": staleReconsentId },
      payload: {
        requestId: staleReconsentId,
        policy,
        consent: { acceptedAt: "2026-07-14T11:40:00.000Z", purpose: "call_metadata" },
        permissions: heartbeatPayload("unused", "denied").permissions,
      },
    });
    expect(rejectedReconsent.statusCode).toBe(409);
    expect(json<Failure>(rejectedReconsent).error.code).toBe("CONSENT_REQUIRED");
    expect((await repository.findDevice("org_alpha", active.deviceId))?.permissions.callLog).toBe("granted");
  });

  it("requires header/body idempotency agreement and rejects request reuse with a changed proposed secret", async () => {
    const code = await pairingCode();
    const requestId = randomUUID();
    const payload = {
      requestId,
      proposedBootstrapCredential: credential("clb", "header-mismatch"),
      code,
      installationId: "header-mismatch-installation",
      collectionMode: "android_call_log",
      platform: "android",
      osVersion: "16",
      appVersion: "0.3.0",
      permissions: heartbeatPayload("unused", "unknown").permissions,
    };
    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": randomUUID() },
      payload,
    });
    expect(mismatch.statusCode).toBe(400);

    const first = await app.inject({
      method: "POST",
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": requestId },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const changed = await app.inject({
      method: "POST",
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": requestId },
      payload: { ...payload, proposedBootstrapCredential: credential("clb", "changed-secret") },
    });
    expect(changed.statusCode).toBe(409);
  });

  it("does not let a device override the admin-bound collection mode", async () => {
    const requestId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": requestId },
      payload: {
        requestId,
        proposedBootstrapCredential: credential("clb", "mode-override"),
        code: await pairingCode("android_call_log"),
        installationId: "mode-override-installation",
        collectionMode: "synthetic_demo",
        platform: "android",
        osVersion: "16",
        appVersion: "0.3.0",
        permissions: heartbeatPayload("unused", "unknown").permissions,
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it("keeps the old session active until a proposed rotation is acknowledged and replays revocation", async () => {
    const active = await activate("phase3c-rotation-installation");
    const nextSession = credential("cls", "phase3c-rotation-next");
    const rotateRequestId = randomUUID();
    const prepared = await app.inject({
      method: "POST",
      url: "/v1/mobile/session/rotation/prepare",
      headers: { ...auth(active.session), "idempotency-key": rotateRequestId },
      payload: { requestId: rotateRequestId, proposedSessionCredential: nextSession },
    });
    expect(prepared.statusCode).toBe(200);
    expect(json<Success<unknown>>(prepared).data).not.toHaveProperty("token");

    expect((await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(nextSession),
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/v1/mobile/heartbeat",
      headers: auth(nextSession),
      payload: heartbeatPayload(active.deviceId),
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/v1/mobile/call-batches",
      headers: { ...auth(nextSession), "idempotency-key": "phase3c-batch-0001" },
      payload: callBatch(active.deviceId),
    })).statusCode).toBe(401);

    const oldPolicy = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(active.session),
    });
    expect(oldPolicy.statusCode).toBe(200);

    const confirmRequestId = randomUUID();
    const confirmed = await app.inject({
      method: "POST",
      url: "/v1/mobile/session/rotation/confirm",
      headers: { ...auth(nextSession), "idempotency-key": confirmRequestId },
      payload: { requestId: confirmRequestId, prepareRequestId: rotateRequestId },
    });
    expect(confirmed.statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(active.session),
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(nextSession),
    })).statusCode).toBe(200);

    const revokeRequestId = randomUUID();
    const revokeOptions = {
      method: "DELETE" as const,
      url: "/v1/mobile/session",
      headers: { ...auth(nextSession), "idempotency-key": revokeRequestId },
      payload: { requestId: revokeRequestId },
    };
    const revoked = await app.inject(revokeOptions);
    const replay = await app.inject(revokeOptions);
    expect(revoked.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(json<Success<unknown>>(replay).data).toEqual(json<Success<unknown>>(revoked).data);
    const differentRequestId = randomUUID();
    const changedRevoke = await app.inject({
      method: "DELETE",
      url: "/v1/mobile/session",
      headers: { ...auth(nextSession), "idempotency-key": differentRequestId },
      payload: { requestId: differentRequestId },
    });
    expect(changedRevoke.statusCode).toBe(401);
  });

  it("recovers an exact lost rotation-prepare response after source expiry and policy rollout", async () => {
    const active = await activate("phase3c-lost-rotation-prepare");
    clock.advanceMinutes(7 * 24 * 60 - 1);
    const nextSession = credential("cls", "phase3c-lost-rotation-next");
    const requestId = randomUUID();
    const request = {
      method: "POST" as const,
      url: "/v1/mobile/session/rotation/prepare",
      headers: { ...auth(active.session), "idempotency-key": requestId },
      payload: { requestId, proposedSessionCredential: nextSession },
    };
    const committed = await app.inject(request);
    expect(committed.statusCode).toBe(200);

    repository.setMobilePolicyForTesting({
      id: "66666666-6666-4666-8666-666666666666",
      contentHash: "d".repeat(64),
      policyVersion: "call-metadata-v6",
      disclosureVersion: "prominent-disclosure-v6",
      collectionMode: "android_call_log",
      purpose: "call_metadata",
      title: "Rolled collection policy",
      summary: "A newer authoritative policy.",
      disclosures: ["Updated disclosure"],
      effectiveAt: clock.now().toISOString(),
    });
    clock.advanceMinutes(2);

    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(json<Success<unknown>>(replay).data).toEqual(json<Success<unknown>>(committed).data);

    const changedRequestId = randomUUID();
    const fresh = await app.inject({
      method: "POST",
      url: "/v1/mobile/session/rotation/prepare",
      headers: { ...auth(active.session), "idempotency-key": changedRequestId },
      payload: {
        requestId: changedRequestId,
        proposedSessionCredential: credential("cls", "phase3c-fresh-expired-source"),
      },
    });
    expect(fresh.statusCode).toBe(401);

    const confirmRequestId = randomUUID();
    const confirmed = await app.inject({
      method: "POST",
      url: "/v1/mobile/session/rotation/confirm",
      headers: { ...auth(nextSession), "idempotency-key": confirmRequestId },
      payload: { requestId: confirmRequestId, prepareRequestId: requestId },
    });
    expect(confirmed.statusCode).toBe(200);
  });

  it("allows activation before READ_CALL_LOG grant, keeps ingest closed, then accepts a granted heartbeat", async () => {
    const paired = await redeem("phase3c-permission-sequence");
    const policyResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(paired.bootstrap),
    });
    const policy = json<Success<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
    const sessionToken = credential("cls", "permission-sequence-session");
    const activationRequestId = randomUUID();
    const activation = await app.inject({
      method: "POST",
      url: "/v1/mobile/activate",
      headers: { ...auth(paired.bootstrap), "idempotency-key": activationRequestId },
      payload: {
        requestId: activationRequestId,
        proposedSessionCredential: sessionToken,
        policy,
        consent: { acceptedAt: "2026-07-14T12:00:00.000Z", purpose: "call_metadata" },
        permissions: heartbeatPayload("unused", "unknown").permissions,
      },
    });
    expect(activation.statusCode).toBe(201);
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/mobile/call-batches",
      headers: { ...auth(sessionToken), "idempotency-key": "phase3c-batch-0001" },
      payload: callBatch(paired.deviceId),
    });
    expect(blocked.statusCode).toBe(403);
    const granted = await app.inject({
      method: "POST",
      url: "/v1/mobile/heartbeat",
      headers: auth(sessionToken),
      payload: heartbeatPayload(paired.deviceId, "granted"),
    });
    expect(granted.statusCode).toBe(200);
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/mobile/call-batches",
      headers: { ...auth(sessionToken), "idempotency-key": "phase3c-batch-0001" },
      payload: callBatch(paired.deviceId),
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("directs stale consent, blocks ingest, and resumes only after exact-policy re-consent", async () => {
    const active = await activate("phase3c-reconsent-installation");
    repository.setMobilePolicyForTesting({
      id: "33333333-3333-4333-8333-333333333333",
      contentHash: "a".repeat(64),
      policyVersion: "call-metadata-v3",
      disclosureVersion: "prominent-disclosure-v3",
      collectionMode: "android_call_log",
      purpose: "call_metadata",
      title: "Updated collection policy",
      summary: "Updated authoritative disclosure.",
      disclosures: ["Updated disclosure"],
      effectiveAt: "2026-07-14T12:00:00.000Z",
    });
    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/mobile/heartbeat",
      headers: auth(active.session),
      payload: heartbeatPayload(active.deviceId),
    });
    expect(json<Success<{ directives: Array<{ type: string; policyId: string }> }>>(heartbeat).data.directives)
      .toEqual([expect.objectContaining({ type: "consent_required", policyId: "33333333-3333-4333-8333-333333333333" })]);
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/mobile/call-batches",
      headers: { ...auth(active.session), "idempotency-key": "phase3c-batch-0001" },
      payload: callBatch(active.deviceId),
    });
    expect(blocked.statusCode).toBe(409);
    expect(json<Failure>(blocked).error.code).toBe("CONSENT_REQUIRED");

    const policyResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(active.session),
    });
    const policy = json<Success<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
    const reconsentRequestId = randomUUID();
    const reconsent = await app.inject({
      method: "POST",
      url: "/v1/mobile/reconsent",
      headers: { ...auth(active.session), "idempotency-key": reconsentRequestId },
      payload: {
        requestId: reconsentRequestId,
        policy,
        consent: { acceptedAt: "2026-07-14T12:00:00.000Z", purpose: "call_metadata" },
        permissions: heartbeatPayload("unused").permissions,
      },
    });
    expect(reconsent.statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/v1/mobile/call-batches",
      headers: { ...auth(active.session), "idempotency-key": "phase3c-batch-0001" },
      payload: callBatch(active.deviceId),
    })).statusCode).toBe(200);
    repository.setMobilePolicyForTesting({
      id: "55555555-5555-4555-8555-555555555555",
      contentHash: "c".repeat(64),
      policyVersion: "call-metadata-v5",
      disclosureVersion: "prominent-disclosure-v5",
      collectionMode: "android_call_log",
      purpose: "call_metadata",
      title: "Another later policy",
      summary: "Another later policy summary",
      disclosures: ["Another disclosure"],
      effectiveAt: "2026-07-14T12:00:00.000Z",
    });
    clock.advanceMinutes(30);
    const reconsentReplay = await app.inject({
      method: "POST",
      url: "/v1/mobile/reconsent",
      headers: { ...auth(active.session), "idempotency-key": reconsentRequestId },
      payload: {
        requestId: reconsentRequestId,
        policy,
        consent: { acceptedAt: "2026-07-14T12:00:00.000Z", purpose: "call_metadata" },
        permissions: heartbeatPayload("unused").permissions,
      },
    });
    expect(reconsentReplay.statusCode).toBe(200);
    expect(json<Success<unknown>>(reconsentReplay).data).toEqual(json<Success<unknown>>(reconsent).data);
    expect((await app.inject({
      method: "POST",
      url: "/v1/mobile/call-batches",
      headers: { ...auth(active.session), "idempotency-key": "phase3c-batch-0001" },
      payload: callBatch(active.deviceId),
    })).statusCode).toBe(409);
  });

  it("does not let an exact successful redemption replay clear accumulated invalid attempts", async () => {
    const requestId = randomUUID();
    const payload = {
      requestId,
      proposedBootstrapCredential: credential("clb", "limiter-replay-bootstrap"),
      code: await pairingCode(),
      installationId: "limiter-replay-installation",
      collectionMode: "android_call_log",
      platform: "android",
      osVersion: "16",
      appVersion: "0.3.0",
      permissions: heartbeatPayload("unused", "unknown").permissions,
    };
    const exactRequest = {
      method: "POST" as const,
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": requestId },
      payload,
    };
    expect((await app.inject(exactRequest)).statusCode).toBe(201);

    const invalidRequestId = randomUUID();
    const invalidRequest = {
      method: "POST" as const,
      url: "/v1/device-pairings/redeem",
      headers: { "idempotency-key": invalidRequestId },
      payload: { ...payload, requestId: invalidRequestId, code: "INVALID1" },
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await app.inject(invalidRequest)).statusCode).toBe(404);
    }
    expect((await app.inject(exactRequest)).statusCode).toBe(201);
    expect((await app.inject(invalidRequest)).statusCode).toBe(429);
  });

  it("trusts forwarded IPs only from configured proxies and sends digest-only limiter dimensions", async () => {
    const requestId = randomUUID();
    const installationId = "proxy-dimension-installation";
    const code = "INVALID1";
    const payload = {
      requestId,
      proposedBootstrapCredential: credential("clb", "proxy-dimension-bootstrap"),
      code,
      installationId,
      collectionMode: "android_call_log",
      platform: "android",
      osVersion: "16",
      appVersion: "0.3.0",
      permissions: heartbeatPayload("unused", "unknown").permissions,
    };
    const expectedNonIpKeys = [
      hashPairingRateLimitDimension(
        "code",
        hashPairingCode(code, config.authSecret),
        config.authSecret,
      ),
      hashPairingRateLimitDimension("installation", installationId, config.authSecret),
    ];

    for (const [trustedProxyCidrs, expectedIp] of [
      [[], "127.0.0.1"],
      [["127.0.0.1/32"], "203.0.113.19"],
    ] as const) {
      const limiter = new RecordingAttemptLimiter();
      const proxyApp = buildApp({
        config: { ...config, trustedProxyCidrs: [...trustedProxyCidrs] },
        repository,
        clock,
        pairingLimiter: limiter,
        logger: false,
      });
      try {
        const response = await proxyApp.inject({
          method: "POST",
          url: "/v1/device-pairings/redeem",
          remoteAddress: "127.0.0.1",
          headers: {
            "idempotency-key": requestId,
            "x-forwarded-for": "203.0.113.19",
          },
          payload,
        });
        expect(response.statusCode).toBe(404);
        expect(limiter.consumed).toEqual([
          hashPairingRateLimitDimension("ip", expectedIp, config.authSecret),
          ...expectedNonIpKeys,
        ]);
        expect(limiter.resetKeys).toEqual([]);
        expect(limiter.consumed.every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
        expect(limiter.consumed.join("")).not.toContain(installationId);
        expect(limiter.consumed.join("")).not.toContain(code);
      } finally {
        await proxyApp.close();
      }
    }
  });

  it("blocks distributed attempts against one code even when IP and installation rotate", async () => {
    const limiter = new PairingAttemptLimiter(clock, 2, 60);
    const limitedApp = buildApp({
      config,
      repository,
      clock,
      pairingLimiter: limiter,
      logger: false,
    });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const requestId = randomUUID();
        statuses.push((await limitedApp.inject({
          method: "POST",
          url: "/v1/device-pairings/redeem",
          remoteAddress: `198.51.100.${attempt + 10}`,
          headers: { "idempotency-key": requestId },
          payload: {
            requestId,
            proposedBootstrapCredential: credential("clb", `distributed-${attempt}`),
            code: "INVALID1",
            installationId: `distributed-installation-${attempt}`,
            collectionMode: "android_call_log",
            platform: "android",
            osVersion: "16",
            appVersion: "0.3.0",
            permissions: heartbeatPayload("unused", "unknown").permissions,
          },
        })).statusCode);
      }
      expect(statuses).toEqual([404, 404, 429]);
    } finally {
      await limitedApp.close();
    }
  });

  it("classifies an activation policy rollover after route lookup as consent-required", async () => {
    const paired = await redeem("activation-policy-race");
    const policyResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(paired.bootstrap),
    });
    const policy = json<Success<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
    const originalFindPolicy = repository.findCurrentMobilePolicy.bind(repository);
    let armed = true;
    repository.findCurrentMobilePolicy = async (context, at) => {
      const found = await originalFindPolicy(context, at);
      if (armed) {
        armed = false;
        rollPolicy("70000000-0000-4000-8000-000000000001", "7".repeat(64), "v7");
      }
      return found;
    };
    const requestId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/v1/mobile/activate",
      headers: { ...auth(paired.bootstrap), "idempotency-key": requestId },
      payload: {
        requestId,
        proposedSessionCredential: credential("cls", "activation-policy-race-session"),
        policy,
        consent: { acceptedAt: clock.now().toISOString(), purpose: "call_metadata" },
        permissions: heartbeatPayload("unused").permissions,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(json<Failure>(response).error.code).toBe("CONSENT_REQUIRED");
    expect((await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(paired.bootstrap),
    })).statusCode).toBe(200);
  });

  it("classifies a re-consent policy rollover after route lookup as consent-required", async () => {
    const active = await activate("reconsent-policy-race");
    rollPolicy("70000000-0000-4000-8000-000000000002", "8".repeat(64), "v8");
    const policyResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(active.session),
    });
    const policy = json<Success<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
    const originalFindPolicy = repository.findCurrentMobilePolicy.bind(repository);
    let armed = true;
    repository.findCurrentMobilePolicy = async (context, at) => {
      const found = await originalFindPolicy(context, at);
      if (armed) {
        armed = false;
        rollPolicy("70000000-0000-4000-8000-000000000003", "9".repeat(64), "v9");
      }
      return found;
    };
    const requestId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/v1/mobile/reconsent",
      headers: { ...auth(active.session), "idempotency-key": requestId },
      payload: {
        requestId,
        policy,
        consent: { acceptedAt: clock.now().toISOString(), purpose: "call_metadata" },
        permissions: heartbeatPayload("unused").permissions,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(json<Failure>(response).error.code).toBe("CONSENT_REQUIRED");
  });

  it("classifies a rotation-prepare policy rollover inside the repository as consent-required", async () => {
    const active = await activate("rotation-policy-race");
    const originalPrepare = repository.prepareDeviceSessionRotation.bind(repository);
    repository.prepareDeviceSessionRotation = async (options) => {
      rollPolicy("70000000-0000-4000-8000-000000000004", "a".repeat(64), "v10");
      return originalPrepare(options);
    };
    const requestId = randomUUID();
    const pending = credential("cls", "rotation-policy-race-pending");
    const response = await app.inject({
      method: "POST",
      url: "/v1/mobile/session/rotation/prepare",
      headers: { ...auth(active.session), "idempotency-key": requestId },
      payload: { requestId, proposedSessionCredential: pending },
    });
    expect(response.statusCode).toBe(409);
    expect(json<Failure>(response).error.code).toBe("CONSENT_REQUIRED");
    expect((await app.inject({
      method: "GET",
      url: "/v1/mobile/collection-policy",
      headers: auth(pending),
    })).statusCode).toBe(401);
  });

  it("classifies a call-batch policy rollover inside the transaction as consent-required", async () => {
    const active = await activate("batch-policy-race");
    const originalIngest = repository.ingestMobileCallBatch.bind(repository);
    repository.ingestMobileCallBatch = async (options) => {
      rollPolicy("70000000-0000-4000-8000-000000000005", "b".repeat(64), "v11");
      return originalIngest(options);
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/mobile/call-batches",
      headers: { ...auth(active.session), "idempotency-key": "phase3c-batch-0001" },
      payload: callBatch(active.deviceId),
    });
    expect(response.statusCode).toBe(409);
    expect(json<Failure>(response).error.code).toBe("CONSENT_REQUIRED");
    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/mobile/heartbeat",
      headers: auth(active.session),
      payload: heartbeatPayload(active.deviceId),
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(json<Success<{ directives: Array<{ type: string }> }>>(heartbeat).data.directives)
      .toContainEqual(expect.objectContaining({ type: "consent_required" }));
  });
});

describe("bounded in-process pairing limiter", () => {
  it("fails closed at capacity and evicts expired keys without an unbounded map", () => {
    const clock = new FixedClock();
    const limiter = new PairingAttemptLimiter(clock, 3, 60, 2);
    limiter.consumeAttempt("one");
    limiter.consumeAttempt("two");
    expect(limiter.trackedKeyCount()).toBe(2);
    expect(() => limiter.consumeAttempt("three")).toThrow(/Too many pairing attempts/);
    clock.advanceMinutes(2);
    expect(limiter.trackedKeyCount()).toBe(0);
    expect(() => limiter.consumeAttempt("three")).not.toThrow();
    expect(limiter.trackedKeyCount()).toBe(1);
  });
});
