import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link2, LoaderCircle, Search, Unlink, X } from 'lucide-react'
import { CalloraApiClient } from '../../api/client'
import type { AuthSession } from '../../auth/types'
import { AccessibleDialog } from '../../components/AccessibleDialog'
import { mapLeadListResponse } from './mappers'
import { newRequestId } from './requestId'
import type { LeadListItemView, LeadTimelineItem } from './types'

interface CallLinkCorrectionDialogProps {
  authSession: AuthSession
  currentLeadId: string
  currentLeadName: string
  item: LeadTimelineItem
  onClose: () => void
  onCompleted: () => void
  onNotify: (message: string) => void
}

function correctionError(error: unknown): string {
  return error instanceof Error ? error.message : 'The call link could not be corrected.'
}

function metadataText(item: LeadTimelineItem, key: string): string | undefined {
  const value = item.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function CallLinkCorrectionDialog({
  authSession,
  currentLeadId,
  currentLeadName,
  item,
  onClose,
  onCompleted,
  onNotify,
}: CallLinkCorrectionDialogProps) {
  const [client] = useState(() => new CalloraApiClient({ authMode: authSession.mode }))
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<LeadListItemView[]>([])
  const [replacementLeadId, setReplacementLeadId] = useState('')
  const [unlinkOnly, setUnlinkOnly] = useState(false)
  const [reason, setReason] = useState('')
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(newRequestId())
  const callLogId = item.callLogId

  const token = async () => {
    const accessToken = await authSession.getAccessToken()
    if (!accessToken) throw new Error('Sign in again to continue.')
    return accessToken
  }

  const findLeads = async () => {
    if (search.trim().length < 2) return
    setSearching(true)
    setError(null)
    try {
      const response = mapLeadListResponse(await client.getLeads({ search: search.trim(), limit: 20 }, await token()))
      setResults(response.items.filter((lead) => lead.id !== currentLeadId))
    } catch (searchError) {
      setError(correctionError(searchError))
    } finally {
      setSearching(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!callLogId || reason.trim().length < 3 || (!unlinkOnly && !replacementLeadId)) return
    setSubmitting(true)
    setError(null)
    try {
      await client.correctCallLeadLink(callLogId, {
        requestId: requestIdRef.current,
        expectedLeadId: currentLeadId,
        replacementLeadId: unlinkOnly ? null : replacementLeadId,
        reason: reason.trim(),
      }, await token())
      const replacement = results.find((lead) => lead.id === replacementLeadId)
      onNotify(unlinkOnly ? 'Call unlinked with audit history' : `Call moved to ${replacement?.displayName ?? 'the selected lead'}`)
      onCompleted()
      onClose()
    } catch (submitError) {
      setError(correctionError(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccessibleDialog closeDisabled={submitting} className="call-link-dialog" labelledBy="call-link-heading" onClose={onClose}>
      <div className="dialog__icon"><Link2 size={22} /></div>
      <button aria-label="Close call-link correction" className="icon-button dialog__close" disabled={submitting} onClick={onClose} type="button"><X size={19} /></button>
      <h2 id="call-link-heading">Correct call link</h2>
      <p>Move this call to the right lead or unlink it. The previous link remains in audit history.</p>
      <div className="call-link-context"><span>Current lead</span><strong>{currentLeadName}</strong><small>{metadataText(item, 'direction') ?? 'Call'}{metadataText(item, 'phoneLastFour') ? ` · •••• ${metadataText(item, 'phoneLastFour')}` : ''} · {item.summary}</small></div>
      {error ? <div className="operation-notice operation-notice--error" role="alert">{error}</div> : null}
      <form onSubmit={submit}>
        <label className="unlink-option"><input checked={unlinkOnly} onChange={(event) => { setUnlinkOnly(event.target.checked); if (event.target.checked) setReplacementLeadId('') }} type="checkbox" /><span><Unlink size={17} />Unlink without replacement</span></label>
        {!unlinkOnly ? (
          <div className="call-link-target">
            <span>Replacement lead</span>
            <div className="call-link-search">
              <label><Search size={17} /><span className="sr-only">Search replacement leads</span><input autoFocus onChange={(event) => setSearch(event.target.value)} placeholder="Search lead, phone or company" type="search" value={search} /></label>
              <button className="secondary-button" disabled={searching || search.trim().length < 2} onClick={() => void findLeads()} type="button">{searching ? 'Searching…' : 'Search'}</button>
            </div>
            <div aria-label="Replacement lead results" className="call-link-results" role="radiogroup">
              {results.map((lead) => <label className={replacementLeadId === lead.id ? 'call-link-result--selected' : ''} key={lead.id}><input checked={replacementLeadId === lead.id} name="replacementLead" onChange={() => setReplacementLeadId(lead.id)} type="radio" value={lead.id} /><span><strong>{lead.displayName}</strong><small>{lead.phoneNumber} · {lead.statusName} · {lead.assignedEmployeeName ?? 'Unassigned'}</small></span></label>)}
              {!searching && search.trim().length >= 2 && results.length === 0 ? <div className="compact-empty">No accessible leads match this search.</div> : null}
            </div>
          </div>
        ) : null}
        <label>Correction reason<textarea maxLength={500} minLength={3} onChange={(event) => setReason(event.target.value)} placeholder="Why is this link being changed?" required value={reason} /></label>
        <div className="dialog__actions"><button className="secondary-button" disabled={submitting} onClick={onClose} type="button">Cancel</button><button className="primary-button" disabled={submitting || reason.trim().length < 3 || (!unlinkOnly && !replacementLeadId)} type="submit">{submitting ? <LoaderCircle className="spin" size={17} /> : <Link2 size={17} />}{submitting ? 'Correcting…' : unlinkOnly ? 'Unlink call' : 'Move call'}</button></div>
      </form>
    </AccessibleDialog>
  )
}
