import { useState } from 'react'
import type { FormEvent } from 'react'
import { NotebookPen, X } from 'lucide-react'

interface AddNoteDialogProps {
  isDemo: boolean
  leadName: string
  onAdd: (body: string) => Promise<boolean>
  onClose: () => void
}
export function AddNoteDialog({ isDemo, leadName, onAdd, onClose }: AddNoteDialogProps) {
  const [body, setBody] = useState('')
  const [isSubmitting, setSubmitting] = useState(false)
  const trimmedBody = body.trim()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (trimmedBody.length < 2 || trimmedBody.length > 2_000) return
    setSubmitting(true)
    try {
      if (await onAdd(trimmedBody)) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div aria-labelledby="lead-note-heading" aria-modal="true" className="dialog-layer" role="dialog">
      <button aria-label="Close add note dialog" className="dialog-backdrop" disabled={isSubmitting} onClick={onClose} type="button" />
      <form className="dialog" onSubmit={submit}>
        <div className="dialog__icon"><NotebookPen size={22} /></div>
        <button aria-label="Close dialog" className="icon-button dialog__close" disabled={isSubmitting} onClick={onClose} type="button"><X size={19} /></button>
        <h2 id="lead-note-heading">Add a note for {leadName}</h2>
        <p>Keep the next person working this opportunity fully informed.</p>
        {isDemo ? <div className="dialog__notice">This note will remain a local draft and will not sync.</div> : null}
        <label>
          Note
          <textarea autoFocus maxLength={2_000} onChange={(event) => setBody(event.target.value)} placeholder="What did the customer say?" required rows={5} value={body} />
        </label>
        <small className="dialog__hint">{trimmedBody.length}/2000 characters</small>
        <div className="dialog__actions">
          <button className="secondary-button" disabled={isSubmitting} onClick={onClose} type="button">Cancel</button>
          <button className="primary-button" disabled={isSubmitting || trimmedBody.length < 2} type="submit">{isSubmitting ? 'Saving…' : isDemo ? 'Save local note' : 'Add note'}</button>
        </div>
      </form>
    </div>
  )
}
