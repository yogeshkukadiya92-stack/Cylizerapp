import { assertPostgresConnectionStringHasNoSslOverrides, postgresSslOptions, type PostgresSslMode } from "./postgres/tls.js";

export interface ReportWorkerConfig {
  workerId: string;
  queueDatabaseUrl: string;
  dataDatabaseUrl: string;
  databaseSslMode: PostgresSslMode;
  artifactRoot: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  scheduleLimit: number;
  jobLimit: number;
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
  return {
    workerId, queueDatabaseUrl, dataDatabaseUrl, databaseSslMode: databaseSslMode as PostgresSslMode,
    artifactRoot: required(env, "REPORT_ARTIFACT_ROOT"),
    pollIntervalMs: integer(env, "REPORT_WORKER_POLL_INTERVAL_MS", 2_000, 250, 60_000),
    leaseSeconds: integer(env, "REPORT_WORKER_LEASE_SECONDS", 300, 30, 1_800),
    scheduleLimit: integer(env, "REPORT_WORKER_SCHEDULE_LIMIT", 50, 1, 100),
    jobLimit: integer(env, "REPORT_WORKER_JOB_LIMIT", 25, 1, 100),
  };
}
