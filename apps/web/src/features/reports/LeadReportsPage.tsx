import type { LeadReport, LeadSource } from '@callora/contracts'
import {
  CalendarDays,
  Clock3,
  Download,
  Filter,
  TimerReset,
  TrendingUp,
  UsersRound,
  Zap,
} from 'lucide-react'

export interface LeadReportFilterDraft {
  from: string
  to: string
  employeeId: string
  team: string
  source: '' | LeadSource
}

interface ReportEmployeeOption {
  id: string
  name: string
}

interface LeadReportsPageProps {
  canExport: boolean
  dataSource: { status: 'loading' | 'live' | 'demo' | 'error'; error: string | null }
  employees: ReportEmployeeOption[]
  filters: LeadReportFilterDraft
  isRefreshing: boolean
  report: LeadReport
  searchQuery: string
  teams: string[]
  onApplyFilters: () => void
  onExport: () => void
  onFilterChange: (changes: Partial<LeadReportFilterDraft>) => void
  showTitle?: boolean
}

const number = new Intl.NumberFormat('en-IN')

function secondsLabel(value?: number): string {
  if (value === undefined) return '—'
  const hours = Math.floor(value / 3600)
  const minutes = Math.round((value % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(value))
}

function sourceLabel(source: LeadSource): string {
  const labels: Partial<Record<LeadSource, string>> = {
    manual: 'Phone / manual', csv_import: 'CSV import', google_ads: 'Google Ads', india_mart: 'IndiaMART', integration: 'Referrals / integration', api: 'API',
  }
  return labels[source] ?? source[0].toUpperCase() + source.slice(1)
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()
}

function TrendChart({ report }: { report: LeadReport }) {
  const width = 680
  const height = 230
  const plot = { left: 48, right: 24, top: 25, bottom: 48 }
  const maxValue = Math.max(1, ...report.trend.flatMap((row) => [row.created, row.won]))
  const x = (index: number) => report.trend.length <= 1 ? width / 2 : plot.left + (index / (report.trend.length - 1)) * (width - plot.left - plot.right)
  const y = (value: number) => plot.top + (1 - value / maxValue) * (height - plot.top - plot.bottom)
  const path = (key: 'created' | 'won') => report.trend.map((row, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(row[key])}`).join(' ')
  return (
    <section className="report-panel report-trend-panel" aria-labelledby="lead-trend-heading">
      <div className="report-panel-heading"><div><h2 id="lead-trend-heading">Leads created and won over time</h2><p><span className="trend-key trend-key--created" />Leads created <span className="trend-key trend-key--won" />Won</p></div><TrendingUp size={19} /></div>
      {report.trend.length ? <div className="report-chart-scroll"><svg aria-label="Leads created and won over time" className="report-trend-chart" preserveAspectRatio="none" role="img" viewBox={`0 0 ${width} ${height}`}>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => { const value = Math.round(maxValue * ratio); const yPosition = y(value); return <g key={ratio}><line className="report-grid-line" x1={plot.left} x2={width - plot.right} y1={yPosition} y2={yPosition} /><text className="report-axis-label" x={plot.left - 10} y={yPosition + 4}>{value}</text></g> })}
        <path className="report-trend-line report-trend-line--created" d={path('created')} /><path className="report-trend-line report-trend-line--won" d={path('won')} />
        {report.trend.map((row, index) => <g key={row.bucketStart}><circle className="report-trend-dot report-trend-dot--created" cx={x(index)} cy={y(row.created)} r="4" /><circle className="report-trend-dot report-trend-dot--won" cx={x(index)} cy={y(row.won)} r="4" /><text className="report-point-label" x={x(index)} y={y(row.created) - 10}>{row.created}</text><text className="report-point-label report-point-label--won" x={x(index)} y={y(row.won) - 10}>{row.won}</text><text className="report-axis-label report-axis-label--x" x={x(index)} y={height - 18}>{dateLabel(row.bucketStart)}</text></g>)}
      </svg><table className="sr-only"><caption>Lead trend values</caption><thead><tr><th>Date</th><th>Created</th><th>Won</th></tr></thead><tbody>{report.trend.map((row) => <tr key={row.bucketStart}><td>{dateLabel(row.bucketStart)}</td><td>{row.created}</td><td>{row.won}</td></tr>)}</tbody></table></div> : <div className="compact-empty">No lead trend data for this period.</div>}
    </section>
  )
}

export function LeadReportsPage({ canExport, dataSource, employees, filters, isRefreshing, report, searchQuery, teams, onApplyFilters, onExport, onFilterChange, showTitle = true }: LeadReportsPageProps) {
  const visibleOwners = report.owners.filter((owner) => owner.displayName.toLowerCase().includes(searchQuery.trim().toLowerCase()))
  const sourceMax = Math.max(1, ...report.sources.map((source) => source.percentageOfTotal))
  return (
    <div className="lead-reports-page">
      <header className="lead-report-intro"><div className="page-title-row">{showTitle ? <h1>Lead reports</h1> : null}<span aria-label={`Report data source: ${dataSource.status}`} className={`data-source data-source--${dataSource.status}`} role="status"><i />{isRefreshing ? 'Refreshing' : dataSource.status === 'live' ? 'Live data' : dataSource.status === 'demo' ? 'Demo data' : dataSource.status === 'error' ? 'Stale data' : 'Loading'}</span></div>{showTitle ? <p>See conversion, follow-up and owner performance in one place.</p> : null}</header>
      {dataSource.error ? <div className="operation-notice operation-notice--warning" role="status">{dataSource.error}</div> : null}
      <section aria-label="Lead report filters" className="lead-report-filters">
        <div className="report-date-range"><CalendarDays size={17} /><label>From<input onChange={(event) => onFilterChange({ from: event.target.value })} type="date" value={filters.from} /></label><span>—</span><label>To<input onChange={(event) => onFilterChange({ to: event.target.value })} type="date" value={filters.to} /></label></div>
        <label>Team<select onChange={(event) => onFilterChange({ team: event.target.value })} value={filters.team}><option value="">All teams</option>{teams.map((team) => <option key={team}>{team}</option>)}</select></label>
        <label>Owner<select onChange={(event) => onFilterChange({ employeeId: event.target.value })} value={filters.employeeId}><option value="">All owners</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
        <label>Source<select onChange={(event) => onFilterChange({ source: event.target.value as LeadReportFilterDraft['source'] })} value={filters.source}><option value="">All sources</option>{(['manual', 'csv_import', 'website', 'facebook', 'instagram', 'google_ads', 'india_mart', 'api', 'integration', 'unknown'] as LeadSource[]).map((source) => <option key={source} value={source}>{sourceLabel(source)}</option>)}</select></label>
        <button className="primary-button" disabled={isRefreshing} onClick={onApplyFilters} type="button"><Filter size={16} />{isRefreshing ? 'Applying…' : 'Apply filters'}</button>
        {canExport ? <button className="secondary-button" onClick={onExport} type="button"><Download size={16} />Export CSV</button> : null}
      </section>
      <section aria-label="Lead report key metrics" className="lead-report-metrics">
        <article><UsersRound /><span>Total leads<strong>{number.format(report.kpis.totalLeads)}</strong><small>Selected cohort</small></span></article>
        <article><Zap /><span>Conversion rate<strong>{report.kpis.conversionRate.toFixed(1)}%</strong><small>{number.format(report.kpis.convertedLeads)} won leads</small></span></article>
        <article className="report-metric--warning"><TimerReset /><span>Follow-ups due<strong>{number.format(report.kpis.followUpsDue)}</strong><small>Pending in period</small></span></article>
        <article><Clock3 /><span>Average first response<strong>{secondsLabel(report.kpis.averageFirstResponseSeconds)}</strong><small>Across contacted leads</small></span></article>
      </section>
      <div className="lead-report-visuals">
        <section className="report-panel report-pipeline-panel" aria-labelledby="pipeline-conversion-heading"><div className="report-panel-heading"><h2 id="pipeline-conversion-heading">Pipeline conversion</h2><Filter size={19} /></div><div className="pipeline-progress">{report.pipeline.map((row) => <div className="pipeline-progress-row" key={row.statusId}><span><strong>{row.statusName}</strong><small>{number.format(row.leadCount)}</small></span><div><i style={{ backgroundColor: row.color, width: `${Math.max(2, row.percentageOfTotal)}%` }} /><b>{number.format(row.leadCount)} ({row.percentageOfTotal.toFixed(1)}%)</b></div></div>)}{report.pipeline.length === 0 ? <div className="compact-empty">No pipeline data for this period.</div> : null}</div></section>
        <TrendChart report={report} />
      </div>
      <section className="report-table-panel" aria-labelledby="owner-performance-heading"><h2 id="owner-performance-heading">Owner performance</h2><div className="report-table-scroll"><table><thead><tr><th>Owner</th><th>Assigned</th><th>Contacted</th><th>Won</th><th>Conversion</th><th>Follow-ups overdue</th><th>Avg response</th></tr></thead><tbody>{visibleOwners.map((owner) => <tr key={owner.employeeId ?? 'unassigned'}><td data-label="Owner"><span className="report-owner-avatar">{initials(owner.displayName)}</span><strong>{owner.displayName}</strong></td><td data-label="Assigned">{number.format(owner.assigned)}</td><td data-label="Contacted">{number.format(owner.contacted)}</td><td data-label="Won">{number.format(owner.won)}</td><td data-label="Conversion">{owner.conversionRate.toFixed(1)}%</td><td className="report-warning-value" data-label="Follow-ups overdue">{number.format(owner.overdueFollowUps)}</td><td data-label="Avg response">{secondsLabel(owner.averageResponseSeconds)}</td></tr>)}</tbody></table>{visibleOwners.length === 0 ? <div className="compact-empty">No owners match this search.</div> : null}</div></section>
      <section className="report-table-panel" aria-labelledby="source-performance-heading"><h2 id="source-performance-heading">Source performance</h2><div className="report-table-scroll"><table><thead><tr><th>Source</th><th>Leads</th><th>Contacted</th><th>Qualified</th><th>Won</th><th>Conversion</th><th>% of total leads</th></tr></thead><tbody>{report.sources.map((source) => <tr key={source.source}><td data-label="Source"><strong>{sourceLabel(source.source)}</strong></td><td data-label="Leads">{number.format(source.leads)}</td><td data-label="Contacted">{number.format(source.contacted)}</td><td data-label="Qualified">{number.format(source.qualified)}</td><td data-label="Won">{number.format(source.won)}</td><td data-label="Conversion">{source.conversionRate.toFixed(1)}%</td><td data-label="% of total leads"><span className="source-share"><i style={{ width: `${(source.percentageOfTotal / sourceMax) * 100}%` }} /><b>{source.percentageOfTotal.toFixed(1)}%</b></span></td></tr>)}</tbody></table>{report.sources.length === 0 ? <div className="compact-empty">No lead source data for this period.</div> : null}</div></section>
      <footer className="report-metadata">Generated {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: report.timeZone }).format(new Date(report.generatedAt))} · {report.timeZone} · Metrics {report.metricDefinitionVersion}</footer>
    </div>
  )
}
