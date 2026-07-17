import {
  Clock3,
  ContactRound,
  Phone,
  PhoneMissed,
  Plus,
  Search,
  SlidersHorizontal,
  Upload,
  UserRound,
  Workflow,
} from 'lucide-react'
import { useState } from 'react'
import { LeadDetailPanel } from './LeadDetailPanel'
import { LeadTable } from './LeadTable'
import type {
  LeadDetailView,
  LeadListItemView,
  LeadListSummary,
  LeadOwnerOption,
  LeadPermissions,
  LeadQueueFilter,
  LeadStatusOption,
  LeadTimelineItem,
  LeadUpdateRequest,
} from './types'

interface LeadsPageProps {
  dataSource: { status: 'loading' | 'live' | 'demo' | 'error'; error: string | null }
  detail: LeadDetailView | null
  detailError: string | null
  detailLoading: boolean
  isDetailOpen: boolean
  leads: LeadListItemView[]
  ownerId: string
  owners: LeadOwnerOption[]
  permissions: LeadPermissions
  queue: LeadQueueFilter
  referenceAt: string
  searchQuery: string
  selectedLeadId: string | null
  statusId: string
  statuses: LeadStatusOption[]
  summary: LeadListSummary
  timeZone: string
  onAddLead: () => void
  onImportCsv: () => void
  onRetry: () => void
  onClearFilters: () => void
  onManageAssignmentRules: () => void
  onAddNote: () => void
  onCloseDetail: () => void
  onCompleteFollowUp: (followUpId: string) => Promise<boolean>
  onCorrectCallLink: (item: LeadTimelineItem) => void
  onOwnerChange: (ownerId: string) => void
  onQueueChange: (queue: LeadQueueFilter) => void
  onScheduleFollowUp: () => void
  onSearchChange: (value: string) => void
  onSelectLead: (leadId: string) => void
  onStatusChange: (statusId: string) => void
  onUpdateLead: (leadId: string, input: LeadUpdateRequest) => Promise<boolean>
}

const queueItems: Array<{ id: LeadQueueFilter; label: string; icon: typeof ContactRound; summaryKey: keyof LeadListSummary }> = [
  { id: 'all', label: 'All leads', icon: ContactRound, summaryKey: 'total' },
  { id: 'not_contacted', label: 'Not contacted', icon: Phone, summaryKey: 'notContacted' },
  { id: 'overdue', label: 'Overdue', icon: Clock3, summaryKey: 'overdue' },
  { id: 'unreturned', label: 'Unreturned calls', icon: PhoneMissed, summaryKey: 'unreturned' },
]

export function LeadsPage({
  dataSource,
  detail,
  detailError,
  detailLoading,
  isDetailOpen,
  leads,
  ownerId,
  owners,
  permissions,
  queue,
  referenceAt,
  searchQuery,
  selectedLeadId,
  statusId,
  statuses,
  summary,
  timeZone,
  onAddLead,
  onImportCsv,
  onRetry,
  onClearFilters,
  onManageAssignmentRules,
  onAddNote,
  onCloseDetail,
  onCompleteFollowUp,
  onCorrectCallLink,
  onOwnerChange,
  onQueueChange,
  onScheduleFollowUp,
  onSearchChange,
  onSelectLead,
  onStatusChange,
  onUpdateLead,
}: LeadsPageProps) {
  const [areFiltersOpen, setFiltersOpen] = useState(false)
  const activeFilterCount = Number(ownerId !== 'all') + Number(statusId !== 'all')
  const hasActiveFilters = activeFilterCount > 0 || queue !== 'all' || searchQuery.trim().length > 0
  if (dataSource.status === 'live' && !permissions.canRead) {
    return (
      <section className="module-preview" aria-labelledby="lead-access-heading">
        <div className="module-preview__icon"><ContactRound size={27} /></div>
        <p>Permission required</p>
        <h1 id="lead-access-heading">Lead pipeline</h1>
        <span>Your role does not include leads.read for this workspace. Ask an administrator for access.</span>
      </section>
    )
  }

  return (
    <div className="leads-page">
      <header className="lead-intro">
        <div className="page-title-row">
          <h1>Lead pipeline</h1>
          {dataSource.status !== 'live' ? (
            <span
              aria-label={`Lead data source: ${dataSource.status === 'loading' ? 'Loading live data' : dataSource.status === 'error' ? 'Live data unavailable' : 'Demo data, local drafts only'}`}
              className={`data-source data-source--${dataSource.status}`}
              role="status"
              title={dataSource.error ?? undefined}
            >
              <i aria-hidden="true" />{dataSource.status === 'loading' ? 'Loading' : dataSource.status === 'error' ? 'Unavailable' : 'Demo · local drafts'}
            </span>
          ) : null}
        </div>
        <p>Own every opportunity from first call to next action.</p>
      </header>

      {dataSource.status === 'error' ? <div className="service-notice" role="alert"><div><strong>Lead data could not be loaded</strong><span>{dataSource.error ?? 'The service is temporarily unavailable.'}</span></div><button className="secondary-button" onClick={onRetry} type="button">Try again</button></div> : null}

      <div className="lead-filter-bar">
        <label className="lead-search-control">
          <Search aria-hidden="true" size={19} />
          <span className="sr-only">Search leads</span>
          <input onChange={(event) => onSearchChange(event.target.value)} placeholder="Search leads, phone or company" type="search" value={searchQuery} />
        </label>

        <div aria-label="Lead queues" className="lead-queue-tabs" role="group">
          {queueItems.map(({ id, label, icon: Icon, summaryKey }) => (
            <button aria-label={label} aria-pressed={queue === id} className={queue === id ? 'lead-queue-tab--active' : ''} key={id} onClick={() => onQueueChange(id)} type="button">
              <Icon aria-hidden="true" size={17} />
              <span>{label}</span>
              <small>{summary[summaryKey]}</small>
            </button>
          ))}
        </div>

        <button aria-expanded={areFiltersOpen} className="secondary-button lead-mobile-filter-button" onClick={() => setFiltersOpen((current) => !current)} type="button"><SlidersHorizontal size={17} />Filters{activeFilterCount > 0 ? <small>{activeFilterCount}</small> : null}</button>
        <div className={`lead-filter-selects ${areFiltersOpen ? 'lead-filter-selects--open' : ''}`}>
          <label>
            <UserRound aria-hidden="true" size={17} />
            <span className="sr-only">Lead owner filter</span>
            <select onChange={(event) => onOwnerChange(event.target.value)} value={ownerId}>
              <option value="all">All owners</option>
              {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
            </select>
          </label>
          <label>
            <SlidersHorizontal aria-hidden="true" size={17} />
            <span className="sr-only">Lead status filter</span>
            <select onChange={(event) => onStatusChange(event.target.value)} value={statusId}>
              <option value="all">All statuses</option>
              {statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="lead-primary-actions">
        {permissions.canAssign ? (
          <button className="secondary-button lead-rules-button" onClick={onManageAssignmentRules} type="button">
            <Workflow size={17} />Assignment rules
          </button>
        ) : null}
        <button className="secondary-button lead-import-button" disabled={!permissions.canManage} onClick={onImportCsv} type="button">
          <Upload size={17} />Import CSV
        </button>
        {permissions.canManage ? (
          <button className="primary-button lead-add-button" onClick={onAddLead} type="button"><Plus size={18} />Add lead</button>
        ) : null}
      </div>

      <div className={`lead-pipeline-layout ${isDetailOpen ? '' : 'lead-pipeline-layout--detail-closed'}`}>
        <LeadTable
          canManage={permissions.canManage}
          hasActiveFilters={hasActiveFilters}
          leads={leads}
          onAddLead={onAddLead}
          onClearFilters={onClearFilters}
          onImportCsv={onImportCsv}
          onSelect={onSelectLead}
          referenceAt={referenceAt}
          selectedLeadId={selectedLeadId}
          timeZone={timeZone}
          total={summary.total}
        />
        {isDetailOpen ? (
          <LeadDetailPanel
            detail={detail}
            error={detailError}
            isLoading={detailLoading}
            onAddNote={onAddNote}
            onClose={onCloseDetail}
            onCompleteFollowUp={onCompleteFollowUp}
            onCorrectCallLink={onCorrectCallLink}
            onScheduleFollowUp={onScheduleFollowUp}
            onUpdate={onUpdateLead}
            owners={owners}
            permissions={permissions}
            referenceAt={referenceAt}
            statuses={statuses}
            timeZone={timeZone}
          />
        ) : null}
      </div>
    </div>
  )
}
