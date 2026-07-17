import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Permission } from '@callora/contracts'
import { ApiRequestError, CalloraApiClient } from '../../api/client'
import type { AuthSession } from '../../auth/types'
import { AuthenticationRequiredError } from '../../auth/types'
import type { AuthorizationFailure } from '../../auth/useAuth'
import { buildDemoLeadDetail, DEMO_LEAD_NOW, demoLeadOwners, demoLeads, demoLeadStatuses } from './data'
import { deriveLeadSummary, filterDemoLeads, initialsForLeadOwner } from './formatters'
import { mapLeadDetail, mapLeadListResponse, mapLeadStatus } from './mappers'
import { canUseDemoData } from '../../runtime'
import type { DataSourceState } from '../../types'
import type {
  CreateLeadFollowUpRequest,
  CreateLeadRequest,
  LeadDetailView,
  LeadFollowUpView,
  LeadListItemView,
  LeadListSummary,
  LeadMutationResult,
  LeadNoteRequest,
  LeadOwnerOption,
  LeadPermissions,
  LeadQuery,
  LeadQueueFilter,
  LeadStatusOption,
  LeadTimelineItem,
  LeadUpdateRequest,
} from './types'

const EMPTY_PERMISSIONS: LeadPermissions = { canRead: false, canManage: false, canAssign: false, canCorrectCallLinks: false }

interface UseLeadDataOptions {
  authSession: AuthSession
  search: string
  queue: LeadQueueFilter
  statusId: string
  ownerId: string
  onAuthenticationFailure?: (reason: AuthorizationFailure) => void
}

interface LeadMeta {
  permissions: LeadPermissions
  owners: LeadOwnerOption[]
  statuses: LeadStatusOption[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'The live lead workspace is unavailable.'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function authorizationFailure(error: unknown): AuthorizationFailure | null {
  if (error instanceof AuthenticationRequiredError) return 'unauthenticated'
  if (!(error instanceof ApiRequestError)) return null
  if (error.status === 401 || error.code === 'UNAUTHENTICATED') return 'unauthenticated'
  if (error.status === 403 || error.code === 'FORBIDDEN') return 'forbidden'
  return null
}

function leadPermissions(permissions: Permission[]): LeadPermissions {
  return {
    canRead: permissions.includes('leads.read'),
    canManage: permissions.includes('leads.manage'),
    canAssign: permissions.includes('leads.assign'),
    canCorrectCallLinks: permissions.includes('leads.manage') && permissions.includes('calls.annotate'),
  }
}

function cloneDemoLeads(): LeadListItemView[] {
  return demoLeads.map((lead) => ({ ...lead }))
}

function nextPendingFollowUp(followUps: LeadFollowUpView[]): LeadFollowUpView | undefined {
  return followUps
    .filter((followUp) => followUp.status === 'pending' || followUp.status === 'overdue')
    .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime())[0]
}

export function useLeadData({
  authSession,
  search,
  queue,
  statusId,
  ownerId,
  onAuthenticationFailure,
}: UseLeadDataOptions) {
  const [client] = useState(() => new CalloraApiClient({ authMode: authSession.mode }))
  const [allLeads, setAllLeads] = useState<LeadListItemView[]>([])
  const [statuses, setStatuses] = useState<LeadStatusOption[]>([])
  const [owners, setOwners] = useState<LeadOwnerOption[]>([])
  const [permissions, setPermissions] = useState<LeadPermissions>(EMPTY_PERMISSIONS)
  const [dataSource, setDataSource] = useState<DataSourceState>({
    status: 'loading',
    error: null,
  })
  const [referenceAt, setReferenceAt] = useState(() => new Date().toISOString())
  const [timeZone, setTimeZone] = useState('Asia/Kolkata')
  const [serverSummary, setServerSummary] = useState<LeadListSummary | null>(null)
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<LeadDetailView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [isDemo, setIsDemo] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const metadataRef = useRef<LeadMeta | null>(null)
  const requestVersionRef = useRef(0)
  const mutationControllersRef = useRef(new Set<AbortController>())
  const localSequenceRef = useRef(0)
  const detailCacheRef = useRef(new Map<string, LeadDetailView>())
  const queryKey = `${search}\u0000${queue}\u0000${statusId}\u0000${ownerId}`

  useEffect(() => {
    if (isDemo) return undefined
    const controller = new AbortController()
    const requestVersion = ++requestVersionRef.current

    const load = async () => {
      setDataSource((current) => ({ status: 'loading', error: current.error }))
      try {
        const accessToken = await authSession.getAccessToken(controller.signal)
        if (!accessToken) throw new AuthenticationRequiredError()

        let meta = metadataRef.current
        if (!meta) {
          const session = await client.getSession(accessToken, controller.signal)
          const capability = leadPermissions(session.permissions)
          if (!capability.canRead) {
            if (controller.signal.aborted || requestVersion !== requestVersionRef.current) return
            setPermissions(capability)
            setDataSource({ status: 'live', error: null })
            setAllLeads([])
            return
          }
          const [statusResponse, ownerResponse] = await Promise.all([
            client.getLeadStatuses(accessToken, controller.signal),
            client.getLeadOwners(accessToken, controller.signal),
          ])
          meta = {
            permissions: capability,
            statuses: statusResponse.items.map(mapLeadStatus).sort((left, right) => left.position - right.position),
            owners: ownerResponse.items.map((owner) => ({
              id: owner.id,
              name: owner.displayName,
              initials: initialsForLeadOwner(owner.displayName),
            })),
          }
          metadataRef.current = meta
        }

        const query: LeadQuery = {
          limit: 50,
          ...(search ? { search } : {}),
          ...(queue !== 'all' ? { queue } : {}),
          ...(statusId !== 'all' ? { statusId } : {}),
          ...(ownerId !== 'all' ? { assignedEmployeeId: ownerId } : {}),
        }
        const response = mapLeadListResponse(await client.getLeads(query, accessToken, controller.signal))
        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) return

        setPermissions(meta.permissions)
        setStatuses(meta.statuses)
        setOwners(meta.owners)
        setAllLeads(response.items)
        setServerSummary(response.summary ?? null)
        setReferenceAt(response.generatedAt ?? new Date().toISOString())
        setTimeZone(response.timeZone ?? 'Asia/Kolkata')
        setSelectedLeadId((current) => (
          current && response.items.some((lead) => lead.id === current)
            ? current
            : response.items[0]?.id ?? null
        ))
        setDataSource({ status: 'live', error: null })
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || requestVersion !== requestVersionRef.current) return
        const failure = authorizationFailure(error)
        if (failure) {
          if (failure === 'forbidden') {
            setPermissions(EMPTY_PERMISSIONS)
            setAllLeads([])
            setDataSource({ status: 'live', error: 'You do not have permission to view leads.' })
            return
          }
          onAuthenticationFailure?.(failure)
          return
        }
        if (!canUseDemoData(authSession.mode)) {
          if (authSession.mode !== 'dev') {
            onAuthenticationFailure?.('service_unavailable')
            return
          }
          setPermissions(EMPTY_PERMISSIONS)
          setAllLeads([])
          setServerSummary(null)
          setDataSource({ status: 'error', error: errorMessage(error) })
          return
        }

        const leads = cloneDemoLeads()
        metadataRef.current = {
          permissions: { canRead: true, canManage: true, canAssign: true, canCorrectCallLinks: true },
          owners: demoLeadOwners.map((owner) => ({ ...owner })),
          statuses: demoLeadStatuses.map((status) => ({ ...status })),
        }
        detailCacheRef.current = new Map(leads.map((lead) => [lead.id, buildDemoLeadDetail(lead)]))
        setPermissions(metadataRef.current.permissions)
        setStatuses(metadataRef.current.statuses)
        setOwners(metadataRef.current.owners)
        setAllLeads(leads)
        setReferenceAt(DEMO_LEAD_NOW)
        setTimeZone('Asia/Kolkata')
        setServerSummary(deriveLeadSummary(leads, DEMO_LEAD_NOW))
        setSelectedLeadId((current) => current ?? leads[0]?.id ?? null)
        setIsDemo(true)
        setDataSource({ status: 'demo', error: errorMessage(error) })
      }
    }

    void load()
    return () => controller.abort()
  }, [authSession, client, isDemo, onAuthenticationFailure, ownerId, queryKey, queue, refreshVersion, search, statusId])

  useEffect(() => {
    if (!selectedLeadId) {
      setSelectedDetail(null)
      setDetailLoading(false)
      setDetailError(null)
      return undefined
    }

    const cached = detailCacheRef.current.get(selectedLeadId)
    if (isDemo) {
      const lead = allLeads.find((item) => item.id === selectedLeadId)
      const detail = cached ?? (lead ? buildDemoLeadDetail(lead) : null)
      setSelectedDetail(detail ? { ...detail, lead: lead ? { ...lead } : detail.lead } : null)
      setDetailLoading(false)
      setDetailError(null)
      return undefined
    }

    if (cached) setSelectedDetail(cached)
    const controller = new AbortController()
    const loadDetail = async () => {
      setDetailLoading(true)
      setDetailError(null)
      try {
        const accessToken = await authSession.getAccessToken(controller.signal)
        if (!accessToken) throw new AuthenticationRequiredError()
        const detail = mapLeadDetail(await client.getLeadDetail(selectedLeadId, accessToken, controller.signal))
        if (controller.signal.aborted) return
        detailCacheRef.current.set(selectedLeadId, detail)
        setSelectedDetail(detail)
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        const failure = authorizationFailure(error)
        if (failure === 'unauthenticated') onAuthenticationFailure?.(failure)
        setDetailError(errorMessage(error))
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false)
      }
    }
    void loadDetail()
    return () => controller.abort()
  }, [allLeads, authSession, client, isDemo, onAuthenticationFailure, selectedLeadId])

  useEffect(() => () => {
    mutationControllersRef.current.forEach((controller) => controller.abort())
    mutationControllersRef.current.clear()
  }, [])

  const visibleLeads = useMemo(() => isDemo
    ? filterDemoLeads(allLeads, search, queue, statusId, ownerId, referenceAt)
    : allLeads, [allLeads, isDemo, ownerId, queue, referenceAt, search, statusId])

  const summary = useMemo(() => serverSummary ?? deriveLeadSummary(allLeads, referenceAt), [allLeads, referenceAt, serverSummary])

  useEffect(() => {
    if (visibleLeads.length === 0) return
    if (!selectedLeadId || !visibleLeads.some((lead) => lead.id === selectedLeadId)) {
      setSelectedLeadId(visibleLeads[0]?.id ?? null)
    }
  }, [selectedLeadId, visibleLeads])

  const getMutationToken = useCallback(async (controller: AbortController): Promise<string> => {
    const token = await authSession.getAccessToken(controller.signal)
    if (!token) throw new AuthenticationRequiredError()
    return token
  }, [authSession])

  const replaceLead = useCallback((lead: LeadListItemView) => {
    setAllLeads((current) => current.some((item) => item.id === lead.id)
      ? current.map((item) => item.id === lead.id ? lead : item)
      : [lead, ...current])
  }, [])

  const storeDetail = useCallback((detail: LeadDetailView) => {
    detailCacheRef.current.set(detail.lead.id, detail)
    replaceLead(detail.lead)
    setSelectedLeadId(detail.lead.id)
    setSelectedDetail(detail)
  }, [replaceLead])

  const createLead = useCallback(async (input: CreateLeadRequest): Promise<LeadMutationResult<LeadDetailView>> => {
    if (!permissions.canManage) throw new Error('You do not have permission to create leads.')
    if (isDemo) {
      localSequenceRef.current += 1
      const status = statuses.find((item) => item.id === input.statusId) ?? statuses.find((item) => item.isInitial) ?? statuses[0]
      if (!status) throw new Error('No lead status is available.')
      const owner = owners.find((item) => item.id === input.assignedEmployeeId)
      const now = new Date().toISOString()
      const displayName = input.companyName?.trim() || [input.firstName, input.lastName].filter(Boolean).join(' ')
      const lead: LeadListItemView = {
        id: `local-lead-${localSequenceRef.current}`,
        version: 1,
        displayName,
        firstName: input.firstName,
        ...(input.lastName ? { lastName: input.lastName } : {}),
        ...(input.companyName ? { companyName: input.companyName } : {}),
        phoneNumber: input.phoneNumber,
        ...(input.email ? { email: input.email } : {}),
        source: input.source ?? 'manual',
        statusId: status.id,
        statusName: status.name,
        statusColor: status.color,
        ...(owner ? { assignedEmployeeId: owner.id, assignedEmployeeName: owner.name } : {}),
        hasUnreturnedMissedCall: false,
        createdAt: now,
        updatedAt: now,
        isLocalDraft: true,
      }
      const detail: LeadDetailView = {
        lead,
        timeline: [{
          id: `local-activity-${localSequenceRef.current}`,
          kind: 'created',
          summary: 'Lead created as a local draft',
          actorName: 'You',
          occurredAt: now,
          isLocalDraft: true,
        }],
        followUps: [],
      }
      storeDetail(detail)
      return { value: detail, source: 'local' }
    }

    const controller = new AbortController()
    mutationControllersRef.current.add(controller)
    try {
      const token = await getMutationToken(controller)
      const detail = mapLeadDetail(await client.createLead(input, token, controller.signal))
      if (controller.signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
      storeDetail(detail)
      return { value: detail, source: 'live' }
    } finally {
      mutationControllersRef.current.delete(controller)
    }
  }, [client, getMutationToken, isDemo, owners, permissions.canManage, statuses, storeDetail])

  const updateLead = useCallback(async (
    leadId: string,
    input: LeadUpdateRequest,
  ): Promise<LeadMutationResult<LeadDetailView>> => {
    if (!permissions.canManage && input.statusId !== undefined) throw new Error('You do not have permission to update lead status.')
    if (!permissions.canAssign && input.assignedEmployeeId !== undefined) throw new Error('You do not have permission to assign leads.')
    if (isDemo) {
      const current = detailCacheRef.current.get(leadId) ?? selectedDetail
      if (!current || current.lead.id !== leadId) throw new Error('The selected lead is unavailable.')
      if (current.lead.version !== input.version) throw new Error('This lead changed. Reopen it and try again.')
      const status = input.statusId ? statuses.find((item) => item.id === input.statusId) : undefined
      const owner = input.assignedEmployeeId ? owners.find((item) => item.id === input.assignedEmployeeId) : undefined
      const updatedLead: LeadListItemView = {
        ...current.lead,
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName ?? undefined } : {}),
        ...(input.companyName !== undefined ? { companyName: input.companyName ?? undefined } : {}),
        ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
        ...(input.email !== undefined ? { email: input.email ?? undefined } : {}),
        ...(status ? { statusId: status.id, statusName: status.name, statusColor: status.color } : {}),
        ...(input.assignedEmployeeId !== undefined ? {
          assignedEmployeeId: owner?.id,
          assignedEmployeeName: owner?.name,
        } : {}),
        version: current.lead.version + 1,
        updatedAt: new Date().toISOString(),
        isLocalDraft: true,
      }
      updatedLead.displayName = updatedLead.companyName?.trim() || [updatedLead.firstName, updatedLead.lastName].filter(Boolean).join(' ')
      const timeline = status && status.id !== current.lead.statusId
        ? [...current.timeline, {
          id: `local-status-${++localSequenceRef.current}`,
          kind: 'status_changed' as const,
          summary: `Status changed to ${status.name}`,
          actorName: 'You',
          occurredAt: updatedLead.updatedAt,
          isLocalDraft: true,
        }]
        : current.timeline
      const detail = { ...current, lead: updatedLead, timeline }
      storeDetail(detail)
      return { value: detail, source: 'local' }
    }

    const controller = new AbortController()
    mutationControllersRef.current.add(controller)
    try {
      const token = await getMutationToken(controller)
      const { version, ...changes } = input
      const detail = mapLeadDetail(await client.updateLead(leadId, {
        expectedVersion: version,
        changes,
      }, token, controller.signal))
      if (controller.signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
      storeDetail(detail)
      return { value: detail, source: 'live' }
    } finally {
      mutationControllersRef.current.delete(controller)
    }
  }, [client, getMutationToken, isDemo, owners, permissions.canAssign, permissions.canManage, selectedDetail, statuses, storeDetail])

  const addNote = useCallback(async (
    leadId: string,
    input: LeadNoteRequest,
  ): Promise<LeadMutationResult<LeadTimelineItem>> => {
    if (!permissions.canManage) throw new Error('You do not have permission to add lead notes.')
    if (isDemo) {
      const current = detailCacheRef.current.get(leadId) ?? selectedDetail
      if (!current || current.lead.id !== leadId) throw new Error('The selected lead is unavailable.')
      const timelineItem: LeadTimelineItem = {
        id: `local-note-${++localSequenceRef.current}`,
        kind: 'note_added',
        summary: 'Note added',
        detail: input.body,
        actorName: 'You',
        occurredAt: new Date().toISOString(),
        isLocalDraft: true,
      }
      storeDetail({ ...current, timeline: [...current.timeline, timelineItem] })
      return { value: timelineItem, source: 'local' }
    }

    const controller = new AbortController()
    mutationControllersRef.current.add(controller)
    try {
      const token = await getMutationToken(controller)
      const detail = mapLeadDetail(await client.addLeadNote(leadId, input, token, controller.signal))
      if (controller.signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
      const current = detailCacheRef.current.get(leadId) ?? selectedDetail
      const previousIds = new Set(current?.timeline.map((item) => item.id) ?? [])
      const item = detail.timeline.find((candidate) => !previousIds.has(candidate.id)) ?? detail.timeline.at(-1)
      if (!item) throw new Error('The API did not return the created note.')
      storeDetail(detail)
      return { value: item, source: 'live' }
    } finally {
      mutationControllersRef.current.delete(controller)
    }
  }, [client, getMutationToken, isDemo, permissions.canManage, selectedDetail, storeDetail])

  const createFollowUp = useCallback(async (
    leadId: string,
    input: CreateLeadFollowUpRequest,
  ): Promise<LeadMutationResult<LeadFollowUpView>> => {
    if (!permissions.canManage) throw new Error('You do not have permission to schedule follow-ups.')
    const current = detailCacheRef.current.get(leadId) ?? selectedDetail
    if (!current || current.lead.id !== leadId) throw new Error('The selected lead is unavailable.')
    let followUp: LeadFollowUpView
    let source: 'live' | 'local'
    if (isDemo) {
      const owner = owners.find((item) => item.id === input.assignedEmployeeId)
      followUp = {
        id: `local-followup-${++localSequenceRef.current}`,
        leadId,
        assignedEmployeeId: input.assignedEmployeeId,
        assignedEmployeeName: owner?.name,
        title: input.title,
        ...(input.notes ? { notes: input.notes } : {}),
        dueAt: input.dueAt,
        priority: input.priority ?? 'normal',
        status: 'pending',
        version: 1,
        isLocalDraft: true,
      }
      source = 'local'
    } else {
      const controller = new AbortController()
      mutationControllersRef.current.add(controller)
      try {
        const token = await getMutationToken(controller)
        const detail = mapLeadDetail(await client.createLeadFollowUp(leadId, input, token, controller.signal))
        if (controller.signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
        const previousIds = new Set(current.followUps.map((item) => item.id))
        const createdFollowUp = detail.followUps.find((item) => !previousIds.has(item.id)) ?? detail.followUps.at(-1)
        if (!createdFollowUp) throw new Error('The API did not return the scheduled follow-up.')
        followUp = createdFollowUp
        storeDetail(detail)
        source = 'live'
      } finally {
        mutationControllersRef.current.delete(controller)
      }
    }

    if (source === 'live') return { value: followUp, source }

    const followUps = [...current.followUps, followUp]
    const next = nextPendingFollowUp(followUps)
    const updatedLead = {
      ...current.lead,
      nextFollowUpAt: next?.dueAt,
      nextFollowUpTitle: next?.title,
      nextFollowUpPriority: next?.priority,
      ...(source === 'local' ? { isLocalDraft: true } : {}),
    }
    const timelineItem: LeadTimelineItem = {
      id: `${followUp.id}-activity`,
      kind: 'follow_up_created',
      summary: 'Follow-up scheduled',
      detail: followUp.title,
      actorName: followUp.assignedEmployeeName ?? 'You',
      occurredAt: new Date().toISOString(),
      ...(source === 'local' ? { isLocalDraft: true } : {}),
    }
    storeDetail({ ...current, lead: updatedLead, followUps, timeline: [...current.timeline, timelineItem] })
    return { value: followUp, source }
  }, [client, getMutationToken, isDemo, owners, permissions.canManage, selectedDetail, storeDetail])

  const completeFollowUp = useCallback(async (
    followUpId: string,
  ): Promise<LeadMutationResult<LeadFollowUpView>> => {
    if (!permissions.canManage) throw new Error('You do not have permission to complete follow-ups.')
    const current = selectedDetail
    const existing = current?.followUps.find((item) => item.id === followUpId)
    if (!current || !existing) throw new Error('The follow-up is unavailable.')
    let completed: LeadFollowUpView
    let source: 'live' | 'local'
    if (isDemo) {
      completed = { ...existing, status: 'completed', completedAt: new Date().toISOString(), version: existing.version + 1, isLocalDraft: true }
      source = 'local'
    } else {
      const controller = new AbortController()
      mutationControllersRef.current.add(controller)
      try {
        const token = await getMutationToken(controller)
        const detail = mapLeadDetail(await client.completeFollowUp(followUpId, {
          expectedVersion: existing.version,
        }, token, controller.signal))
        if (controller.signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
        const completedFollowUp = detail.followUps.find((item) => item.id === followUpId)
        if (!completedFollowUp) throw new Error('The API did not return the completed follow-up.')
        completed = completedFollowUp
        storeDetail(detail)
        source = 'live'
      } finally {
        mutationControllersRef.current.delete(controller)
      }
    }

    if (source === 'live') return { value: completed, source }

    const followUps = current.followUps.map((item) => item.id === completed.id ? completed : item)
    const next = nextPendingFollowUp(followUps)
    const lead = {
      ...current.lead,
      nextFollowUpAt: next?.dueAt,
      nextFollowUpTitle: next?.title,
      nextFollowUpPriority: next?.priority,
      ...(source === 'local' ? { isLocalDraft: true } : {}),
    }
    const timelineItem: LeadTimelineItem = {
      id: `${completed.id}-completed-activity`,
      kind: 'follow_up_completed',
      summary: 'Follow-up completed',
      detail: completed.title,
      actorName: 'You',
      occurredAt: completed.completedAt ?? new Date().toISOString(),
      ...(source === 'local' ? { isLocalDraft: true } : {}),
    }
    storeDetail({ ...current, lead, followUps, timeline: [...current.timeline, timelineItem] })
    return { value: completed, source }
  }, [client, getMutationToken, isDemo, permissions.canManage, selectedDetail, storeDetail])

  const refresh = useCallback(() => {
    detailCacheRef.current.clear()
    setServerSummary(null)
    setRefreshVersion((current) => current + 1)
  }, [])

  return {
    addNote,
    completeFollowUp,
    createFollowUp,
    createLead,
    dataSource,
    detailError,
    detailLoading,
    leads: visibleLeads,
    owners,
    permissions,
    referenceAt,
    refresh,
    selectedDetail,
    selectedLeadId,
    selectLead: setSelectedLeadId,
    closeLead: () => setSelectedLeadId(null),
    statuses,
    summary,
    timeZone,
    updateLead,
  }
}
