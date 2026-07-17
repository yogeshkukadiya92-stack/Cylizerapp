import { useState } from 'react'
import type { AuthSession } from '../../auth/types'
import type { AuthorizationFailure } from '../../auth/useAuth'
import { AddLeadDialog } from './AddLeadDialog'
import { AddNoteDialog } from './AddNoteDialog'
import { CallLinkCorrectionDialog } from './CallLinkCorrectionDialog'
import { FollowUpDialog } from './FollowUpDialog'
import { LeadOperationsDialog, type LeadOperationsTab } from './LeadOperationsDialog'
import { LeadsPage } from './LeadsPage'
import type {
  CreateLeadFollowUpRequest,
  CreateLeadRequest,
  LeadQueueFilter,
  LeadTimelineItem,
  LeadUpdateRequest,
} from './types'
import { useDebouncedValue } from './useDebouncedValue'
import { useLeadData } from './useLeadData'

interface LeadsWorkspaceProps {
  authSession: AuthSession
  onAuthenticationFailure: (reason: AuthorizationFailure) => void
  onNotify: (message: string) => void
  onSearchChange: (value: string) => void
  searchQuery: string
}
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Please try again.'
}

export function LeadsWorkspace({
  authSession,
  onAuthenticationFailure,
  onNotify,
  onSearchChange,
  searchQuery,
}: LeadsWorkspaceProps) {
  const [queue, setQueue] = useState<LeadQueueFilter>('all')
  const [statusId, setStatusId] = useState('all')
  const [ownerId, setOwnerId] = useState('all')
  const [isAddLeadOpen, setAddLeadOpen] = useState(false)
  const [isAddNoteOpen, setAddNoteOpen] = useState(false)
  const [isFollowUpOpen, setFollowUpOpen] = useState(false)
  const [isDetailOpen, setDetailOpen] = useState(true)
  const [operationsTab, setOperationsTab] = useState<LeadOperationsTab | null>(null)
  const [correctionItem, setCorrectionItem] = useState<LeadTimelineItem | null>(null)
  const debouncedSearch = useDebouncedValue(searchQuery.trim(), 250)
  const leadData = useLeadData({
    authSession,
    onAuthenticationFailure,
    ownerId,
    queue,
    search: debouncedSearch,
    statusId,
  })

  const notifyMutation = (action: string, source: 'live' | 'local') => {
    onNotify(source === 'live' ? action : `${action} as a local draft · not synced`)
  }

  const addLead = async (input: CreateLeadRequest): Promise<boolean> => {
    try {
      const result = await leadData.createLead(input)
      setDetailOpen(true)
      notifyMutation(`${result.value.lead.displayName} added`, result.source)
      return true
    } catch (error) {
      onNotify(`Could not add lead: ${failureMessage(error)}`)
      return false
    }
  }

  const updateLead = async (leadId: string, input: LeadUpdateRequest): Promise<boolean> => {
    try {
      const result = await leadData.updateLead(leadId, input)
      notifyMutation('Lead updated', result.source)
      return true
    } catch (error) {
      onNotify(`Could not update lead: ${failureMessage(error)}`)
      return false
    }
  }

  const addNote = async (body: string): Promise<boolean> => {
    const leadId = leadData.selectedDetail?.lead.id
    if (!leadId) return false
    try {
      const result = await leadData.addNote(leadId, { body })
      notifyMutation('Note added', result.source)
      return true
    } catch (error) {
      onNotify(`Could not add note: ${failureMessage(error)}`)
      return false
    }
  }

  const scheduleFollowUp = async (input: CreateLeadFollowUpRequest): Promise<boolean> => {
    const leadId = leadData.selectedDetail?.lead.id
    if (!leadId) return false
    try {
      const result = await leadData.createFollowUp(leadId, input)
      notifyMutation('Follow-up scheduled', result.source)
      return true
    } catch (error) {
      onNotify(`Could not schedule follow-up: ${failureMessage(error)}`)
      return false
    }
  }

  const completeFollowUp = async (followUpId: string): Promise<boolean> => {
    try {
      const result = await leadData.completeFollowUp(followUpId)
      notifyMutation('Follow-up completed', result.source)
      return true
    } catch (error) {
      onNotify(`Could not complete follow-up: ${failureMessage(error)}`)
      return false
    }
  }

  return (
    <>
      <LeadsPage
        dataSource={leadData.dataSource}
        detail={leadData.selectedDetail}
        detailError={leadData.detailError}
        detailLoading={leadData.detailLoading}
        isDetailOpen={isDetailOpen}
        leads={leadData.leads}
        onAddLead={() => setAddLeadOpen(true)}
        onImportCsv={() => setOperationsTab('imports')}
        onRetry={leadData.refresh}
        onClearFilters={() => {
          setQueue('all')
          setStatusId('all')
          setOwnerId('all')
          onSearchChange('')
        }}
        onManageAssignmentRules={() => setOperationsTab('rules')}
        onAddNote={() => setAddNoteOpen(true)}
        onCloseDetail={() => setDetailOpen(false)}
        onCompleteFollowUp={completeFollowUp}
        onCorrectCallLink={setCorrectionItem}
        onOwnerChange={setOwnerId}
        onQueueChange={setQueue}
        onScheduleFollowUp={() => setFollowUpOpen(true)}
        onSearchChange={onSearchChange}
        onSelectLead={(leadId) => {
          leadData.selectLead(leadId)
          setDetailOpen(true)
        }}
        onStatusChange={setStatusId}
        onUpdateLead={updateLead}
        ownerId={ownerId}
        owners={leadData.owners}
        permissions={leadData.permissions}
        queue={queue}
        referenceAt={leadData.referenceAt}
        searchQuery={searchQuery}
        selectedLeadId={leadData.selectedLeadId}
        statusId={statusId}
        statuses={leadData.statuses}
        summary={leadData.summary}
        timeZone={leadData.timeZone}
      />
      <AddLeadDialog
        canAssign={leadData.permissions.canAssign}
        isDemo={leadData.dataSource.status === 'demo'}
        isOpen={isAddLeadOpen}
        onAdd={addLead}
        onClose={() => setAddLeadOpen(false)}
        owners={leadData.owners}
        statuses={leadData.statuses}
      />
      {operationsTab ? (
        <LeadOperationsDialog
          authSession={authSession}
          initialTab={operationsTab}
          isLive={leadData.dataSource.status === 'live'}
          onChanged={leadData.refresh}
          onClose={() => setOperationsTab(null)}
          onNotify={onNotify}
          owners={leadData.owners}
          permissions={leadData.permissions}
          statuses={leadData.statuses}
        />
      ) : null}
      {correctionItem?.callLogId && leadData.selectedDetail ? (
        <CallLinkCorrectionDialog
          authSession={authSession}
          currentLeadId={leadData.selectedDetail.lead.id}
          currentLeadName={leadData.selectedDetail.lead.displayName}
          item={correctionItem}
          onClose={() => setCorrectionItem(null)}
          onCompleted={leadData.refresh}
          onNotify={onNotify}
        />
      ) : null}
      {isAddNoteOpen && leadData.selectedDetail ? (
        <AddNoteDialog
          isDemo={leadData.dataSource.status === 'demo'}
          leadName={leadData.selectedDetail.lead.displayName}
          onAdd={addNote}
          onClose={() => setAddNoteOpen(false)}
        />
      ) : null}
      {isFollowUpOpen && leadData.selectedDetail ? (
        <FollowUpDialog
          canAssign={leadData.permissions.canAssign}
          isDemo={leadData.dataSource.status === 'demo'}
          lead={leadData.selectedDetail.lead}
          onClose={() => setFollowUpOpen(false)}
          onSchedule={scheduleFollowUp}
          owners={leadData.owners}
        />
      ) : null}
    </>
  )
}
