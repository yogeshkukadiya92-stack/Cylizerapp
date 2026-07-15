import type { LeadListItemView, LeadListSummary, LeadQueueFilter } from './types'

const SOURCE_LABELS: Record<LeadListItemView['source'], string> = {
  manual: 'Incoming call',
  csv_import: 'Trade show',
  website: 'Website',
  facebook: 'Facebook',
  instagram: 'Instagram',
  google_ads: 'Google Ads',
  india_mart: 'IndiaMART',
  api: 'API',
  integration: 'Referral',
  unknown: 'Unknown',
}
function dateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(date)
}

export function formatLeadDate(
  value: string | undefined,
  referenceAt: string,
  timeZone = 'Asia/Kolkata',
): string {
  if (!value) return '—'
  const date = new Date(value)
  const reference = new Date(referenceAt)
  if (Number.isNaN(date.getTime()) || Number.isNaN(reference.getTime())) return value

  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone,
    year: 'numeric',
  }).format(date)
  const timeLabel = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date)
  const targetKey = dateKey(date, timeZone)
  const referenceKey = dateKey(reference, timeZone)
  const tomorrow = new Date(reference.getTime() + 86_400_000)
  const yesterday = new Date(reference.getTime() - 86_400_000)

  if (targetKey === referenceKey) return `Today, ${timeLabel}`
  if (targetKey === dateKey(tomorrow, timeZone)) return `Tomorrow, ${timeLabel}`
  if (targetKey === dateKey(yesterday, timeZone)) return `Yesterday, ${timeLabel}`
  return `${dateLabel}, ${timeLabel}`
}

export function formatLeadPhone(value: string): string {
  const india = /^\+91(\d{5})(\d{5})$/.exec(value)
  return india ? `+91 ${india[1]} ${india[2]}` : value
}

export function leadSourceLabel(source: LeadListItemView['source']): string {
  return SOURCE_LABELS[source]
}

export function initialsForLeadOwner(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}

export function deriveLeadSummary(leads: LeadListItemView[], referenceAt: string): LeadListSummary {
  const reference = new Date(referenceAt).getTime()
  return leads.reduce<LeadListSummary>((summary, lead) => {
    summary.total += 1
    if (!lead.lastContactedAt) summary.notContacted += 1
    if (lead.nextFollowUpAt && new Date(lead.nextFollowUpAt).getTime() < reference) summary.overdue += 1
    if (lead.hasUnreturnedMissedCall) summary.unreturned += 1
    return summary
  }, { total: 0, notContacted: 0, overdue: 0, unreturned: 0 })
}

export function filterDemoLeads(
  leads: LeadListItemView[],
  search: string,
  queue: LeadQueueFilter,
  statusId: string,
  ownerId: string,
  referenceAt: string,
): LeadListItemView[] {
  const normalizedSearch = search.trim().toLowerCase()
  const reference = new Date(referenceAt).getTime()
  return leads.filter((lead) => {
    if (statusId !== 'all' && lead.statusId !== statusId) return false
    if (ownerId !== 'all' && lead.assignedEmployeeId !== ownerId) return false
    if (queue === 'not_contacted' && lead.lastContactedAt) return false
    if (queue === 'overdue' && (!lead.nextFollowUpAt || new Date(lead.nextFollowUpAt).getTime() >= reference)) return false
    if (queue === 'unreturned' && !lead.hasUnreturnedMissedCall) return false
    if (!normalizedSearch) return true
    return [lead.displayName, lead.companyName, lead.phoneNumber, lead.assignedEmployeeName]
      .some((value) => value?.toLowerCase().includes(normalizedSearch))
  })
}
