import { Pool, type PoolConfig } from "pg";

export interface CreatePostgresPoolOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  ssl?: PoolConfig["ssl"];
  applicationName?: string;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

/** Creates one bounded process-wide pool. Do not create a pool per request. */
export function createPostgresPool(options: CreatePostgresPoolOptions): Pool {
  if (!options.connectionString.trim()) {
    throw new Error("PostgreSQL connectionString is required");
  }

  return new Pool({
    connectionString: options.connectionString,
    max: positiveInteger(options.max, 10, "max"),
    idleTimeoutMillis: positiveInteger(options.idleTimeoutMillis, 30_000, "idleTimeoutMillis"),
    connectionTimeoutMillis: positiveInteger(
      options.connectionTimeoutMillis,
      5_000,
      "connectionTimeoutMillis",
    ),
    application_name: options.applicationName ?? "callora-api",
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });
}
