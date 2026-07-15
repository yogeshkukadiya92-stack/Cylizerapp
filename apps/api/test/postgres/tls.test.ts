import { describe, expect, it } from "vitest";
import {
  assertPostgresConnectionStringHasNoSslOverrides,
  postgresSslOptions,
} from "../../src/postgres/tls.js";

describe("PostgreSQL transport policy", () => {
  it("requires certificate verification for call-log PII backfill", () => {
    expect(postgresSslOptions("verify-full", { requireVerified: true }))
      .toEqual({ rejectUnauthorized: true });
    for (const mode of ["disable", "require"]) {
      expect(() => postgresSslOptions(mode, { requireVerified: true })).toThrow(/verify-full/);
    }
  });

  it("rejects connection-string SSL overrides", () => {
    expect(() => assertPostgresConnectionStringHasNoSslOverrides(
      "postgresql://callora@db.internal/callora?sslmode=disable",
    )).toThrow(/DATABASE_SSL_MODE/);
    expect(() => assertPostgresConnectionStringHasNoSslOverrides(
      "postgresql://callora@db.internal/callora?ssl=false",
    )).toThrow(/DATABASE_SSL_MODE/);
    expect(() => assertPostgresConnectionStringHasNoSslOverrides(
      "postgresql://callora@db.internal/callora",
    )).not.toThrow();
  });
});
