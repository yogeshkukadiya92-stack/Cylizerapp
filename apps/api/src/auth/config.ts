const SUPPORTED_ASYMMETRIC_ALGORITHMS = [
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
] as const;

export type OidcSignatureAlgorithm = (typeof SUPPORTED_ASYMMETRIC_ALGORITHMS)[number];

export interface OidcVerifierConfig {
  /** Exact `iss` claim expected in every accepted token. */
  issuer: string;
  /** Exact API audience expected in every accepted token. */
  audience: string;
  /** HTTPS endpoint used by jose's caching remote JWKS resolver. */
  jwksUri: string;
  /** Exact top-level JWT claim containing the Callora organization ID. */
  organizationClaim: string;
  /** Explicit asymmetric JWS allowlist. Symmetric and `none` algorithms are rejected. */
  algorithms: readonly OidcSignatureAlgorithm[];
  clockToleranceSeconds: number;
}

const REGISTERED_CLAIMS = new Set(["iss", "sub", "aud", "exp", "nbf", "iat", "jti"]);

function requiredExactValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when production OIDC authentication is enabled`);
  }
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireHttpsUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials or a fragment`);
  }
  return value;
}

function readAlgorithms(value: string | undefined): readonly OidcSignatureAlgorithm[] {
  const candidates = value === undefined ? ["RS256"] : value.split(",");
  if (candidates.length === 0) {
    throw new Error("OIDC_ALLOWED_ALGORITHMS must contain at least one algorithm");
  }

  const algorithms: OidcSignatureAlgorithm[] = [];
  for (const candidate of candidates) {
    if (candidate.length === 0 || candidate !== candidate.trim()) {
      throw new Error("OIDC_ALLOWED_ALGORITHMS must be a comma-separated list without empty or padded values");
    }
    if (!SUPPORTED_ASYMMETRIC_ALGORITHMS.includes(candidate as OidcSignatureAlgorithm)) {
      throw new Error(
        `OIDC_ALLOWED_ALGORITHMS contains unsupported or unsafe algorithm: ${candidate}`,
      );
    }
    const algorithm = candidate as OidcSignatureAlgorithm;
    if (algorithms.includes(algorithm)) {
      throw new Error(`OIDC_ALLOWED_ALGORITHMS contains duplicate algorithm: ${algorithm}`);
    }
    algorithms.push(algorithm);
  }
  return algorithms;
}

function readClockTolerance(value: string | undefined): number {
  if (value === undefined) return 5;
  if (!/^\d+$/.test(value)) {
    throw new Error("OIDC_CLOCK_TOLERANCE_SECONDS must be an integer between 0 and 300");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 300) {
    throw new Error("OIDC_CLOCK_TOLERANCE_SECONDS must be an integer between 0 and 300");
  }
  return parsed;
}

/**
 * Load the production OIDC settings without coupling them to the API's local
 * development-token configuration. All trust-boundary values are required and
 * validated exactly; no discovery or issuer normalization is performed.
 */
export function loadOidcVerifierConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OidcVerifierConfig {
  const issuer = requireHttpsUrl(requiredExactValue(env, "OIDC_ISSUER"), "OIDC_ISSUER");
  const audience = requiredExactValue(env, "OIDC_AUDIENCE");
  if (audience === "*") {
    throw new Error("OIDC_AUDIENCE must be an exact audience and cannot be a wildcard");
  }

  const jwksUri = requireHttpsUrl(requiredExactValue(env, "OIDC_JWKS_URI"), "OIDC_JWKS_URI");
  const organizationClaim = requiredExactValue(env, "OIDC_ORGANIZATION_CLAIM");
  if (REGISTERED_CLAIMS.has(organizationClaim)) {
    throw new Error("OIDC_ORGANIZATION_CLAIM must name a dedicated non-registered claim");
  }

  return {
    issuer,
    audience,
    jwksUri,
    organizationClaim,
    algorithms: readAlgorithms(env.OIDC_ALLOWED_ALGORITHMS),
    clockToleranceSeconds: readClockTolerance(env.OIDC_CLOCK_TOLERANCE_SECONDS),
  };
}
