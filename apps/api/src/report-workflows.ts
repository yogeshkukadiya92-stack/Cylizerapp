import { createHash, randomBytes } from "node:crypto";

export const REPORT_DOWNLOAD_TTL_SECONDS = 48 * 60 * 60;
export const MAX_DELIVERY_ATTEMPTS = 5;

export function createDownloadToken(): string {
  return `clr_${randomBytes(32).toString("base64url")}`;
}

export function hashDownloadToken(token: string): Buffer {
  if (!/^clr_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid report download token");
  return createHash("sha256").update(token, "utf8").digest();
}

export function secureTokenMatches(token: string, expectedHash: Uint8Array): boolean {
  const actual = hashDownloadToken(token);
  if (actual.length !== expectedHash.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index]! ^ expectedHash[index]!;
  return difference === 0;
}

export function retryDelaySeconds(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_DELIVERY_ATTEMPTS) throw new Error("attempt must be between 1 and 5");
  return Math.min(3600, 30 * 2 ** (attempt - 1));
}

export function schedulePeriodKey(at: Date, timeZone: string, cadence: "daily" | "weekly"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", ...(cadence === "weekly" ? { weekday: "short" as const } : {}) }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const dateKey = `${value("year")}-${value("month")}-${value("day")}`;
  if (cadence === "daily") return dateKey;
  const local = new Date(`${dateKey}T00:00:00.000Z`); const day = local.getUTCDay() || 7; local.setUTCDate(local.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1)); const week = Math.ceil((((local.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${local.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
