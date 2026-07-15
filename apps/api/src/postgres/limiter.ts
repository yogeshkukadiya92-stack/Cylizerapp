import { createHmac } from "node:crypto";
import { ApiDomainError } from "../errors.js";
import type { Clock, SharedAttemptLimiter } from "../security.js";
import type { PgPoolLike } from "./types.js";

/** Replica-safe fixed-window limiter backed by the shared PostgreSQL store. */
export class PostgresPairingAttemptLimiter implements SharedAttemptLimiter {
  readonly isReplicaSafe = true;

  constructor(
    private readonly pool: PgPoolLike,
    private readonly secret: string,
    private readonly clock: Clock,
    private readonly maximumAttempts: number,
    private readonly windowSeconds: number,
  ) {}

  private keyHash(key: string): string {
    return createHmac("sha256", this.secret)
      .update(`mobile-rate-limit:pairing_redeem:${key}`)
      .digest("hex");
  }

  async consumeAttempt(key: string): Promise<void> {
    const result = await this.pool.query<{
      allowed: boolean;
      retry_after_seconds: number;
    }>(`
      select allowed, retry_after_seconds
      from callora.consume_mobile_rate_limit(
        decode($1, 'hex'), 'pairing_redeem', $2, $3, $4::timestamptz
      )
    `, [this.keyHash(key), this.maximumAttempts, this.windowSeconds, this.clock.now().toISOString()]);
    const row = result.rows[0];
    if (!row || typeof row.allowed !== "boolean") {
      throw new Error("PostgreSQL returned an invalid rate-limit decision");
    }
    if (!row.allowed) {
      throw new ApiDomainError({
        statusCode: 429,
        code: "RATE_LIMITED",
        message: "Too many pairing attempts. Try again later.",
        retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds) || 1),
      });
    }
  }

  async reset(key: string): Promise<void> {
    await this.pool.query(`
      select callora.reset_mobile_rate_limit(decode($1, 'hex'), 'pairing_redeem')
    `, [this.keyHash(key)]);
  }
}
