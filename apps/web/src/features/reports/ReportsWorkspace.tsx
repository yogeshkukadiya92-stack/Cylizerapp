import { useEffect, useMemo, useState } from 'react'
import type { LeadReport, LeadReportFilter, Permission } from '@callora/contracts'
import { BarChart3 } from 'lucide-react'
import { ApiRequestError, CalloraApiClient } from '../../api/client'
import type { AuthSession } from '../../auth/types'
import { AuthenticationRequiredError } from '../../auth/types'
import type { AuthorizationFailure } from '../../auth/useAuth'
import { demoLeadReport } from './data'
import { LeadReportsPage, type LeadReportFilterDraft } from './LeadReportsPage'

interface ReportsWorkspaceProps {
  authSession: AuthSession
  onAuthenticationFailure: (reason: AuthorizationFailure) => void
  onNotify: (message: string) => void
  searchQuery: string
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

function initialFilters(): LeadReportFilterDraft {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  return {
    from: `${year}-${twoDigits(month + 1)}-01`,
    to: `${year}-${twoDigits(month + 1)}-${twoDigits(new Date(year, month + 1, 0).getDate())}`,
    employeeId: '',
    team: '',
    source: '',
  }
}

function reportQuery(filters: LeadReportFilterDraft): LeadReportFilter {
  return {
    from: new Date(`${filters.from}T00:00:00.000Z`).toISOString(),
    to: new Date(`${filters.to}T23:59:59.999Z`).toISOString(),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...(filters.team.trim() ? { team: filters.team.trim() } : {}),
    ...(filters.source ? { source: filters.source } : {}),
  }
}

function authorizationFailure(error: unknown): AuthorizationFailure | null {
  if (error instanceof AuthenticationRequiredError) return 'unauthenticated'
  if (!(error instanceof ApiRequestError)) return null
  if (error.status === 401 || error.code === 'UNAUTHENTICATED') return 'unauthenticated'
  if (error.status === 403 || error.code === 'FORBIDDEN') return 'forbidden'
  return null
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function reportCsv(report: LeadReport): string {
  const rows: Array<Array<string | number>> = [
    ['Callora lead report'],
    ['Generated at', report.generatedAt],
    ['Timezone', report.timeZone],
    ['Metric definition', report.metricDefinitionVersion],
    [],
    ['Summary'],
    ['Total leads', 'Converted leads', 'Conversion rate', 'Follow-ups due', 'Average first response seconds'],
    [report.kpis.totalLeads, report.kpis.convertedLeads, report.kpis.conversionRate, report.kpis.followUpsDue, report.kpis.averageFirstResponseSeconds ?? ''],
    [],
    ['Owner performance'],
    ['Owner', 'Assigned', 'Contacted', 'Won', 'Conversion rate', 'Overdue follow-ups', 'Average response seconds'],
    ...report.owners.map((owner) => [owner.displayName, owner.assigned, owner.contacted, owner.won, owner.conversionRate, owner.overdueFollowUps, owner.averageResponseSeconds ?? '']),
    [],
    ['Source performance'],
    ['Source', 'Leads', 'Contacted', 'Qualified', 'Won', 'Conversion rate', 'Percentage of total'],
    ...report.sources.map((source) => [source.source, source.leads, source.contacted, source.qualified, source.won, source.conversionRate, source.percentageOfTotal]),
  ]
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

export function ReportsWorkspace({ authSession, onAuthenticationFailure, onNotify, searchQuery }: ReportsWorkspaceProps) {
  const [client] = useState(() => new CalloraApiClient({ authMode: authSession.mode }))
  const [filters, setFilters] = useState<LeadReportFilterDraft>(initialFilters)
  const [appliedFilters, setAppliedFilters] = useState<LeadReportFilterDraft>(initialFilters)
  const [report, setReport] = useState<LeadReport | null>(null)
  const [employees, setEmployees] = useState<Array<{ id: string; name: string; team?: string }>>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [isRefreshing, setRefreshing] = useState(false)
  const [dataSource, setDataSource] = useState<{ status: 'loading' | 'live' | 'demo'; error: string | null }>({ status: 'loading', error: null })
  const appliedKey = JSON.stringify(appliedFilters)

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      setRefreshing(report !== null)
      if (!report) setDataSource((current) => ({ status: 'loading', error: current.error }))
      try {
        if (!appliedFilters.from || !appliedFilters.to || appliedFilters.from > appliedFilters.to) {
          throw new Error('Choose a valid report date range.')
        }
        const accessToken = await authSession.getAccessToken(controller.signal)
        if (!accessToken) throw new AuthenticationRequiredError()
        const session = await client.getSession(accessToken, controller.signal)
        if (!session.permissions.includes('reports.read')) {
          if (!controller.signal.aborted) {
            setPermissions(session.permissions)
            setReport(null)
            setDataSource({ status: 'live', error: null })
          }
          return
        }
        const [nextReport, employeeResponse] = await Promise.all([
          client.getLeadReport(reportQuery(appliedFilters), accessToken, controller.signal),
          client.getEmployees(accessToken, controller.signal),
        ])
        if (controller.signal.aborted) return
        setPermissions(session.permissions)
        setEmployees(employeeResponse.items.map((employee) => ({ id: employee.id, name: employee.displayName, ...(employee.team ? { team: employee.team } : {}) })))
        setReport(nextReport)
        setDataSource({ status: 'live', error: null })
      } catch (error) {
        if (controller.signal.aborted) return
        const failure = authorizationFailure(error)
        if (authSession.mode === 'oidc') {
          onAuthenticationFailure(failure ?? 'service_unavailable')
          return
        }
        setPermissions(['reports.read', 'reports.export'])
        setEmployees(demoLeadReport.owners.filter((owner) => owner.employeeId).map((owner) => ({ id: owner.employeeId!, name: owner.displayName })))
        setReport(demoLeadReport)
        setDataSource({ status: 'demo', error: error instanceof Error ? `API unavailable · ${error.message}` : 'API unavailable · showing demo data' })
      } finally {
        if (!controller.signal.aborted) setRefreshing(false)
      }
    }
    void load()
    return () => controller.abort()
    // appliedKey is the stable request boundary; draft filter edits do not fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey, authSession, client, onAuthenticationFailure])

  const teams = useMemo(() => [...new Set(employees.map((employee) => employee.team).filter((team): team is string => Boolean(team)))].sort(), [employees])

  const applyFilters = () => {
    if (!filters.from || !filters.to || filters.from > filters.to) {
      onNotify('Choose a valid report date range')
      return
    }
    setAppliedFilters({ ...filters })
  }

  const exportCsv = () => {
    if (!report || !permissions.includes('reports.export')) return
    const blob = new Blob([reportCsv(report)], { type: 'text/csv;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = `callora-lead-report-${filters.from}-to-${filters.to}.csv`
    anchor.click()
    URL.revokeObjectURL(href)
    onNotify('Lead report CSV exported')
  }

  if (dataSource.status === 'live' && !permissions.includes('reports.read')) {
    return <section className="module-preview" aria-labelledby="report-access-heading"><div className="module-preview__icon"><BarChart3 size={27} /></div><p>Permission required</p><h1 id="report-access-heading">Lead reports</h1><span>Your role does not include reports.read for this workspace.</span></section>
  }
  if (!report) {
    return <section className="module-preview" aria-label="Loading lead reports"><div className="module-preview__icon"><BarChart3 size={27} /></div><p>Loading</p><h1>Lead reports</h1><span>Preparing conversion and owner performance.</span></section>
  }

  return (
    <LeadReportsPage
      canExport={permissions.includes('reports.export')}
      dataSource={dataSource}
      employees={employees}
      filters={filters}
      isRefreshing={isRefreshing}
      onApplyFilters={applyFilters}
      onExport={exportCsv}
      onFilterChange={(changes) => setFilters((current) => ({ ...current, ...changes }))}
      report={report}
      searchQuery={searchQuery}
      teams={teams}
    />
  )
}
