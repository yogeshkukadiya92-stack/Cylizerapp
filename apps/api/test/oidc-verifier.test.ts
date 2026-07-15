import { describe, expect, it, vi } from "vitest";
import {
  loadOidcVerifierConfig,
  OidcBearerVerificationError,
  ProductionOidcBearerVerifier,
  type JwtVerificationBackend,
  type OidcVerifierConfig,
} from "../src/auth/index.js";

const config: OidcVerifierConfig = {
  issuer: "https://identity.example.test/tenant-a",
  audience: "https://api.callora.example",
  jwksUri: "https://identity.example.test/tenant-a/.well-known/jwks.json",
  organizationClaim: "https://callora.example/claims/organization_id",
  algorithms: ["RS256", "ES256"],
  clockToleranceSeconds: 10,
};

describe("OIDC verifier configuration", () => {
  it("loads exact trust-boundary values and an asymmetric algorithm allowlist", () => {
    expect(loadOidcVerifierConfig({
      OIDC_ISSUER: config.issuer,
      OIDC_AUDIENCE: config.audience,
      OIDC_JWKS_URI: config.jwksUri,
      OIDC_ORGANIZATION_CLAIM: config.organizationClaim,
      OIDC_ALLOWED_ALGORITHMS: "RS256,ES256",
      OIDC_CLOCK_TOLERANCE_SECONDS: "10",
    })).toEqual(config);
  });

  it("defaults to RS256 and five seconds of clock tolerance", () => {
    const loaded = loadOidcVerifierConfig({
      OIDC_ISSUER: config.issuer,
      OIDC_AUDIENCE: config.audience,
      OIDC_JWKS_URI: config.jwksUri,
      OIDC_ORGANIZATION_CLAIM: config.organizationClaim,
    });
    expect(loaded.algorithms).toEqual(["RS256"]);
    expect(loaded.clockToleranceSeconds).toBe(5);
  });

  it.each([
    ["missing issuer", { OIDC_AUDIENCE: "api", OIDC_JWKS_URI: config.jwksUri, OIDC_ORGANIZATION_CLAIM: "org_id" }],
    ["insecure issuer", { OIDC_ISSUER: "http://issuer.test", OIDC_AUDIENCE: "api", OIDC_JWKS_URI: config.jwksUri, OIDC_ORGANIZATION_CLAIM: "org_id" }],
    ["wildcard audience", { OIDC_ISSUER: config.issuer, OIDC_AUDIENCE: "*", OIDC_JWKS_URI: config.jwksUri, OIDC_ORGANIZATION_CLAIM: "org_id" }],
    ["registered organization claim", { OIDC_ISSUER: config.issuer, OIDC_AUDIENCE: "api", OIDC_JWKS_URI: config.jwksUri, OIDC_ORGANIZATION_CLAIM: "sub" }],
    ["symmetric algorithm", { OIDC_ISSUER: config.issuer, OIDC_AUDIENCE: "api", OIDC_JWKS_URI: config.jwksUri, OIDC_ORGANIZATION_CLAIM: "org_id", OIDC_ALLOWED_ALGORITHMS: "HS256" }],
    ["unsigned algorithm", { OIDC_ISSUER: config.issuer, OIDC_AUDIENCE: "api", OIDC_JWKS_URI: config.jwksUri, OIDC_ORGANIZATION_CLAIM: "org_id", OIDC_ALLOWED_ALGORITHMS: "none" }],
  ])("rejects %s configuration", (_label, env) => {
    expect(() => loadOidcVerifierConfig(env)).toThrow();
  });
});

describe("ProductionOidcBearerVerifier", () => {
  it("passes strict verification requirements to the backend and returns only trusted identity fields", async () => {
    const backend = vi.fn<JwtVerificationBackend>(async () => ({
      protectedHeader: { alg: "RS256" },
      payload: {
        iss: config.issuer,
        sub: "external-user-42",
        aud: config.audience,
        exp: 1_900_000_000,
        [config.organizationClaim]: "org_alpha",
        email: "not-forwarded@example.test",
        role: "owner",
      },
    }));
    const verifier = new ProductionOidcBearerVerifier(config, backend);

    await expect(verifier.verify("header.payload.signature")).resolves.toEqual({
      subject: "external-user-42",
      organizationId: "org_alpha",
      issuer: config.issuer,
    });
    expect(backend).toHaveBeenCalledWith({
      token: "header.payload.signature",
      issuer: config.issuer,
      audience: config.audience,
      algorithms: config.algorithms,
      clockToleranceSeconds: 10,
      requiredClaims: ["iss", "aud", "exp", "sub", config.organizationClaim],
    });
  });

  it.each([
    ["missing subject", { iss: config.issuer, [config.organizationClaim]: "org_alpha" }, "invalid_subject"],
    ["blank organization", { iss: config.issuer, sub: "external-user", [config.organizationClaim]: "  " }, "invalid_organization"],
    ["wrong issuer", { iss: "https://other-issuer.example", sub: "external-user", [config.organizationClaim]: "org_alpha" }, "invalid_issuer"],
  ])("rejects %s after cryptographic verification", async (_label, payload, reason) => {
    const verifier = new ProductionOidcBearerVerifier(config, async () => ({
      protectedHeader: { alg: "RS256" },
      payload,
    }));
    await expect(verifier.verify("header.payload.signature")).rejects.toMatchObject({ reason });
  });

  it("rejects a backend result using an algorithm outside the configured allowlist", async () => {
    const verifier = new ProductionOidcBearerVerifier(config, async () => ({
      protectedHeader: { alg: "HS256" },
      payload: {
        iss: config.issuer,
        sub: "external-user",
        [config.organizationClaim]: "org_alpha",
      },
    }));
    await expect(verifier.verify("header.payload.signature")).rejects.toMatchObject({
      reason: "disallowed_algorithm",
    });
  });

  it("wraps backend errors without exposing provider or signature details", async () => {
    const providerError = new Error("provider-specific signature failure");
    const verifier = new ProductionOidcBearerVerifier(config, async () => {
      throw providerError;
    });

    const failure = await verifier.verify("header.payload.signature").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OidcBearerVerificationError);
    expect(failure).toMatchObject({
      message: "The bearer token could not be verified",
      reason: "invalid_token",
      cause: providerError,
    });
  });

  it("rejects blank or padded tokens before invoking the backend", async () => {
    const backend = vi.fn<JwtVerificationBackend>();
    const verifier = new ProductionOidcBearerVerifier(config, backend);

    await expect(verifier.verify(" ")).rejects.toMatchObject({ reason: "invalid_token" });
    await expect(verifier.verify(" token ")).rejects.toMatchObject({ reason: "invalid_token" });
    expect(backend).not.toHaveBeenCalled();
  });
});
