import { describe, expect, it, vi } from "vitest";
import { PostgresReportWorkerRepository } from "../src/postgres/report-worker-repository.js";
import type { PgPoolLike } from "../src/postgres/types.js";

function poolWithClient(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length, command: "", oid: 0, fields: [] });
  const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] }), release: vi.fn() };
  return { pool: { query, connect: vi.fn().mockResolvedValue(client), end: vi.fn() } as unknown as PgPoolLike, query, client };
}

describe("PostgresReportWorkerRepository", () => {
  it("claims one validated job through the skip-locked database function", async () => {
    const fixture = poolWithClient([{ organization_id: "org", id: "job", report_kind: "call_summary", format: "csv", parameters: { dateFrom: "2026-07-01" } }]);
    const repository = new PostgresReportWorkerRepository(fixture.pool, "worker-a", async () => []);
    await expect(repository.claim("worker-a", 300)).resolves.toEqual({ organizationId: "org", id: "job", kind: "call_summary", format: "csv", parameters: { dateFrom: "2026-07-01" } });
    expect(fixture.query).toHaveBeenCalledWith("select * from callora.claim_report_export_job($1, $2)", ["worker-a", 300]);
  });

  it("enqueues due schedules and counts only jobs newly created for a period", async () => {
    const fixture = poolWithClient([{ organization_id: "org", job_id: "job-1" }, { organization_id: "org", job_id: null }]);
    const repository = new PostgresReportWorkerRepository(fixture.pool, "worker-a", async () => []);
    await expect(repository.enqueueDueSchedules("2026-07-15T10:00:00.000Z", 50)).resolves.toBe(1);
    expect(fixture.query).toHaveBeenCalledWith("select * from callora.enqueue_due_report_schedules($1::timestamptz, $2)", ["2026-07-15T10:00:00.000Z", 50]);
  });

  it("completes only a live lease in a tenant-scoped transaction", async () => {
    const fixture = poolWithClient();
    fixture.client.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("returning id") ? [{ id: "job" }] : [], rowCount: 0, command: "", oid: 0, fields: [] }));
    const repository = new PostgresReportWorkerRepository(fixture.pool, "worker-a", async () => []);
    await expect(repository.complete({ job: { organizationId: "org", id: "job", kind: "call_summary", format: "csv", parameters: {} }, objectKey: "org/job.csv", tokenHash: new Uint8Array(32), expiresAt: "2026-07-17T00:00:00.000Z", completedAt: "2026-07-15T00:00:00.000Z" })).resolves.toBe(true);
    expect(fixture.client.query.mock.calls.map((call) => call[0])).toEqual(["begin", "select set_config('app.current_organization_id', $1, true)", expect.stringContaining("lease_owner=$3"), expect.stringContaining("notification_deliveries"), expect.stringContaining("in_app_notifications"), expect.stringContaining("notification_deliveries"), "commit"]);
    expect(fixture.client.release).toHaveBeenCalledOnce();
  });

  it("materializes token-free in-app and email export-ready delivery state", async () => {
    const fixture = poolWithClient();
    fixture.client.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("returning id") ? [{ id: "job", requested_by_user_id: "user", report_kind: "call_summary" }] : [], rowCount: 0, command: "", oid: 0, fields: [] }));
    const repository = new PostgresReportWorkerRepository(fixture.pool, "worker-a", async () => []);
    await repository.complete({ job: { organizationId: "org", id: "job", kind: "call_summary", format: "csv", parameters: {} }, objectKey: "org/job.csv", tokenHash: new Uint8Array(32), expiresAt: "2026-07-17T00:00:00.000Z", completedAt: "2026-07-15T00:00:00.000Z" });
    const sql=fixture.client.query.mock.calls.map((call)=>String(call[0])).join("\n");
    expect(sql).toContain("'export_ready','in_app'"); expect(sql).toContain("'export_ready','email'"); expect(sql).toContain("/reports/automation"); expect(sql).not.toContain("downloadToken");
  });

  it("requeues failures with bounded backoff and clears the lease", async () => {
    const fixture = poolWithClient(); const repository = new PostgresReportWorkerRepository(fixture.pool, "worker-a", async () => []);
    await repository.fail({ organizationId: "org", id: "job", kind: "call_summary", format: "csv", parameters: {} }, "provider unavailable", "2026-07-15T00:00:00.000Z");
    expect(fixture.client.query.mock.calls[2]![0]).toContain("attempts >= 5");
    expect(fixture.client.query.mock.calls[2]![0]).toContain("lease_owner=null");
  });
});
