import { useState } from 'react'
import {
  CalendarCheck2,
  CalendarPlus,
  Check,
  History,
  NotebookPen,
  Phone,
  X,
} from 'lucide-react'
import { formatLeadDate, formatLeadPhone } from './formatters'
import { LeadActivityDialog } from './LeadActivityDialog'
import { LeadStatusBadge } from './LeadStatusBadge'
import { LeadTimeline } from './LeadTimeline'
import type {
  LeadDetailView,
  LeadOwnerOption,
  LeadPermissions,
  LeadStatusOption,
  LeadTimelineItem,
  LeadUpdateRequest,
} from './types'

interface LeadDetailPanelProps {
  detail: LeadDetailView | null
  error: string | null
  isLoading: boolean
  owners: LeadOwnerOption[]
  permissions: LeadPermissions
  referenceAt: string
  statuses: LeadStatusOption[]
  timeZone: string
  onAddNote: () => void
  onClose: () => void
  onCorrectCallLink: (item: LeadTimelineItem) => void
  onCompleteFollowUp: (followUpId: string) => Promise<boolean>
  onScheduleFollowUp: () => void
  onUpdate: (leadId: string, input: LeadUpdateRequest) => Promise<boolean>
}

export function LeadDetailPanel({
  detail,
  error,
  isLoading,
  owners,
  permissions,
  referenceAt,
  statuses,
  timeZone,
  onAddNote,
  onClose,
  onCorrectCallLink,
  onCompleteFollowUp,
  onScheduleFollowUp,
  onUpdate,
}: LeadDetailPanelProps) {
  const [isUpdating, setUpdating] = useState(false)
  const [completingFollowUpId, setCompletingFollowUpId] = useState<string | null>(null)
  const [isActivityOpen, setActivityOpen] = useState(false)

  if (!detail) {
    return (
      <aside aria-label="Lead details" className="lead-detail-panel lead-detail-panel--empty">
        {isLoading ? 'Loading lead details…' : error ?? 'Select a lead to review its timeline and next action.'}
      </aside>
    )
  }

  const { lead } = detail
  const nextFollowUp = [...detail.followUps]
    .filter((followUp) => followUp.status === 'pending' || followUp.status === 'overdue')
    .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime())[0]

  const update = async (input: Omit<LeadUpdateRequest, 'version'>) => {
    setUpdating(true)
    try {
      await onUpdate(lead.id, { ...input, version: lead.version })
    } finally {
      setUpdating(false)
    }
  }

  const complete = async (followUpId: string) => {
    setCompletingFollowUpId(followUpId)
    try {
      await onCompleteFollowUp(followUpId)
    } finally {
      setCompletingFollowUpId(null)
    }
  }

  return (
    <>
    <aside aria-labelledby="lead-detail-heading" className="lead-detail-panel">
      <div aria-hidden="true" className="lead-sheet-handle" />
      <header className="lead-detail-header">
        <div>
          <div className="lead-detail-title-row">
            <h2 id="lead-detail-heading">{lead.displayName}</h2>
            {lead.isLocalDraft ? <span className="lead-local-badge">Local draft</span> : null}
          </div>
          <p>{formatLeadPhone(lead.phoneNumber)}</p>
        </div>
        <button aria-label="Close lead details" className="icon-button" onClick={onClose} type="button"><X size={20} /></button>
      </header>

      <div className="lead-detail-controls">
        <label>
          <span>Owner</span>
          {permissions.canAssign ? (
            <span className="lead-detail-select lead-detail-select--owner">
              <i>{lead.assignedEmployeeName ? lead.assignedEmployeeName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('') : '—'}</i>
              <select
                aria-label="Lead owner"
                disabled={isUpdating}
                onChange={(event) => void update({ assignedEmployeeId: event.target.value || null })}
                value={lead.assignedEmployeeId ?? ''}
              >
                <option value="">Unassigned</option>
                {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
              </select>
            </span>
          ) : <strong>{lead.assignedEmployeeName ?? 'Unassigned'}</strong>}
        </label>
        <label>
          <span>Status</span>
          {permissions.canManage ? (
            <span className="lead-detail-select lead-detail-select--status">
              <i style={{ background: lead.statusColor }} />
              <select
                aria-label="Lead status"
                disabled={isUpdating}
                onChange={(event) => void update({ statusId: event.target.value })}
                value={lead.statusId}
              >
                {statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
              </select>
            </span>
          ) : <LeadStatusBadge color={lead.statusColor} name={lead.statusName} />}
        </label>
      </div>

      <div className="lead-detail-actions">
        <a href={`tel:${lead.phoneNumber}`}><Phone size={17} />Call</a>
        <button disabled={!permissions.canManage} onClick={onAddNote} type="button"><NotebookPen size={17} />Add note</button>
        <button
          aria-label="Schedule follow-up"
          disabled={!permissions.canManage || (!permissions.canAssign && !lead.assignedEmployeeId)}
          onClick={onScheduleFollowUp}
          type="button"
        >
          <CalendarPlus size={17} />
          <span className="lead-action-label lead-action-label--desktop">Schedule follow-up</span>
          <span className="lead-action-label lead-action-label--mobile">Follow-up</span>
        </button>
        <button className="lead-mobile-activity-button" onClick={() => setActivityOpen(true)} type="button"><History size={17} />Activity</button>
      </div>

      <LeadTimeline canCorrectCallLinks={permissions.canCorrectCallLinks} items={detail.timeline} onCorrectCallLink={onCorrectCallLink} referenceAt={referenceAt} timeZone={timeZone} />

      <section className="lead-next-action">
        <span>Next follow-up</span>
        {nextFollowUp ? (
          <div className="lead-next-action__row">
            <div className="lead-next-action__icon"><CalendarCheck2 size={19} /></div>
            <div className="lead-next-action__copy">
              <strong>{formatLeadDate(nextFollowUp.dueAt, referenceAt, timeZone)}</strong>
              <p>{nextFollowUp.title}</p>
              {nextFollowUp.priority === 'high' || nextFollowUp.priority === 'urgent' ? (
                <small className="lead-priority">⚑ {nextFollowUp.priority === 'urgent' ? 'Urgent' : 'High priority'}</small>
              ) : null}
            </div>
            {permissions.canManage ? (
              <button
                className="secondary-button lead-complete-button"
                disabled={completingFollowUpId === nextFollowUp.id}
                onClick={() => void complete(nextFollowUp.id)}
                type="button"
              >
                <Check size={16} />{completingFollowUpId === nextFollowUp.id ? 'Completing…' : 'Complete'}
              </button>
            ) : null}
          </div>
        ) : (
          <button className="secondary-button lead-empty-followup" disabled={!permissions.canManage} onClick={onScheduleFollowUp} type="button">
            <CalendarPlus size={16} />Schedule the next action
          </button>
        )}
      </section>
    </aside>
    {isActivityOpen ? (
      <LeadActivityDialog
        canCorrectCallLinks={permissions.canCorrectCallLinks}
        items={detail.timeline}
        leadName={lead.displayName}
        onClose={() => setActivityOpen(false)}
        onCorrectCallLink={(item) => {
          setActivityOpen(false)
          onCorrectCallLink(item)
        }}
        referenceAt={referenceAt}
        timeZone={timeZone}
      />
    ) : null}
    </>
  )
}
