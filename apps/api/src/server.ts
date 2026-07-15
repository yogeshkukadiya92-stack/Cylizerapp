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
  PostgresApiKeyManager,
  UuidIdGenerator,
} from "./postgres/index.js";
import { SystemClock } from "./security.js";
import { FileSystemReportArtifactReader } from "./report-worker.js";
import { EncryptedS3ReportArtifactStore } from "./s3-artifact-store.js";

function reportArtifactReader() {
  const kind = process.env.REPORT_ARTIFACT_STORE?.trim() || "filesystem";
  if (kind === "filesystem") return process.env.REPORT_ARTIFACT_ROOT?.trim() ? new FileSystemReportArtifactReader(process.env.REPORT_ARTIFACT_ROOT) : undefined;
  if (kind !== "s3") throw new Error("REPORT_ARTIFACT_STORE must be filesystem or s3");
  const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required for S3 report artifacts`); return value; };
  const encodedKey = required("REPORT_S3_ENCRYPTION_KEY"); const encryptionKey = Buffer.from(encodedKey, "base64url"); if (encryptionKey.length !== 32 || encryptionKey.toString("base64url") !== encodedKey) throw new Error("REPORT_S3_ENCRYPTION_KEY must encode exactly 32 bytes as unpadded base64url");
  return new EncryptedS3ReportArtifactStore({ endpoint: required("REPORT_S3_ENDPOINT"), bucket: required("REPORT_S3_BUCKET"), region: required("REPORT_S3_REGION"), accessKeyId: required("REPORT_S3_ACCESS_KEY_ID"), secretAccessKey: required("REPORT_S3_SECRET_ACCESS_KEY"), encryptionKey });
}

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
    const artifacts = reportArtifactReader();
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
      ...(config.authMode === "builtin" ? {} : { oidcVerifier: new ProductionOidcBearerVerifier(loadOidcVerifierConfig()) }),
      apiKeyManager: new PostgresApiKeyManager(pool),
      ...(artifacts ? { reportArtifactReader: artifacts } : {}),
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
