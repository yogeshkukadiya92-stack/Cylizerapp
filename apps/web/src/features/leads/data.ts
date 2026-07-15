import type {
  LeadDetailView,
  LeadListItemView,
  LeadOwnerOption,
  LeadStatusOption,
} from './types'

export const DEMO_LEAD_NOW = '2026-07-14T05:00:00.000Z'

export const demoLeadStatuses: LeadStatusOption[] = [
  { id: 'status-new', name: 'New', color: '#2f83ee', position: 1, isInitial: true, isWon: false, isLost: false },
  { id: 'status-contacted', name: 'Contacted', color: '#f3942b', position: 2, isInitial: false, isWon: false, isLost: false },
  { id: 'status-qualified', name: 'Qualified', color: '#12a983', position: 3, isInitial: false, isWon: false, isLost: false },
  { id: 'status-won', name: 'Won', color: '#0b9277', position: 4, isInitial: false, isWon: true, isLost: false },
  { id: 'status-lost', name: 'Lost', color: '#f35a46', position: 5, isInitial: false, isWon: false, isLost: true },
]

export const demoLeadOwners: LeadOwnerOption[] = [
  { id: 'emp-1', name: 'Amit Patel', initials: 'AP' },
  { id: 'emp-2', name: 'Priya Sharma', initials: 'PS' },
  { id: 'emp-3', name: 'Rohit Verma', initials: 'RV' },
  { id: 'emp-4', name: 'Neha Gupta', initials: 'NG' },
]

export const demoLeads: LeadListItemView[] = [
  {
    id: 'lead-ramesh',
    version: 3,
    displayName: 'Ramesh Traders',
    firstName: 'Ramesh',
    lastName: 'Traders',
    companyName: 'Ramesh Traders',
    phoneNumber: '+919876543210',
    source: 'manual',
    statusId: 'status-qualified',
    statusName: 'Qualified',
    statusColor: '#12a983',
    assignedEmployeeId: 'emp-2',
    assignedEmployeeName: 'Priya Sharma',
    lastContactedAt: '2026-07-14T04:51:00.000Z',
    nextFollowUpAt: '2026-07-14T11:00:00.000Z',
    nextFollowUpTitle: 'Discuss annual order',
    nextFollowUpPriority: 'high',
    hasUnreturnedMissedCall: true,
    createdAt: '2026-07-09T08:30:00.000Z',
    updatedAt: '2026-07-14T04:55:00.000Z',
  },
  {
    id: 'lead-aarav',
    version: 1,
    displayName: 'Aarav Shah',
    firstName: 'Aarav',
    lastName: 'Shah',
    phoneNumber: '+919123456789',
    source: 'website',
    statusId: 'status-new',
    statusName: 'New',
    statusColor: '#2f83ee',
    assignedEmployeeId: 'emp-1',
    assignedEmployeeName: 'Amit Patel',
    nextFollowUpAt: '2026-07-15T05:30:00.000Z',
    nextFollowUpTitle: 'Introductory call',
    nextFollowUpPriority: 'normal',
    hasUnreturnedMissedCall: false,
    createdAt: '2026-07-14T03:15:00.000Z',
    updatedAt: '2026-07-14T03:15:00.000Z',
  },
  {
    id: 'lead-shree',
    version: 2,
    displayName: 'Shree Enterprises',
    firstName: 'Shree',
    lastName: 'Enterprises',
    companyName: 'Shree Enterprises',
    phoneNumber: '+918765432109',
    source: 'integration',
    statusId: 'status-contacted',
    statusName: 'Contacted',
    statusColor: '#f3942b',
    assignedEmployeeId: 'emp-3',
    assignedEmployeeName: 'Rohit Verma',
    lastContactedAt: '2026-07-13T10:15:00.000Z',
    nextFollowUpAt: '2026-07-16T08:30:00.000Z',
    nextFollowUpTitle: 'Share pricing options',
    nextFollowUpPriority: 'normal',
    hasUnreturnedMissedCall: false,
    createdAt: '2026-07-08T07:40:00.000Z',
    updatedAt: '2026-07-13T10:15:00.000Z',
  },
  {
    id: 'lead-meera',
    version: 4,
    displayName: 'Meera Textiles',
    firstName: 'Meera',
    lastName: 'Textiles',
    companyName: 'Meera Textiles',
    phoneNumber: '+919988766554',
    source: 'manual',
    statusId: 'status-won',
    statusName: 'Won',
    statusColor: '#0b9277',
    assignedEmployeeId: 'emp-2',
    assignedEmployeeName: 'Priya Sharma',
    lastContactedAt: '2026-07-09T07:40:00.000Z',
    hasUnreturnedMissedCall: false,
    createdAt: '2026-07-01T05:30:00.000Z',
    updatedAt: '2026-07-09T07:40:00.000Z',
  },
  {
    id: 'lead-nisha',
    version: 1,
    displayName: 'Nisha Patel',
    firstName: 'Nisha',
    lastName: 'Patel',
    phoneNumber: '+919345678901',
    source: 'csv_import',
    statusId: 'status-new',
    statusName: 'New',
    statusColor: '#2f83ee',
    assignedEmployeeId: 'emp-1',
    assignedEmployeeName: 'Amit Patel',
    nextFollowUpAt: '2026-07-18T05:00:00.000Z',
    nextFollowUpTitle: 'Trade show follow-up',
    nextFollowUpPriority: 'low',
    hasUnreturnedMissedCall: false,
    createdAt: '2026-07-12T09:00:00.000Z',
    updatedAt: '2026-07-12T09:00:00.000Z',
  },
]

export const demoLeadDetails: Record<string, LeadDetailView> = {
  'lead-ramesh': {
    lead: demoLeads[0],
    timeline: [
      {
        id: 'activity-call-ramesh',
        kind: 'missed_call',
        summary: 'Missed incoming call',
        actorName: 'System',
        occurredAt: '2026-07-14T04:51:00.000Z',
      },
      {
        id: 'activity-followup-ramesh',
        kind: 'follow_up_created',
        summary: 'Follow-up scheduled',
        actorName: 'Priya Sharma',
        occurredAt: '2026-07-14T04:52:00.000Z',
      },
      {
        id: 'activity-status-ramesh',
        kind: 'status_changed',
        summary: 'Status changed to Qualified',
        actorName: 'Priya Sharma',
        occurredAt: '2026-07-14T04:52:00.000Z',
      },
      {
        id: 'activity-note-ramesh',
        kind: 'note_added',
        summary: 'Note added',
        detail: 'Interested in our premium textile range.',
        actorName: 'Priya Sharma',
        occurredAt: '2026-07-14T04:55:00.000Z',
      },
    ],
    followUps: [
      {
        id: 'followup-ramesh',
        leadId: 'lead-ramesh',
        assignedEmployeeId: 'emp-2',
        assignedEmployeeName: 'Priya Sharma',
        title: 'Discuss annual order',
        dueAt: '2026-07-14T11:00:00.000Z',
        priority: 'high',
        status: 'pending',
        version: 1,
      },
    ],
  },
}

export function buildDemoLeadDetail(lead: LeadListItemView): LeadDetailView {
  const seeded = demoLeadDetails[lead.id]
  if (seeded) {
    return {
      lead: { ...seeded.lead },
      timeline: seeded.timeline.map((item) => ({ ...item })),
      followUps: seeded.followUps.map((item) => ({ ...item })),
    }
  }
  return { lead: { ...lead }, timeline: [], followUps: [] }
}
