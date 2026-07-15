import type { FollowUp, LeadNote } from '@callora/contracts'
import { initialsForLeadOwner } from './formatters'
import type {
  LeadApiDetail,
  LeadApiListItem,
  LeadApiListResponse,
  LeadDetailView,
  LeadFollowUpView,
  LeadListItemView,
  LeadListViewResponse,
  LeadOwnerOption,
  LeadStatusOption,
  LeadTimelineItem,
} from './types'

function displayName(item: LeadApiListItem): string {
  return item.lead.companyName?.trim() || [item.lead.firstName, item.lead.lastName].filter(Boolean).join(' ')
}

export function mapLeadListItem(item: LeadApiListItem): LeadListItemView {
  return {
    id: item.lead.id,
    version: item.lead.version,
    displayName: displayName(item),
    firstName: item.lead.firstName,
    ...(item.lead.lastName ? { lastName: item.lead.lastName } : {}),
    ...(item.lead.companyName ? { companyName: item.lead.companyName } : {}),
    phoneNumber: item.lead.phoneNumber,
    ...(item.lead.email ? { email: item.lead.email } : {}),
    source: item.lead.source,
    statusId: item.status.id,
    statusName: item.status.name,
    statusColor: item.status.color,
    ...(item.assignedEmployee ? {
      assignedEmployeeId: item.assignedEmployee.id,
      assignedEmployeeName: item.assignedEmployee.displayName,
    } : {}),
    ...(item.lead.lastContactedAt ? { lastContactedAt: item.lead.lastContactedAt } : {}),
    ...(item.nextFollowUp ? {
      nextFollowUpAt: item.nextFollowUp.dueAt,
      nextFollowUpTitle: item.nextFollowUp.title,
      nextFollowUpPriority: item.nextFollowUp.priority,
    } : {}),
    hasUnreturnedMissedCall: item.unreturnedMissedCallCount > 0,
    createdAt: item.lead.createdAt,
    updatedAt: item.lead.updatedAt,
  }
}

export function mapLeadListResponse(response: LeadApiListResponse): LeadListViewResponse {
  return {
    items: response.items.map(mapLeadListItem),
    cursorInfo: response.cursorInfo,
    summary: {
      total: response.summary.total,
      notContacted: response.summary.notContacted,
      overdue: response.summary.overdue,
      unreturned: response.summary.unreturnedCalls,
    },
    ...(response.generatedAt ? { generatedAt: response.generatedAt } : {}),
    ...(response.timeZone ? { timeZone: response.timeZone } : {}),
  }
}

export function mapLeadStatus(status: LeadApiListItem['status']): LeadStatusOption {
  return {
    id: status.id,
    name: status.name,
    color: status.color,
    position: status.position,
    isInitial: status.isInitial,
    isWon: status.isWon,
    isLost: status.isLost,
  }
}

export function mapLeadOwner(employee: NonNullable<LeadApiListItem['assignedEmployee']>): LeadOwnerOption {
  return {
    id: employee.id,
    name: employee.displayName,
    initials: initialsForLeadOwner(employee.displayName),
  }
}

function mapFollowUp(followUp: FollowUp, item: LeadApiListItem): LeadFollowUpView {
  const assignedEmployeeName = item.assignedEmployee?.id === followUp.assignedEmployeeId
    ? item.assignedEmployee.displayName
    : undefined
  return {
    id: followUp.id,
    leadId: followUp.leadId,
    assignedEmployeeId: followUp.assignedEmployeeId,
    ...(assignedEmployeeName ? { assignedEmployeeName } : {}),
    title: followUp.title,
    ...(followUp.notes ? { notes: followUp.notes } : {}),
    dueAt: followUp.dueAt,
    priority: followUp.priority,
    status: followUp.status,
    version: followUp.version,
    ...(followUp.completedAt ? { completedAt: followUp.completedAt } : {}),
  }
}

function mapNote(note: LeadNote): LeadTimelineItem {
  return {
    id: `note:${note.id}`,
    kind: 'note_added',
    summary: 'Note added',
    detail: note.body,
    occurredAt: note.createdAt,
  }
}

export function mapLeadDetail(detail: LeadApiDetail): LeadDetailView {
  const activities: LeadTimelineItem[] = detail.activities
    .filter((activity) => activity.kind !== 'note_added')
    .map((activity) => ({
      id: `activity:${activity.id}`,
      kind: activity.kind,
      summary: activity.summary,
      occurredAt: activity.occurredAt,
      ...(activity.callLogId ? { callLogId: activity.callLogId } : {}),
      ...(activity.metadata ? { metadata: activity.metadata } : {}),
    }))
  return {
    lead: mapLeadListItem(detail.item),
    timeline: [...activities, ...detail.notes.map(mapNote)],
    followUps: detail.followUps.map((followUp) => mapFollowUp(followUp, detail.item)),
  }
}
