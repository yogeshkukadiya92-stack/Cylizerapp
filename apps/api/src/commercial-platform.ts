import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export type ApiScope = "leads.read" | "leads.write" | "reports.read" | "webhooks.manage";
export interface CommercialPlan { key: "trial" | "starter" | "growth" | "enterprise"; seatLimit: number; storageLimitBytes: number; apiRequestsPerMinute: number; }
export interface SubscriptionState { organizationId: string; plan: CommercialPlan; status: "trialing" | "active" | "past_due" | "canceled"; graceEndsAt?: string; providerCustomerId?: string; providerSubscriptionId?: string; }
interface ApiKeyRecord { id: string; organizationId: string; name: string; prefix: string; secretHash: string; scopes: ApiScope[]; revokedAt?: string; }
interface Delivery { id: string; organizationId: string; url: string; eventId: string; eventType: string; payload: string; attempts: number; nextAttemptAt: number; status: "queued" | "delivered" | "failed"; }

/** Hashed, show-once API keys with scoped verification and bounded quotas. */
export class ApiKeyService {
  private readonly records = new Map<string, ApiKeyRecord>(); private readonly windows = new Map<string, { minute: number; count: number }>();
  create(organizationId: string, name: string, scopes: ApiScope[]): { id: string; key: string; prefix: string } { if (!name.trim() || scopes.length === 0) throw new Error("API key name and scopes are required"); const id = randomUUID(); const secret = randomBytes(32).toString("base64url"); const prefix = `clr_live_${id.slice(0, 8)}`; const key = `${prefix}.${secret}`; this.records.set(id, { id, organizationId, name: name.trim(), prefix, secretHash: digest(key), scopes: [...new Set(scopes)] }); return { id, key, prefix }; }
  verify(key: string, scope: ApiScope, limit: number, now = Date.now()): { organizationId: string; keyId: string } | undefined { const prefix = key.split(".")[0]; const record = [...this.records.values()].find((item) => item.prefix === prefix); if (!record || record.revokedAt || !record.scopes.includes(scope)) return undefined; const actual = Buffer.from(digest(key)); const expected = Buffer.from(record.secretHash); if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined; const minute = Math.floor(now / 60_000); const window = this.windows.get(record.id); const count = window?.minute === minute ? window.count + 1 : 1; if (count > limit) throw new Error("API quota exceeded"); this.windows.set(record.id, { minute, count }); return { organizationId: record.organizationId, keyId: record.id }; }
  revoke(organizationId: string, id: string, at = new Date().toISOString()): boolean { const record = this.records.get(id); if (!record || record.organizationId !== organizationId || record.revokedAt) return false; record.revokedAt = at; return true; }
}

export function signCustomerWebhook(secret: string, timestamp: number, body: string): string { return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`; }
export function verifySignedWebhook(secret: string, signature: string, body: string, now = Date.now(), toleranceSeconds = 300): boolean { const parts = Object.fromEntries(signature.split(",").map((part) => part.split("=", 2))); const timestamp = Number(parts.t); if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp * 1000) > toleranceSeconds * 1000 || !parts.v1) return false; const expected = signCustomerWebhook(secret, timestamp, body).split("v1=")[1]!; const a = Buffer.from(parts.v1); const b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }

export class CustomerWebhookQueue {
  private readonly deliveries = new Map<string, Delivery>(); enqueue(input: Omit<Delivery, "id" | "attempts" | "nextAttemptAt" | "status">): string { const duplicate = [...this.deliveries.values()].find((item) => item.organizationId === input.organizationId && item.url === input.url && item.eventId === input.eventId); if (duplicate) return duplicate.id; const id = randomUUID(); this.deliveries.set(id, { ...input, id, attempts: 0, nextAttemptAt: Date.now(), status: "queued" }); return id; }
  async deliver(id: string, secret: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<"delivered" | "deferred" | "failed"> { const item = this.deliveries.get(id); if (!item || item.status !== "queued" || item.nextAttemptAt > now) return "deferred"; item.attempts += 1; try { const timestamp = Math.floor(now / 1000); const response = await fetcher(item.url, { method: "POST", headers: { "content-type": "application/json", "x-callora-event": item.eventType, "x-callora-delivery": item.eventId, "x-callora-signature": signCustomerWebhook(secret, timestamp, item.payload) }, body: item.payload, redirect: "error", signal: AbortSignal.timeout(10_000) }); if (response.ok) { item.status = "delivered"; return "delivered"; } } catch { /* isolated retry */ } if (item.attempts >= 8) { item.status = "failed"; return "failed"; } item.nextAttemptAt = now + Math.min(24 * 60 * 60_000, 30_000 * 2 ** (item.attempts - 1)); return "deferred"; }
}

export class SubscriptionService {
  private readonly states = new Map<string, SubscriptionState>(); private readonly processedEvents = new Set<string>();
  set(state: SubscriptionState): void { this.states.set(state.organizationId, structuredClone(state)); }
  access(organizationId: string, now = new Date()): "full" | "read_only" { const state = this.states.get(organizationId); if (!state) return "read_only"; if (["active", "trialing"].includes(state.status)) return "full"; return state.graceEndsAt && state.graceEndsAt > now.toISOString() ? "full" : "read_only"; }
  applyProviderEvent(eventId: string, state: SubscriptionState): boolean { if (this.processedEvents.has(eventId)) return false; this.processedEvents.add(eventId); this.set(state); return true; }
}

/** Stripe Checkout/Portal adapter; no raw card data enters Callora. */
export class StripeBillingProvider {
  constructor(private readonly secretKey: string, private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, parameters: URLSearchParams): Promise<Record<string, unknown>> { const response = await this.fetcher(`https://api.stripe.com/v1/${path}`, { method: "POST", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded", "stripe-version": "2026-02-25.clover" }, body: parameters, signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`Billing provider request failed (${response.status})`); return await response.json() as Record<string, unknown>; }
  checkout(customerId: string, priceId: string, successUrl: string, cancelUrl: string) { return this.request("checkout/sessions", new URLSearchParams({ customer: customerId, mode: "subscription", "line_items[0][price]": priceId, "line_items[0][quantity]": "1", success_url: successUrl, cancel_url: cancelUrl })); }
  portal(customerId: string, returnUrl: string) { return this.request("billing_portal/sessions", new URLSearchParams({ customer: customerId, return_url: returnUrl })); }
}

export interface ConnectorCredentialVault { seal(organizationId: string, value: string): Promise<string>; open(organizationId: string, sealed: string): Promise<string>; }
export class ConnectorRunner { async run<T>(organizationId: string, operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; retryable: boolean }> { try { return { ok: true, value: await operation() }; } catch { return { ok: false, retryable: true }; } } }
