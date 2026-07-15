import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresConnectionConfigurationError,
  preparePostgresCliConnection,
} from "../scripts/postgres-connection.mjs";

test("moves a URL password out of psql argv and removes DATABASE_URL from the child environment", () => {
  const prepared = preparePostgresCliConnection(
    "postgresql://migration:s3cr%40t%2Fvalue@db.internal:5432/callora?application_name=migrate",
    {
      DATABASE_URL: "must-not-propagate",
      DATABASE_SSL_MODE: "verify-full",
      PATH: "/bin",
      PGPASSWORD: "stale",
    },
  );

  assert.deepEqual(
    prepared.databaseUrl,
    "postgresql://migration@db.internal:5432/callora?application_name=migrate",
  );
  assert.equal(prepared.databaseUrl.includes("s3cr"), false);
  assert.equal(prepared.environment.PGPASSWORD, "s3cr@t/value");
  assert.equal(prepared.environment.PGSSLMODE, "verify-full");
  assert.equal(Object.hasOwn(prepared.environment, "DATABASE_URL"), false);
  assert.equal(Object.hasOwn(prepared.environment, "DATABASE_SSL_MODE"), false);
  assert.equal(prepared.environment.PATH, "/bin");
});

test("preserves an explicitly injected PGPASSWORD for a passwordless live-harness URL", () => {
  const prepared = preparePostgresCliConnection(
    "postgresql://runtime@127.0.0.1:5432/callora_phase3d",
    { DATABASE_URL: "redacted", DATABASE_SSL_MODE: "disable", PGPASSWORD: "injected-secret" },
  );

  assert.equal(prepared.environment.PGPASSWORD, "injected-secret");
  assert.equal(prepared.databaseUrl.includes("injected-secret"), false);
});

test("rejects malformed connections without reflecting their secret input", () => {
  const secret = "do-not-reflect-this-secret";
  assert.throws(
    () => preparePostgresCliConnection(
      `https://user:${secret}@example.com/database`,
      { DATABASE_SSL_MODE: "verify-full" },
    ),
    (error) => {
      assert.equal(error instanceof PostgresConnectionConfigurationError, true);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("requires an explicit verified mode in production and rejects URL SSL overrides", () => {
  const connection = "postgresql://migration:secret@db.internal:5432/callora";
  assert.throws(
    () => preparePostgresCliConnection(connection, { NODE_ENV: "production" }),
    /DATABASE_SSL_MODE/,
  );
  assert.throws(
    () => preparePostgresCliConnection(connection, {
      NODE_ENV: "production",
      DATABASE_SSL_MODE: "disable",
    }),
    /loopback|verify-full/,
  );
  assert.throws(
    () => preparePostgresCliConnection(connection, {
      DATABASE_SSL_MODE: "disable",
    }),
    /loopback/,
  );
  for (const deceptiveHost of ["127.example.com", "127.evil.internal"]) {
    assert.throws(
      () => preparePostgresCliConnection(
        `postgresql://migration:secret@${deceptiveHost}:5432/callora`,
        { DATABASE_SSL_MODE: "disable" },
      ),
      /loopback/,
    );
  }
  assert.throws(
    () => preparePostgresCliConnection(`${connection}?sslmode=disable`, {
      NODE_ENV: "production",
      DATABASE_SSL_MODE: "verify-full",
    }),
    /SSL overrides/,
  );
  assert.deepEqual(
    preparePostgresCliConnection(connection, {
      NODE_ENV: "production",
      DATABASE_SSL_MODE: "verify-full",
      PGSSLMODE: "disable",
      PGSSLROOTCERT: "/run/secrets/database-ca.pem",
    }).environment,
    {
      NODE_ENV: "production",
      PGPASSWORD: "secret",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/run/secrets/database-ca.pem",
    },
  );
});
