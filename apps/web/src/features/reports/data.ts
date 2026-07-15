import type { LeadReport } from '@callora/contracts'

export const demoLeadReport: LeadReport = {
  filter: {
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-31T23:59:59.999Z',
  },
  kpis: {
    totalLeads: 1284,
    convertedLeads: 239,
    conversionRate: 18.6,
    followUpsDue: 94,
    averageFirstResponseSeconds: 8280,
  },
  pipeline: [
    { statusId: 'new', statusName: 'New', color: '#2f83ee', leadCount: 1284, percentageOfTotal: 100, isWon: false, isLost: false },
    { statusId: 'contacted', statusName: 'Contacted', color: '#0b9277', leadCount: 846, percentageOfTotal: 65.9, isWon: false, isLost: false },
    { statusId: 'qualified', statusName: 'Qualified', color: '#e29a24', leadCount: 402, percentageOfTotal: 31.3, isWon: false, isLost: false },
    { statusId: 'won', statusName: 'Won', color: '#08755f', leadCount: 239, percentageOfTotal: 18.6, isWon: true, isLost: false },
  ],
  trend: [
    { bucketStart: '2026-07-01T00:00:00.000Z', created: 280, won: 38 },
    { bucketStart: '2026-07-08T00:00:00.000Z', created: 320, won: 52 },
    { bucketStart: '2026-07-15T00:00:00.000Z', created: 340, won: 67 },
    { bucketStart: '2026-07-22T00:00:00.000Z', created: 344, won: 82 },
  ],
  owners: [
    { employeeId: 'emp-2', displayName: 'Priya Sharma', assigned: 482, contacted: 314, won: 98, conversionRate: 20.3, overdueFollowUps: 24, averageResponseSeconds: 6120 },
    { employeeId: 'emp-1', displayName: 'Amit Patel', assigned: 401, contacted: 258, won: 72, conversionRate: 17.9, overdueFollowUps: 18, averageResponseSeconds: 7500 },
    { employeeId: 'emp-3', displayName: 'Rohit Mehta', assigned: 321, contacted: 196, won: 51, conversionRate: 15.9, overdueFollowUps: 22, averageResponseSeconds: 10080 },
    { employeeId: null, displayName: 'Unassigned', assigned: 80, contacted: 78, won: 18, conversionRate: 23.1, overdueFollowUps: 30, averageResponseSeconds: 11520 },
  ],
  sources: [
    { source: 'website', leads: 612, contacted: 402, qualified: 208, won: 126, conversionRate: 20.6, percentageOfTotal: 47.7 },
    { source: 'manual', leads: 384, contacted: 246, qualified: 122, won: 66, conversionRate: 17.2, percentageOfTotal: 29.9 },
    { source: 'integration', leads: 192, contacted: 132, qualified: 56, won: 32, conversionRate: 16.7, percentageOfTotal: 15 },
    { source: 'google_ads', leads: 96, contacted: 66, qualified: 16, won: 15, conversionRate: 15.6, percentageOfTotal: 7.5 },
  ],
  generatedAt: '2026-07-15T10:21:00.000Z',
  timeZone: 'Asia/Kolkata',
  metricDefinitionVersion: '2026-07-15',
}
