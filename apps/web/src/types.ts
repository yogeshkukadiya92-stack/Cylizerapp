import type { LucideIcon } from 'lucide-react'

export type DateRange = 'Today' | 'Yesterday' | 'Last 7 days'

export type MetricTone = 'primary' | 'blue' | 'danger' | 'warning'

export interface DashboardMetric {
  label: string
  value: string
  trend: number | null
  comparison: string
  tone: MetricTone
  icon: LucideIcon
}

export interface ActivityPoint {
  label: string
  incoming: number
  outgoing: number
}

export interface OutcomeItem {
  label: string
  value: number
  color: string
}

export type EmployeeStatus = 'Active' | 'Offline'

export interface EmployeeRow {
  id: string
  name: string
  deviceIds?: string[]
  primaryPhone?: string
  initials: string
  color: string
  calls: number
  connected: number
  talkMinutes: number
  followUps: number
  status: EmployeeStatus
  isLocalOnly?: boolean
}

export interface AttentionItem {
  id: 'missed' | 'leads' | 'devices'
  label: string
  value: number
  tone: MetricTone
  icon: LucideIcon
}

export interface RecentActivityItem {
  id: string
  kind: 'connected' | 'missed' | 'followup' | 'overdue'
  title: string
  detail: string
  time: string
}

export interface DashboardViewData {
  metrics: DashboardMetric[]
  activityPoints: ActivityPoint[]
  outcomes: OutcomeItem[]
  attentionItems: AttentionItem[]
  recentActivities: RecentActivityItem[]
}

export type DataSourceStatus = 'loading' | 'live' | 'demo'

export interface DataSourceState {
  status: DataSourceStatus
  error: string | null
}
