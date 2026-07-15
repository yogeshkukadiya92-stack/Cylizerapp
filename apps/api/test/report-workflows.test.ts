import { describe, expect, it } from "vitest";
import { createDownloadToken, hashDownloadToken, retryDelaySeconds, schedulePeriodKey, secureTokenMatches } from "../src/report-workflows.js";

describe("report workflows", () => {
  it("creates opaque high-entropy tokens and verifies only their SHA-256 digest", () => {
    const token=createDownloadToken(); expect(token).toMatch(/^clr_[A-Za-z0-9_-]{43}$/); const hash=hashDownloadToken(token); expect(hash).toHaveLength(32); expect(secureTokenMatches(token,hash)).toBe(true); expect(secureTokenMatches(createDownloadToken(),hash)).toBe(false);
  });
  it("uses bounded exponential delivery retries", () => { expect([1,2,3,4,5].map(retryDelaySeconds)).toEqual([30,60,120,240,480]); expect(()=>retryDelaySeconds(6)).toThrow(); });
  it("derives organization-local daily and ISO-week idempotency keys", () => { const instant=new Date("2026-01-01T00:15:00.000Z"); expect(schedulePeriodKey(instant,"America/Los_Angeles","daily")).toBe("2025-12-31"); expect(schedulePeriodKey(instant,"Asia/Kolkata","daily")).toBe("2026-01-01"); expect(schedulePeriodKey(instant,"Asia/Kolkata","weekly")).toBe("2026-W01"); });
});
