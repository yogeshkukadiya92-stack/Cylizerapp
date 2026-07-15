import type {
  CreateFollowUpInput,
  CreateLeadInput,
  Employee,
  FollowUp,
  FollowUpPriority,
  FollowUpStatus,
  Lead,
  LeadActivity,
  LeadActivityKind,
  LeadNote,
  LeadSource,
  LeadStatus,
  JsonValue,
  UpdateLeadInput,
} from '@callora/contracts'

export type LeadQueueFilter = 'all' | 'not_contacted' | 'overdue' | 'unreturned'

export interface LeadOwnerOption {
  id: string
  name: string
  initials: string
}

export interface LeadStatusOption {
  id: string
  name: string
  color: string
  position: number
  isInitial: boolean
  isWon: boolean
  isLost: boolean
}

export interface LeadFollowUpView {
  id: string
  leadId: string
  assignedEmployeeId: string
  assignedEmployeeName?: string
  title: string
  notes?: string
  dueAt: string
  priority: FollowUpPriority
  status: FollowUpStatus
  version: number
  completedAt?: string
  isLocalDraft?: boolean
}

export interface LeadTimelineItem {
  id: string
  kind: LeadActivityKind | 'missed_call'
  summary: string
  detail?: string
  actorName?: string
  occurredAt: string
  callLogId?: string
  metadata?: Record<string, JsonValue>
  isLocalDraft?: boolean
}

export interface LeadListItemView {
  id: string
  version: number
  displayName: string
  firstName: string
  lastName?: string
  companyName?: string
  phoneNumber: string
  email?: string
  source: LeadSource
  statusId: string
  statusName: string
  statusColor: string
  assignedEmployeeId?: string
  assignedEmployeeName?: string
  lastContactedAt?: string
  nextFollowUpAt?: string
  nextFollowUpTitle?: string
  nextFollowUpPriority?: FollowUpPriority
  hasUnreturnedMissedCall: boolean
  createdAt: string
  updatedAt: string
  isLocalDraft?: boolean
}

export interface LeadDetailView {
  lead: LeadListItemView
  timeline: LeadTimelineItem[]
  followUps: LeadFollowUpView[]
}

export interface LeadListSummary {
  total: number
  notContacted: number
  overdue: number
  unreturned: number
}

export interface LeadApiListItem {
  lead: Lead & { version: number }
  status: LeadStatus
  assignedEmployee?: Employee
  nextFollowUp?: FollowUp
  overdueFollowUpCount: number
  unreturnedMissedCallCount: number
}

export interface LeadApiDetail {
  item: LeadApiListItem
  notes: LeadNote[]
  followUps: FollowUp[]
  activities: LeadActivity[]
}

export interface LeadApiListResponse {
  items: LeadApiListItem[]
  cursorInfo: {
    nextCursor?: string
    hasMore: boolean
  }
  summary: {
    total: number
    notContacted: number
    overdue: number
    unreturnedCalls: number
  }
  generatedAt?: string
  timeZone?: string
}

export interface LeadListViewResponse {
  items: LeadListItemView[]
  cursorInfo: {
    nextCursor?: string
    hasMore: boolean
  }
  summary?: LeadListSummary
  generatedAt?: string
  timeZone?: string
}

export interface LeadStatusApiResponse {
  items: LeadStatus[]
}

export interface LeadOwnerApiResponse {
  items: Array<{
    id: string
    displayName: string
    team?: string
  }>
}

export interface LeadPermissions {
  canRead: boolean
  canManage: boolean
  canAssign: boolean
  canCorrectCallLinks: boolean
}

export interface LeadQuery {
  search?: string
  queue?: LeadQueueFilter
  statusId?: string
  assignedEmployeeId?: string
  cursor?: string
  limit?: number
}

export interface LeadUpdateRequest extends UpdateLeadInput {
  version: number
}

export interface LeadApiUpdateRequest {
  expectedVersion: number
  changes: UpdateLeadInput
}

export interface LeadNoteRequest {
  body: string
  isPinned?: boolean
}

export interface LeadMutationResult<T> {
  value: T
  source: 'live' | 'local'
}

export type CreateLeadRequest = CreateLeadInput
export type CreateLeadFollowUpRequest = CreateFollowUpInput
