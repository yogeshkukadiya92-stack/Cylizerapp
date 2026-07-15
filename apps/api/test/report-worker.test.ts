import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileSystemReportArtifactReader, FileSystemReportArtifactStore, processNextReportJob, renderCsv, runReportOperationalTick, runReportWorkerLoop, type ReportWorkerRepository } from "../src/report-worker.js";

describe("report worker", () => {
  it("renders UTF-8 CSV with stable columns and escaping", () => {
    const bytes = renderCsv([{ name: 'A, "B"', calls: 2 }, { name: "Line\nbreak", active: true }]);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe('name,calls,active\r\n"A, ""B""",2,\r\n"Line\nbreak",,true\r\n');
  });
  it("stores CSV and completes it with a hashed expiring grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "callora-report-")); const complete = vi.fn().mockResolvedValue(true);
    const repository: ReportWorkerRepository = { claim: vi.fn().mockResolvedValue({ organizationId: "org-one", id: "job-one", kind: "call_summary", format: "csv", parameters: {} }), rows: vi.fn().mockResolvedValue([{ employee: "Priya", calls: 12 }]), complete, fail: vi.fn() };
    const result = await processNextReportJob({ repository, store: new FileSystemReportArtifactStore(root), workerId: "worker-1", now: new Date("2026-07-15T12:00:00.000Z") });
    expect(result.status).toBe("ready"); expect(result.downloadToken).toMatch(/^clr_/); expect(complete.mock.calls[0]![0].tokenHash).toHaveLength(32); expect(complete.mock.calls[0]![0].expiresAt).toBe("2026-07-17T12:00:00.000Z"); expect(await readFile(join(root, "org-one/job-one.csv"), "utf8")).toContain("Priya,12");
  });
  it("reads only bounded report files with safe download metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "callora-download-")); const store = new FileSystemReportArtifactStore(root);
    await store.put("org/job.csv", new TextEncoder().encode("calls\r\n12\r\n"));
    const artifact = await new FileSystemReportArtifactReader(root, 100).get("org/job.csv");
    expect(new TextDecoder().decode(artifact!.body)).toContain("12"); expect(artifact).toMatchObject({ contentType: "text/csv; charset=utf-8", fileName: "callora-report.csv" });
    await expect(new FileSystemReportArtifactReader(root, 2).get("org/job.csv")).rejects.toThrow("download size limit");
    await expect(new FileSystemReportArtifactReader(root).get("../secret.csv")).rejects.toThrow("Invalid artifact object key");
  });
  it("fails unsupported formats without issuing an artifact token", async () => {
    const fail = vi.fn(); const repository: ReportWorkerRepository = { claim: vi.fn().mockResolvedValue({ organizationId: "org-one", id: "job-pdf", kind: "call_summary", format: "pdf", parameters: {} }), rows: vi.fn(), complete: vi.fn(), fail };
    expect(await processNextReportJob({ repository, store: { put: vi.fn() }, workerId: "worker-1" })).toEqual({ status: "failed", jobId: "job-pdf" });
    expect(fail).toHaveBeenCalledWith(expect.anything(), "PDF rendering is not enabled", expect.any(String));
  });
  it("stops an idle polling loop promptly when aborted", async () => {
    const controller = new AbortController();
    const repository: ReportWorkerRepository = { claim: vi.fn().mockImplementation(async () => { controller.abort(); return undefined; }), rows: vi.fn(), complete: vi.fn(), fail: vi.fn() };
    await runReportWorkerLoop({ repository, store: { put: vi.fn() }, workerId: "worker-1", signal: controller.signal, idleDelayMs: 100 });
    expect(repository.claim).toHaveBeenCalledOnce();
  });
  it("enqueues schedules and drains only the bounded number of jobs", async () => {
    const jobs = [
      { organizationId: "org", id: "one", kind: "call_summary", format: "csv" as const, parameters: {} },
      { organizationId: "org", id: "two", kind: "call_summary", format: "csv" as const, parameters: {} },
    ];
    const repository: ReportWorkerRepository = { claim: vi.fn().mockImplementation(async () => jobs.shift()), rows: vi.fn().mockResolvedValue([{ calls: 1 }]), complete: vi.fn().mockResolvedValue(true), fail: vi.fn() };
    const result = await runReportOperationalTick({ scheduler: { enqueueDueSchedules: vi.fn().mockResolvedValue(2) }, repository, store: { put: vi.fn() }, workerId: "worker-1", now: new Date("2026-07-15T10:00:00.000Z"), jobLimit: 2 });
    expect(result).toEqual({ enqueued: 2, ready: 2, failed: 0 });
    expect(repository.claim).toHaveBeenCalledTimes(2);
  });
});
