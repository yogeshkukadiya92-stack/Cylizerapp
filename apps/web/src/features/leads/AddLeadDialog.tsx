import { useState } from 'react'
import type { FormEvent } from 'react'
import { ContactRound, X } from 'lucide-react'
import type { CreateLeadRequest, LeadOwnerOption, LeadStatusOption } from './types'

interface AddLeadDialogProps {
  isDemo: boolean
  isOpen: boolean
  owners: LeadOwnerOption[]
  statuses: LeadStatusOption[]
  canAssign: boolean
  onAdd: (input: CreateLeadRequest) => Promise<boolean>
  onClose: () => void
}
export function AddLeadDialog({
  isDemo,
  isOpen,
  owners,
  statuses,
  canAssign,
  onAdd,
  onClose,
}: AddLeadDialogProps) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [email, setEmail] = useState('')
  const [source, setSource] = useState<CreateLeadRequest['source']>('manual')
  const [statusId, setStatusId] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [isSubmitting, setSubmitting] = useState(false)

  if (!isOpen) return null

  const initialStatusId = statusId || statuses.find((status) => status.isInitial)?.id || statuses[0]?.id || ''
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedPhone = phoneNumber.trim().replace(/[^\d+]/g, '')
    const normalizedEmail = email.trim().toLowerCase()
    if (!firstName.trim() || !/^\+[1-9]\d{7,14}$/.test(normalizedPhone) || !initialStatusId) return
    setSubmitting(true)
    try {
      const input: CreateLeadRequest = {
        firstName: firstName.trim(),
        phoneNumber: normalizedPhone,
        source,
        statusId: initialStatusId,
        ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
        ...(companyName.trim() ? { companyName: companyName.trim() } : {}),
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(canAssign && ownerId ? { assignedEmployeeId: ownerId } : {}),
      }
      if (!await onAdd(input)) return
      setFirstName('')
      setLastName('')
      setCompanyName('')
      setPhoneNumber('')
      setEmail('')
      setSource('manual')
      setStatusId('')
      setOwnerId('')
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div aria-labelledby="add-lead-heading" aria-modal="true" className="dialog-layer" role="dialog">
      <button aria-label="Close add lead dialog" className="dialog-backdrop" disabled={isSubmitting} onClick={onClose} type="button" />
      <form className="dialog lead-form-dialog" onSubmit={submit}>
        <div className="dialog__icon"><ContactRound size={22} /></div>
        <button aria-label="Close dialog" className="icon-button dialog__close" disabled={isSubmitting} onClick={onClose} type="button"><X size={19} /></button>
        <h2 id="add-lead-heading">Add a lead</h2>
        <p>Capture the opportunity, owner and first pipeline status.</p>
        {isDemo ? <div className="dialog__notice">API unavailable · this lead will be saved as a local draft and will not sync.</div> : null}
        <div className="lead-form-grid">
          <label>
            First name
            <input autoFocus maxLength={120} onChange={(event) => setFirstName(event.target.value)} placeholder="e.g. Ramesh" required value={firstName} />
          </label>
          <label>
            Last name
            <input maxLength={120} onChange={(event) => setLastName(event.target.value)} placeholder="e.g. Patel" value={lastName} />
          </label>
        </div>
        <label>
          Company
          <input maxLength={160} onChange={(event) => setCompanyName(event.target.value)} placeholder="e.g. Ramesh Traders" value={companyName} />
        </label>
        <div className="lead-form-grid">
          <label>
            Mobile number
            <input inputMode="tel" onChange={(event) => setPhoneNumber(event.target.value)} pattern="\+[1-9][0-9 ()-]{7,}" placeholder="+91 98765 43210" required value={phoneNumber} />
          </label>
          <label>
            Email
            <input inputMode="email" onChange={(event) => setEmail(event.target.value)} placeholder="buyer@example.com" type="email" value={email} />
          </label>
        </div>
        <div className="lead-form-grid">
          <label>
            Source
            <select onChange={(event) => setSource(event.target.value as CreateLeadRequest['source'])} value={source}>
              <option value="manual">Manual / incoming call</option>
              <option value="website">Website</option>
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
              <option value="google_ads">Google Ads</option>
              <option value="india_mart">IndiaMART</option>
              <option value="integration">Referral / integration</option>
            </select>
          </label>
          <label>
            Status
            <select onChange={(event) => setStatusId(event.target.value)} required value={initialStatusId}>
              {statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
            </select>
          </label>
        </div>
        {canAssign ? (
          <label>
            Owner
            <select onChange={(event) => setOwnerId(event.target.value)} value={ownerId}>
              <option value="">Unassigned</option>
              {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
            </select>
          </label>
        ) : null}
        <div className="dialog__actions">
          <button className="secondary-button" disabled={isSubmitting} onClick={onClose} type="button">Cancel</button>
          <button className="primary-button" disabled={isSubmitting || !initialStatusId} type="submit">{isSubmitting ? 'Adding…' : isDemo ? 'Save local draft' : 'Add lead'}</button>
        </div>
      </form>
    </div>
  )
}
