import { describe, expect, it } from "vitest";
import { loadReportWorkerConfig } from "../src/report-worker-config.js";

const valid = { NODE_ENV: "production", REPORT_WORKER_ID: "reports:worker-1", REPORT_QUEUE_DATABASE_URL: "postgresql://queue:secret@db.example.com/callora", REPORT_DATA_DATABASE_URL: "postgresql://reader:secret@db.example.com/callora", REPORT_DATABASE_SSL_MODE: "verify-full", REPORT_ARTIFACT_ROOT: "/srv/callora/reports" };
describe("report worker config", () => {
  it("loads bounded production settings with separate database identities", () => {
    expect(loadReportWorkerConfig(valid)).toMatchObject({ workerId: "reports:worker-1", databaseSslMode: "verify-full", pollIntervalMs: 2000, leaseSeconds: 300, scheduleLimit: 50, jobLimit: 25 });
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
});
