import { useState } from 'react'
import {
  CalendarCheck2,
  CalendarPlus,
  Check,
  NotebookPen,
  Phone,
  PhoneMissed,
  Tag,
  UserRoundCheck,
  X,
} from 'lucide-react'
import { formatLeadDate, formatLeadPhone } from './formatters'
import { LeadStatusBadge } from './LeadStatusBadge'
import type {
  LeadDetailView,
  LeadOwnerOption,
  LeadPermissions,
  LeadStatusOption,
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
  onCompleteFollowUp: (followUpId: string) => Promise<boolean>
  onScheduleFollowUp: () => void
  onUpdate: (leadId: string, input: LeadUpdateRequest) => Promise<boolean>
}

function TimelineIcon({ kind }: { kind: LeadDetailView['timeline'][number]['kind'] }) {
  if (kind === 'missed_call') return <PhoneMissed size={17} />
  if (kind === 'follow_up_created' || kind === 'follow_up_completed') return <CalendarCheck2 size={17} />
  if (kind === 'status_changed') return <Tag size={17} />
  if (kind === 'note_added') return <NotebookPen size={17} />
  return <UserRoundCheck size={17} />
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
  onCompleteFollowUp,
  onScheduleFollowUp,
  onUpdate,
}: LeadDetailPanelProps) {
  const [isUpdating, setUpdating] = useState(false)
  const [completingFollowUpId, setCompletingFollowUpId] = useState<string | null>(null)

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
      </div>

      <div className="lead-timeline" role="list">
        {detail.timeline.length > 0 ? [...detail.timeline].sort((left, right) => (
          new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()
        )).map((item) => (
          <div className={`lead-timeline-item lead-timeline-item--${item.kind}`} key={item.id} role="listitem">
            <span className="lead-timeline-icon"><TimelineIcon kind={item.kind} /></span>
            <div>
              <strong>{item.summary}</strong>
              {item.detail ? <p>“{item.detail}”</p> : null}
              <time dateTime={item.occurredAt}>{formatLeadDate(item.occurredAt, referenceAt, timeZone)}</time>
              {item.isLocalDraft ? <small>Local draft</small> : null}
            </div>
            <span className="lead-timeline-actor">by {item.actorName ?? 'System'}</span>
          </div>
        )) : <div className="compact-empty">No timeline activity yet.</div>}
      </div>

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
  )
}
