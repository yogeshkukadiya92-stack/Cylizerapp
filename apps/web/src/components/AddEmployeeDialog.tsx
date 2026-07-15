import { useState } from 'react'
import type { FormEvent } from 'react'
import { UserPlus, X } from 'lucide-react'
import type { EmployeeRow } from '../types'

interface AddEmployeeDialogProps {
  isOpen: boolean
  onClose: () => void
  onAdd: (employee: EmployeeRow) => Promise<boolean>
}

export function AddEmployeeDialog({ isOpen, onClose, onAdd }: AddEmployeeDialogProps) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [isSubmitting, setSubmitting] = useState(false)

  if (!isOpen) return null

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    const normalizedPhone = phone.trim().replace(/[^\d+]/g, '')
    if (!trimmedName || !/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) return
    const initials = trimmedName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
    setSubmitting(true)
    try {
      const wasAdded = await onAdd({
        id: `emp-${Date.now()}`,
        name: trimmedName,
        primaryPhone: normalizedPhone,
        initials,
        color: '#e2f5ef',
        calls: 0,
        connected: 0,
        talkMinutes: 0,
        followUps: 0,
        status: 'Offline',
      })
      if (!wasAdded) return
      setName('')
      setPhone('')
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div aria-modal="true" className="dialog-layer" role="dialog">
      <button aria-label="Close add employee dialog" className="dialog-backdrop" disabled={isSubmitting} onClick={onClose} type="button" />
      <form className="dialog" onSubmit={submit}>
        <div className="dialog__icon"><UserPlus size={22} /></div>
        <button aria-label="Close dialog" className="icon-button dialog__close" disabled={isSubmitting} onClick={onClose} type="button"><X size={19} /></button>
        <h2>Add an employee</h2>
        <p>They will receive a device connection code after the backend onboarding service is enabled.</p>
        <label>
          Full name
          <input autoFocus onChange={(event) => setName(event.target.value)} placeholder="e.g. Kiran Shah" required value={name} />
        </label>
        <label>
          Mobile number
          <input inputMode="tel" onChange={(event) => setPhone(event.target.value)} pattern="\+[1-9][0-9 ()-]{7,}" placeholder="+91 98765 43210" required value={phone} />
        </label>
        <div className="dialog__actions">
          <button className="secondary-button" disabled={isSubmitting} onClick={onClose} type="button">Cancel</button>
          <button className="primary-button" disabled={isSubmitting} type="submit">{isSubmitting ? 'Adding…' : 'Add employee'}</button>
        </div>
      </form>
    </div>
  )
}
