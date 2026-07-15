import { createPublicKey, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ASYMMETRIC_ALGORITHMS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);
const REGISTERED_JWT_CLAIMS = new Set(["iss", "sub", "aud", "exp", "nbf", "iat", "jti"]);
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
const PLACEHOLDER_HOST_SUFFIXES = [".example", ".example.com", ".example.net", ".example.org", ".test", ".invalid"];

export class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreflightError";
  }
}

function fail(message) {
  throw new PreflightError(message);
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} is required.`);
  }
  if (value !== value.trim()) {
    fail(`${name} must not contain leading or trailing whitespace.`);
  }
  return value;
}

function optional(env, name) {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  if (value !== value.trim()) fail(`${name} must not contain leading or trailing whitespace.`);
  return value;
}

function exactBoolean(env, name) {
  const value = required(env, name);
  if (value !== "true" && value !== "false") fail(`${name} must be exactly true or false.`);
  return value === "true";
}

function parseInteger(env, name, minimum, maximum) {
  const value = required(env, name);
  if (!/^\d+$/.test(value)) fail(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function isPlaceholderHost(hostname, { rejectIpAddress = false } = {}) {
  const normalized = hostname.toLowerCase();
  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  const addressFamily = isIP(unbracketed);
  const isLocalAddress =
    (addressFamily === 4 && (unbracketed === "0.0.0.0" || unbracketed.startsWith("127."))) ||
    (addressFamily === 6 && (
      unbracketed === "::" ||
      unbracketed === "::1" ||
      unbracketed.startsWith("::ffff:127.") ||
      /^::ffff:7f[0-9a-f]{2}:/.test(unbracketed)
    ));
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    isLocalAddress ||
    (rejectIpAddress && addressFamily !== 0) ||
    PLACEHOLDER_HOST_SUFFIXES.some((suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix))
  );
}

function parseHttpsUrl(value, name, { originOnly = false, rejectPlaceholder = true } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be an absolute HTTPS URL.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    fail(`${name} must be an absolute HTTPS URL without credentials or a fragment.`);
  }
  if (originOnly && (parsed.origin !== value || parsed.pathname !== "/" || parsed.search.length > 0)) {
    fail(`${name} must be an exact HTTPS origin without a path, query, or trailing slash.`);
  }
  if (rejectPlaceholder && isPlaceholderHost(parsed.hostname, { rejectIpAddress: true })) {
    fail(`${name} must use a deployed non-placeholder hostname.`);
  }
  return parsed;
}

function parsePostgresUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be an absolute PostgreSQL URL.`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hash.length > 0) {
    fail(`${name} must use postgres:// or postgresql:// without a fragment.`);
  }
  if (!parsed.username || !parsed.hostname || parsed.pathname.length <= 1) {
    fail(`${name} must include a username, host, and database name.`);
  }
  if (isPlaceholderHost(parsed.hostname)) fail(`${name} must use a deployed non-placeholder database host.`);
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase().startsWith("ssl")) {
      fail(`${name} must not contain SSL query parameters; use DATABASE_SSL_MODE.`);
    }
  }
  return parsed;
}

function decodeBase64Url32(value, name) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    fail(`${name} must be an unpadded base64url encoding of exactly 32 bytes.`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    fail(`${name} must be valid base64url.`);
  }
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    fail(`${name} must be an unpadded base64url encoding of exactly 32 bytes.`);
  }
  return decoded;
}

function parseKeyVersion(value, name) {
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    fail(`${name} must be a canonical positive integer key version.`);
  }
  return value;
}

function parseVersionedKeyring(env, name) {
  const serializedKeyring = required(env, name);
  const rawEntries = serializedKeyring.split(",");
  if (rawEntries.length === 0 || rawEntries.length > 32) {
    fail(`${name} must contain between 1 and 32 version:key entries.`);
  }

  const decodedKeys = new Map();
  for (const entry of rawEntries) {
    const separator = entry.indexOf(":");
    if (entry !== entry.trim() || separator <= 0 || separator !== entry.lastIndexOf(":")) {
      fail(`${name} must use comma-separated version:base64url entries without whitespace.`);
    }
    const keyVersion = parseKeyVersion(entry.slice(0, separator), `${name} key version`);
    const encodedKey = entry.slice(separator + 1);
    if (decodedKeys.has(keyVersion)) fail(`${name} contains a duplicate key version.`);
    const decoded = decodeBase64Url32(encodedKey, `${name}[${keyVersion}]`);
    const fingerprint = decoded.toString("hex");
    if ([...decodedKeys.values()].includes(fingerprint)) {
      fail(`${name} must not reuse key material under multiple versions.`);
    }
    decodedKeys.set(keyVersion, fingerprint);
  }
  return { fingerprints: decodedKeys, count: rawEntries.length };
}

function validateActiveKeyVersion(env, activeName, keyringName, keyring) {
  const activeKeyVersion = parseKeyVersion(required(env, activeName), activeName);
  if (!keyring.fingerprints.has(activeKeyVersion)) {
    fail(`${activeName} must reference a version in ${keyringName}.`);
  }
  const newestVersion = Math.max(...[...keyring.fingerprints.keys()].map(Number));
  if (Number(activeKeyVersion) !== newestVersion) {
    fail(`${activeName} must be the highest configured key version.`);
  }
  return activeKeyVersion;
}

function validateCallDataKeys(env) {
  if (env.CALL_PII_BLIND_INDEX_KEY !== undefined) {
    fail(
      "Legacy CALL_PII_BLIND_INDEX_KEY must be absent; use versioned " +
      "CALL_PII_BLIND_INDEX_KEYS and CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION.",
    );
  }

  const encryptionKeys = parseVersionedKeyring(env, "CALL_PII_ENCRYPTION_KEYS");
  const activeKeyVersion = validateActiveKeyVersion(
    env,
    "CALL_PII_ACTIVE_KEY_VERSION",
    "CALL_PII_ENCRYPTION_KEYS",
    encryptionKeys,
  );
  const blindIndexKeys = parseVersionedKeyring(env, "CALL_PII_BLIND_INDEX_KEYS");
  const activeBlindIndexKeyVersion = validateActiveKeyVersion(
    env,
    "CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION",
    "CALL_PII_BLIND_INDEX_KEYS",
    blindIndexKeys,
  );

  const encryptionFingerprints = new Set(encryptionKeys.fingerprints.values());
  if ([...blindIndexKeys.fingerprints.values()].some((fingerprint) => encryptionFingerprints.has(fingerprint))) {
    fail("CALL_PII_BLIND_INDEX_KEYS must use independent material from every encryption key.");
  }
  const rowIdKey = decodeBase64Url32(
    required(env, "CALL_PII_ROW_ID_KEY"),
    "CALL_PII_ROW_ID_KEY",
  );
  const rotatingFingerprints = new Set([
    ...encryptionKeys.fingerprints.values(),
    ...blindIndexKeys.fingerprints.values(),
  ]);
  if (rotatingFingerprints.has(rowIdKey.toString("hex"))) {
    fail("CALL_PII_ROW_ID_KEY must use independent material from every encryption and blind-index key.");
  }
  return {
    activeKeyVersion,
    encryptionKeyCount: encryptionKeys.count,
    activeBlindIndexKeyVersion,
    blindIndexKeyCount: blindIndexKeys.count,
  };
}

export function validatePiiBackfillConfig(env) {
  const organizationId = required(env, "CALL_PII_BACKFILL_ORGANIZATION_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(organizationId)) {
    fail("CALL_PII_BACKFILL_ORGANIZATION_ID must be a lowercase canonical UUID.");
  }
  const batchSize = env.CALL_PII_BACKFILL_BATCH_SIZE === undefined
    ? 100
    : parseInteger(env, "CALL_PII_BACKFILL_BATCH_SIZE", 1, 500);
  const keys = validateCallDataKeys(env);
  return {
    organizationId,
    batchSize,
    activeKeyVersion: keys.activeKeyVersion,
    activeBlindIndexKeyVersion: keys.activeBlindIndexKeyVersion,
  };
}

function parseProxyCidrs(value) {
  if (value === "") return [];
  const entries = value.split(",");
  const result = new Set();
  for (const entry of entries) {
    if (entry !== entry.trim() || entry.length === 0) {
      fail("TRUSTED_PROXY_CIDRS must be a comma-separated list without padding or empty values.");
    }
    const separator = entry.lastIndexOf("/");
    const address = entry.slice(0, separator);
    const prefix = Number(entry.slice(separator + 1));
    const family = isIP(address);
    const maximum = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (separator <= 0 || !Number.isInteger(prefix) || prefix < 1 || prefix > maximum) {
      fail("TRUSTED_PROXY_CIDRS contains an invalid or overly broad CIDR.");
    }
    result.add(entry);
  }
  if (result.size !== entries.length) fail("TRUSTED_PROXY_CIDRS must not contain duplicates.");
  return [...result];
}

function parseAlgorithms(value) {
  const algorithms = value.split(",");
  if (algorithms.length === 0 || algorithms.some((algorithm) => !ASYMMETRIC_ALGORITHMS.has(algorithm))) {
    fail("OIDC_ALLOWED_ALGORITHMS must contain only explicitly supported asymmetric algorithms.");
  }
  if (new Set(algorithms).size !== algorithms.length) {
    fail("OIDC_ALLOWED_ALGORITHMS must not contain duplicates.");
  }
  return algorithms;
}

function compatibleAlgorithmsForKey(publicKey) {
  const keyType = publicKey.asymmetricKeyType;
  const details = publicKey.asymmetricKeyDetails ?? {};
  if (keyType === "rsa") {
    if (!Number.isInteger(details.modulusLength) || details.modulusLength < 2_048) return [];
    return ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"];
  }
  if (keyType === "rsa-pss") {
    if (!Number.isInteger(details.modulusLength) || details.modulusLength < 2_048) return [];
    return ["PS256", "PS384", "PS512"];
  }
  if (keyType === "ec") {
    const curves = {
      "P-256": "ES256",
      prime256v1: "ES256",
      secp256r1: "ES256",
      "P-384": "ES384",
      secp384r1: "ES384",
      "P-521": "ES512",
      secp521r1: "ES512",
    };
    const algorithm = curves[details.namedCurve];
    return algorithm ? [algorithm] : [];
  }
  // The API's installed JOSE verifier supports EdDSA through Ed25519. Ed448
  // keys must not make a deployment look usable when runtime verification
  // cannot consume them.
  if (keyType === "ed25519") return ["EdDSA"];
  return [];
}

export function validatePublicJwks(jwks, algorithms) {
  if (!Array.isArray(jwks?.keys) || jwks.keys.length === 0 || jwks.keys.length > 100) {
    fail("OIDC JWKS must contain between 1 and 100 public keys.");
  }
  const keyIds = new Set();
  let usableKeyCount = 0;
  for (const key of jwks.keys) {
    if (key === null || typeof key !== "object" || Array.isArray(key)) fail("OIDC JWKS contains an invalid key.");
    if (PRIVATE_JWK_FIELDS.some((field) => Object.hasOwn(key, field))) fail("OIDC JWKS exposes private or symmetric key material.");
    if (typeof key.kid !== "string" || key.kid.length === 0 || keyIds.has(key.kid)) {
      fail("OIDC JWKS keys must have unique non-empty kid values.");
    }
    keyIds.add(key.kid);
    if (key.use !== undefined && typeof key.use !== "string") fail("OIDC JWKS use must be a string when present.");
    if (key.use !== undefined && key.use !== "sig") continue;
    if (key.key_ops !== undefined) {
      if (!Array.isArray(key.key_ops) || key.key_ops.some((operation) => typeof operation !== "string")) {
        fail("OIDC JWKS key_ops must be a string array when present.");
      }
      if (!key.key_ops.includes("verify")) continue;
    }
    if (key.alg !== undefined && typeof key.alg !== "string") fail("OIDC JWKS alg must be a string when present.");
    if (typeof key.alg === "string" && !algorithms.includes(key.alg)) continue;

    let publicKey;
    try {
      publicKey = createPublicKey({ key, format: "jwk" });
    } catch {
      continue;
    }
    const compatibleAlgorithms = compatibleAlgorithmsForKey(publicKey);
    const candidates = typeof key.alg === "string" ? [key.alg] : algorithms;
    if (candidates.some((algorithm) => compatibleAlgorithms.includes(algorithm))) usableKeyCount += 1;
  }
  if (usableKeyCount === 0) {
    fail("OIDC JWKS contains no structurally valid public signing key compatible with OIDC_ALLOWED_ALGORITHMS.");
  }
  return { keyCount: jwks.keys.length, usableKeyCount };
}

export function validateProductionConfig(env) {
  if (required(env, "NODE_ENV") !== "production") fail("NODE_ENV must be production.");
  if (required(env, "DEV_AUTH_ENABLED") !== "false") fail("DEV_AUTH_ENABLED must be exactly false.");
  if (required(env, "AUTH_SECRET").length < 32) fail("AUTH_SECRET must contain at least 32 characters.");
  if (optional(env, "VITE_DEV_ORGANIZATION_ID") || optional(env, "VITE_DEV_ROLE")) {
    fail("VITE_DEV_ORGANIZATION_ID and VITE_DEV_ROLE must be absent from a production web build.");
  }
  if (optional(env, "CALL_PII_BACKFILL_ORGANIZATION_ID") || optional(env, "CALL_PII_BACKFILL_BATCH_SIZE")) {
    fail("CALL_PII_BACKFILL_* variables must be absent from the long-running API environment and set only for the scoped CLI job.");
  }

  const webOrigin = parseHttpsUrl(required(env, "PHASE3D_WEB_ORIGIN"), "PHASE3D_WEB_ORIGIN", { originOnly: true }).origin;
  const apiOrigin = parseHttpsUrl(required(env, "PHASE3D_API_ORIGIN"), "PHASE3D_API_ORIGIN", { originOnly: true }).origin;
  if (webOrigin === apiOrigin) fail("PHASE3D_WEB_ORIGIN and PHASE3D_API_ORIGIN must be distinct origins.");

  const viteApiOrigin = parseHttpsUrl(required(env, "VITE_API_URL"), "VITE_API_URL", { originOnly: true }).origin;
  if (viteApiOrigin !== apiOrigin) fail("VITE_API_URL must exactly equal PHASE3D_API_ORIGIN.");
  if (required(env, "VITE_AUTH_MODE") !== "oidc") fail("VITE_AUTH_MODE must be exactly oidc.");

  const issuer = required(env, "OIDC_ISSUER");
  parseHttpsUrl(issuer, "OIDC_ISSUER");
  if (issuer.endsWith("/")) fail("OIDC_ISSUER must use one exact canonical value without a trailing slash.");
  const authority = required(env, "VITE_OIDC_AUTHORITY");
  parseHttpsUrl(authority, "VITE_OIDC_AUTHORITY");
  if (authority.endsWith("/")) {
    fail("VITE_OIDC_AUTHORITY must use the exact OIDC_ISSUER value without a trailing slash.");
  }
  if (issuer !== authority) {
    fail("VITE_OIDC_AUTHORITY must exactly match OIDC_ISSUER.");
  }
  const jwksUri = required(env, "OIDC_JWKS_URI");
  parseHttpsUrl(jwksUri, "OIDC_JWKS_URI");
  const audience = required(env, "OIDC_AUDIENCE");
  if (audience === "*") fail("OIDC_AUDIENCE must be an exact non-wildcard audience.");
  const organizationClaim = required(env, "OIDC_ORGANIZATION_CLAIM");
  if (REGISTERED_JWT_CLAIMS.has(organizationClaim)) {
    fail("OIDC_ORGANIZATION_CLAIM must name a dedicated non-registered claim.");
  }
  const algorithms = parseAlgorithms(required(env, "OIDC_ALLOWED_ALGORITHMS"));
  parseInteger(env, "OIDC_CLOCK_TOLERANCE_SECONDS", 0, 300);

  const redirect = parseHttpsUrl(required(env, "VITE_OIDC_REDIRECT_URI"), "VITE_OIDC_REDIRECT_URI");
  const postLogout = parseHttpsUrl(
    required(env, "VITE_OIDC_POST_LOGOUT_REDIRECT_URI"),
    "VITE_OIDC_POST_LOGOUT_REDIRECT_URI",
  );
  if (redirect.origin !== webOrigin || postLogout.origin !== webOrigin) {
    fail("OIDC redirect and post-logout redirect URLs must use PHASE3D_WEB_ORIGIN.");
  }
  const scopes = required(env, "VITE_OIDC_SCOPE").split(/\s+/);
  if (!scopes.includes("openid")) fail("VITE_OIDC_SCOPE must include openid.");
  required(env, "VITE_OIDC_CLIENT_ID");

  const origins = required(env, "CORS_ALLOWED_ORIGINS").split(",").map((origin, index) =>
    parseHttpsUrl(origin, `CORS_ALLOWED_ORIGINS[${index}]`, { originOnly: true }).origin,
  );
  if (new Set(origins).size !== origins.length) fail("CORS_ALLOWED_ORIGINS must not contain duplicates.");
  if (!origins.includes(webOrigin)) fail("CORS_ALLOWED_ORIGINS must include PHASE3D_WEB_ORIGIN exactly.");

  const expectsProxy = exactBoolean(env, "PHASE3D_EXPECT_PROXY");
  const trustedProxyCidrs = parseProxyCidrs(env.TRUSTED_PROXY_CIDRS ?? "");
  if (expectsProxy && trustedProxyCidrs.length === 0) {
    fail("TRUSTED_PROXY_CIDRS must contain the exact proxy networks when PHASE3D_EXPECT_PROXY=true.");
  }
  if (!expectsProxy && trustedProxyCidrs.length > 0) {
    fail("TRUSTED_PROXY_CIDRS must be empty when PHASE3D_EXPECT_PROXY=false.");
  }

  parsePostgresUrl(required(env, "DATABASE_URL"), "DATABASE_URL");
  if (required(env, "DATABASE_SSL_MODE") !== "verify-full") {
    fail("DATABASE_SSL_MODE must be verify-full for production verification.");
  }
  parseInteger(env, "DATABASE_POOL_MAX", 1, 100);
  parseInteger(env, "DATABASE_IDLE_TIMEOUT_MS", 1_000, 300_000);
  parseInteger(env, "DATABASE_CONNECTION_TIMEOUT_MS", 100, 60_000);
  parseInteger(env, "DATABASE_STATEMENT_TIMEOUT_MS", 100, 60_000);
  parseInteger(env, "DATABASE_LOCK_TIMEOUT_MS", 100, 60_000);

  const callDataKeys = validateCallDataKeys(env);
  return {
    webOrigin,
    apiOrigin,
    issuer,
    jwksUri,
    algorithms,
    proxyMode: expectsProxy ? "trusted_proxy" : "direct",
    trustedProxyCount: trustedProxyCidrs.length,
    callDataActiveKeyVersion: callDataKeys.activeKeyVersion,
    callDataEncryptionKeyCount: callDataKeys.encryptionKeyCount,
    callDataActiveBlindIndexKeyVersion: callDataKeys.activeBlindIndexKeyVersion,
    callDataBlindIndexKeyCount: callDataKeys.blindIndexKeyCount,
  };
}

export function validateAndroidReleaseConfig(env, { fileExists = existsSync } = {}) {
  const apiOrigin = parseHttpsUrl(
    required(env, "CALLORA_ANDROID_API_BASE_URL"),
    "CALLORA_ANDROID_API_BASE_URL",
    { originOnly: true },
  ).origin;
  const keystorePath = required(env, "CALLORA_ANDROID_KEYSTORE_PATH");
  if (!keystorePath.startsWith("/")) fail("CALLORA_ANDROID_KEYSTORE_PATH must be an absolute path.");
  if (!fileExists(keystorePath)) fail("CALLORA_ANDROID_KEYSTORE_PATH does not point to a readable file.");
  const keyAlias = required(env, "CALLORA_ANDROID_KEY_ALIAS");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyAlias)) fail("CALLORA_ANDROID_KEY_ALIAS contains invalid characters.");
  required(env, "CALLORA_ANDROID_KEYSTORE_PASSWORD");
  required(env, "CALLORA_ANDROID_KEY_PASSWORD");
  return { apiOrigin, keystorePath, keyAlias };
}

function boundedJsonResponse(response, label, maximumBytes = 1_048_576) {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    fail(`${label} response exceeds the ${maximumBytes}-byte safety limit.`);
  }
  return response.text().then((body) => {
    if (Buffer.byteLength(body) > maximumBytes) fail(`${label} response exceeds the safety limit.`);
    try {
      return JSON.parse(body);
    } catch {
      fail(`${label} did not return valid JSON.`);
    }
  });
}

async function fetchWithoutRedirect(url, init, label) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    fail(`${label} request failed; verify DNS, TLS, firewall, and deployed endpoint availability.`);
  }
  return response;
}

export async function probeProductionEndpoints(config) {
  const discoveryUrl = `${config.issuer}/.well-known/openid-configuration`;
  const discoveryResponse = await fetchWithoutRedirect(discoveryUrl, { headers: { accept: "application/json" } }, "OIDC discovery");
  if (!discoveryResponse.ok) fail("OIDC discovery did not return a successful response.");
  const discovery = await boundedJsonResponse(discoveryResponse, "OIDC discovery");
  if (discovery.issuer !== config.issuer) fail("OIDC discovery issuer does not exactly match OIDC_ISSUER.");
  if (discovery.jwks_uri !== config.jwksUri) fail("OIDC discovery jwks_uri does not exactly match OIDC_JWKS_URI.");
  parseHttpsUrl(discovery.authorization_endpoint, "OIDC discovery authorization_endpoint", { rejectPlaceholder: true });
  parseHttpsUrl(discovery.token_endpoint, "OIDC discovery token_endpoint", { rejectPlaceholder: true });
  if (!Array.isArray(discovery.response_types_supported) || !discovery.response_types_supported.includes("code")) {
    fail("OIDC discovery must advertise the authorization code response type.");
  }
  if (
    !Array.isArray(discovery.code_challenge_methods_supported) ||
    !discovery.code_challenge_methods_supported.includes("S256")
  ) {
    fail("OIDC discovery must advertise PKCE S256 support.");
  }

  const jwksResponse = await fetchWithoutRedirect(config.jwksUri, { headers: { accept: "application/json" } }, "OIDC JWKS");
  if (!jwksResponse.ok) fail("OIDC JWKS did not return a successful response.");
  const jwks = await boundedJsonResponse(jwksResponse, "OIDC JWKS");
  const jwksResult = validatePublicJwks(jwks, config.algorithms);

  for (const path of ["/health", "/ready"]) {
    const response = await fetchWithoutRedirect(`${config.apiOrigin}${path}`, { headers: { accept: "application/json" } }, `API ${path}`);
    if (!response.ok) fail(`API ${path} did not return a successful response.`);
    await boundedJsonResponse(response, `API ${path}`, 65_536);
  }

  const corsResponse = await fetchWithoutRedirect(
    `${config.apiOrigin}/v1/session`,
    {
      method: "OPTIONS",
      headers: {
        origin: config.webOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    },
    "API CORS preflight",
  );
  if (!corsResponse.ok) fail("API CORS preflight did not return a successful response.");
  if (corsResponse.headers.get("access-control-allow-origin") !== config.webOrigin) {
    fail("API CORS preflight did not echo the exact production web origin.");
  }
  if (corsResponse.headers.get("access-control-allow-credentials") === "true") {
    fail("API CORS preflight unexpectedly enables credentialed browser requests.");
  }
  const allowedMethods = (corsResponse.headers.get("access-control-allow-methods") ?? "")
    .split(",")
    .map((method) => method.trim().toUpperCase());
  if (!allowedMethods.includes("GET")) fail("API CORS preflight did not allow the requested GET method.");
  const allowedHeaders = (corsResponse.headers.get("access-control-allow-headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase());
  if (!allowedHeaders.includes("authorization") || !allowedHeaders.includes("content-type")) {
    fail("API CORS preflight did not allow authorization and content-type headers.");
  }

  const webResponse = await fetchWithoutRedirect(config.webOrigin, { headers: { accept: "text/html" } }, "production web origin");
  if (!webResponse.ok) fail("Production web origin did not return a successful response.");
  return {
    discovery: true,
    jwksKeyCount: jwksResult.keyCount,
    usableJwksKeyCount: jwksResult.usableKeyCount,
    api: true,
    cors: true,
    web: true,
  };
}

function runKeytool(android) {
  const result = spawnSync(
    "keytool",
    [
      "-exportcert",
      "-rfc",
      "-keystore",
      android.keystorePath,
      "-alias",
      android.keyAlias,
      "-storepass:env",
      "CALLORA_ANDROID_KEYSTORE_PASSWORD",
    ],
    { encoding: "utf8", env: process.env },
  );
  if (result.error?.code === "ENOENT") fail("keytool is required for the Android signing preflight.");
  if (result.status !== 0) fail("Android signing certificate could not be read with the configured keystore and alias.");
  let certificate;
  try {
    certificate = new X509Certificate(result.stdout);
  } catch {
    fail("Android keystore did not return a valid X.509 signing certificate.");
  }
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  const minimumRemainingMs = 365 * 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > Date.now()) {
    fail("Android signing certificate is not currently valid.");
  }
  if (validTo - Date.now() < minimumRemainingMs) {
    fail("Android signing certificate must remain valid for at least one year.");
  }
  return { fingerprintSha256: certificate.fingerprint256, validTo: certificate.validTo };
}

export function redactSensitiveText(value, secretValues = []) {
  let redacted = String(value);
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  redacted = redacted.replace(/postgres(?:ql)?:\/\/[^\s'\"]+/gi, "[REDACTED_POSTGRES_URL]");
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
  return redacted;
}

async function main() {
  const mode = process.argv[2];
  if (!["--config", "--network", "--android", "--all"].includes(mode)) {
    fail("Usage: node scripts/phase3d-release-preflight.mjs <--config|--network|--android|--all>");
  }
  const result = { checkedAt: new Date().toISOString(), mode };
  if (["--config", "--network", "--all"].includes(mode)) {
    const config = validateProductionConfig(process.env);
    result.productionConfig = {
      webOrigin: config.webOrigin,
      apiOrigin: config.apiOrigin,
      issuer: config.issuer,
      algorithms: config.algorithms,
      proxyMode: config.proxyMode,
      trustedProxyCount: config.trustedProxyCount,
      callDataActiveKeyVersion: config.callDataActiveKeyVersion,
      callDataEncryptionKeyCount: config.callDataEncryptionKeyCount,
      callDataActiveBlindIndexKeyVersion: config.callDataActiveBlindIndexKeyVersion,
      callDataBlindIndexKeyCount: config.callDataBlindIndexKeyCount,
    };
    if (["--network", "--all"].includes(mode)) result.network = await probeProductionEndpoints(config);
  }
  if (["--android", "--all"].includes(mode)) {
    const android = validateAndroidReleaseConfig(process.env);
    const certificate = runKeytool(android);
    result.android = { apiOrigin: android.apiOrigin, keyAlias: android.keyAlias, certificate };
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const secrets = [
      process.env.AUTH_SECRET,
      process.env.DATABASE_URL,
      process.env.CALL_PII_ENCRYPTION_KEYS,
      process.env.CALL_PII_ROW_ID_KEY,
      process.env.CALL_PII_BLIND_INDEX_KEYS,
      process.env.CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION,
      process.env.CALL_PII_BLIND_INDEX_KEY,
      process.env.CALLORA_ANDROID_KEYSTORE_PASSWORD,
      process.env.CALLORA_ANDROID_KEY_PASSWORD,
    ];
    console.error(`Phase 3D preflight failed: ${redactSensitiveText(error instanceof Error ? error.message : error, secrets)}`);
    process.exitCode = 1;
  });
}
