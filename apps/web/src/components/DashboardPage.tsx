import { CalendarDays, ChevronDown, Plus, UsersRound } from 'lucide-react'
import type {
  AttentionItem,
  DashboardViewData,
  DataSourceState,
  DateRange,
  EmployeeRow,
} from '../types'
import { ActivityChart } from './ActivityChart'
import { AttentionPanel } from './AttentionPanel'
import { MetricCard } from './MetricCard'
import { OutcomeChart } from './OutcomeChart'
import { RecentActivity } from './RecentActivity'
import { TeamTable } from './TeamTable'

interface DashboardPageProps {
  canManageDevices: boolean
  dateRange: DateRange
  dashboard: DashboardViewData
  dataSource: DataSourceState
  employees: EmployeeRow[]
  employeeFilter: string
  searchQuery: string
  onAddEmployee: () => void
  onAttentionSelect: (item: AttentionItem) => void
  onDateRangeChange: (dateRange: DateRange) => void
  onEmployeeFilterChange: (employee: string) => void
  onRevokeDevice: (deviceId: string, reason: string) => Promise<boolean>
  onRetry: () => void
}

export function DashboardPage({
  canManageDevices,
  dateRange,
  dashboard,
  dataSource,
  employees,
  employeeFilter,
  searchQuery,
  onAddEmployee,
  onAttentionSelect,
  onDateRangeChange,
  onEmployeeFilterChange,
  onRevokeDevice,
  onRetry,
}: DashboardPageProps) {
  const displayedEmployees = employeeFilter === 'all'
    ? employees
    : employees.filter((employee) => employee.id === employeeFilter)
  const dataSourceLabel = {
    loading: 'Loading live data',
    live: 'Live data',
    demo: 'Demo data · API unavailable',
    error: 'Live data unavailable',
  }[dataSource.status]
  const updatedAt = dashboard.generatedAt ? new Date(dashboard.generatedAt) : null
  const updatedLabel = updatedAt && !Number.isNaN(updatedAt.getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(updatedAt)
    : null

  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div>
          <div className="page-title-row">
            <h1>Team calling overview</h1>
            <span
              aria-label={`Data source: ${dataSourceLabel}`}
              className={`data-source data-source--${dataSource.status}`}
              role="status"
              title={dataSource.error ?? dataSourceLabel}
            >
              <i aria-hidden="true" />{dataSourceLabel}
            </span>
            {dataSource.status === 'live' && updatedLabel ? <span className="data-freshness">Updated {updatedLabel}</span> : null}
          </div>
          <p>Live activity and follow-up health across your team.</p>
        </div>
        <div className="page-header__actions">
          <label className="select-control">
            <CalendarDays size={17} />
            <span className="sr-only">Date range</span>
            <select value={dateRange} onChange={(event) => onDateRangeChange(event.target.value as DateRange)}>
              <option>Today</option>
              <option>Yesterday</option>
              <option>Last 7 days</option>
            </select>
            <ChevronDown size={15} />
          </label>
          <label className="select-control select-control--employee">
            <UsersRound size={17} />
            <span className="sr-only">Employee</span>
            <select value={employeeFilter} onChange={(event) => onEmployeeFilterChange(event.target.value)}>
              <option value="all">All employees</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
            <ChevronDown size={15} />
          </label>
          <button className="primary-button add-employee-button" onClick={onAddEmployee} type="button">
            <Plus size={18} /> Add employee
          </button>
        </div>
      </header>

      {dataSource.status === 'error' ? (
        <div className="service-notice" role="alert">
          <div><strong>Dashboard data could not be loaded</strong><span>{dataSource.error ?? 'The service is temporarily unavailable.'}</span></div>
          <button className="secondary-button" onClick={onRetry} type="button">Try again</button>
        </div>
      ) : null}

      <section aria-label="Key metrics" className="metrics-grid">
        {dashboard.metrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}
      </section>

      <div className="analytics-grid">
        <ActivityChart points={dashboard.activityPoints} />
        <OutcomeChart outcomes={dashboard.outcomes} />
        <AttentionPanel items={dashboard.attentionItems} onSelect={onAttentionSelect} />
      </div>

      <div className="operations-grid">
        <TeamTable
          canManageDevices={canManageDevices}
          employees={displayedEmployees}
          onRevokeDevice={onRevokeDevice}
          searchQuery={searchQuery}
        />
        <RecentActivity activities={dashboard.recentActivities} />
      </div>
    </div>
  )
}
