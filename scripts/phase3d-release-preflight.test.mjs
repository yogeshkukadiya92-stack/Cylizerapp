import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  PreflightError,
  probeProductionEndpoints,
  redactSensitiveText,
  validateAndroidReleaseConfig,
  validatePiiBackfillConfig,
  validatePublicJwks,
  validateProductionConfig,
} from "./phase3d-release-preflight.mjs";

const encryptionKey = Buffer.alloc(32, 7).toString("base64url");
const blindIndexKey = Buffer.alloc(32, 9).toString("base64url");
const rowIdKey = Buffer.alloc(32, 10).toString("base64url");
const oidcPublicJwk = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .publicKey.export({ format: "jwk" });
const ed25519PublicJwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
const ed448PublicJwk = generateKeyPairSync("ed448").publicKey.export({ format: "jwk" });

function validEnvironment() {
  return {
    NODE_ENV: "production",
    DEV_AUTH_ENABLED: "false",
    AUTH_SECRET: "a".repeat(32),
    PHASE3D_WEB_ORIGIN: "https://app.callora.company",
    PHASE3D_API_ORIGIN: "https://api.callora.company",
    PHASE3D_EXPECT_PROXY: "true",
    TRUSTED_PROXY_CIDRS: "10.20.0.0/16,2001:db8:1234::/48",
    CORS_ALLOWED_ORIGINS: "https://app.callora.company",
    VITE_API_URL: "https://api.callora.company",
    VITE_AUTH_MODE: "oidc",
    VITE_OIDC_AUTHORITY: "https://identity.callora.company",
    VITE_OIDC_CLIENT_ID: "callora-web",
    VITE_OIDC_REDIRECT_URI: "https://app.callora.company/auth/callback",
    VITE_OIDC_POST_LOGOUT_REDIRECT_URI: "https://app.callora.company/auth/logout-callback",
    VITE_OIDC_SCOPE: "openid profile email callora-api",
    OIDC_ISSUER: "https://identity.callora.company",
    OIDC_AUDIENCE: "callora-api",
    OIDC_JWKS_URI: "https://identity.callora.company/.well-known/jwks.json",
    OIDC_ORGANIZATION_CLAIM: "https://callora.company/claims/organization_id",
    OIDC_ALLOWED_ALGORITHMS: "ES256",
    OIDC_CLOCK_TOLERANCE_SECONDS: "5",
    DATABASE_URL: "postgresql://callora_runtime:secret@db.callora.company:5432/callora",
    DATABASE_SSL_MODE: "verify-full",
    DATABASE_POOL_MAX: "10",
    DATABASE_IDLE_TIMEOUT_MS: "30000",
    DATABASE_CONNECTION_TIMEOUT_MS: "5000",
    DATABASE_STATEMENT_TIMEOUT_MS: "5000",
    DATABASE_LOCK_TIMEOUT_MS: "1000",
    CALL_PII_ACTIVE_KEY_VERSION: "1",
    CALL_PII_ENCRYPTION_KEYS: `1:${encryptionKey}`,
    CALL_PII_BLIND_INDEX_KEYS: `1:${blindIndexKey}`,
    CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "1",
    CALL_PII_ROW_ID_KEY: rowIdKey,
  };
}

test("accepts a complete production configuration without exposing secret material", () => {
  const environment = validEnvironment();
  const result = validateProductionConfig(environment);
  assert.equal(result.webOrigin, environment.PHASE3D_WEB_ORIGIN);
  assert.equal(result.callDataEncryptionKeyCount, 1);
  assert.equal(result.callDataBlindIndexKeyCount, 1);
  assert.equal(result.callDataActiveBlindIndexKeyVersion, "1");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes(encryptionKey), false);
  assert.equal(JSON.stringify(result).includes(blindIndexKey), false);
  assert.equal(JSON.stringify(result).includes(rowIdKey), false);
});

test("rejects placeholders, wildcard trust, and proxy ambiguity", () => {
  const placeholder = validEnvironment();
  placeholder.PHASE3D_API_ORIGIN = "https://api.example.com";
  placeholder.VITE_API_URL = placeholder.PHASE3D_API_ORIGIN;
  assert.throws(() => validateProductionConfig(placeholder), PreflightError);

  const wildcard = validEnvironment();
  wildcard.CORS_ALLOWED_ORIGINS = "*";
  assert.throws(() => validateProductionConfig(wildcard), PreflightError);

  const proxy = validEnvironment();
  proxy.PHASE3D_EXPECT_PROXY = "false";
  assert.throws(() => validateProductionConfig(proxy), PreflightError);

  const trailingIssuer = validEnvironment();
  trailingIssuer.OIDC_ISSUER = `${trailingIssuer.OIDC_ISSUER}/`;
  trailingIssuer.VITE_OIDC_AUTHORITY = trailingIssuer.OIDC_ISSUER;
  assert.throws(() => validateProductionConfig(trailingIssuer), /without a trailing slash/);

  for (const loopbackOrigin of ["https://127.9.8.7", "https://[::1]"]) {
    const loopback = validEnvironment();
    loopback.PHASE3D_API_ORIGIN = loopbackOrigin;
    loopback.VITE_API_URL = loopbackOrigin;
    assert.throws(() => validateProductionConfig(loopback), /non-placeholder hostname/);
  }
});

test("requires independent well-formed call-data keys", () => {
  const reused = validEnvironment();
  reused.CALL_PII_BLIND_INDEX_KEYS = `1:${encryptionKey}`;
  assert.throws(() => validateProductionConfig(reused), /independent/);

  const reusedRowId = validEnvironment();
  reusedRowId.CALL_PII_ROW_ID_KEY = blindIndexKey;
  assert.throws(() => validateProductionConfig(reusedRowId), /independent/);

  const missingActive = validEnvironment();
  missingActive.CALL_PII_ACTIVE_KEY_VERSION = "2";
  assert.throws(() => validateProductionConfig(missingActive), /must reference/);

  const padded = validEnvironment();
  padded.CALL_PII_BLIND_INDEX_KEYS = `1:${blindIndexKey}=`;
  assert.throws(() => validateProductionConfig(padded), /unpadded base64url/);

  const rollback = validEnvironment();
  rollback.CALL_PII_ENCRYPTION_KEYS = `1:${encryptionKey},2:${Buffer.alloc(32, 8).toString("base64url")}`;
  assert.throws(() => validateProductionConfig(rollback), /highest configured/);

  const blindRollback = validEnvironment();
  blindRollback.CALL_PII_BLIND_INDEX_KEYS = `1:${blindIndexKey},2:${Buffer.alloc(32, 11).toString("base64url")}`;
  assert.throws(() => validateProductionConfig(blindRollback), /highest configured/);

  const missingActiveBlind = validEnvironment();
  missingActiveBlind.CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION = "2";
  assert.throws(() => validateProductionConfig(missingActiveBlind), /must reference/);

  const duplicateBlindMaterial = validEnvironment();
  duplicateBlindMaterial.CALL_PII_BLIND_INDEX_KEYS = `1:${blindIndexKey},2:${blindIndexKey}`;
  duplicateBlindMaterial.CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION = "2";
  assert.throws(() => validateProductionConfig(duplicateBlindMaterial), /must not reuse key material/);

  const legacySingleton = validEnvironment();
  legacySingleton.CALL_PII_BLIND_INDEX_KEY = blindIndexKey;
  assert.throws(() => validateProductionConfig(legacySingleton), /Legacy CALL_PII_BLIND_INDEX_KEY must be absent/);
});

test("validates scoped PII backfill variables without allowing them in the API runtime", () => {
  const environment = validEnvironment();
  environment.CALL_PII_BACKFILL_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
  environment.CALL_PII_BACKFILL_BATCH_SIZE = "250";
  assert.deepEqual(validatePiiBackfillConfig(environment), {
    organizationId: environment.CALL_PII_BACKFILL_ORGANIZATION_ID,
    batchSize: 250,
    activeKeyVersion: "1",
    activeBlindIndexKeyVersion: "1",
  });
  assert.throws(() => validateProductionConfig(environment), /long-running API/);
  assert.throws(
    () => validatePiiBackfillConfig({ ...environment, CALL_PII_BACKFILL_BATCH_SIZE: "501" }),
    /between 1 and 500/,
  );
});

test("requires a deployed Android origin and a present external keystore", () => {
  const environment = {
    CALLORA_ANDROID_API_BASE_URL: "https://api.callora.company",
    CALLORA_ANDROID_KEYSTORE_PATH: "/secure/release.jks",
    CALLORA_ANDROID_KEY_ALIAS: "callora-release",
    CALLORA_ANDROID_KEYSTORE_PASSWORD: "not-printed",
    CALLORA_ANDROID_KEY_PASSWORD: "not-printed-either",
  };
  assert.equal(
    validateAndroidReleaseConfig(environment, { fileExists: () => true }).apiOrigin,
    environment.CALLORA_ANDROID_API_BASE_URL,
  );
  assert.throws(
    () => validateAndroidReleaseConfig({ ...environment, CALLORA_ANDROID_API_BASE_URL: "https://api.example.com" }, { fileExists: () => true }),
    /non-placeholder/,
  );
  for (const loopbackOrigin of ["https://127.42.0.9", "https://[::1]"]) {
    assert.throws(
      () => validateAndroidReleaseConfig(
        { ...environment, CALLORA_ANDROID_API_BASE_URL: loopbackOrigin },
        { fileExists: () => true },
      ),
      /non-placeholder hostname/,
    );
  }
  assert.throws(() => validateAndroidReleaseConfig(environment, { fileExists: () => false }), /readable file/);
});

test("redacts PostgreSQL URLs, bearer tokens, and provided secret values", () => {
  const output = redactSensitiveText(
    "postgresql://user:password@db.internal/callora Bearer abc.def secret-value",
    ["secret-value"],
  );
  assert.equal(output.includes("password"), false);
  assert.equal(output.includes("abc.def"), false);
  assert.equal(output.includes("secret-value"), false);
});

test("probes exact OIDC, JWKS, API, CORS, and web deployment surfaces", async () => {
  const config = validateProductionConfig(validEnvironment());
  const responses = [
    new Response(JSON.stringify({
      issuer: config.issuer,
      jwks_uri: config.jwksUri,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({
      keys: [{ ...oidcPublicJwk, kid: "release-1", use: "sig", alg: "ES256" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ data: { status: "ok" } }), { status: 200 }),
    new Response(JSON.stringify({ data: { status: "ready" } }), { status: 200 }),
    new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": config.webOrigin,
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "authorization,content-type",
      },
    }),
    new Response("<!doctype html><title>Callora</title>", { status: 200 }),
  ];
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  try {
    const result = await probeProductionEndpoints(config);
    assert.equal(result.usableJwksKeyCount, 1);
    assert.equal(result.cors, true);
    assert.equal(requested.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects malformed, private, weak, or algorithm-incompatible JWKS keys", () => {
  assert.equal(
    validatePublicJwks(
      { keys: [{ ...ed25519PublicJwk, kid: "ed25519", alg: "EdDSA", use: "sig" }] },
      ["EdDSA"],
    ).usableKeyCount,
    1,
  );
  assert.throws(
    () => validatePublicJwks(
      { keys: [{ ...ed448PublicJwk, kid: "ed448", alg: "EdDSA", use: "sig" }] },
      ["EdDSA"],
    ),
    /no structurally valid/,
  );
  assert.throws(
    () => validatePublicJwks({ keys: [{ kid: "missing-rsa", kty: "RSA", alg: "RS256" }] }, ["RS256"]),
    /no structurally valid/,
  );
  assert.throws(
    () => validatePublicJwks({ keys: [{ ...oidcPublicJwk, kid: "private", alg: "ES256", d: "private" }] }, ["ES256"]),
    /private or symmetric/,
  );
  assert.throws(
    () => validatePublicJwks({ keys: [{ ...oidcPublicJwk, kid: "wrong-alg", alg: "ES384" }] }, ["ES384"]),
    /no structurally valid/,
  );
  assert.throws(
    () => validatePublicJwks({ keys: [{ ...oidcPublicJwk, kid: "numeric-alg", alg: 256 }] }, ["ES256"]),
    /alg must be a string/,
  );
});
