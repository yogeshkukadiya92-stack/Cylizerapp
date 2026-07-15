import type { PoolConfig } from "pg";

export type PostgresSslMode = "disable" | "require" | "verify-full";

/** Rejects URL parameters that could silently override the explicit TLS policy. */
export function assertPostgresConnectionStringHasNoSslOverrides(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be an absolute PostgreSQL connection URL");
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hash.length > 0) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql:// and must not contain a fragment");
  }
  for (const parameter of parsed.searchParams.keys()) {
    if (parameter.toLowerCase().startsWith("ssl")) {
      throw new Error("Configure database TLS with DATABASE_SSL_MODE, not DATABASE_URL SSL parameters");
    }
  }
}

export function postgresSslOptions(
  mode: string,
  options: { requireVerified?: boolean } = {},
): PoolConfig["ssl"] {
  if (mode !== "disable" && mode !== "require" && mode !== "verify-full") {
    throw new Error("DATABASE_SSL_MODE must be disable, require, or verify-full");
  }
  if (options.requireVerified === true && mode !== "verify-full") {
    throw new Error("DATABASE_SSL_MODE must be verify-full for call-log PII backfill and verification");
  }
  return mode === "disable" ? false : { rejectUnauthorized: mode === "verify-full" };
}
