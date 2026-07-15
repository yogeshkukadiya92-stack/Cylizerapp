import { useState } from 'react'
import { ContactRound, X } from 'lucide-react'
import { CalloraApiClient } from '../../api/client'
import type { AuthSession } from '../../auth/types'
import { AccessibleDialog } from '../../components/AccessibleDialog'
import { AssignmentRulesPanel } from './AssignmentRulesPanel'
import { LeadImportPanel } from './LeadImportPanel'
import type { LeadOwnerOption, LeadPermissions, LeadStatusOption } from './types'

export type LeadOperationsTab = 'imports' | 'rules'

interface LeadOperationsDialogProps {
  authSession: AuthSession
  initialTab: LeadOperationsTab
  isLive: boolean
  owners: LeadOwnerOption[]
  permissions: LeadPermissions
  statuses: LeadStatusOption[]
  onChanged: () => void
  onClose: () => void
  onNotify: (message: string) => void
}

export function LeadOperationsDialog({
  authSession,
  initialTab,
  isLive,
  owners,
  permissions,
  statuses,
  onChanged,
  onClose,
  onNotify,
}: LeadOperationsDialogProps) {
  const [tab, setTab] = useState<LeadOperationsTab>(initialTab)
  const [client] = useState(() => new CalloraApiClient({ authMode: authSession.mode }))

  return (
    <AccessibleDialog className="lead-operations-dialog" labelledBy="lead-operations-heading" onClose={onClose}>
      <header className="lead-operations-header">
        <div className="dialog__icon"><ContactRound size={22} /></div>
        <div><h2 id="lead-operations-heading">Lead operations</h2><p>Import, assign and reconcile leads with confidence.</p></div>
        <button aria-label="Close lead operations" className="icon-button" onClick={onClose} type="button"><X size={20} /></button>
      </header>
      <div aria-label="Lead operations sections" className="lead-operations-tabs" role="tablist">
        <button onClick={onClose} role="tab" type="button">Pipeline</button>
        <button aria-selected={tab === 'imports'} className={tab === 'imports' ? 'lead-operations-tab--active' : ''} onClick={() => setTab('imports')} role="tab" type="button">Imports</button>
        <button aria-selected={tab === 'rules'} className={tab === 'rules' ? 'lead-operations-tab--active' : ''} onClick={() => setTab('rules')} role="tab" type="button">Assignment rules</button>
      </div>
      <div className="lead-operations-content" role="tabpanel">
        {tab === 'imports' ? (
          <LeadImportPanel
            authSession={authSession}
            canManage={permissions.canManage}
            client={client}
            isLive={isLive}
            onChanged={onChanged}
            onNotify={onNotify}
            owners={owners}
          />
        ) : (
          <AssignmentRulesPanel
            authSession={authSession}
            canAssign={permissions.canAssign}
            client={client}
            isLive={isLive}
            onChanged={onChanged}
            onNotify={onNotify}
            owners={owners}
            statuses={statuses}
          />
        )}
      </div>
    </AccessibleDialog>
  )
}
