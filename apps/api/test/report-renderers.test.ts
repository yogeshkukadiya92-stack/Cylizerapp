import { describe, expect, it } from "vitest";
import { renderPdf, renderXlsx } from "../src/report-renderers.js";
describe("bounded report renderers", () => {
  it("creates a valid XLSX zip with escaped cells", () => { const result = renderXlsx([{ name: "A&B", calls: 2 }]); expect(Buffer.from(result.subarray(0, 2)).toString()).toBe("PK"); expect(result.length).toBeGreaterThan(500); });
  it("creates a valid paginated PDF", () => { const result = renderPdf(Array.from({ length: 50 }, (_, index) => ({ row: index }))); expect(Buffer.from(result.subarray(0, 8)).toString()).toBe("%PDF-1.4"); expect(Buffer.from(result).toString()).toContain("/Count 2"); });
  it("rejects unbounded row counts", () => { expect(() => renderXlsx(Array.from({ length: 10_001 }, () => ({ value: 1 })))).toThrow(/row limit/); });
});
