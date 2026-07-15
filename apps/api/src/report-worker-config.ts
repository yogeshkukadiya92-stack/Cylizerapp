import { assertPostgresConnectionStringHasNoSslOverrides, postgresSslOptions, type PostgresSslMode } from "./postgres/tls.js";

export interface ReportWorkerConfig {
  workerId: string;
  queueDatabaseUrl: string;
  dataDatabaseUrl: string;
  databaseSslMode: PostgresSslMode;
  artifact: { kind: "filesystem"; root: string } | { kind: "s3"; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; encryptionKey: Uint8Array };
  pollIntervalMs: number;
  leaseSeconds: number;
  scheduleLimit: number;
  jobLimit: number;
  resendApiKey: string;
  emailFrom: string;
  emailTimeoutMs: number;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value;
}
function integer(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name]; const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
export function loadReportWorkerConfig(env: Readonly<Record<string, string | undefined>> = process.env): ReportWorkerConfig {
  const workerId = required(env, "REPORT_WORKER_ID");
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(workerId)) throw new Error("REPORT_WORKER_ID contains invalid characters");
  const queueDatabaseUrl = required(env, "REPORT_QUEUE_DATABASE_URL"); const dataDatabaseUrl = required(env, "REPORT_DATA_DATABASE_URL");
  assertPostgresConnectionStringHasNoSslOverrides(queueDatabaseUrl); assertPostgresConnectionStringHasNoSslOverrides(dataDatabaseUrl);
  if (queueDatabaseUrl === dataDatabaseUrl) throw new Error("Report queue and data database credentials must use separate least-privilege URLs");
  const databaseSslMode = required(env, "REPORT_DATABASE_SSL_MODE");
  postgresSslOptions(databaseSslMode, { requireVerified: env.NODE_ENV === "production" });
  const artifactKind = env.REPORT_ARTIFACT_STORE?.trim() || "filesystem";
  let artifact: ReportWorkerConfig["artifact"];
  if (artifactKind === "filesystem") artifact = { kind: "filesystem", root: required(env, "REPORT_ARTIFACT_ROOT") };
  else if (artifactKind === "s3") {
    const endpoint = required(env, "REPORT_S3_ENDPOINT"); let parsed: URL; try { parsed = new URL(endpoint); } catch { throw new Error("REPORT_S3_ENDPOINT must be an absolute HTTPS URL"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("REPORT_S3_ENDPOINT must be an absolute HTTPS URL without credentials, query, or fragment");
    const encodedKey = required(env, "REPORT_S3_ENCRYPTION_KEY"); const encryptionKey = Buffer.from(encodedKey, "base64url"); if (encryptionKey.length !== 32 || encryptionKey.toString("base64url") !== encodedKey) throw new Error("REPORT_S3_ENCRYPTION_KEY must encode exactly 32 bytes as unpadded base64url");
    artifact = { kind: "s3", endpoint, bucket: required(env, "REPORT_S3_BUCKET"), region: required(env, "REPORT_S3_REGION"), accessKeyId: required(env, "REPORT_S3_ACCESS_KEY_ID"), secretAccessKey: required(env, "REPORT_S3_SECRET_ACCESS_KEY"), encryptionKey };
  } else throw new Error("REPORT_ARTIFACT_STORE must be filesystem or s3");
  return {
    workerId, queueDatabaseUrl, dataDatabaseUrl, databaseSslMode: databaseSslMode as PostgresSslMode,
    artifact,
    pollIntervalMs: integer(env, "REPORT_WORKER_POLL_INTERVAL_MS", 2_000, 250, 60_000),
    leaseSeconds: integer(env, "REPORT_WORKER_LEASE_SECONDS", 300, 30, 1_800),
    scheduleLimit: integer(env, "REPORT_WORKER_SCHEDULE_LIMIT", 50, 1, 100),
    jobLimit: integer(env, "REPORT_WORKER_JOB_LIMIT", 25, 1, 100),
    resendApiKey: required(env,"RESEND_API_KEY"),
    emailFrom: required(env,"REPORT_EMAIL_FROM"),
    emailTimeoutMs: integer(env,"REPORT_EMAIL_TIMEOUT_MS",10_000,1_000,30_000),
  };
}
