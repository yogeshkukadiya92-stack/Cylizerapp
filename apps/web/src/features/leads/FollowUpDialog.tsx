import { useState } from 'react'
import type { FormEvent } from 'react'
import { CalendarPlus, X } from 'lucide-react'
import type { CreateLeadFollowUpRequest, LeadListItemView, LeadOwnerOption } from './types'

function defaultDueAt(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1_000)
  date.setMinutes(0, 0, 0)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}
interface FollowUpDialogProps {
  canAssign: boolean
  isDemo: boolean
  lead: LeadListItemView
  owners: LeadOwnerOption[]
  onClose: () => void
  onSchedule: (input: CreateLeadFollowUpRequest) => Promise<boolean>
}

export function FollowUpDialog({ canAssign, isDemo, lead, owners, onClose, onSchedule }: FollowUpDialogProps) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [dueAt, setDueAt] = useState(defaultDueAt)
  const [priority, setPriority] = useState<CreateLeadFollowUpRequest['priority']>('normal')
  const [ownerId, setOwnerId] = useState(lead.assignedEmployeeId ?? '')
  const [isSubmitting, setSubmitting] = useState(false)
  const assignedEmployeeId = canAssign ? ownerId : lead.assignedEmployeeId ?? ''

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim() || !assignedEmployeeId || !dueAt) return
    const dueDate = new Date(dueAt)
    if (Number.isNaN(dueDate.getTime())) return
    setSubmitting(true)
    try {
      const input: CreateLeadFollowUpRequest = {
        leadId: lead.id,
        assignedEmployeeId,
        title: title.trim(),
        dueAt: dueDate.toISOString(),
        priority,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }
      if (await onSchedule(input)) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div aria-labelledby="schedule-follow-up-heading" aria-modal="true" className="dialog-layer" role="dialog">
      <button aria-label="Close schedule follow-up dialog" className="dialog-backdrop" disabled={isSubmitting} onClick={onClose} type="button" />
      <form className="dialog" onSubmit={submit}>
        <div className="dialog__icon"><CalendarPlus size={22} /></div>
        <button aria-label="Close dialog" className="icon-button dialog__close" disabled={isSubmitting} onClick={onClose} type="button"><X size={19} /></button>
        <h2 id="schedule-follow-up-heading">Schedule follow-up</h2>
        <p>Plan the next action for {lead.displayName}.</p>
        {isDemo ? <div className="dialog__notice">This follow-up will remain a local draft and will not sync.</div> : null}
        <label>
          Action
          <input autoFocus maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Discuss annual order" required value={title} />
        </label>
        <div className="lead-form-grid">
          <label>
            Due date and time
            <input min={new Date().toISOString().slice(0, 16)} onChange={(event) => setDueAt(event.target.value)} required type="datetime-local" value={dueAt} />
          </label>
          <label>
            Priority
            <select onChange={(event) => setPriority(event.target.value as CreateLeadFollowUpRequest['priority'])} value={priority}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        </div>
        {canAssign ? (
          <label>
            Owner
            <select onChange={(event) => setOwnerId(event.target.value)} required value={ownerId}>
              <option value="">Choose an owner</option>
              {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
            </select>
          </label>
        ) : null}
        <label>
          Notes
          <textarea maxLength={1_000} onChange={(event) => setNotes(event.target.value)} placeholder="Optional context for the owner" rows={3} value={notes} />
        </label>
        {!assignedEmployeeId ? <p className="form-error" role="alert">Assign this lead before scheduling a follow-up.</p> : null}
        <div className="dialog__actions">
          <button className="secondary-button" disabled={isSubmitting} onClick={onClose} type="button">Cancel</button>
          <button className="primary-button" disabled={isSubmitting || !assignedEmployeeId || !title.trim()} type="submit">{isSubmitting ? 'Scheduling…' : isDemo ? 'Save local follow-up' : 'Schedule follow-up'}</button>
        </div>
      </form>
    </div>
  )
}
