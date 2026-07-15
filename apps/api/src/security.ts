import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OrganizationId, UserId } from "@callora/contracts";
import { isNonEmptyString, isRecord } from "@callora/contracts";
import { ApiDomainError, badRequest, unauthenticated } from "./errors.js";

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

interface AccessTokenPayload {
  version: 1;
  subject: UserId;
  organizationId: OrganizationId;
  issuedAt: number;
  expiresAt: number;
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signaturesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class AccessTokenService {
  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
    private readonly ttlSeconds: number,
  ) {}

  issue(subject: UserId, organizationId: OrganizationId): {
    accessToken: string;
    expiresAt: string;
  } {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1_000);
    const payload: AccessTokenPayload = {
      version: 1,
      subject,
      organizationId,
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + this.ttlSeconds,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return {
      accessToken: `${encoded}.${sign(encoded, this.secret)}`,
      expiresAt: new Date(payload.expiresAt * 1_000).toISOString(),
    };
  }

  verify(token: string): AccessTokenPayload {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw unauthenticated("The bearer token is malformed");
    }

    const expectedSignature = sign(parts[0], this.secret);
    if (!signaturesMatch(parts[1], expectedSignature)) {
      throw unauthenticated("The bearer token signature is invalid");
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw unauthenticated("The bearer token payload is invalid");
    }

    if (
      !isRecord(candidate) ||
      candidate.version !== 1 ||
      !isNonEmptyString(candidate.subject) ||
      !isNonEmptyString(candidate.organizationId) ||
      typeof candidate.issuedAt !== "number" ||
      typeof candidate.expiresAt !== "number"
    ) {
      throw unauthenticated("The bearer token payload is invalid");
    }

    const nowSeconds = Math.floor(this.clock.now().getTime() / 1_000);
    if (candidate.expiresAt <= nowSeconds) {
      throw unauthenticated("The bearer token has expired");
    }
    if (candidate.issuedAt > nowSeconds + 60) {
      throw unauthenticated("The bearer token was issued in the future");
    }

    return candidate as unknown as AccessTokenPayload;
  }
}

interface SignedCursorEnvelope {
  version: 1;
  kind: string;
  organizationId: OrganizationId;
  value: unknown;
}

export class CursorCodec {
  constructor(private readonly secret: string) {}

  encode(kind: string, organizationId: OrganizationId, value: unknown): string {
    const envelope: SignedCursorEnvelope = { version: 1, kind, organizationId, value };
    const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64url");
    return `${encoded}.${sign(encoded, this.secret)}`;
  }

  decode<T>(cursor: string, kind: string, organizationId: OrganizationId): T {
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw badRequest("The cursor is malformed", "cursor");
    }
    const expectedSignature = sign(parts[0], this.secret);
    if (!signaturesMatch(parts[1], expectedSignature)) {
      throw badRequest("The cursor signature is invalid", "cursor");
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw badRequest("The cursor payload is invalid", "cursor");
    }

    if (
      !isRecord(candidate) ||
      candidate.version !== 1 ||
      candidate.kind !== kind ||
      candidate.organizationId !== organizationId ||
      !("value" in candidate)
    ) {
      throw badRequest("The cursor does not belong to this resource", "cursor");
    }
    return candidate.value as T;
  }
}

export function hashPairingCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(`pairing:${code.trim().toUpperCase()}`).digest("hex");
}

export function hashPairingRateLimitDimension(
  dimension: "ip" | "code" | "installation",
  value: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`pairing-rate-limit:${dimension}:${value}`)
    .digest("hex");
}

export type DeviceCredentialType = "bootstrap" | "session";

export interface IssuedDeviceCredential {
  token: string;
  tokenHash: string;
  expiresAt: string;
}

export function hashDeviceCredential(
  token: string,
  secret: string,
  credentialType: DeviceCredentialType,
): string {
  return createHmac("sha256", secret)
    .update(`device-credential:${credentialType}:${token}`)
    .digest("hex");
}

export function issueDeviceCredential(options: {
  credentialType: DeviceCredentialType;
  secret: string;
  clock: Clock;
  ttlSeconds: number;
  issuedAt?: Date;
}): IssuedDeviceCredential {
  const prefix = options.credentialType === "bootstrap" ? "clb" : "cls";
  const token = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const issuedAt = options.issuedAt ?? options.clock.now();
  return {
    token,
    tokenHash: hashDeviceCredential(token, options.secret, options.credentialType),
    expiresAt: new Date(issuedAt.getTime() + options.ttlSeconds * 1_000).toISOString(),
  };
}

export function isOpaqueDeviceCredential(token: string, credentialType: DeviceCredentialType): boolean {
  const prefix = credentialType === "bootstrap" ? "clb" : "cls";
  return new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(token);
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Database-bound mobile payload digests must not permit offline PII guessing.
 * The domain prefix prevents this key use from colliding with other HMACs.
 */
export function fingerprintMobileCallBatch(value: unknown, secret: string): string {
  if (secret.length < 32) throw new Error("Mobile batch fingerprint secret must contain at least 32 characters");
  return createHmac("sha256", secret)
    .update("callora:mobile-call-batch-payload:v1\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

export interface SharedAttemptLimiter {
  /** True only when all API replicas observe the same limiter state. */
  readonly isReplicaSafe: boolean;
  /** Atomically checks and consumes one attempt. Successful callers reset it. */
  consumeAttempt(key: string): void | Promise<void>;
  reset(key: string): void | Promise<void>;
}

/**
 * Bounded development/test limiter. It is intentionally not replica-safe and
 * must never be selected implicitly in production.
 */
export class PairingAttemptLimiter implements SharedAttemptLimiter {
  private readonly failures = new Map<string, number[]>();
  readonly isReplicaSafe = false;

  constructor(
    private readonly clock: Clock,
    private readonly maximumAttempts: number,
    private readonly windowSeconds: number,
    private readonly maximumTrackedKeys = 10_000,
  ) {}

  private pruneExpired(): void {
    const validAfter = this.clock.now().getTime() - this.windowSeconds * 1_000;
    for (const [key, values] of this.failures) {
      const recent = values.filter((value) => value > validAfter);
      if (recent.length === 0) this.failures.delete(key);
      else this.failures.set(key, recent);
    }
  }

  private rateLimited(retryAfterSeconds: number): ApiDomainError {
    return new ApiDomainError({
      statusCode: 429,
      code: "RATE_LIMITED",
      message: "Too many pairing attempts. Try again later.",
      retryAfterSeconds,
    });
  }

  consumeAttempt(key: string): void {
    this.pruneExpired();
    const now = this.clock.now().getTime();
    const validAfter = now - this.windowSeconds * 1_000;
    const recent = (this.failures.get(key) ?? []).filter((value) => value > validAfter);
    if (recent.length >= this.maximumAttempts) {
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowSeconds * 1_000 - now) / 1_000));
      throw this.rateLimited(retryAfterSeconds);
    }
    if (!this.failures.has(key) && this.failures.size >= this.maximumTrackedKeys) {
      throw this.rateLimited(this.windowSeconds);
    }
    const values = recent;
    values.push(now);
    this.failures.set(key, values);
  }

  getRetryAfterSeconds(key: string): number | undefined {
    const now = this.clock.now().getTime();
    const recent = this.failures.get(key) ?? [];
    if (recent.length < this.maximumAttempts) return undefined;
    return Math.max(1, Math.ceil(((recent[0] ?? now) + this.windowSeconds * 1_000 - now) / 1_000));
  }

  /** @deprecated Use consumeAttempt so check+increment cannot be split. */
  assertAllowed(key: string): void {
    this.consumeAttempt(key);
  }

  /** @deprecated Attempts are consumed atomically by consumeAttempt. */
  recordFailure(_key: string): void {}

  reset(key: string): void {
    this.failures.delete(key);
  }

  /** Exposed for deterministic capacity/TTL tests, not for request decisions. */
  trackedKeyCount(): number {
    this.pruneExpired();
    return this.failures.size;
  }
}
