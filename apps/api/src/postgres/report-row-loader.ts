import type { QueryResultRow } from "pg";
import type { ClaimedReportJob, ReportRow } from "../report-worker.js";
import type { PgClientLike, PgPoolLike } from "./types.js";

const DAY = 86_400_000;
const REPORT_KINDS = new Set(["call_summary", "employee_performance", "client_activity", "never_attended", "client_not_pickup", "lead_performance", "lead_status", "lead_not_contacted", "status_change"]);

function reportRange(job: ClaimedReportJob): { from: string; to: string } {
  const explicitFrom = job.parameters.dateFrom; const explicitTo = job.parameters.dateTo;
  if (typeof explicitFrom === "string" && typeof explicitTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(explicitFrom) && /^\d{4}-\d{2}-\d{2}$/.test(explicitTo)) {
    const from = new Date(`${explicitFrom}T00:00:00.000Z`); const to = new Date(`${explicitTo}T00:00:00.000Z`);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > 366 * DAY) throw new Error("Report date range must span 1 to 366 days");
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const anchor = new Date(job.requestedAt ?? new Date().toISOString());
  if (!Number.isFinite(anchor.getTime())) throw new Error("Report requestedAt is invalid");
  const period = job.parameters.period;
  if (period !== undefined && period !== "last_7_days" && period !== "last_30_days" && period !== "this_month") throw new Error("Unsupported report period");
  if (period === "this_month") return { from: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)).toISOString(), to: anchor.toISOString() };
  const days = period === "last_7_days" ? 7 : 30;
  return { from: new Date(anchor.getTime() - days * DAY).toISOString(), to: anchor.toISOString() };
}

function sqlFor(kind: string): string {
  if (!REPORT_KINDS.has(kind)) throw new Error("Unsupported report kind");
  if (kind === "call_summary" || kind === "client_activity") return `select direction, disposition, count(*)::integer as calls, coalesce(sum(duration_seconds),0)::integer as duration_seconds from callora.call_logs where organization_id=$1::uuid and started_at >= $2::timestamptz and started_at < $3::timestamptz group by direction,disposition order by direction,disposition`;
  if (["employee_performance", "never_attended", "client_not_pickup"].includes(kind)) return `select employee.display_name as employee, team.name as team, count(call_log.id)::integer as calls, count(call_log.id) filter (where call_log.disposition='answered')::integer as answered, count(call_log.id) filter (where call_log.disposition in ('missed','rejected','busy'))::integer as unattended, coalesce(sum(call_log.duration_seconds),0)::integer as duration_seconds from callora.employees employee left join callora.teams team on team.organization_id=employee.organization_id and team.id=employee.team_id left join callora.call_logs call_log on call_log.organization_id=employee.organization_id and call_log.employee_id=employee.id and call_log.started_at >= $2::timestamptz and call_log.started_at < $3::timestamptz where employee.organization_id=$1::uuid group by employee.id,employee.display_name,team.name having ($4::text='employee_performance') or ($4::text='never_attended' and count(call_log.id) filter (where call_log.disposition='answered')=0) or ($4::text='client_not_pickup' and count(call_log.id) filter (where call_log.disposition in ('missed','rejected','busy'))>0) order by lower(employee.display_name),employee.id limit 10000`;
  if (kind === "status_change") return `select activity.occurred_at, concat_ws(' ',lead.first_name,lead.last_name) as lead, activity.summary from callora.lead_activities activity join callora.leads lead on lead.organization_id=activity.organization_id and lead.id=activity.lead_id where activity.organization_id=$1::uuid and activity.kind='status_changed' and activity.occurred_at >= $2::timestamptz and activity.occurred_at < $3::timestamptz order by activity.occurred_at desc,activity.id desc limit 10000`;
  return `select status.name as status, count(lead.id)::integer as leads, count(lead.id) filter (where lead.last_contacted_at is not null)::integer as contacted, count(lead.id) filter (where lead.converted_at is not null)::integer as converted, count(lead.id) filter (where lead.last_contacted_at is null)::integer as not_contacted from callora.lead_statuses status left join callora.leads lead on lead.organization_id=status.organization_id and lead.status_id=status.id and lead.archived_at is null and lead.created_at >= $2::timestamptz and lead.created_at < $3::timestamptz where status.organization_id=$1::uuid and status.is_active group by status.id,status.name,status.position having ($4::text<>'lead_not_contacted') or count(lead.id) filter (where lead.last_contacted_at is null)>0 order by status.position,status.id`;
}

export class PostgresReportRowLoader {
  constructor(private readonly pool: PgPoolLike) {}
  async load(job: ClaimedReportJob): Promise<ReportRow[]> {
    const range = reportRange(job); const client = await this.pool.connect();
    try {
      await client.query("begin"); await client.query("select set_config('app.current_organization_id', $1, true)", [job.organizationId]);
      await client.query("set local statement_timeout = '30s'");
      const result = await client.query<QueryResultRow>(sqlFor(job.kind), [job.organizationId, range.from, range.to, job.kind]);
      if (result.rows.length > 10_000) throw new Error("Report exceeds the 10000 row export limit");
      await client.query("commit");
      return result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value as ReportRow[string]])));
    } catch (error) { try { await client.query("rollback"); } catch { /* preserve original */ } throw error; }
    finally { client.release(); }
  }
}
