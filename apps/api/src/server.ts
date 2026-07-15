import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadOidcVerifierConfig, ProductionOidcBearerVerifier } from "./auth/index.js";
import { loadConfig } from "./config.js";
import { CallPiiCrypto, parseCallPiiKeyring } from "./call-pii-crypto.js";
import {
  createPostgresPool,
  postgresSslOptions,
  PostgresCalloraRepository,
  PostgresPairingAttemptLimiter,
  UuidIdGenerator,
} from "./postgres/index.js";
import { SystemClock } from "./security.js";

let activeApp: FastifyInstance | undefined;
let activeRepository: PostgresCalloraRepository | undefined;
let isShuttingDown = false;

const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  activeApp?.log.info({ signal }, "Shutting down");
  await activeApp?.close();
  await activeRepository?.close();
  process.exitCode = exitCode;
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const config = loadConfig();
  if (config.environment === "production") {
    if (!config.database) throw new Error("Production database configuration is missing");
    const ssl = postgresSslOptions(config.database.sslMode, { requireVerified: true });
    const pool = createPostgresPool({
      connectionString: config.database.connectionString,
      max: config.database.maxConnections,
      idleTimeoutMillis: config.database.idleTimeoutMs,
      connectionTimeoutMillis: config.database.connectionTimeoutMs,
      ssl,
      applicationName: "callora-api",
    });
    pool.on("error", (error) => {
      if (activeApp) {
        activeApp.log.error({ err: error }, "Unexpected idle PostgreSQL client error");
      } else {
        process.stderr.write("Unexpected idle PostgreSQL client error\n");
      }
    });
    activeRepository = new PostgresCalloraRepository(pool, {
      statementTimeoutMs: config.database.statementTimeoutMs,
      lockTimeoutMs: config.database.lockTimeoutMs,
      callPiiCrypto: new CallPiiCrypto(parseCallPiiKeyring({
        encryptionKeys: process.env.CALL_PII_ENCRYPTION_KEYS,
        activeKeyVersion: process.env.CALL_PII_ACTIVE_KEY_VERSION,
        rowIdKey: process.env.CALL_PII_ROW_ID_KEY,
        blindIndexKeys: process.env.CALL_PII_BLIND_INDEX_KEYS,
        activeBlindIndexKeyVersion: process.env.CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION,
      })),
    });
    const clock = new SystemClock();
    activeApp = buildApp({
      config,
      repository: activeRepository,
      clock,
      pairingLimiter: new PostgresPairingAttemptLimiter(
        pool,
        config.authSecret,
        clock,
        config.pairingAttemptLimit,
        config.pairingAttemptWindowSeconds,
      ),
      idGenerator: new UuidIdGenerator(),
      oidcVerifier: new ProductionOidcBearerVerifier(loadOidcVerifierConfig()),
    });
  } else {
    activeApp = buildApp({ config });
  }

  const app = activeApp;
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  if (activeApp) {
    activeApp.log.error(error);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  await shutdown("STARTUP_FAILURE", 1);
}
