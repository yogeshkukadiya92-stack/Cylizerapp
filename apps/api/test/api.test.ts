import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  OidcBearerVerificationError,
  type OidcBearerVerifier,
} from "../src/auth/index.js";
import type { ApiConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { InMemoryCalloraRepository, SequentialIdGenerator, SequentialPairingCodeGenerator } from "../src/repository.js";
import type { Clock } from "../src/security.js";
import { createDownloadToken, hashDownloadToken } from "../src/report-workflows.js";

class MutableClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  advanceSeconds(seconds: number): void {
    this.value = new Date(this.value.getTime() + seconds * 1_000);
  }
}

const config: ApiConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4100,
  authSecret: "test-secret-with-more-than-thirty-two-characters",
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

interface SuccessPayload<T> {
  ok: true;
  data: T;
  requestId: string;
}

interface FailurePayload {
  ok: false;
  error: { code: string; message: string; retryAfterSeconds?: number };
  requestId: string;
}

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

async function session(
  app: FastifyInstance,
  organizationId = "org_alpha",
  role = "owner",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/dev/session",
    payload: { organizationId, role },
  });
  expect(response.statusCode).toBe(200);
  return json<SuccessPayload<{ accessToken: string }>>(response).data.accessToken;
}

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function deviceCredential(prefix: "clb" | "cls", seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("base64url")}`;
}

function redemptionRequest(code: string, installationId: string, extra: Record<string, unknown> = {}) {
  const requestId = randomUUID();
  const bootstrap = deviceCredential("clb", `${installationId}:bootstrap`);
  return {
    bootstrap,
    requestId,
    headers: { "idempotency-key": requestId },
    payload: {
      requestId,
      proposedBootstrapCredential: bootstrap,
      code,
      installationId,
      collectionMode: "android_call_log",
      platform: "android",
      osVersion: "16",
      appVersion: "0.1.0",
      permissions,
      ...extra,
    },
  };
}

const permissions = {
  callLog: "granted",
  phoneState: "granted",
  contacts: "denied",
  notifications: "granted",
  recordingFiles: "unknown",
  backgroundExecution: "granted",
} as const;

const replicaSafeLimiter = {
  isReplicaSafe: true as const,
  consumeAttempt(): void {},
  reset(): void {},
};

describe("Callora API", () => {
  let app: FastifyInstance;
  let repository: InMemoryCalloraRepository;
  let clock: MutableClock;

  beforeEach(() => {
    repository = new InMemoryCalloraRepository(new SequentialIdGenerator());
    clock = new MutableClock(new Date("2026-07-14T12:00:00.000Z"));
    app = buildApp({
      config,
      repository,
      clock,
      idGenerator: new SequentialIdGenerator(),
      pairingCodeGenerator: new SequentialPairingCodeGenerator(),
      reportArtifactReader: { get: async () => ({ body: new TextEncoder().encode("xlsx-bytes"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "callora-report.xlsx" }) },
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe("operational safety and authentication", () => {
    it("reports liveness and repository readiness", async () => {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(json<SuccessPayload<{ status: string }>>(health).data.status).toBe("ok");

      repository.setReady(false);
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(json<FailurePayload>(ready).error.code).toBe("SERVICE_UNAVAILABLE");
    });

    it("issues a signed development session and rejects missing or tampered tokens", async () => {
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/v1/dev/session",
        payload: { organizationId: "org_alpha", role: "owner" },
      });
      const sessionPayload = json<SuccessPayload<{
        accessToken: string;
        tokenType: string;
        actor: { organizationId: string; role: string; permissions: string[] };
      }>>(sessionResponse);
      expect(sessionPayload.data.tokenType).toBe("Bearer");
      expect(sessionPayload.data.actor).toMatchObject({ organizationId: "org_alpha", role: "owner" });
      expect(sessionPayload.data.actor.permissions).toContain("employees.manage");

      const missing = await app.inject({ method: "GET", url: "/v1/employees" });
      expect(missing.statusCode).toBe(401);

      const tampered = await app.inject({
        method: "GET",
        url: "/v1/employees",
        headers: authorization(`${sessionPayload.data.accessToken}tampered`),
      });
      expect(tampered.statusCode).toBe(401);
      expect(json<FailurePayload>(tampered).error.code).toBe("UNAUTHENTICATED");

      clock.advanceSeconds(config.tokenTtlSeconds);
      const expired = await app.inject({
        method: "GET",
        url: "/v1/employees",
        headers: authorization(sessionPayload.data.accessToken),
      });
      expect(expired.statusCode).toBe(401);
      expect(json<FailurePayload>(expired).error.message).toMatch(/expired/);
    });

    it("does not register development auth in production and refuses insecure production defaults", async () => {
      expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/AUTH_SECRET/);
      expect(() => loadConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "production-secret-with-more-than-thirty-two-characters",
        CORS_ALLOWED_ORIGINS: "*",
      })).toThrow(/wildcard/);
      expect(() => loadConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "production-secret-with-more-than-thirty-two-characters",
      })).toThrow(/DATABASE_URL/);
      expect(() => loadConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "production-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: "postgresql://callora@example.test/callora?sslmode=disable",
      })).toThrow(/DATABASE_SSL_MODE/);
      expect(() => loadConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "production-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: "postgresql://callora@example.test/callora",
        DATABASE_SSL_MODE: "require",
      })).toThrow(/verify-full/);
      expect(loadConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "production-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: "postgresql://callora@example.test/callora",
        TRUSTED_PROXY_CIDRS: "10.0.0.0/8,2001:db8::/32",
      })).toMatchObject({
        trustedProxyCidrs: ["10.0.0.0/8", "2001:db8::/32"],
        database: {
        maxConnections: 10,
        statementTimeoutMs: 5_000,
        sslMode: "verify-full",
        },
      });
      for (const trustedProxyCidrs of ["0.0.0.0/0", "::/0", "proxy.internal", "10.0.0.1"]) {
        expect(() => loadConfig({
          NODE_ENV: "production",
          AUTH_SECRET: "production-secret-with-more-than-thirty-two-characters",
          DATABASE_URL: "postgresql://callora@example.test/callora",
          TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
        })).toThrow(/TRUSTED_PROXY_CIDRS/);
      }
      expect(() => loadConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "production-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: "postgresql://callora@example.test/callora",
        DEVICE_BOOTSTRAP_TTL_SECONDS: "601",
      })).toThrow(/DEVICE_BOOTSTRAP_TTL_SECONDS/);
      expect(() => loadConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "production-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: "postgresql://callora@example.test/callora",
        DEVICE_SESSION_TTL_SECONDS: "604801",
      })).toThrow(/DEVICE_SESSION_TTL_SECONDS/);
      const productionConfig = { ...config, environment: "production" as const, enableDevAuth: true };
      expect(() => buildApp({ config: productionConfig })).toThrow(/durable production/);
      expect(() => buildApp({ config: productionConfig, repository, clock, logger: false })).toThrow(/OIDC bearer verifier/);

      const oidcVerifier: OidcBearerVerifier = {
        async verify() {
          return {
            issuer: "https://identity.example.test",
            subject: "external-owner",
            organizationId: "org_alpha",
          };
        },
      };
      expect(() => buildApp({
        config: productionConfig,
        repository,
        oidcVerifier,
        clock,
        logger: false,
      })).toThrow(/replica-safe shared pairing limiter/);

      const productionApp = buildApp({
        config: productionConfig,
        repository,
        oidcVerifier,
        clock,
        pairingLimiter: replicaSafeLimiter,
        logger: false,
      });
      const response = await productionApp.inject({
        method: "POST",
        url: "/v1/dev/session",
        payload: { organizationId: "org_alpha", role: "owner" },
      });
      expect(response.statusCode).toBe(404);

      const simulatedIngest = await productionApp.inject({
        method: "POST",
        url: "/v1/calls/ingest/simulated",
        headers: { "idempotency-key": "production-route-check" },
        payload: {},
      });
      expect(simulatedIngest.statusCode).toBe(404);
      await productionApp.close();
    });

    it("resolves a production OIDC identity only through its exact external mapping", async () => {
      const productionConfig = { ...config, environment: "production" as const, enableDevAuth: false };
      repository.linkExternalIdentity({
        issuer: "https://identity.example.test",
        subject: "external-owner",
        organizationId: "org_alpha",
        userId: "user_org_alpha_owner",
      });
      repository.linkExternalIdentity({
        issuer: "https://identity.example.test",
        subject: "external-inactive",
        organizationId: "org_alpha",
        userId: "user_org_alpha_admin",
      });
      repository.setUserStatus("user_org_alpha_admin", "suspended");
      const oidcVerifier: OidcBearerVerifier = {
        async verify(token) {
          if (token === "invalid-token") {
            throw new OidcBearerVerificationError("invalid_token");
          }
          if (token === "verifier-failure-token") {
            throw new Error("provider unavailable");
          }
          return {
            issuer: token === "wrong-issuer-token"
              ? "https://other-identity.example.test"
              : "https://identity.example.test",
            subject: token === "wrong-subject-token"
              ? "other-external-owner"
              : token === "inactive-token"
                ? "external-inactive"
                : "external-owner",
            organizationId: token === "cross-tenant-token" ? "org_beta" : "org_alpha",
          };
        },
      };
      const productionApp = buildApp({
        config: productionConfig,
        repository,
        oidcVerifier,
        clock,
        pairingLimiter: replicaSafeLimiter,
        logger: false,
      });

      const accepted = await productionApp.inject({
        method: "GET",
        url: "/v1/session",
        headers: authorization("valid-token"),
      });
      expect(accepted.statusCode).toBe(200);
      expect(json<SuccessPayload<{ organizationId: string; userId: string }>>(accepted).data).toMatchObject({
        organizationId: "org_alpha",
        userId: "user_org_alpha_owner",
      });

      const failures = await Promise.all([
        "invalid-token",
        "verifier-failure-token",
        "cross-tenant-token",
        "wrong-issuer-token",
        "wrong-subject-token",
        "inactive-token",
      ].map((token) => productionApp.inject({
        method: "GET",
        url: "/v1/session",
        headers: authorization(token),
      })));
      const expectedFailure = {
        code: "UNAUTHENTICATED",
        message: "The bearer token is invalid",
      };
      for (const failure of failures) {
        expect(failure.statusCode).toBe(401);
        expect(json<FailurePayload>(failure).error).toMatchObject(expectedFailure);
      }

      await productionApp.close();
    });

    it("allows the configured web origin and withholds CORS from untrusted origins", async () => {
      const accepted = await app.inject({
        method: "OPTIONS",
        url: "/v1/employees",
        headers: {
          origin: "http://localhost:4173",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
      expect(accepted.statusCode).toBe(204);
      expect(accepted.headers["access-control-allow-origin"]).toBe("http://localhost:4173");
      expect(accepted.headers["access-control-allow-credentials"]).toBeUndefined();

      const rejected = await app.inject({
        method: "OPTIONS",
        url: "/v1/employees",
        headers: {
          origin: "https://untrusted.example",
          "access-control-request-method": "GET",
        },
      });
      expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("tenant context and RBAC", () => {
    it("isolates employee reads and mutations across organizations", async () => {
      const alphaToken = await session(app, "org_alpha", "owner");
      const betaToken = await session(app, "org_beta", "owner");

      const createdResponse = await app.inject({
        method: "POST",
        url: "/v1/employees",
        headers: authorization(alphaToken),
        payload: { displayName: "Alpha Only", email: "alpha.only@example.test", team: "Sales" },
      });
      expect(createdResponse.statusCode).toBe(201);
      const created = json<SuccessPayload<{ id: string; organizationId: string }>>(createdResponse).data;
      expect(created.organizationId).toBe("org_alpha");

      const betaList = await app.inject({ method: "GET", url: "/v1/employees", headers: authorization(betaToken) });
      const betaItems = json<SuccessPayload<{ items: Array<{ id: string; organizationId: string }> }>>(betaList).data.items;
      expect(betaItems.every((employee) => employee.organizationId === "org_beta")).toBe(true);
      expect(betaItems.map((employee) => employee.id)).not.toContain(created.id);

      const crossTenantSuspend = await app.inject({
        method: "POST",
        url: `/v1/employees/${created.id}/suspend`,
        headers: authorization(betaToken),
      });
      expect(crossTenantSuspend.statusCode).toBe(404);
    });

    it("enforces server-side role permissions", async () => {
      const analystToken = await session(app, "org_alpha", "analyst");
      const read = await app.inject({ method: "GET", url: "/v1/employees", headers: authorization(analystToken) });
      expect(read.statusCode).toBe(200);

      const write = await app.inject({
        method: "POST",
        url: "/v1/employees",
        headers: authorization(analystToken),
        payload: { displayName: "Not Authorized" },
      });
      expect(write.statusCode).toBe(403);
      expect(json<FailurePayload>(write).error.code).toBe("FORBIDDEN");

      const audit = await app.inject({ method: "GET", url: "/v1/audit-events", headers: authorization(analystToken) });
      expect(audit.statusCode).toBe(403);
    });

    it("keeps organization-wide routes fail-closed while lead-only manager and employee scopes are enabled", async () => {
      for (const role of ["manager", "employee"] as const) {
        const token = await session(app, "org_alpha", role);
        for (const url of ["/v1/employees", "/v1/calls", "/v1/dashboard/overview"] as const) {
          const response = await app.inject({ method: "GET", url, headers: authorization(token) });
          expect(response.statusCode, `${role} should not access ${url}`).toBe(403);
          expect(json<FailurePayload>(response).error.code).toBe("FORBIDDEN");
        }

        const simulatedIngest = await app.inject({
          method: "POST",
          url: "/v1/calls/ingest/simulated",
          headers: { ...authorization(token), "idempotency-key": `${role}-scope-check` },
          payload: {},
        });
        expect(simulatedIngest.statusCode).toBe(403);
      }

      const managerSession = await app.inject({
        method: "POST",
        url: "/v1/dev/session",
        payload: { organizationId: "org_alpha", role: "manager" },
      });
      expect(json<SuccessPayload<{ actor: { permissions: string[] } }>>(managerSession).data.actor.permissions)
        .toEqual([
          "organization.read",
          "employees.read",
          "calls.read",
          "calls.annotate",
          "leads.read",
          "leads.manage",
          "leads.assign",
          "reports.read",
        ]);

      const employeeSession = await app.inject({
        method: "POST",
        url: "/v1/dev/session",
        payload: { organizationId: "org_alpha", role: "employee" },
      });
      expect(json<SuccessPayload<{ actor: { permissions: string[] } }>>(employeeSession).data.actor.permissions)
        .toEqual(["organization.read", "leads.read", "leads.manage"]);

      const adminToken = await session(app, "org_alpha", "admin");
      for (const url of ["/v1/employees", "/v1/calls", "/v1/dashboard/overview"] as const) {
        const response = await app.inject({ method: "GET", url, headers: authorization(adminToken) });
        expect(response.statusCode, `admin should access ${url}`).toBe(200);
      }
    });

    it("masks analyst employee phone numbers when organization masking is enabled", async () => {
      const ownerToken = await session(app, "org_alpha", "owner");
      const analystToken = await session(app, "org_alpha", "analyst");

      const ownerList = await app.inject({ method: "GET", url: "/v1/employees", headers: authorization(ownerToken) });
      const analystList = await app.inject({ method: "GET", url: "/v1/employees", headers: authorization(analystToken) });
      const ownerEmployee = json<SuccessPayload<{ items: Array<{ id: string; primaryPhone?: string }> }>>(ownerList)
        .data.items.find((employee) => employee.id === "emp_alpha_amit");
      const analystEmployee = json<SuccessPayload<{ items: Array<{ id: string; primaryPhone?: string }> }>>(analystList)
        .data.items.find((employee) => employee.id === "emp_alpha_amit");

      expect(ownerEmployee?.primaryPhone).toBe("+919800000001");
      expect(analystEmployee?.primaryPhone).toBe("•••• 0001");
    });

    it("returns opaque cursor-paginated employees without overlap", async () => {
      const token = await session(app);
      const first = await app.inject({ method: "GET", url: "/v1/employees?limit=1", headers: authorization(token) });
      const firstData = json<SuccessPayload<{ items: Array<{ id: string }>; cursorInfo: { hasMore: boolean; nextCursor: string } }>>(first).data;
      expect(firstData.items).toHaveLength(1);
      expect(firstData.cursorInfo.hasMore).toBe(true);

      const second = await app.inject({
        method: "GET",
        url: `/v1/employees?limit=1&cursor=${encodeURIComponent(firstData.cursorInfo.nextCursor)}`,
        headers: authorization(token),
      });
      const secondData = json<SuccessPayload<{ items: Array<{ id: string }> }>>(second).data;
      expect(secondData.items).toHaveLength(1);
      expect(secondData.items[0]?.id).not.toBe(firstData.items[0]?.id);
    });
  });

  describe("device pairing", () => {
    it("redeems a pairing code once, returns one bootstrap credential, and activates only after consent", async () => {
      const token = await session(app);
      const created = await app.inject({
        method: "POST",
        url: "/v1/employees/emp_alpha_priya/pairing-codes",
        headers: authorization(token),
        payload: { ttlSeconds: 120 },
      });
      expect(created.statusCode).toBe(201);
      const pairing = json<SuccessPayload<{ id: string; code: string }>>(created).data;

      const redemptionRequestData = redemptionRequest(pairing.code, "new-installation-1");
      const redeemed = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: redemptionRequestData.headers,
        payload: redemptionRequestData.payload,
      });
      expect(redeemed.statusCode).toBe(201);
      const redemption = json<SuccessPayload<{
        device: { id: string; employeeId: string; status: string };
        bootstrapCredential: { tokenType: string; expiresAt: string; token?: string };
      }>>(redeemed).data;
      expect(redemption.device).toMatchObject({ employeeId: "emp_alpha_priya", status: "pending" });
      expect(redemption.bootstrapCredential).toMatchObject({ tokenType: "Bearer" });
      expect(redemption.bootstrapCredential).not.toHaveProperty("token");

      const pendingEmployee = await repository.findEmployee("org_alpha", "emp_alpha_priya");
      expect(pendingEmployee?.status).toBe("invited");

      const policyResponse = await app.inject({
        method: "GET",
        url: "/v1/mobile/collection-policy",
        headers: authorization(redemptionRequestData.bootstrap),
      });
      const policy = json<SuccessPayload<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
      const activationRequestId = randomUUID();
      const proposedSessionCredential = deviceCredential("cls", "new-installation-1:session");
      const activated = await app.inject({
        method: "POST",
        url: "/v1/mobile/activate",
        headers: { ...authorization(redemptionRequestData.bootstrap), "idempotency-key": activationRequestId },
        payload: {
          requestId: activationRequestId,
          proposedSessionCredential,
          policy,
          consent: {
            acceptedAt: clock.now().toISOString(),
            purpose: "call_metadata",
            locale: "en-IN",
          },
          permissions,
        },
      });
      expect(activated.statusCode).toBe(201);
      const activation = json<SuccessPayload<{
        device: { status: string };
        sessionCredential: { tokenType: string; expiresAt: string; token?: string };
      }>>(activated).data;
      expect(activation.device.status).toBe("connected");
      expect(activation.sessionCredential).not.toHaveProperty("token");

      const reusedRequestId = randomUUID();
      const reusedBootstrap = await app.inject({
        method: "POST",
        url: "/v1/mobile/activate",
        headers: { ...authorization(redemptionRequestData.bootstrap), "idempotency-key": reusedRequestId },
        payload: {
          requestId: reusedRequestId,
          proposedSessionCredential: deviceCredential("cls", "new-installation-1:second-session"),
          policy,
          consent: {
            acceptedAt: clock.now().toISOString(),
            purpose: "call_metadata",
          },
          permissions,
        },
      });
      expect(reusedBootstrap.statusCode).toBe(401);
      expect(json<FailurePayload>(reusedBootstrap).error.message).toBe("The device credential is invalid");

      const repeatedRequest = redemptionRequest(pairing.code, "new-installation-1");
      const repeated = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: repeatedRequest.headers,
        payload: repeatedRequest.payload,
      });
      expect(repeated.statusCode).toBe(409);
      expect(json<FailurePayload>(repeated).error.message).toMatch(/already been used/);

      const employee = await repository.findEmployee("org_alpha", "emp_alpha_priya");
      expect(employee?.status).toBe("active");
      expect(employee?.deviceIds).toHaveLength(1);
    });

    it("expires bootstrap credentials after the configured ten-minute maximum", async () => {
      const token = await session(app);
      const created = await app.inject({
        method: "POST",
        url: "/v1/employees/emp_alpha_priya/pairing-codes",
        headers: authorization(token),
        payload: { ttlSeconds: 120 },
      });
      const pairing = json<SuccessPayload<{ code: string }>>(created).data;
      const redemption = redemptionRequest(pairing.code, "expiring-bootstrap-installation");
      const redeemed = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: redemption.headers,
        payload: redemption.payload,
      });
      expect(redeemed.statusCode).toBe(201);
      const policyResponse = await app.inject({
        method: "GET",
        url: "/v1/mobile/collection-policy",
        headers: authorization(redemption.bootstrap),
      });
      const policy = json<SuccessPayload<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
      clock.advanceSeconds(601);
      const requestId = randomUUID();
      const expired = await app.inject({
        method: "POST",
        url: "/v1/mobile/activate",
        headers: { ...authorization(redemption.bootstrap), "idempotency-key": requestId },
        payload: {
          requestId,
          proposedSessionCredential: deviceCredential("cls", "expiring-bootstrap:session"),
          policy,
          consent: {
            acceptedAt: clock.now().toISOString(),
            purpose: "call_metadata",
          },
          permissions,
        },
      });
      expect(expired.statusCode).toBe(401);
      expect(json<FailurePayload>(expired).error.message).toBe("The device credential is invalid");
    });

    it("rejects revoked and expired codes", async () => {
      const token = await session(app);
      const createPairing = async (installationId: string): Promise<{ id: string; code: string; installationId: string }> => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/employees/emp_alpha_priya/pairing-codes",
          headers: authorization(token),
          payload: { ttlSeconds: 60 },
        });
        return { ...json<SuccessPayload<{ id: string; code: string }>>(response).data, installationId };
      };

      const revokedPairing = await createPairing("revoked-installation");
      const revoke = await app.inject({
        method: "DELETE",
        url: `/v1/pairing-codes/${revokedPairing.id}`,
        headers: authorization(token),
      });
      expect(revoke.statusCode).toBe(200);
      const revokedRequest = redemptionRequest(revokedPairing.code, revokedPairing.installationId);
      const revokedRedeem = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: revokedRequest.headers,
        payload: revokedRequest.payload,
      });
      expect(revokedRedeem.statusCode).toBe(409);

      const expiredPairing = await createPairing("expired-installation");
      clock.advanceSeconds(61);
      const expiredRequest = redemptionRequest(expiredPairing.code, expiredPairing.installationId);
      const expiredRedeem = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: expiredRequest.headers,
        payload: expiredRequest.payload,
      });
      expect(expiredRedeem.statusCode).toBe(409);
      expect(json<FailurePayload>(expiredRedeem).error.message).toMatch(/expired/);
    });

    it("rate limits repeated invalid redemption attempts", async () => {
      const invalidRequest = redemptionRequest("INVALID1", "rate-limit-installation");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/device-pairings/redeem",
          headers: invalidRequest.headers,
          payload: invalidRequest.payload,
        });
        expect(response.statusCode).toBe(404);
      }
      const limited = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: invalidRequest.headers,
        payload: invalidRequest.payload,
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(json<FailurePayload>(limited).error).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 60 });
    });
  });

  describe("mobile device sessions and synchronization", () => {
    async function pairAndActivate(installationId: string): Promise<{
      deviceId: string;
      bootstrapToken: string;
      sessionToken: string;
    }> {
      const ownerToken = await session(app);
      const pairingResponse = await app.inject({
        method: "POST",
        url: "/v1/employees/emp_alpha_priya/pairing-codes",
        headers: authorization(ownerToken),
        payload: { ttlSeconds: 120 },
      });
      const pairing = json<SuccessPayload<{ code: string }>>(pairingResponse).data;
      const redemptionRequestData = redemptionRequest(pairing.code, installationId, {
        manufacturer: "Google",
        model: "Pixel",
      });
      const redemptionResponse = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: redemptionRequestData.headers,
        payload: redemptionRequestData.payload,
      });
      expect(redemptionResponse.statusCode).toBe(201);
      const redemption = json<SuccessPayload<{
        device: { id: string };
      }>>(redemptionResponse).data;
      const policyResponse = await app.inject({
        method: "GET",
        url: "/v1/mobile/collection-policy",
        headers: authorization(redemptionRequestData.bootstrap),
      });
      const policy = json<SuccessPayload<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
      const activationRequestId = randomUUID();
      const proposedSessionCredential = deviceCredential("cls", `${installationId}:session`);
      const activationResponse = await app.inject({
        method: "POST",
        url: "/v1/mobile/activate",
        headers: {
          ...authorization(redemptionRequestData.bootstrap),
          "idempotency-key": activationRequestId,
        },
        payload: {
          requestId: activationRequestId,
          proposedSessionCredential,
          policy,
          consent: {
            acceptedAt: clock.now().toISOString(),
            purpose: "call_metadata",
            locale: "en-IN",
          },
          permissions,
        },
      });
      expect(activationResponse.statusCode).toBe(201);
      return {
        deviceId: redemption.device.id,
        bootstrapToken: redemptionRequestData.bootstrap,
        sessionToken: proposedSessionCredential,
      };
    }

    function heartbeat(deviceId: string, override: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        schemaVersion: 1,
        organizationId: "org_alpha",
        employeeId: "emp_alpha_priya",
        deviceId,
        observedAt: clock.now().toISOString(),
        appVersion: "0.1.0",
        osVersion: "16",
        batteryPercent: 82,
        isCharging: false,
        networkType: "wifi",
        pendingCallCount: 0,
        pendingRecordingCount: 0,
        syncState: "idle",
        permissions,
        ...override,
      };
    }

    function callBatch(deviceId: string, override: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        schemaVersion: 1,
        collectionMode: "android_call_log",
        batchId: "android-batch-0001",
        organizationId: "org_alpha",
        employeeId: "emp_alpha_priya",
        deviceId,
        sentAt: clock.now().toISOString(),
        items: [{
          localId: "android-call-0001",
          nativeCallId: "native-row-1001",
          phoneNumber: "+919811112222",
          direction: "incoming",
          disposition: "answered",
          startedAt: "2026-07-14T11:50:00.000Z",
          answeredAt: "2026-07-14T11:50:02.000Z",
          endedAt: "2026-07-14T11:52:00.000Z",
          durationSeconds: 118,
          ringDurationSeconds: 2,
          isInternal: false,
          nativeLastModifiedAt: "2026-07-14T11:52:01.000Z",
        }],
        ...override,
      };
    }

    it("accepts heartbeats only for the exact device context and reports permission loss", async () => {
      const mobile = await pairAndActivate("heartbeat-installation");
      const accepted = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(mobile.sessionToken),
        payload: heartbeat(mobile.deviceId),
      });
      expect(accepted.statusCode).toBe(200);
      expect(json<SuccessPayload<{ nextHeartbeatAfterSeconds: number }>>(accepted).data.nextHeartbeatAfterSeconds).toBe(900);
      expect(await repository.findDevice("org_alpha", mobile.deviceId)).toMatchObject({
        lastHeartbeatAt: clock.now().toISOString(),
        batteryPercent: 82,
        isCharging: false,
        networkType: "wifi",
        pendingCallCount: 0,
        pendingRecordingCount: 0,
      });

      const mismatched = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(mobile.sessionToken),
        payload: heartbeat("device-from-another-context"),
      });
      expect(mismatched.statusCode).toBe(403);

      const deniedPermissions = { ...permissions, callLog: "denied" as const };
      const permissionLoss = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(mobile.sessionToken),
        payload: heartbeat(mobile.deviceId, { permissions: deniedPermissions }),
      });
      expect(permissionLoss.statusCode).toBe(200);
      const blockedSync = await app.inject({
        method: "POST",
        url: "/v1/mobile/call-batches",
        headers: { ...authorization(mobile.sessionToken), "idempotency-key": "android-batch-0001" },
        payload: callBatch(mobile.deviceId),
      });
      expect(blockedSync.statusCode).toBe(403);
      expect(json<FailurePayload>(blockedSync).error.message).toMatch(/call-log permission/);

      const syntheticDemo = await app.inject({
        method: "POST",
        url: "/v1/mobile/call-batches",
        headers: { ...authorization(mobile.sessionToken), "idempotency-key": "android-batch-0001" },
        payload: callBatch(mobile.deviceId, { collectionMode: "synthetic_demo" }),
      });
      expect(syntheticDemo.statusCode).toBe(403);
      expect(json<FailurePayload>(syntheticDemo).error.message).toMatch(/collection mode/i);
    });

    it("ingests a bounded batch atomically and returns the stored response on an exact retry", async () => {
      const mobile = await pairAndActivate("batch-installation");
      const payload = callBatch(mobile.deviceId);
      const mismatchedHeader = await app.inject({
        method: "POST",
        url: "/v1/mobile/call-batches",
        headers: { ...authorization(mobile.sessionToken), "idempotency-key": "different-key" },
        payload,
      });
      expect(mismatchedHeader.statusCode).toBe(400);
      expect(json<FailurePayload>(mismatchedHeader).error.message).toMatch(/exactly match/);

      const first = await app.inject({
        method: "POST",
        url: "/v1/mobile/call-batches",
        headers: { ...authorization(mobile.sessionToken), "idempotency-key": "android-batch-0001" },
        payload,
      });
      expect(first.statusCode).toBe(200);
      const firstData = json<SuccessPayload<{
        batchId: string;
        nextCursor: string;
        items: Array<{ localId: string; outcome: string; callLogId: string }>;
      }>>(first).data;
      expect(firstData).toMatchObject({
        batchId: "android-batch-0001",
        items: [{ localId: "android-call-0001", outcome: "created" }],
      });

      const retry = await app.inject({
        method: "POST",
        url: "/v1/mobile/call-batches",
        headers: { ...authorization(mobile.sessionToken), "idempotency-key": "android-batch-0001" },
        payload,
      });
      expect(retry.statusCode).toBe(200);
      expect(json<SuccessPayload<unknown>>(retry).data).toEqual(json<SuccessPayload<unknown>>(first).data);

      const conflictResponse = await app.inject({
        method: "POST",
        url: "/v1/mobile/call-batches",
        headers: { ...authorization(mobile.sessionToken), "idempotency-key": "android-batch-0001" },
        payload: callBatch(mobile.deviceId, {
          items: [{
            ...(payload.items as Array<Record<string, unknown>>)[0],
            durationSeconds: 999,
          }],
        }),
      });
      expect(conflictResponse.statusCode).toBe(409);

      const ownerToken = await session(app);
      const calls = await app.inject({ method: "GET", url: "/v1/calls", headers: authorization(ownerToken) });
      expect(json<SuccessPayload<{ items: Array<{ source: string; deviceId: string }> }>>(calls).data.items)
        .toContainEqual(expect.objectContaining({ source: "mobile_call_log", deviceId: mobile.deviceId }));
    });

    it("enforces the 100-item contract and 512KiB application body limit", async () => {
      const mobile = await pairAndActivate("batch-bounds-installation");
      const base = (callBatch(mobile.deviceId).items as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
      const tooManyItems = Array.from({ length: 101 }, (_, index) => ({ ...base, localId: `call-${index}` }));
      const tooMany = await app.inject({
        method: "POST",
        url: "/v1/mobile/call-batches",
        headers: { ...authorization(mobile.sessionToken), "idempotency-key": "android-batch-0001" },
        payload: callBatch(mobile.deviceId, { items: tooManyItems }),
      });
      expect(tooMany.statusCode).toBe(400);

      const oversized = await app.inject({
        method: "POST",
        url: "/v1/mobile/call-batches",
        headers: {
          ...authorization(mobile.sessionToken),
          "content-type": "application/json",
          "idempotency-key": "android-batch-0001",
        },
        payload: JSON.stringify(callBatch(mobile.deviceId, {
          items: [{ ...base, contactName: "x".repeat(513 * 1_024) }],
        })),
      });
      expect(oversized.statusCode).toBe(413);
    });

    it("rotates one session at a time and self-revocation withdraws consent", async () => {
      const mobile = await pairAndActivate("rotation-installation");
      const prepareRequestId = randomUUID();
      const rotatedToken = deviceCredential("cls", "rotation-installation:next-session");
      const preparedResponse = await app.inject({
        method: "POST",
        url: "/v1/mobile/session/rotation/prepare",
        headers: { ...authorization(mobile.sessionToken), "idempotency-key": prepareRequestId },
        payload: { requestId: prepareRequestId, proposedSessionCredential: rotatedToken },
      });
      expect(preparedResponse.statusCode).toBe(200);
      const confirmRequestId = randomUUID();
      const rotatedResponse = await app.inject({
        method: "POST",
        url: "/v1/mobile/session/rotation/confirm",
        headers: { ...authorization(rotatedToken), "idempotency-key": confirmRequestId },
        payload: { requestId: confirmRequestId, prepareRequestId },
      });
      expect(rotatedResponse.statusCode).toBe(200);
      expect(rotatedToken).not.toBe(mobile.sessionToken);

      const oldCredential = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(mobile.sessionToken),
        payload: heartbeat(mobile.deviceId),
      });
      expect(oldCredential.statusCode).toBe(401);
      expect(json<FailurePayload>(oldCredential).error.message).toBe("The device credential is invalid");

      const revokeRequestId = randomUUID();
      const revoke = await app.inject({
        method: "DELETE",
        url: "/v1/mobile/session",
        headers: { ...authorization(rotatedToken), "idempotency-key": revokeRequestId },
        payload: { requestId: revokeRequestId },
      });
      expect(revoke.statusCode).toBe(200);
      expect(json<SuccessPayload<{ deviceId: string; consentWithdrawnAt: string }>>(revoke).data.deviceId)
        .toBe(mobile.deviceId);

      const revokedCredential = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(rotatedToken),
        payload: heartbeat(mobile.deviceId),
      });
      expect(revokedCredential.statusCode).toBe(401);
      expect(json<FailurePayload>(revokedCredential).error.message).toBe("The device credential is invalid");
      const device = await repository.findDevice("org_alpha", mobile.deviceId);
      expect(device).toMatchObject({ status: "revoked", revokedAt: clock.now().toISOString() });
    });

    it("lets an authorized administrator idempotently revoke exactly one stranded device", async () => {
      const stranded = await pairAndActivate("admin-recovery-stranded-installation");
      const healthy = await pairAndActivate("admin-recovery-healthy-installation");
      const ownerToken = await session(app);
      const adminToken = await session(app, "org_alpha", "admin");
      const analystToken = await session(app, "org_alpha", "analyst");
      const prepareRequestId = randomUUID();
      const pendingSessionToken = deviceCredential("cls", "admin-recovery-pending-session");
      const prepare = await app.inject({
        method: "POST",
        url: "/v1/mobile/session/rotation/prepare",
        headers: { ...authorization(stranded.sessionToken), "idempotency-key": prepareRequestId },
        payload: { requestId: prepareRequestId, proposedSessionCredential: pendingSessionToken },
      });
      expect(prepare.statusCode).toBe(200);
      const requestId = randomUUID();
      const payload = { requestId, reason: "Lost corporate handset" };

      const malformedRequest = await app.inject({
        method: "POST",
        url: `/v1/devices/${stranded.deviceId}/revoke`,
        headers: { ...authorization(ownerToken), "idempotency-key": "not-a-uuid" },
        payload: { requestId: "not-a-uuid", reason: payload.reason },
      });
      expect(malformedRequest.statusCode).toBe(400);

      const mismatchedRequestId = randomUUID();
      const mismatchedHeader = await app.inject({
        method: "POST",
        url: `/v1/devices/${stranded.deviceId}/revoke`,
        headers: { ...authorization(ownerToken), "idempotency-key": randomUUID() },
        payload: { requestId: mismatchedRequestId, reason: payload.reason },
      });
      expect(mismatchedHeader.statusCode).toBe(400);

      for (const reason of ["short", "Reported\nmissing", "x".repeat(501)]) {
        const invalidReasonRequestId = randomUUID();
        const invalidReason = await app.inject({
          method: "POST",
          url: `/v1/devices/${stranded.deviceId}/revoke`,
          headers: { ...authorization(ownerToken), "idempotency-key": invalidReasonRequestId },
          payload: { requestId: invalidReasonRequestId, reason },
        });
        expect(invalidReason.statusCode).toBe(400);
      }

      const forbiddenResponse = await app.inject({
        method: "POST",
        url: `/v1/devices/${stranded.deviceId}/revoke`,
        headers: { ...authorization(analystToken), "idempotency-key": requestId },
        payload,
      });
      expect(forbiddenResponse.statusCode).toBe(403);

      const first = await app.inject({
        method: "POST",
        url: `/v1/devices/${stranded.deviceId}/revoke`,
        headers: { ...authorization(ownerToken), "idempotency-key": requestId },
        payload,
      });
      expect(first.statusCode).toBe(200);
      expect(json<SuccessPayload<{
        deviceId: string;
        employeeId: string;
        revokedAt: string;
        reason: string;
        revokedCredentialCount: number;
        consentWithdrawn: boolean;
      }>>(first).data).toMatchObject({
        deviceId: stranded.deviceId,
        employeeId: "emp_alpha_priya",
        revokedAt: clock.now().toISOString(),
        reason: payload.reason,
        revokedCredentialCount: 2,
        consentWithdrawn: true,
      });

      const replay = await app.inject({
        method: "POST",
        url: `/v1/devices/${stranded.deviceId}/revoke`,
        headers: { ...authorization(ownerToken), "idempotency-key": requestId },
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(json<SuccessPayload<unknown>>(replay).data).toEqual(json<SuccessPayload<unknown>>(first).data);

      const differentActorReplay = await app.inject({
        method: "POST",
        url: `/v1/devices/${stranded.deviceId}/revoke`,
        headers: { ...authorization(adminToken), "idempotency-key": requestId },
        payload,
      });
      expect(differentActorReplay.statusCode).toBe(409);

      const conflictingReplay = await app.inject({
        method: "POST",
        url: `/v1/devices/${stranded.deviceId}/revoke`,
        headers: { ...authorization(ownerToken), "idempotency-key": requestId },
        payload: { ...payload, reason: "Transferred to another employee" },
      });
      expect(conflictingReplay.statusCode).toBe(409);

      const conflictingTarget = await app.inject({
        method: "POST",
        url: `/v1/devices/${healthy.deviceId}/revoke`,
        headers: { ...authorization(ownerToken), "idempotency-key": requestId },
        payload,
      });
      expect(conflictingTarget.statusCode).toBe(409);

      const crossTenantRequestId = randomUUID();
      const crossTenant = await app.inject({
        method: "POST",
        url: "/v1/devices/device_beta_riya/revoke",
        headers: { ...authorization(ownerToken), "idempotency-key": crossTenantRequestId },
        payload: { requestId: crossTenantRequestId, reason: "Reported missing by employee" },
      });
      expect(crossTenant.statusCode).toBe(404);

      const revokedCredential = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(stranded.sessionToken),
        payload: heartbeat(stranded.deviceId),
      });
      expect(revokedCredential.statusCode).toBe(401);

      const confirmRequestId = randomUUID();
      const revokedPendingCredential = await app.inject({
        method: "POST",
        url: "/v1/mobile/session/rotation/confirm",
        headers: { ...authorization(pendingSessionToken), "idempotency-key": confirmRequestId },
        payload: { requestId: confirmRequestId, prepareRequestId },
      });
      expect(revokedPendingCredential.statusCode).toBe(401);

      const healthyCredential = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(healthy.sessionToken),
        payload: heartbeat(healthy.deviceId),
      });
      expect(healthyCredential.statusCode).toBe(200);

      const auditResponse = await app.inject({
        method: "GET",
        url: "/v1/audit-events?limit=100",
        headers: authorization(ownerToken),
      });
      const recoveryAudits = json<SuccessPayload<{ items: Array<{ action: string; entityId: string }> }>>(
        auditResponse,
      ).data.items.filter((event) =>
        event.action === "device.admin_revoked" && event.entityId === stranded.deviceId);
      expect(recoveryAudits).toHaveLength(1);
      expect(repository.countAdminRecoveryOutboxEvents("org_alpha", requestId)).toBe(1);
    });

    it("allows the same employee installation to re-pair after its session expires", async () => {
      const installationId = "expired-session-repair-installation";
      const mobile = await pairAndActivate(installationId);
      const healthy = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(mobile.sessionToken),
        payload: heartbeat(mobile.deviceId, { pendingCallCount: 7, pendingRecordingCount: 3 }),
      });
      expect(healthy.statusCode).toBe(200);
      clock.advanceSeconds(config.deviceSessionTtlSeconds + 1);
      const expired = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization(mobile.sessionToken),
        payload: heartbeat(mobile.deviceId),
      });
      expect(expired.statusCode).toBe(401);

      const ownerToken = await session(app);
      const pairingResponse = await app.inject({
        method: "POST",
        url: "/v1/employees/emp_alpha_priya/pairing-codes",
        headers: authorization(ownerToken),
        payload: { ttlSeconds: 120 },
      });
      const pairing = json<SuccessPayload<{ code: string }>>(pairingResponse).data;
      const repairRequest = redemptionRequest(pairing.code, installationId, { appVersion: "0.2.0" });
      const repaired = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: repairRequest.headers,
        payload: repairRequest.payload,
      });
      expect(repaired.statusCode).toBe(201);
      const data = json<SuccessPayload<{
        device: { id: string; status: string; pendingCallCount: number; pendingRecordingCount: number };
        bootstrapCredential: { tokenType: string; token?: string };
      }>>(repaired).data;
      expect(data.device).toEqual(expect.objectContaining({
        id: mobile.deviceId,
        status: "pending",
        pendingCallCount: 0,
        pendingRecordingCount: 0,
      }));
      expect(data.device).not.toHaveProperty("lastHeartbeatAt");
      expect(data.bootstrapCredential).not.toHaveProperty("token");
    });

    it("rejects malformed credentials and stale or future consent with generic token failures", async () => {
      const malformed = await app.inject({
        method: "POST",
        url: "/v1/mobile/heartbeat",
        headers: authorization("not-a-device-token"),
        payload: {},
      });
      expect(malformed.statusCode).toBe(401);
      expect(json<FailurePayload>(malformed).error.message).toBe("The device credential is invalid");

      const ownerToken = await session(app);
      const pairing = await app.inject({
        method: "POST",
        url: "/v1/employees/emp_alpha_priya/pairing-codes",
        headers: authorization(ownerToken),
        payload: { ttlSeconds: 120 },
      });
      const code = json<SuccessPayload<{ code: string }>>(pairing).data.code;
      const redemptionRequestData = redemptionRequest(code, "invalid-consent-time");
      const redemption = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: redemptionRequestData.headers,
        payload: redemptionRequestData.payload,
      });
      expect(redemption.statusCode).toBe(201);
      const policyResponse = await app.inject({
        method: "GET",
        url: "/v1/mobile/collection-policy",
        headers: authorization(redemptionRequestData.bootstrap),
      });
      const policy = json<SuccessPayload<{ policy: { id: string; contentHash: string } }>>(policyResponse).data.policy;
      for (const acceptedAt of [
        new Date(clock.now().getTime() - 16 * 60 * 1_000).toISOString(),
        new Date(clock.now().getTime() + 6 * 60 * 1_000).toISOString(),
      ]) {
        const requestId = randomUUID();
        const response = await app.inject({
          method: "POST",
          url: "/v1/mobile/activate",
          headers: { ...authorization(redemptionRequestData.bootstrap), "idempotency-key": requestId },
          payload: {
            requestId,
            proposedSessionCredential: deviceCredential("cls", `invalid-consent:${acceptedAt}`),
            policy,
            consent: {
              acceptedAt,
              purpose: "call_metadata",
            },
            permissions,
          },
        });
        expect(response.statusCode).toBe(409);
        expect(json<FailurePayload>(response).error.code).toBe("CONSENT_REQUIRED");
      }
    });
  });

  describe("call ingestion, pagination, and reconciliation", () => {
    const baseCall = {
      employeeId: "emp_alpha_amit",
      direction: "incoming",
      disposition: "answered",
      phoneNumber: "+919811111111",
      startedAt: "2026-07-14T04:00:00.000Z",
      durationSeconds: 120,
      isInternal: false,
      isWithinWorkingHours: true,
    } as const;

    async function ingest(
      targetApp: FastifyInstance,
      token: string,
      idempotency: string,
      payload: Record<string, unknown>,
    ): Promise<LightMyRequestResponse> {
      return targetApp.inject({
        method: "POST",
        url: "/v1/calls/ingest/simulated",
        headers: { ...authorization(token), "idempotency-key": idempotency },
        payload,
      });
    }

    it("makes retries idempotent and detects key/payload conflicts", async () => {
      const token = await session(app);
      const payload = { ...baseCall, externalId: "native-call-1" };
      const first = await ingest(app, token, "ingest-key-0001", payload);
      expect(first.statusCode).toBe(201);
      const firstData = json<SuccessPayload<{ call: { id: string }; duplicate: boolean }>>(first).data;
      expect(firstData.duplicate).toBe(false);

      const retry = await ingest(app, token, "ingest-key-0001", payload);
      expect(retry.statusCode).toBe(200);
      const retryData = json<SuccessPayload<{ call: { id: string }; duplicate: boolean }>>(retry).data;
      expect(retryData).toEqual({ call: expect.objectContaining({ id: firstData.call.id }), duplicate: true });

      const externalIdRetry = await ingest(app, token, "ingest-key-0002", payload);
      expect(externalIdRetry.statusCode).toBe(200);
      expect(json<SuccessPayload<{ call: { id: string }; duplicate: boolean }>>(externalIdRetry).data)
        .toEqual({ call: expect.objectContaining({ id: firstData.call.id }), duplicate: true });

      const conflictResponse = await ingest(app, token, "ingest-key-0001", { ...payload, durationSeconds: 999 });
      expect(conflictResponse.statusCode).toBe(409);
      expect(json<FailurePayload>(conflictResponse).error.code).toBe("CONFLICT");

      const externalIdConflict = await ingest(app, token, "ingest-key-0003", { ...payload, durationSeconds: 998 });
      expect(externalIdConflict.statusCode).toBe(409);

      const list = await app.inject({ method: "GET", url: "/v1/calls", headers: authorization(token) });
      expect(json<SuccessPayload<{ items: unknown[] }>>(list).data.items).toHaveLength(1);
    });

    it("uses organization, device, and externalId as the external call identity", async () => {
      const token = await session(app);
      const pairingResponse = await app.inject({
        method: "POST",
        url: "/v1/employees/emp_alpha_priya/pairing-codes",
        headers: authorization(token),
        payload: { ttlSeconds: 120 },
      });
      const pairing = json<SuccessPayload<{ code: string }>>(pairingResponse).data;
      const secondDeviceRequest = redemptionRequest(pairing.code, "second-org-alpha-device");
      const redemption = await app.inject({
        method: "POST",
        url: "/v1/device-pairings/redeem",
        headers: secondDeviceRequest.headers,
        payload: secondDeviceRequest.payload,
      });
      const secondDeviceId = json<SuccessPayload<{ device: { id: string } }>>(redemption).data.device.id;

      const first = await ingest(app, token, "device-key-0001", {
        ...baseCall,
        externalId: "device-local-call-id",
        deviceId: "device_alpha_amit",
      });
      const second = await ingest(app, token, "device-key-0002", {
        ...baseCall,
        externalId: "device-local-call-id",
        employeeId: "emp_alpha_priya",
        deviceId: secondDeviceId,
        phoneNumber: "+919822222222",
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(json<SuccessPayload<{ call: { id: string } }>>(second).data.call.id)
        .not.toBe(json<SuccessPayload<{ call: { id: string } }>>(first).data.call.id);
    });

    it("strictly validates booleans, integer durations, and explicit timestamp offsets", async () => {
      const token = await session(app);
      const invalidPayloads: Array<{ override: Record<string, unknown>; field: string }> = [
        { override: { isInternal: "false" }, field: "isInternal" },
        { override: { isWithinWorkingHours: 1 }, field: "isWithinWorkingHours" },
        { override: { durationSeconds: 1.5 }, field: "durationSeconds" },
        { override: { ringDurationSeconds: 2.5 }, field: "ringDurationSeconds" },
        { override: { startedAt: "2026-07-14T04:00:00" }, field: "startedAt" },
      ];

      for (const [index, invalid] of invalidPayloads.entries()) {
        const response = await ingest(app, token, `invalid-key-00${index}`, {
          ...baseCall,
          externalId: `invalid-call-${index}`,
          ...invalid.override,
        });
        expect(response.statusCode).toBe(400);
        expect(json<FailurePayload>(response).error.message).toContain(invalid.field);
      }

      const missingOffsetDashboard = await app.inject({
        method: "GET",
        url: "/v1/dashboard/overview?from=2026-07-14T00%3A00%3A00&to=2026-07-15T00%3A00%3A00Z",
        headers: authorization(token),
      });
      expect(missingOffsetDashboard.statusCode).toBe(400);

      const validOffset = await ingest(app, token, "offset-key-0001", {
        ...baseCall,
        externalId: "offset-call",
        startedAt: "2026-07-14T09:30:00+05:30",
      });
      expect(validOffset.statusCode).toBe(201);
      expect(json<SuccessPayload<{ call: { startedAt: string } }>>(validOffset).data.call.startedAt)
        .toBe("2026-07-14T04:00:00.000Z");
    });

    it("masks analyst call phone numbers while owners receive the stored value", async () => {
      const ownerToken = await session(app, "org_alpha", "owner");
      const analystToken = await session(app, "org_alpha", "analyst");
      await ingest(app, ownerToken, "masking-key-0001", { ...baseCall, externalId: "masked-call" });

      const ownerList = await app.inject({ method: "GET", url: "/v1/calls", headers: authorization(ownerToken) });
      const analystList = await app.inject({ method: "GET", url: "/v1/calls", headers: authorization(analystToken) });
      const ownerPhone = json<SuccessPayload<{ items: Array<{ participant: { phoneNumber: string } }> }>>(ownerList).data.items[0]?.participant.phoneNumber;
      const analystPhone = json<SuccessPayload<{ items: Array<{ participant: { phoneNumber: string } }> }>>(analystList).data.items[0]?.participant.phoneNumber;

      expect(ownerPhone).toBe("+919811111111");
      expect(analystPhone).toBe("•••• 1111");
    });

    it("keeps call idempotency and reads tenant-scoped", async () => {
      const alphaToken = await session(app, "org_alpha", "owner");
      const betaToken = await session(app, "org_beta", "owner");
      await ingest(app, alphaToken, "shared-key-0001", { ...baseCall, externalId: "shared-external" });
      const betaCall = {
        ...baseCall,
        employeeId: "emp_beta_riya",
        phoneNumber: "+919822222222",
        externalId: "shared-external",
      };
      const betaIngest = await ingest(app, betaToken, "shared-key-0001", betaCall);
      expect(betaIngest.statusCode).toBe(201);

      const alphaList = await app.inject({ method: "GET", url: "/v1/calls", headers: authorization(alphaToken) });
      const betaList = await app.inject({ method: "GET", url: "/v1/calls", headers: authorization(betaToken) });
      expect(json<SuccessPayload<{ items: Array<{ organizationId: string }> }>>(alphaList).data.items.map((call) => call.organizationId)).toEqual(["org_alpha"]);
      expect(json<SuccessPayload<{ items: Array<{ organizationId: string }> }>>(betaList).data.items.map((call) => call.organizationId)).toEqual(["org_beta"]);
    });

    it("cursor-paginates calls and rejects a cursor from another tenant", async () => {
      const alphaToken = await session(app, "org_alpha", "owner");
      const betaToken = await session(app, "org_beta", "owner");
      for (let index = 0; index < 3; index += 1) {
        await ingest(app, alphaToken, `page-key-000${index}`, {
          ...baseCall,
          externalId: `page-call-${index}`,
          startedAt: `2026-07-14T0${4 + index}:00:00.000Z`,
        });
      }
      const first = await app.inject({ method: "GET", url: "/v1/calls?limit=2", headers: authorization(alphaToken) });
      const firstData = json<SuccessPayload<{ items: Array<{ id: string }>; cursorInfo: { hasMore: boolean; nextCursor: string } }>>(first).data;
      expect(firstData.items).toHaveLength(2);
      expect(firstData.cursorInfo.hasMore).toBe(true);

      const second = await app.inject({
        method: "GET",
        url: `/v1/calls?limit=2&cursor=${encodeURIComponent(firstData.cursorInfo.nextCursor)}`,
        headers: authorization(alphaToken),
      });
      const secondData = json<SuccessPayload<{ items: Array<{ id: string }> }>>(second).data;
      expect(secondData.items).toHaveLength(1);
      expect(firstData.items.map((call) => call.id)).not.toContain(secondData.items[0]?.id);

      const crossTenantCursor = await app.inject({
        method: "GET",
        url: `/v1/calls?cursor=${encodeURIComponent(firstData.cursorInfo.nextCursor)}`,
        headers: authorization(betaToken),
      });
      expect(crossTenantCursor.statusCode).toBe(400);
    });

    it("reconciles dashboard totals exactly with stored call rows", async () => {
      const token = await session(app);
      const calls = [
        { ...baseCall, externalId: "reconcile-1" },
        {
          ...baseCall,
          externalId: "reconcile-2",
          direction: "outgoing",
          phoneNumber: "+919822222222",
          startedAt: "2026-07-14T05:00:00.000Z",
          durationSeconds: 60,
        },
        {
          ...baseCall,
          externalId: "reconcile-3",
          disposition: "missed",
          startedAt: "2026-07-14T06:00:00.000Z",
          durationSeconds: 0,
        },
      ];
      for (const [index, call] of calls.entries()) {
        const response = await ingest(app, token, `reconcile-key-${index}`, call);
        expect(response.statusCode).toBe(201);
      }

      const dashboard = await app.inject({
        method: "GET",
        url: "/v1/dashboard/overview?preset=today",
        headers: authorization(token),
      });
      expect(dashboard.statusCode).toBe(200);
      const data = json<SuccessPayload<{
        summary: { period: { from: string; to: string }; calls: { totalCalls: number; incomingCalls: number; outgoingCalls: number; connectedCalls: number; missedCalls: number; uniqueClients: number; totalTalkDurationSeconds: number } };
        metrics: { totalCalls: number; connectedCalls: number; missedCalls: number; uniqueClients: number; totalTalkDurationSeconds: number; workingHoursSeconds: number };
        hourlyActivity: Array<{ incoming: number; outgoing: number }>;
        outcomes: Array<{ value: number }>;
        teamPerformance: Array<{ totalCalls: number }>;
      }>>(dashboard).data;
      expect(data.summary.calls).toMatchObject({
        totalCalls: 3,
        incomingCalls: 2,
        outgoingCalls: 1,
        connectedCalls: 2,
        missedCalls: 1,
        uniqueClients: 2,
        totalTalkDurationSeconds: 180,
      });
      // Asia/Kolkata is UTC+05:30: the local 2026-07-14 day is bounded by these UTC instants.
      expect(data.summary.period).toEqual({
        from: "2026-07-13T18:30:00.000Z",
        to: "2026-07-14T18:30:00.000Z",
      });
      expect(data.metrics).toEqual({
        totalCalls: 3,
        connectedCalls: 2,
        missedCalls: 1,
        uniqueClients: 2,
        totalTalkDurationSeconds: 180,
        workingHoursSeconds: 180,
      });
      expect(data.hourlyActivity.reduce((sum, point) => sum + point.incoming + point.outgoing, 0)).toBe(3);
      expect(data.outcomes.reduce((sum, outcome) => sum + outcome.value, 0)).toBe(3);
      expect(data.teamPerformance.reduce((sum, employee) => sum + employee.totalCalls, 0)).toBe(3);
      expect((data as { attention?: Array<{ key: string; label: string }> }).attention)
        .toContainEqual(expect.objectContaining({ key: "missed", label: "Missed incoming calls" }));

      const betaToken = await session(app, "org_beta", "owner");
      const betaDashboard = await app.inject({ method: "GET", url: "/v1/dashboard/overview?preset=today", headers: authorization(betaToken) });
      expect(json<SuccessPayload<{ metrics: { totalCalls: number } }>>(betaDashboard).data.metrics.totalCalls).toBe(0);
    });

    it("records tenant-scoped audit events for mutations", async () => {
      const token = await session(app);
      await ingest(app, token, "audit-key-0001", { ...baseCall, externalId: "audit-call" });
      await app.inject({
        method: "POST",
        url: "/v1/employees",
        headers: authorization(token),
        payload: { displayName: "Audited Employee" },
      });
      const response = await app.inject({ method: "GET", url: "/v1/audit-events", headers: authorization(token) });
      const items = json<SuccessPayload<{ items: Array<{ action: string; organizationId: string }> }>>(response).data.items;
      expect(items.map((event) => event.action)).toEqual(expect.arrayContaining(["call.ingested", "employee.created"]));
      expect(items.every((event) => event.organizationId === "org_alpha")).toBe(true);
    });
  });

  describe("report automation", () => {
    it("persists saved views, schedules, preferences, and queued exports per tenant", async () => {
      const token = await session(app);
      const viewResponse = await app.inject({ method: "POST", url: "/v1/report-views", headers: authorization(token), payload: { name: "Manager lead view", kind: "lead_performance", filters: { period: "this_month" } } });
      expect(viewResponse.statusCode).toBe(201);
      const view = json<SuccessPayload<{ id: string }>>(viewResponse).data;
      const scheduleResponse = await app.inject({ method: "POST", url: "/v1/report-schedules", headers: authorization(token), payload: { savedViewId: view.id, name: "Daily manager report", cadence: "daily", localTime: "08:00", format: "pdf", recipients: ["manager@example.com"] } });
      expect(scheduleResponse.statusCode).toBe(201);
      const schedule = json<SuccessPayload<{ id: string }>>(scheduleResponse).data;
      const paused = await app.inject({ method: "PATCH", url: `/v1/report-schedules/${schedule.id}`, headers: authorization(token), payload: { status: "paused" } });
      expect(json<SuccessPayload<{ status: string }>>(paused).data.status).toBe("paused");
      const preferences = ["missed_call","overdue_follow_up","device_offline","import_completed","export_ready"].map((event) => ({ event, email: event !== "import_completed", inApp: true }));
      const preferenceResponse = await app.inject({ method: "PUT", url: "/v1/notification-preferences", headers: authorization(token), payload: { preferences } });
      expect(preferenceResponse.statusCode).toBe(200);
      const exportResponse = await app.inject({ method: "POST", url: "/v1/report-exports", headers: authorization(token), payload: { kind: "lead_performance", format: "xlsx", parameters: { period: "this_month" } } });
      expect(exportResponse.statusCode).toBe(202);
      const exportJob=json<SuccessPayload<{id:string}>>(exportResponse).data; const initialToken=createDownloadToken(); expect(await repository.completeReportExportJob({organizationId:"org_alpha",jobId:exportJob.id,objectKey:"reports/org_alpha/export.xlsx",tokenHash:hashDownloadToken(initialToken),expiresAt:"2026-07-16T12:00:00.000Z",at:"2026-07-14T12:05:00.000Z"})).toBe(true); const tokenResponse=await app.inject({method:"POST",url:`/v1/report-downloads/${exportJob.id}/token`,headers:authorization(token)}); expect(tokenResponse.statusCode).toBe(200); const downloadToken=json<SuccessPayload<{token:string}>>(tokenResponse).data.token;
      const redemption=await app.inject({method:"POST",url:`/v1/report-downloads/${exportJob.id}/redeem`,headers:authorization(token),payload:{token:downloadToken}}); expect(redemption.statusCode).toBe(200); expect(redemption.body).toBe("xlsx-bytes"); expect(redemption.headers["content-disposition"]).toBe('attachment; filename="callora-report.xlsx"'); expect(redemption.headers["cache-control"]).toBe("no-store");
      const replay=await app.inject({method:"POST",url:`/v1/report-downloads/${exportJob.id}/redeem`,headers:authorization(token),payload:{token:downloadToken}}); expect(replay.statusCode).toBe(404);
      const replacement=await app.inject({method:"POST",url:`/v1/report-downloads/${exportJob.id}/token`,headers:authorization(token)}); expect(replacement.statusCode).toBe(404);
      const snapshot = await app.inject({ method: "GET", url: "/v1/report-automation", headers: authorization(token) });
      const data = json<SuccessPayload<{ savedViews: unknown[]; schedules: Array<{ status: string }>; preferences: unknown[]; jobs: unknown[] }>>(snapshot).data;
      expect(data.savedViews).toHaveLength(1); expect(data.schedules).toHaveLength(1); expect(data.schedules[0]!.status).toBe("paused"); expect(data.preferences).toHaveLength(5); expect(data.jobs).toHaveLength(1);
      const betaToken = await session(app, "org_beta", "owner");
      const crossTenantToken=await app.inject({method:"POST",url:`/v1/report-downloads/${exportJob.id}/token`,headers:authorization(betaToken)}); expect(crossTenantToken.statusCode).toBe(404);
      const beta = await app.inject({ method: "GET", url: "/v1/report-automation", headers: authorization(betaToken) });
      expect(json<SuccessPayload<{ savedViews: unknown[]; schedules: unknown[]; jobs: unknown[] }>>(beta).data).toMatchObject({ savedViews: [], schedules: [], jobs: [] });
    });

    it("rejects malformed schedules and report exports without permission", async () => {
      const token = await session(app);
      const invalid = await app.inject({ method: "POST", url: "/v1/report-schedules", headers: authorization(token), payload: { savedViewId: "missing", name: "Bad", cadence: "weekly", weekDay: 9, localTime: "99:00", format: "pdf", recipients: ["bad"] } });
      expect(invalid.statusCode).toBe(400);
      const employee = await session(app, "org_alpha", "employee");
      const forbiddenExport = await app.inject({ method: "POST", url: "/v1/report-exports", headers: authorization(employee), payload: { kind: "lead_performance", format: "csv" } });
      expect(forbiddenExport.statusCode).toBe(403);
    });
  });
});
