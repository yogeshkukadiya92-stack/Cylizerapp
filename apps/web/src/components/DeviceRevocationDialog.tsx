import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  DEVICE_REVOCATION_REASON_MAX_LENGTH,
  DEVICE_REVOCATION_REASON_MIN_LENGTH,
} from '@callora/contracts'
import { ShieldAlert, X } from 'lucide-react'

interface DeviceRevocationDialogProps {
  deviceIds: string[]
  employeeName: string
  onClose: () => void
  onRevoke: (deviceId: string, reason: string) => Promise<boolean>
}

export function DeviceRevocationDialog({
  deviceIds,
  employeeName,
  onClose,
  onRevoke,
}: DeviceRevocationDialogProps) {
  const [deviceId, setDeviceId] = useState(deviceIds[0] ?? '')
  const [reason, setReason] = useState('')
  const [isSubmitting, setSubmitting] = useState(false)
  const selectedDeviceId = deviceIds.includes(deviceId) ? deviceId : deviceIds[0] ?? ''
  const trimmedReason = reason.trim()
  const isReasonValid = trimmedReason.length >= DEVICE_REVOCATION_REASON_MIN_LENGTH &&
    trimmedReason.length <= DEVICE_REVOCATION_REASON_MAX_LENGTH

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedDeviceId || !isReasonValid) return
    setSubmitting(true)
    try {
      if (await onRevoke(selectedDeviceId, trimmedReason)) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  const headingId = 'device-revocation-heading'
  return (
    <div aria-labelledby={headingId} aria-modal="true" className="dialog-layer" role="dialog">
      <button
        aria-label="Close device revocation dialog"
        className="dialog-backdrop"
        disabled={isSubmitting}
        onClick={onClose}
        type="button"
      />
      <form className="dialog dialog--danger" onSubmit={submit}>
        <div className="dialog__icon dialog__icon--danger"><ShieldAlert size={22} /></div>
        <button
          aria-label="Close dialog"
          className="icon-button dialog__close"
          disabled={isSubmitting}
          onClick={onClose}
          type="button"
        >
          <X size={19} />
        </button>
        <h2 id={headingId}>Revoke {employeeName}’s device</h2>
        <p>
          Use this recovery action only when the device credential is lost. Collection stops,
          active credentials are revoked, and consent is withdrawn with an audit record.
        </p>
        <label>
          Device
          <select autoFocus disabled={isSubmitting} onChange={(event) => setDeviceId(event.target.value)} value={selectedDeviceId}>
            {deviceIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label>
          Operational reason
          <textarea
            disabled={isSubmitting}
            maxLength={DEVICE_REVOCATION_REASON_MAX_LENGTH}
            minLength={DEVICE_REVOCATION_REASON_MIN_LENGTH}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why can the employee no longer revoke this device?"
            required
            rows={3}
            value={reason}
          />
        </label>
        <small className="dialog__hint">
          {trimmedReason.length}/{DEVICE_REVOCATION_REASON_MAX_LENGTH} characters · minimum {DEVICE_REVOCATION_REASON_MIN_LENGTH}
        </small>
        <div className="dialog__actions">
          <button className="secondary-button" disabled={isSubmitting} onClick={onClose} type="button">Cancel</button>
          <button className="danger-button" disabled={isSubmitting || !selectedDeviceId || !isReasonValid} type="submit">
            {isSubmitting ? 'Revoking…' : 'Revoke device'}
          </button>
        </div>
      </form>
    </div>
  )
}
