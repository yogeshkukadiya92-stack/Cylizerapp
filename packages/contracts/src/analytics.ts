import type {
  DateTimeRange,
  DurationSeconds,
  EntityId,
  IsoDate,
  IsoDateTime,
  Percentage,
} from "./common.js";
import type { CallDirection, CallDisposition } from "./calls.js";
import type { EmployeeId } from "./employees.js";
import type { LeadStatusId } from "./leads.js";
import type { OrganizationId } from "./organizations.js";

export type DashboardPeriodPreset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "custom";
export type MetricTrendDirection = "up" | "down" | "flat" | "unavailable";
export type ReportFormat = "csv" | "xlsx" | "pdf";
export type ReportKind =
  | "call_summary"
  | "employee_performance"
  | "client_activity"
  | "never_attended"
  | "client_not_pickup"
  | "lead_performance"
  | "lead_status"
  | "lead_not_contacted"
  | "status_change";

export interface MetricComparison {
  current: number;
  previous?: number;
  percentageChange?: Percentage;
  trend: MetricTrendDirection;
}

export interface CallKpis {
  totalCalls: number;
  incomingCalls: number;
  outgoingCalls: number;
  answeredCalls: number;
  missedCalls: number;
  rejectedCalls: number;
  connectedCalls: number;
  neverAttendedCalls: number;
  clientNotPickupCalls: number;
  uniqueClients: number;
  totalTalkDurationSeconds: DurationSeconds;
  averageTalkDurationSeconds: DurationSeconds;
  answerRate: Percentage;
}

export interface LeadKpis {
  totalLeads: number;
  newLeads: number;
  contactedLeads: number;
  uncontactedLeads: number;
  dueFollowUps: number;
  overdueFollowUps: number;
  wonLeads: number;
  lostLeads: number;
  conversionRate: Percentage;
}

export interface DashboardSummary {
  organizationId: OrganizationId;
  generatedAt: IsoDateTime;
  period: DateTimeRange;
  preset?: DashboardPeriodPreset;
  calls: CallKpis;
  leads: LeadKpis;
  comparisons: Partial<Record<keyof CallKpis | keyof LeadKpis, MetricComparison>>;
}

export interface TimeSeriesPoint {
  timestamp: IsoDateTime;
  value: number;
  secondaryValue?: number;
}

export interface CallBreakdownItem {
  direction?: CallDirection;
  disposition?: CallDisposition;
  count: number;
  durationSeconds: DurationSeconds;
  percentage: Percentage;
}

export interface EmployeePerformanceRow {
  employeeId: EmployeeId;
  employeeName: string;
  team?: string;
  totalCalls: number;
  connectedCalls: number;
  missedCalls: number;
  uniqueClients: number;
  talkDurationSeconds: DurationSeconds;
  averageCallDurationSeconds: DurationSeconds;
  answerRate: Percentage;
  assignedLeads: number;
  contactedLeads: number;
  wonLeads: number;
  overdueFollowUps: number;
}

export interface LeadFunnelItem {
  statusId: LeadStatusId;
  statusName: string;
  color: string;
  position: number;
  count: number;
  percentage: Percentage;
}

export interface ScheduledReport {
  id: EntityId;
  organizationId: OrganizationId;
  kind: ReportKind;
  name: string;
  format: ReportFormat;
  cadence: "daily" | "weekly" | "monthly";
  recipients: string[];
  employeeIds?: EmployeeId[];
  isActive: boolean;
  nextRunAt: IsoDateTime;
  lastRunAt?: IsoDateTime;
}

export interface ReportExportRequest {
  kind: ReportKind;
  format: ReportFormat;
  dateFrom: IsoDate;
  dateTo: IsoDate;
  employeeIds?: EmployeeId[];
  timeZone: string;
}

export interface ReportExportJob {
  id: EntityId;
  kind: ReportKind;
  format: ReportFormat;
  status: "queued" | "processing" | "ready" | "failed" | "expired";
  requestedAt: IsoDateTime;
  completedAt?: IsoDateTime;
  downloadUrl?: string;
  expiresAt?: IsoDateTime;
  failureMessage?: string;
}

export type ReportCadence = "daily" | "weekly";
export type NotificationChannel = "email" | "in_app";
export type NotificationEvent =
  | "missed_call"
  | "overdue_follow_up"
  | "device_offline"
  | "import_completed"
  | "export_ready";

export interface SavedReportView {
  id: EntityId;
  organizationId: OrganizationId;
  ownerUserId: EntityId;
  name: string;
  kind: ReportKind;
  filters: Record<string, string | string[]>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ReportSchedule {
  id: EntityId;
  organizationId: OrganizationId;
  savedViewId: EntityId;
  name: string;
  cadence: ReportCadence;
  weekDay?: number;
  localTime: string;
  timeZone: string;
  format: ReportFormat;
  recipients: string[];
  status: "active" | "paused";
  nextRunAt: IsoDateTime;
  lastRunAt?: IsoDateTime;
}

export interface NotificationPreference {
  event: NotificationEvent;
  email: boolean;
  inApp: boolean;
}

export interface ReportAutomationSnapshot {
  savedViews: SavedReportView[];
  schedules: ReportSchedule[];
  preferences: NotificationPreference[];
  jobs: ReportExportJob[];
}

export interface CreateSavedReportViewInput {
  name: string;
  kind: ReportKind;
  filters: Record<string, string | string[]>;
}

export interface CreateReportScheduleInput {
  savedViewId: EntityId;
  name: string;
  cadence: ReportCadence;
  weekDay?: number;
  localTime: string;
  format: ReportFormat;
  recipients: string[];
}

export interface UpdateReportScheduleInput {
  status: "active" | "paused";
}

export interface UpdateNotificationPreferencesInput {
  preferences: NotificationPreference[];
}

export interface InAppNotification {
  id: EntityId;
  event: NotificationEvent;
  title: string;
  body: string;
  actionUrl?: string;
  createdAt: IsoDateTime;
  readAt?: IsoDateTime;
}

export interface NotificationInbox {
  items: InAppNotification[];
  unreadCount: number;
}

export interface ReportArtifactReceipt {
  jobId: EntityId;
  objectKey: string;
  downloadToken: string;
  expiresAt: IsoDateTime;
}
