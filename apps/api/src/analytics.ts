import type {
  CallKpis,
  CallLog,
  DashboardPeriodPreset,
  DashboardSummary,
  EmployeePerformanceRow,
  LeadKpis,
  Organization,
} from "@callora/contracts";
import { badRequest } from "./errors.js";
import type { CalloraRepository } from "./repository.js";
import type { Clock } from "./security.js";

export type DashboardPreset = "today" | "yesterday" | "last_7_days";

export interface DashboardQuery {
  preset?: DashboardPreset;
  from?: string;
  to?: string;
  employeeId?: string;
}

export interface DashboardOverview {
  summary: DashboardSummary;
  metrics: {
    totalCalls: number;
    totalTalkDurationSeconds: number;
    connectedCalls: number;
    missedCalls: number;
    uniqueClients: number;
    workingHoursSeconds: number;
  };
  hourlyActivity: Array<{ hour: string; label: string; incoming: number; outgoing: number }>;
  outcomes: Array<{ key: string; label: string; value: number; color: string }>;
  attention: Array<{
    key: "missed" | "leads" | "devices";
    label: string;
    value: number;
  }>;
  teamPerformance: EmployeePerformanceRow[];
  recentActivity: Array<{
    id: string;
    kind: "connected" | "missed" | "employee" | "device";
    title: string;
    detail?: string;
    occurredAt: string;
  }>;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function dateParts(date: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function addCalendarDays(value: CalendarDate, days: number): CalendarDate {
  const result = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() };
}

function zonedDateTimeParts(date: Date, timeZone: string): CalendarDate & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"), month: value("month"), day: value("day"),
    hour: value("hour"), minute: value("minute"), second: value("second"),
  };
}

function zonedMidnight(value: CalendarDate, timeZone: string): Date {
  const desiredUtc = Date.UTC(value.year, value.month - 1, value.day);
  let candidate = new Date(desiredUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedDateTimeParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate = new Date(candidate.getTime() + desiredUtc - actualAsUtc);
  }
  return candidate;
}

function validTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function resolveDashboardPeriod(
  query: DashboardQuery,
  organization: Organization,
  clock: Clock,
): { from: string; to: string; summaryPreset?: DashboardPeriodPreset } {
  if (query.from !== undefined || query.to !== undefined) {
    if (!query.from || !query.to || !validTimestamp(query.from) || !validTimestamp(query.to)) {
      throw badRequest("Both from and to must be valid RFC 3339 timestamps", "from");
    }
    if (Date.parse(query.from) >= Date.parse(query.to)) {
      throw badRequest("from must be earlier than to", "from");
    }
    return { from: new Date(query.from).toISOString(), to: new Date(query.to).toISOString(), summaryPreset: "custom" };
  }

  const preset = query.preset ?? "today";
  const today = dateParts(clock.now(), organization.settings.timeZone);
  const fromDate = preset === "yesterday" ? addCalendarDays(today, -1) : preset === "last_7_days" ? addCalendarDays(today, -6) : today;
  const toDate = preset === "yesterday" ? today : addCalendarDays(today, 1);
  return {
    from: zonedMidnight(fromDate, organization.settings.timeZone).toISOString(),
    to: zonedMidnight(toDate, organization.settings.timeZone).toISOString(),
    ...(preset === "last_7_days" ? {} : { summaryPreset: preset }),
  };
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 100;
}

function callKpis(calls: CallLog[]): CallKpis {
  const connected = calls.filter((call) => call.disposition === "answered");
  const talkDuration = connected.reduce((sum, call) => sum + call.durationSeconds, 0);
  return {
    totalCalls: calls.length,
    incomingCalls: calls.filter((call) => call.direction === "incoming").length,
    outgoingCalls: calls.filter((call) => call.direction === "outgoing").length,
    answeredCalls: connected.length,
    missedCalls: calls.filter((call) => call.disposition === "missed").length,
    rejectedCalls: calls.filter((call) => call.disposition === "rejected").length,
    connectedCalls: connected.length,
    neverAttendedCalls: calls.filter((call) => call.direction === "incoming" && call.disposition === "missed").length,
    clientNotPickupCalls: calls.filter((call) => call.direction === "outgoing" && ["missed", "busy", "voicemail"].includes(call.disposition)).length,
    uniqueClients: new Set(calls.filter((call) => !call.participant.isInternal).map((call) => call.participant.phoneNumber)).size,
    totalTalkDurationSeconds: talkDuration,
    averageTalkDurationSeconds: connected.length === 0 ? 0 : Math.round(talkDuration / connected.length),
    answerRate: percentage(connected.length, calls.length),
  };
}

const EMPTY_LEAD_KPIS: LeadKpis = {
  totalLeads: 0,
  newLeads: 0,
  contactedLeads: 0,
  uncontactedLeads: 0,
  dueFollowUps: 0,
  overdueFollowUps: 0,
  wonLeads: 0,
  lostLeads: 0,
  conversionRate: 0,
};

function hourlyActivity(calls: CallLog[], timeZone: string): DashboardOverview["hourlyActivity"] {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour: String(hour).padStart(2, "0"), label: hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`, incoming: 0, outgoing: 0 }));
  for (const call of calls) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(new Date(call.startedAt)));
    const bucket = buckets[hour];
    if (bucket) bucket[call.direction] += 1;
  }
  return buckets;
}

const OUTCOME_STYLE: Readonly<Record<string, { label: string; color: string }>> = {
  answered: { label: "Connected", color: "#12a983" },
  missed: { label: "Missed", color: "#f25e48" },
  rejected: { label: "Rejected", color: "#d15bad" },
  busy: { label: "Busy", color: "#ff9d36" },
  voicemail: { label: "Voicemail", color: "#2f83ee" },
  blocked: { label: "Blocked", color: "#64748b" },
  unknown: { label: "Unknown", color: "#94a3b8" },
};

function employeePerformance(calls: CallLog[], employeeId: string, employeeName: string, team?: string): EmployeePerformanceRow {
  const employeeCalls = calls.filter((call) => call.employeeId === employeeId);
  const connected = employeeCalls.filter((call) => call.disposition === "answered");
  const duration = connected.reduce((sum, call) => sum + call.durationSeconds, 0);
  return {
    employeeId,
    employeeName,
    ...(team === undefined ? {} : { team }),
    totalCalls: employeeCalls.length,
    connectedCalls: connected.length,
    missedCalls: employeeCalls.filter((call) => call.disposition === "missed").length,
    uniqueClients: new Set(employeeCalls.map((call) => call.participant.phoneNumber)).size,
    talkDurationSeconds: duration,
    averageCallDurationSeconds: connected.length === 0 ? 0 : Math.round(duration / connected.length),
    answerRate: percentage(connected.length, employeeCalls.length),
    assignedLeads: 0,
    contactedLeads: 0,
    wonLeads: 0,
    overdueFollowUps: 0,
  };
}

function maskedPhone(phoneNumber: string): string {
  return `•••• ${phoneNumber.replace(/\D/g, "").slice(-4)}`;
}

export async function buildDashboardOverview(options: {
  repository: CalloraRepository;
  organization: Organization;
  query: DashboardQuery;
  clock: Clock;
}): Promise<DashboardOverview> {
  const period = resolveDashboardPeriod(options.query, options.organization, options.clock);
  const calls = await options.repository.listCallsInPeriod({
    organizationId: options.organization.id,
    from: period.from,
    to: period.to,
    ...(options.query.employeeId === undefined ? {} : { employeeId: options.query.employeeId }),
  });
  const kpis = callKpis(calls);
  const employees = await options.repository.listEmployees({
    organizationId: options.organization.id,
    filter: {},
    limit: 1_000,
  });
  const selectedEmployees = options.query.employeeId === undefined
    ? employees.items
    : employees.items.filter((employee) => employee.id === options.query.employeeId);
  const offlineDevices = await options.repository.countOfflineDevices(options.organization.id, options.query.employeeId);
  const outcomeCounts = new Map<string, number>();
  for (const call of calls) outcomeCounts.set(call.disposition, (outcomeCounts.get(call.disposition) ?? 0) + 1);
  const recentCalls = [...calls].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 5);
  const employeeNames = new Map(employees.items.map((employee) => [employee.id, employee.displayName]));

  return {
    summary: {
      organizationId: options.organization.id,
      generatedAt: options.clock.now().toISOString(),
      period: { from: period.from, to: period.to },
      ...(period.summaryPreset === undefined ? {} : { preset: period.summaryPreset }),
      calls: kpis,
      leads: EMPTY_LEAD_KPIS,
      comparisons: {},
    },
    metrics: {
      totalCalls: kpis.totalCalls,
      totalTalkDurationSeconds: kpis.totalTalkDurationSeconds,
      connectedCalls: kpis.connectedCalls,
      missedCalls: kpis.missedCalls,
      uniqueClients: kpis.uniqueClients,
      workingHoursSeconds: calls.filter((call) => call.isWithinWorkingHours).reduce((sum, call) => sum + call.durationSeconds, 0),
    },
    hourlyActivity: hourlyActivity(calls, options.organization.settings.timeZone),
    outcomes: Object.entries(OUTCOME_STYLE).map(([key, style]) => ({ key, ...style, value: outcomeCounts.get(key) ?? 0 })),
    attention: [
      { key: "missed", label: "Missed incoming calls", value: kpis.neverAttendedCalls },
      { key: "leads", label: "Leads overdue", value: 0 },
      { key: "devices", label: "Devices offline", value: offlineDevices },
    ],
    teamPerformance: selectedEmployees.map((employee) => employeePerformance(calls, employee.id, employee.displayName, employee.team)),
    recentActivity: recentCalls.map((call) => ({
      id: call.id,
      kind: call.disposition === "answered" ? "connected" : "missed",
      title: call.disposition === "answered"
        ? `${employeeNames.get(call.employeeId) ?? "Employee"} connected a call`
        : `Call ${call.disposition}`,
      detail: maskedPhone(call.participant.phoneNumber),
      occurredAt: call.startedAt,
    })),
  };
}
