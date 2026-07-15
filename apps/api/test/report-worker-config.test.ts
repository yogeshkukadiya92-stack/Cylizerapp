import { describe, expect, it } from "vitest";
import { loadReportWorkerConfig } from "../src/report-worker-config.js";

const valid = { NODE_ENV: "production", REPORT_WORKER_ID: "reports:worker-1", REPORT_QUEUE_DATABASE_URL: "postgresql://queue:secret@db.example.com/callora", REPORT_DATA_DATABASE_URL: "postgresql://reader:secret@db.example.com/callora", REPORT_DATABASE_SSL_MODE: "verify-full", REPORT_ARTIFACT_ROOT: "/srv/callora/reports", RESEND_API_KEY:"re_1234567890abcdef",REPORT_EMAIL_FROM:"Callora <reports@example.com>" };
describe("report worker config", () => {
  it("loads bounded production settings with separate database identities", () => {
    expect(loadReportWorkerConfig(valid)).toMatchObject({ workerId: "reports:worker-1", databaseSslMode: "verify-full", artifact: { kind: "filesystem", root: "/srv/callora/reports" }, pollIntervalMs: 2000, leaseSeconds: 300, scheduleLimit: 50, jobLimit: 25 });
  });
  it("fails closed on shared credentials, URL SSL overrides, and weak production TLS", () => {
    expect(() => loadReportWorkerConfig({ ...valid, REPORT_DATA_DATABASE_URL: valid.REPORT_QUEUE_DATABASE_URL })).toThrow("separate least-privilege");
    expect(() => loadReportWorkerConfig({ ...valid, REPORT_QUEUE_DATABASE_URL: `${valid.REPORT_QUEUE_DATABASE_URL}?sslmode=disable` })).toThrow("DATABASE_SSL_MODE");
    expect(() => loadReportWorkerConfig({ ...valid, REPORT_DATABASE_SSL_MODE: "require" })).toThrow("verify-full");
  });
  it("rejects unbounded loop settings", () => {
    expect(() => loadReportWorkerConfig({ ...valid, REPORT_WORKER_JOB_LIMIT: "101" })).toThrow("between 1 and 100");
    expect(() => loadReportWorkerConfig({ ...valid, REPORT_WORKER_POLL_INTERVAL_MS: "10" })).toThrow("between 250 and 60000");
  });
  it("loads only complete encrypted S3 settings", () => {
    const s3 = { ...valid, REPORT_ARTIFACT_STORE: "s3", REPORT_S3_ENDPOINT: "https://objects.example.com", REPORT_S3_BUCKET: "callora-reports", REPORT_S3_REGION: "ap-south-1", REPORT_S3_ACCESS_KEY_ID: "access", REPORT_S3_SECRET_ACCESS_KEY: "secret", REPORT_S3_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") };
    expect(loadReportWorkerConfig(s3).artifact).toMatchObject({ kind: "s3", bucket: "callora-reports", region: "ap-south-1" });
    expect(() => loadReportWorkerConfig({ ...s3, REPORT_S3_ENCRYPTION_KEY: "weak" })).toThrow(/32 bytes/);
    expect(() => loadReportWorkerConfig({ ...s3, REPORT_S3_ENDPOINT: "http://objects.example.com" })).toThrow(/HTTPS/);
  });
});
