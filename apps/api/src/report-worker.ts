import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { createDownloadToken, hashDownloadToken, REPORT_DOWNLOAD_TTL_SECONDS } from "./report-workflows.js";

export type ReportCell = string | number | boolean | null | undefined;
export type ReportRow = Record<string, ReportCell>;
export interface ClaimedReportJob { organizationId: string; id: string; kind: string; format: "csv" | "xlsx" | "pdf"; parameters: Record<string, unknown>; requestedAt?: string; }
export interface ReportWorkerRepository {
  claim(workerId: string, leaseSeconds: number): Promise<ClaimedReportJob | undefined>;
  rows(job: ClaimedReportJob): Promise<ReportRow[]>;
  complete(input: { job: ClaimedReportJob; objectKey: string; tokenHash: Uint8Array; expiresAt: string; completedAt: string }): Promise<boolean>;
  fail(job: ClaimedReportJob, message: string, failedAt: string): Promise<void>;
}
export interface ReportArtifactStore { put(objectKey: string, body: Uint8Array): Promise<void>; }
export interface ReportArtifactReader { get(objectKey: string): Promise<{ body: Uint8Array; contentType: string; fileName: string } | undefined>; }
export interface ReportScheduleEnqueuer { enqueueDueSchedules(at: string, limit: number): Promise<number>; }

function csvCell(value: ReportCell): string {
  const valueText = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(valueText) ? `"${valueText.replaceAll('"', '""')}"` : valueText;
}
export function renderCsv(rows: ReportRow[]): Uint8Array {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))];
  return new TextEncoder().encode(`\uFEFF${lines.join("\r\n")}\r\n`);
}

export class FileSystemReportArtifactStore implements ReportArtifactStore {
  private readonly root: string;
  constructor(root: string) { if (!root.trim()) throw new Error("artifact root is required"); this.root = resolve(root); }
  async put(objectKey: string, body: Uint8Array): Promise<void> {
    if (!/^[a-zA-Z0-9/_-]+\.[a-z0-9]+$/.test(objectKey)) throw new Error("Invalid artifact object key");
    const destination = resolve(this.root, objectKey);
    if (!destination.startsWith(`${this.root}${sep}`)) throw new Error("Artifact object key escapes the configured root");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, destination);
  }
}

export class FileSystemReportArtifactReader implements ReportArtifactReader {
  private readonly root: string;
  constructor(root: string, private readonly maximumBytes = 50 * 1024 * 1024) {
    if (!root.trim()) throw new Error("artifact root is required");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("maximumBytes must be a positive integer");
    this.root = resolve(root);
  }
  async get(objectKey: string): Promise<{ body: Uint8Array; contentType: string; fileName: string } | undefined> {
    if (!/^[a-zA-Z0-9/_-]+\.(csv|xlsx|pdf)$/.test(objectKey)) throw new Error("Invalid artifact object key");
    const destination = resolve(this.root, objectKey);
    if (!destination.startsWith(`${this.root}${sep}`)) throw new Error("Artifact object key escapes the configured root");
    let handle;
    try { handle = await open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return undefined;
      if (metadata.size > this.maximumBytes) throw new Error("Report artifact exceeds the download size limit");
      const extension = objectKey.split(".").at(-1)!;
      return { body: await handle.readFile(), contentType: extension === "csv" ? "text/csv; charset=utf-8" : extension === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf", fileName: `callora-report.${extension}` };
    } finally { await handle.close(); }
  }
}

function safeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown report worker failure").replace(/[\r\n\t]/g, " ").slice(0, 500);
}
export async function processNextReportJob(options: { repository: ReportWorkerRepository; store: ReportArtifactStore; workerId: string; now?: Date; leaseSeconds?: number }): Promise<{ status: "idle" | "ready" | "failed"; jobId?: string; downloadToken?: string }> {
  const now = options.now ?? new Date();
  const job = await options.repository.claim(options.workerId, options.leaseSeconds ?? 300);
  if (!job) return { status: "idle" };
  try {
    if (job.format !== "csv") throw new Error(`${job.format.toUpperCase()} rendering is not enabled`);
    const objectKey = `${job.organizationId}/${job.id}.csv`;
    await options.store.put(objectKey, renderCsv(await options.repository.rows(job)));
    const downloadToken = createDownloadToken();
    const expiresAt = new Date(now.getTime() + REPORT_DOWNLOAD_TTL_SECONDS * 1000).toISOString();
    if (!await options.repository.complete({ job, objectKey, tokenHash: hashDownloadToken(downloadToken), expiresAt, completedAt: now.toISOString() })) throw new Error("Report job lease was lost before completion");
    return { status: "ready", jobId: job.id, downloadToken };
  } catch (error) {
    await options.repository.fail(job, safeFailure(error), now.toISOString());
    return { status: "failed", jobId: job.id };
  }
}

export async function runReportWorkerLoop(options: {
  repository: ReportWorkerRepository;
  store: ReportArtifactStore;
  workerId: string;
  signal: AbortSignal;
  idleDelayMs?: number;
  onResult?: (result: Awaited<ReturnType<typeof processNextReportJob>>) => void;
}): Promise<void> {
  const idleDelayMs = options.idleDelayMs ?? 2_000;
  if (!Number.isInteger(idleDelayMs) || idleDelayMs < 100 || idleDelayMs > 60_000) throw new Error("idleDelayMs must be between 100 and 60000");
  while (!options.signal.aborted) {
    const result = await processNextReportJob(options);
    options.onResult?.(result);
    if (result.status === "idle" && !options.signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, idleDelayMs);
        options.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}

export async function runReportOperationalTick(options: {
  scheduler: ReportScheduleEnqueuer;
  repository: ReportWorkerRepository;
  store: ReportArtifactStore;
  workerId: string;
  now?: Date;
  scheduleLimit?: number;
  jobLimit?: number;
  leaseSeconds?: number;
}): Promise<{ enqueued: number; ready: number; failed: number }> {
  const now = options.now ?? new Date();
  const scheduleLimit = options.scheduleLimit ?? 50;
  const jobLimit = options.jobLimit ?? 25;
  if (!Number.isInteger(scheduleLimit) || scheduleLimit < 1 || scheduleLimit > 100) throw new Error("scheduleLimit must be between 1 and 100");
  if (!Number.isInteger(jobLimit) || jobLimit < 1 || jobLimit > 100) throw new Error("jobLimit must be between 1 and 100");
  const enqueued = await options.scheduler.enqueueDueSchedules(now.toISOString(), scheduleLimit);
  let ready = 0; let failed = 0;
  for (let index = 0; index < jobLimit; index += 1) {
    const result = await processNextReportJob({ repository: options.repository, store: options.store, workerId: options.workerId, now, ...(options.leaseSeconds === undefined ? {} : { leaseSeconds: options.leaseSeconds }) });
    if (result.status === "idle") break;
    if (result.status === "ready") ready += 1; else failed += 1;
  }
  return { enqueued, ready, failed };
}
