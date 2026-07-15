import { isIP } from "node:net";

export class PostgresConnectionConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PostgresConnectionConfigurationError";
  }
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase();
  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  return normalized === "localhost" || normalized.endsWith(".localhost") ||
    unbracketed === "::1" ||
    (isIP(unbracketed) === 4 && unbracketed.split(".")[0] === "127");
}

export function preparePostgresCliConnection(value, inheritedEnvironment = process.env) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new PostgresConnectionConfigurationError("DATABASE_URL must be an absolute PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.username.length === 0 ||
    parsed.hostname.length === 0 ||
    parsed.pathname.length <= 1 ||
    parsed.hash.length > 0
  ) {
    throw new PostgresConnectionConfigurationError(
      "DATABASE_URL must include a PostgreSQL scheme, username, host, and database without a fragment.",
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase().startsWith("ssl")) {
      throw new PostgresConnectionConfigurationError(
        "DATABASE_URL must not contain SSL overrides; use DATABASE_SSL_MODE.",
      );
    }
  }

  const sslMode = inheritedEnvironment.DATABASE_SSL_MODE;
  if (sslMode !== "disable" && sslMode !== "verify-full") {
    throw new PostgresConnectionConfigurationError(
      "DATABASE_SSL_MODE must be explicitly disable or verify-full for database CLI commands.",
    );
  }
  if (sslMode === "disable" && !isLoopbackHost(parsed.hostname)) {
    throw new PostgresConnectionConfigurationError(
      "DATABASE_SSL_MODE=disable is allowed only for an isolated loopback database.",
    );
  }
  if (inheritedEnvironment.NODE_ENV === "production" && sslMode !== "verify-full") {
    throw new PostgresConnectionConfigurationError(
      "Production database CLI commands require DATABASE_SSL_MODE=verify-full.",
    );
  }

  const environment = { ...inheritedEnvironment };
  delete environment.DATABASE_URL;
  delete environment.DATABASE_SSL_MODE;
  environment.PGSSLMODE = sslMode;
  if (parsed.password.length > 0) {
    try {
      environment.PGPASSWORD = decodeURIComponent(parsed.password);
    } catch {
      throw new PostgresConnectionConfigurationError(
        "DATABASE_URL contains an invalid percent-encoded password.",
      );
    }
    parsed.password = "";
  }

  return {
    databaseUrl: parsed.toString(),
    environment,
  };
}
