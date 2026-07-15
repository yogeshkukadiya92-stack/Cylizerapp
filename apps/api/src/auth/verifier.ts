import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcVerifierConfig, OidcSignatureAlgorithm } from "./config.js";
import { OidcBearerVerificationError } from "./errors.js";
import type { OidcBearerVerifier, TrustedOidcIdentity } from "./types.js";

const REQUIRED_STANDARD_CLAIMS = ["iss", "aud", "exp", "sub"] as const;

export interface StrictJwtVerificationInput {
  token: string;
  issuer: string;
  audience: string;
  algorithms: readonly OidcSignatureAlgorithm[];
  clockToleranceSeconds: number;
  requiredClaims: readonly string[];
}

export interface StrictJwtVerificationResult {
  payload: Readonly<Record<string, unknown>>;
  protectedHeader: Readonly<{ alg?: string }>;
}

/** Injection point for deterministic tests or an alternative audited JWT backend. */
export type JwtVerificationBackend = (
  input: StrictJwtVerificationInput,
) => Promise<StrictJwtVerificationResult>;

function createJoseRemoteJwksBackend(config: OidcVerifierConfig): JwtVerificationBackend {
  const remoteJwks = createRemoteJWKSet(new URL(config.jwksUri), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60 * 1_000,
  });

  return async (input) => {
    const result = await jwtVerify(input.token, remoteJwks, {
      issuer: input.issuer,
      audience: input.audience,
      algorithms: [...input.algorithms],
      clockTolerance: input.clockToleranceSeconds,
      requiredClaims: [...input.requiredClaims],
    });
    return {
      payload: result.payload,
      protectedHeader: result.protectedHeader,
    };
  };
}

function exactNonEmptyClaim(
  payload: Readonly<Record<string, unknown>>,
  claim: string,
  reason: "invalid_subject" | "invalid_organization" | "invalid_issuer",
): string {
  const value = payload[claim];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 512
  ) {
    throw new OidcBearerVerificationError(reason);
  }
  return value;
}

/**
 * Production verifier using jose and a caching remote JWKS resolver by default.
 * The injected backend exists so claim projection and integration tests do not
 * need network access; production callers should omit it.
 */
export class ProductionOidcBearerVerifier implements OidcBearerVerifier {
  private readonly backend: JwtVerificationBackend;

  constructor(
    private readonly config: OidcVerifierConfig,
    backend?: JwtVerificationBackend,
  ) {
    this.backend = backend ?? createJoseRemoteJwksBackend(config);
  }

  async verify(token: string): Promise<TrustedOidcIdentity> {
    if (token.length === 0 || token !== token.trim()) {
      throw new OidcBearerVerificationError("invalid_token");
    }

    try {
      const result = await this.backend({
        token,
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        clockToleranceSeconds: this.config.clockToleranceSeconds,
        requiredClaims: [...REQUIRED_STANDARD_CLAIMS, this.config.organizationClaim],
      });

      const algorithm = result.protectedHeader.alg;
      if (algorithm === undefined || !this.config.algorithms.includes(algorithm as OidcSignatureAlgorithm)) {
        throw new OidcBearerVerificationError("disallowed_algorithm");
      }

      const issuer = exactNonEmptyClaim(result.payload, "iss", "invalid_issuer");
      if (issuer !== this.config.issuer) {
        throw new OidcBearerVerificationError("invalid_issuer");
      }

      return {
        subject: exactNonEmptyClaim(result.payload, "sub", "invalid_subject"),
        organizationId: exactNonEmptyClaim(
          result.payload,
          this.config.organizationClaim,
          "invalid_organization",
        ),
        issuer,
      };
    } catch (error) {
      if (error instanceof OidcBearerVerificationError) throw error;
      throw new OidcBearerVerificationError("invalid_token", { cause: error });
    }
  }
}
