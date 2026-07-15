import { describe, expect, it, vi } from "vitest";
import { PostgresReportRowLoader } from "../src/postgres/report-row-loader.js";
import type { PgPoolLike } from "../src/postgres/types.js";

function fixture(rows: Record<string, unknown>[]) {
  const client = { query: vi.fn().mockImplementation(async (sql: string) => ({ rows: sql.startsWith("select direction") || sql.startsWith("select status.name") ? rows : [], rowCount: rows.length, command: "", oid: 0, fields: [] })), release: vi.fn() };
  return { pool: { connect: vi.fn().mockResolvedValue(client), query: vi.fn(), end: vi.fn() } as unknown as PgPoolLike, client };
}

describe("PostgresReportRowLoader", () => {
  it("loads an explicitly bounded call summary inside tenant context", async () => {
    const test = fixture([{ direction: "incoming", disposition: "answered", calls: 4, duration_seconds: 180 }]);
    const rows = await new PostgresReportRowLoader(test.pool).load({ organizationId: "org", id: "job", kind: "call_summary", format: "csv", parameters: { dateFrom: "2026-07-01", dateTo: "2026-07-15" }, requestedAt: "2026-07-15T10:00:00.000Z" });
    expect(rows).toHaveLength(1);
    expect(test.client.query.mock.calls[1]).toEqual(["select set_config('app.current_organization_id', $1, true)", ["org"]]);
    expect(test.client.query.mock.calls[3]![1]).toEqual(["org", "2026-07-01T00:00:00.000Z", "2026-07-15T00:00:00.000Z", "call_summary"]);
    expect(test.client.query.mock.calls.at(-1)![0]).toBe("commit");
  });
  it("derives this-month range from the immutable job requested time", async () => {
    const test = fixture([]);
    await new PostgresReportRowLoader(test.pool).load({ organizationId: "org", id: "job", kind: "lead_status", format: "csv", parameters: { period: "this_month" }, requestedAt: "2026-07-15T10:00:00.000Z" });
    expect(test.client.query.mock.calls[3]![1]).toEqual(["org", "2026-07-01T00:00:00.000Z", "2026-07-15T10:00:00.000Z", "lead_status"]);
  });
  it("rejects oversized and unsupported ranges before opening a connection", async () => {
    const test = fixture([]); const loader = new PostgresReportRowLoader(test.pool);
    await expect(loader.load({ organizationId: "org", id: "job", kind: "call_summary", format: "csv", parameters: { dateFrom: "2024-01-01", dateTo: "2026-01-01" } })).rejects.toThrow("1 to 366 days");
    expect(test.pool.connect).not.toHaveBeenCalled();
  });
});
