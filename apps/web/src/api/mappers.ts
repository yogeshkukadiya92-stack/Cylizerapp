import type { Employee, EmployeePerformanceRow, MetricComparison } from '@callora/contracts'
import {
  activityPoints,
  attentionItems,
  dashboardMetrics,
  initialEmployees,
  outcomes,
  recentActivities,
} from '../data/dashboard'
import type {
  AttentionItem,
  DashboardMetric,
  DashboardViewData,
  DateRange,
  EmployeeRow,
  RecentActivityItem,
} from '../types'
import type { DashboardOverviewData } from './client'

const employeeColors = ['#dff4ec', '#ddecff', '#fff0d9', '#f1e7ff', '#e2f5ef']

const dateComparison: Record<DateRange, string> = {
  Today: 'vs yesterday',
  Yesterday: 'vs previous day',
  'Last 7 days': 'vs prior week',
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function numberOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)
}

function formatDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m`
}

function initialsFor(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

function colorFor(id: string): string {
  const seed = [...id].reduce((total, character) => total + character.charCodeAt(0), 0)
  return employeeColors[seed % employeeColors.length]
}

function metricTrend(comparison: MetricComparison | undefined): number | null {
  return isFiniteNumber(comparison?.percentageChange) ? comparison.percentageChange : null
}

function buildMetrics(overview: DashboardOverviewData, dateRange: DateRange): DashboardMetric[] {
  const fallback = dashboardMetrics[dateRange]
  const metrics = overview.metrics ?? {}
  const comparisons = overview.summary?.comparisons ?? {}
  const values = [
    formatCount(numberOr(metrics.totalCalls, 0)),
    formatDuration(numberOr(metrics.totalTalkDurationSeconds, 0)),
    formatCount(numberOr(metrics.connectedCalls, 0)),
    formatCount(numberOr(metrics.missedCalls, 0)),
    formatCount(numberOr(metrics.uniqueClients, 0)),
    formatDuration(numberOr(metrics.workingHoursSeconds, 0)),
  ]
  const comparisonKeys = [
    'totalCalls',
    'totalTalkDurationSeconds',
    'connectedCalls',
    'missedCalls',
    'uniqueClients',
    null,
  ] as const

  return fallback.map((metric, index) => {
    const comparisonKey = comparisonKeys[index]
    const comparison = comparisonKey ? comparisons[comparisonKey] : undefined
    return {
      ...metric,
      value: values[index],
      trend: metricTrend(comparison),
      comparison: dateComparison[dateRange],
    }
  })
}

function buildAttention(overview: DashboardOverviewData): AttentionItem[] {
  if (!Array.isArray(overview.attention) || overview.attention.length === 0) {
    return attentionItems.map((item) => ({ ...item, value: 0 }))
  }
  const fallbackById = new Map(attentionItems.map((item) => [item.id, item]))
  return overview.attention.flatMap((item) => {
    const fallback = fallbackById.get(item.key)
    return fallback ? [{ ...fallback, label: item.label || fallback.label, value: numberOr(item.value, 0) }] : []
  })
}

function formatActivityTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date)
}

function buildRecentActivity(overview: DashboardOverviewData): RecentActivityItem[] {
  if (!Array.isArray(overview.recentActivity) || overview.recentActivity.length === 0) return []
  const kinds: Record<DashboardOverviewData['recentActivity'][number]['kind'], RecentActivityItem['kind']> = {
    connected: 'connected',
    missed: 'missed',
    employee: 'followup',
    device: 'overdue',
  }
  return overview.recentActivity.map((item) => ({
    id: item.id,
    kind: kinds[item.kind] ?? 'followup',
    title: item.title,
    detail: item.detail ?? '',
    time: formatActivityTime(item.occurredAt),
  }))
}

export function getDemoDashboard(dateRange: DateRange): DashboardViewData {
  return {
    metrics: dashboardMetrics[dateRange],
    activityPoints,
    outcomes,
    attentionItems,
    recentActivities,
  }
}

export function getEmptyDashboard(dateRange: DateRange): DashboardViewData {
  return {
    metrics: dashboardMetrics[dateRange].map((metric, index) => ({
      ...metric,
      value: index === 1 || index === 5 ? '0h 0m' : '0',
      trend: null,
      comparison: dateComparison[dateRange],
    })),
    activityPoints: [],
    outcomes: [],
    attentionItems: attentionItems.map((item) => ({ ...item, value: 0 })),
    recentActivities: [],
  }
}

export function normalizeDashboardOverview(
  overview: DashboardOverviewData,
  dateRange: DateRange,
): DashboardViewData {
  const remoteActivity = Array.isArray(overview.hourlyActivity)
    ? overview.hourlyActivity.map((point) => ({
      label: point.label,
      incoming: numberOr(point.incoming, 0),
      outgoing: numberOr(point.outgoing, 0),
    }))
    : []
  const remoteOutcomes = Array.isArray(overview.outcomes)
    ? overview.outcomes.map((outcome) => ({
      label: outcome.label,
      value: Math.max(0, numberOr(outcome.value, 0)),
      color: outcome.color,
    }))
    : []

  return {
    generatedAt: overview.summary.generatedAt,
    metrics: buildMetrics(overview, dateRange),
    activityPoints: remoteActivity,
    outcomes: remoteOutcomes,
    attentionItems: buildAttention(overview),
    recentActivities: buildRecentActivity(overview),
  }
}

export function normalizeEmployee(employee: Employee): EmployeeRow {
  return {
    id: employee.id,
    name: employee.displayName,
    deviceIds: employee.deviceIds,
    primaryPhone: employee.primaryPhone,
    initials: initialsFor(employee.displayName),
    color: colorFor(employee.id),
    calls: 0,
    connected: 0,
    talkMinutes: 0,
    followUps: 0,
    status: employee.status === 'active' ? 'Active' : 'Offline',
  }
}

function normalizePerformance(performance: EmployeePerformanceRow): EmployeeRow {
  return {
    id: performance.employeeId,
    name: performance.employeeName,
    initials: initialsFor(performance.employeeName),
    color: colorFor(performance.employeeId),
    calls: numberOr(performance.totalCalls, 0),
    connected: numberOr(performance.connectedCalls, 0),
    talkMinutes: Math.round(numberOr(performance.talkDurationSeconds, 0) / 60),
    followUps: numberOr(performance.overdueFollowUps, 0),
    status: 'Active',
  }
}

export function mergeEmployeesWithPerformance(
  employees: Employee[],
  performance: EmployeePerformanceRow[],
): EmployeeRow[] {
  const performanceById = new Map(performance.map((row) => [row.employeeId, normalizePerformance(row)]))
  const merged = employees.map((employee) => {
    const base = normalizeEmployee(employee)
    const metrics = performanceById.get(employee.id)
    if (!metrics) return base
    performanceById.delete(employee.id)
    return { ...metrics, ...base, calls: metrics.calls, connected: metrics.connected, talkMinutes: metrics.talkMinutes, followUps: metrics.followUps }
  })
  return [...merged, ...performanceById.values()]
}

export function mergePendingEmployees(employees: EmployeeRow[], pending: EmployeeRow[]): EmployeeRow[] {
  const existingIds = new Set(employees.map((employee) => employee.id))
  return [...employees, ...pending.filter((employee) => !existingIds.has(employee.id))]
}

export function getDemoEmployees(): EmployeeRow[] {
  return initialEmployees
}
