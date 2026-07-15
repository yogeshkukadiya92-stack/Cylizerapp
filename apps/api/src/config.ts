import { isIP } from "node:net";

export type RuntimeEnvironment = "development" | "test" | "production";
export type DatabaseSslMode = "disable" | "require" | "verify-full";

export interface DatabaseConfig {
  connectionString: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  sslMode: DatabaseSslMode;
}

export interface ApiConfig {
  environment: RuntimeEnvironment;
  host: string;
  port: number;
  authSecret: string;
  enableDevAuth: boolean;
  tokenTtlSeconds: number;
  pairingCodeTtlSeconds: number;
  deviceBootstrapTtlSeconds: number;
  deviceSessionTtlSeconds: number;
  pairingAttemptLimit: number;
  pairingAttemptWindowSeconds: number;
  trustedProxyCidrs: string[];
  allowedOrigins: string[];
  releaseSha?: string;
  database?: DatabaseConfig;
}

const LOCAL_ONLY_SECRET = "callora-local-development-secret-not-for-production-use";

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = readPositiveInteger(value, fallback);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function readEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === undefined || value === "development") {
    return "development";
  }
  if (value === "test" || value === "production") {
    return value;
  }
  throw new Error(`Unsupported NODE_ENV: ${value}`);
}

function readTrustedProxyCidrs(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error("TRUSTED_PROXY_CIDRS must be a comma-separated list of explicit CIDRs");
  }

  const trusted = new Set<string>();
  for (const entry of entries) {
    const separator = entry.lastIndexOf("/");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`TRUSTED_PROXY_CIDRS entry must use CIDR notation: ${entry}`);
    }
    const address = entry.slice(0, separator);
    const prefixText = entry.slice(separator + 1);
    const family = isIP(address);
    const prefix = Number(prefixText);
    const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > maximumPrefix) {
      throw new Error(`TRUSTED_PROXY_CIDRS entry is invalid or overly broad: ${entry}`);
    }
    trusted.add(entry);
  }
  return [...trusted];
}

function readDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
  environment: RuntimeEnvironment,
): DatabaseConfig | undefined {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    if (environment === "production") {
      throw new Error("DATABASE_URL is required in production");
    }
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be an absolute PostgreSQL connection URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hash.length > 0) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql:// and must not contain a fragment");
  }
  for (const parameter of parsed.searchParams.keys()) {
    if (parameter.toLowerCase() === "ssl" || parameter.toLowerCase().startsWith("ssl")) {
      throw new Error("Configure database TLS with DATABASE_SSL_MODE, not DATABASE_URL SSL parameters");
    }
  }

  const sslMode = env.DATABASE_SSL_MODE ?? (environment === "production" ? "verify-full" : "disable");
  if (!["disable", "require", "verify-full"].includes(sslMode)) {
    throw new Error("DATABASE_SSL_MODE must be disable, require, or verify-full");
  }
  if (environment === "production" && sslMode !== "verify-full") {
    throw new Error("DATABASE_SSL_MODE must be verify-full in production");
  }

  return {
    connectionString,
    maxConnections: readPositiveInteger(env.DATABASE_POOL_MAX, 10),
    idleTimeoutMs: readPositiveInteger(env.DATABASE_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMs: readPositiveInteger(env.DATABASE_CONNECTION_TIMEOUT_MS, 5_000),
    statementTimeoutMs: readPositiveInteger(env.DATABASE_STATEMENT_TIMEOUT_MS, 5_000),
    lockTimeoutMs: readPositiveInteger(env.DATABASE_LOCK_TIMEOUT_MS, 1_000),
    sslMode: sslMode as DatabaseSslMode,
  };
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiConfig {
  const environment = readEnvironment(env.NODE_ENV);
  const configuredSecret = env.AUTH_SECRET;

  if (environment === "production" && (!configuredSecret || configuredSecret.length < 32)) {
    throw new Error("AUTH_SECRET must be configured with at least 32 characters in production");
  }

  const authSecret = configuredSecret ?? LOCAL_ONLY_SECRET;
  if (authSecret.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }

  const configuredOrigins = env.CORS_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const allowedOrigins = configuredOrigins ?? (environment === "development" ? ["http://localhost:4173"] : []);
  if (allowedOrigins.includes("*")) {
    throw new Error("CORS_ALLOWED_ORIGINS must not contain a wildcard");
  }
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (!parsed.origin || parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`CORS origin must be an exact http(s) origin: ${origin}`);
    }
  }

  const database = readDatabaseConfig(env, environment);
  const releaseSha = env.RELEASE_SHA?.trim(); if (releaseSha && !/^[a-f0-9]{7,64}$/i.test(releaseSha)) throw new Error("RELEASE_SHA must be a 7-64 character hexadecimal commit identifier");

  return {
    environment,
    host: env.HOST ?? "127.0.0.1",
    port: readPositiveInteger(env.PORT, 4100),
    authSecret,
    enableDevAuth:
      environment !== "production" &&
      (env.DEV_AUTH_ENABLED === "true" || environment === "test"),
    tokenTtlSeconds: readPositiveInteger(env.AUTH_TOKEN_TTL_SECONDS, 8 * 60 * 60),
    pairingCodeTtlSeconds: readPositiveInteger(env.PAIRING_CODE_TTL_SECONDS, 10 * 60),
    deviceBootstrapTtlSeconds: readBoundedInteger(
      env.DEVICE_BOOTSTRAP_TTL_SECONDS,
      10 * 60,
      "DEVICE_BOOTSTRAP_TTL_SECONDS",
      60,
      10 * 60,
    ),
    deviceSessionTtlSeconds: readBoundedInteger(
      env.DEVICE_SESSION_TTL_SECONDS,
      7 * 24 * 60 * 60,
      "DEVICE_SESSION_TTL_SECONDS",
      5 * 60,
      7 * 24 * 60 * 60,
    ),
    pairingAttemptLimit: readBoundedInteger(env.PAIRING_ATTEMPT_LIMIT, 5, "PAIRING_ATTEMPT_LIMIT", 1, 100),
    pairingAttemptWindowSeconds: readBoundedInteger(
      env.PAIRING_ATTEMPT_WINDOW_SECONDS,
      60,
      "PAIRING_ATTEMPT_WINDOW_SECONDS",
      1,
      86_400,
    ),
    trustedProxyCidrs: readTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS),
    allowedOrigins,
    ...(releaseSha ? { releaseSha } : {}),
    ...(database === undefined ? {} : { database }),
  };
}
