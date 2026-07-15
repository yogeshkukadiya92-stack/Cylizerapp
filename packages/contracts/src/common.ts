/** An opaque server-issued identifier. IDs are strings at every transport boundary. */
export type EntityId = string;

/** An RFC 3339 timestamp, for example `2026-07-14T09:30:00.000Z`. */
export type IsoDateTime = string;

/** An ISO 8601 calendar date, for example `2026-07-14`. */
export type IsoDate = string;

/** A normalized E.164 phone number whenever the source can provide one. */
export type PhoneNumber = string;

export type EmailAddress = string;
export type CurrencyCode = string;
export type CountryCode = string;
export type TimeZone = string;
export type DurationSeconds = number;
export type Percentage = number;
export type SortDirection = "asc" | "desc";

export interface AuditFields {
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  createdBy?: EntityId;
  updatedBy?: EntityId;
}

export interface DateTimeRange {
  from: IsoDateTime;
  to: IsoDateTime;
}

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  countryCode: CountryCode;
}

export interface Money {
  /** Integer value in the currency's smallest unit, such as paise or cents. */
  amountMinor: number;
  currency: CurrencyCode;
}

export type Primitive = string | number | boolean | null;
export type JsonValue = Primitive | JsonValue[] | { [key: string]: JsonValue };

/** Narrow an unknown value to a plain object suitable for lightweight guards. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isIsoDateTime(value: unknown): value is IsoDateTime {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function hasOnlyStringValues(
  value: unknown,
): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

/** Compile-time exhaustiveness helper for discriminated unions. */
export function assertNever(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${String(value)}`);
}
