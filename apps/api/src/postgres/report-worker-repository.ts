import type { QueryResultRow } from "pg";
import type { ClaimedReportJob, ReportRow, ReportScheduleEnqueuer, ReportWorkerRepository } from "../report-worker.js";
import type { PgClientLike, PgPoolLike } from "./types.js";

type RowLoader = (job: ClaimedReportJob) => Promise<ReportRow[]>;

function claimedJob(row: QueryResultRow | undefined): ClaimedReportJob | undefined {
  if (!row) return undefined;
  const format = String(row.format);
  if (format !== "csv" && format !== "xlsx" && format !== "pdf") throw new Error("Claimed report job has an invalid format");
  if (typeof row.organization_id !== "string" || typeof row.id !== "string" || typeof row.report_kind !== "string") throw new Error("Claimed report job is malformed");
  const parameters = row.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Claimed report job parameters are malformed");
  return { organizationId: row.organization_id, id: row.id, kind: row.report_kind, format, parameters: parameters as Record<string, unknown>, ...(row.requested_at === undefined ? {} : { requestedAt: new Date(String(row.requested_at)).toISOString() }) };
}

export class PostgresReportWorkerRepository implements ReportWorkerRepository, ReportScheduleEnqueuer {
  constructor(private readonly pool: PgPoolLike, private readonly workerId: string, private readonly rowLoader: RowLoader) {
    if (!workerId.trim() || workerId.length > 120) throw new Error("workerId must be between 1 and 120 characters");
  }

  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedReportJob | undefined> {
    if (workerId !== this.workerId) throw new Error("workerId does not match the configured worker");
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 1800) throw new Error("leaseSeconds must be between 30 and 1800");
    const result = await this.pool.query("select * from callora.claim_report_export_job($1, $2)", [workerId, leaseSeconds]);
    return claimedJob(result.rows[0]);
  }

  rows(job: ClaimedReportJob): Promise<ReportRow[]> { return this.rowLoader(job); }

  async enqueueDueSchedules(at: string, limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("schedule limit must be between 1 and 100");
    if (!Number.isFinite(Date.parse(at))) throw new Error("schedule time must be an ISO date-time");
    const result = await this.pool.query("select * from callora.enqueue_due_report_schedules($1::timestamptz, $2)", [at, limit]);
    return result.rows.filter((row) => row.job_id !== null && row.job_id !== undefined).length;
  }

  complete(input: { job: ClaimedReportJob; objectKey: string; tokenHash: Uint8Array; expiresAt: string; completedAt: string }): Promise<boolean> {
    if (input.tokenHash.length !== 32) throw new Error("download token hash must be 32 bytes");
    return this.inTenant(input.job.organizationId, async (client) => {
      const result = await client.query(`update callora.report_export_jobs set status='ready', object_key=$4,
        download_token_hash=$5::bytea, download_expires_at=$6::timestamptz, completed_at=$7::timestamptz,
        lease_owner=null, lease_expires_at=null, failure_message=null
        where organization_id=$1::uuid and id=$2::uuid and status='processing' and lease_owner=$3
          and lease_expires_at > $7::timestamptz returning id`,
      [input.job.organizationId, input.job.id, this.workerId, input.objectKey, Buffer.from(input.tokenHash), input.expiresAt, input.completedAt]);
      return result.rows.length === 1;
    });
  }

  fail(job: ClaimedReportJob, message: string, failedAt: string): Promise<void> {
    return this.inTenant(job.organizationId, async (client) => {
      await client.query(`update callora.report_export_jobs set
        status=case when attempts >= 5 then 'failed' else 'queued' end,
        available_at=case when attempts >= 5 then available_at else $4::timestamptz + make_interval(secs => least(3600, 30 * (2 ^ greatest(attempts - 1, 0)))) end,
        failure_message=$5, lease_owner=null, lease_expires_at=null,
        completed_at=case when attempts >= 5 then $4::timestamptz else null end
        where organization_id=$1::uuid and id=$2::uuid and status='processing' and lease_owner=$3`,
      [job.organizationId, job.id, this.workerId, failedAt, message]);
    });
  }

  private async inTenant<T>(organizationId: string, operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.current_organization_id', $1, true)", [organizationId]);
      const value = await operation(client);
      await client.query("commit");
      return value;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }
}
