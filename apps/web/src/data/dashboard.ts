import {
  Clock3,
  Hourglass,
  Phone,
  PhoneCall,
  PhoneMissed,
  Smartphone,
  TimerReset,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react'
import type {
  ActivityPoint,
  AttentionItem,
  DashboardMetric,
  DateRange,
  EmployeeRow,
  OutcomeItem,
  RecentActivityItem,
} from '../types'

export const dashboardMetrics: Record<DateRange, DashboardMetric[]> = {
  Today: [
    { label: 'Total calls', value: '428', trend: 12.4, comparison: 'vs yesterday', tone: 'primary', icon: Phone },
    { label: 'Talk time', value: '18h 42m', trend: 8.6, comparison: 'vs yesterday', tone: 'primary', icon: Clock3 },
    { label: 'Connected', value: '286', trend: 15.1, comparison: 'vs yesterday', tone: 'primary', icon: PhoneCall },
    { label: 'Missed', value: '37', trend: -18.4, comparison: 'vs yesterday', tone: 'danger', icon: PhoneMissed },
    { label: 'Unique clients', value: '193', trend: 9.3, comparison: 'vs yesterday', tone: 'primary', icon: UsersRound },
    { label: 'Working hours', value: '7h 36m', trend: 6.7, comparison: 'vs yesterday', tone: 'primary', icon: Hourglass },
  ],
  Yesterday: [
    { label: 'Total calls', value: '381', trend: 5.8, comparison: 'vs previous day', tone: 'primary', icon: Phone },
    { label: 'Talk time', value: '17h 13m', trend: 3.1, comparison: 'vs previous day', tone: 'primary', icon: Clock3 },
    { label: 'Connected', value: '248', trend: 7.4, comparison: 'vs previous day', tone: 'primary', icon: PhoneCall },
    { label: 'Missed', value: '45', trend: 8.7, comparison: 'vs previous day', tone: 'danger', icon: PhoneMissed },
    { label: 'Unique clients', value: '176', trend: 5.2, comparison: 'vs previous day', tone: 'primary', icon: UsersRound },
    { label: 'Working hours', value: '7h 08m', trend: 2.9, comparison: 'vs previous day', tone: 'primary', icon: Hourglass },
  ],
  'Last 7 days': [
    { label: 'Total calls', value: '2,614', trend: 10.2, comparison: 'vs prior week', tone: 'primary', icon: Phone },
    { label: 'Talk time', value: '112h 8m', trend: 7.4, comparison: 'vs prior week', tone: 'primary', icon: Clock3 },
    { label: 'Connected', value: '1,746', trend: 12.3, comparison: 'vs prior week', tone: 'primary', icon: PhoneCall },
    { label: 'Missed', value: '213', trend: -4.1, comparison: 'vs prior week', tone: 'danger', icon: PhoneMissed },
    { label: 'Unique clients', value: '1,082', trend: 8.9, comparison: 'vs prior week', tone: 'primary', icon: UsersRound },
    { label: 'Working hours', value: '45h 32m', trend: 6.1, comparison: 'vs prior week', tone: 'primary', icon: Hourglass },
  ],
}

export const activityPoints: ActivityPoint[] = [
  { label: '9 AM', incoming: 28, outgoing: 41 },
  { label: '10 AM', incoming: 43, outgoing: 57 },
  { label: '11 AM', incoming: 52, outgoing: 69 },
  { label: '12 PM', incoming: 56, outgoing: 72 },
  { label: '1 PM', incoming: 55, outgoing: 68 },
  { label: '2 PM', incoming: 39, outgoing: 57 },
  { label: '3 PM', incoming: 28, outgoing: 49 },
  { label: '4 PM', incoming: 37, outgoing: 57 },
  { label: '5 PM', incoming: 49, outgoing: 69 },
  { label: '6 PM', incoming: 40, outgoing: 62 },
  { label: '7 PM', incoming: 19, outgoing: 40 },
]

export const outcomes: OutcomeItem[] = [
  { label: 'Connected', value: 286, color: '#12a983' },
  { label: 'Not interested', value: 72, color: '#2f83ee' },
  { label: 'Switched off', value: 28, color: '#ff9d36' },
  { label: 'Busy', value: 24, color: '#d15bad' },
  { label: 'Invalid number', value: 18, color: '#f25e48' },
]

export const attentionItems: AttentionItem[] = [
  { id: 'missed', label: 'Missed calls not returned', value: 12, tone: 'danger', icon: PhoneMissed },
  { id: 'leads', label: 'Leads overdue', value: 8, tone: 'warning', icon: TimerReset },
  { id: 'devices', label: 'Devices offline', value: 2, tone: 'blue', icon: Smartphone },
]

export const initialEmployees: EmployeeRow[] = [
  { id: 'emp-1', name: 'Amit Patel', initials: 'AP', color: '#dff4ec', calls: 126, connected: 84, talkMinutes: 298, followUps: 24, status: 'Active' },
  { id: 'emp-2', name: 'Priya Sharma', initials: 'PS', color: '#ddecff', calls: 112, connected: 72, talkMinutes: 252, followUps: 19, status: 'Active' },
  { id: 'emp-3', name: 'Rohit Verma', initials: 'RV', color: '#fff0d9', calls: 98, connected: 62, talkMinutes: 216, followUps: 16, status: 'Active' },
  { id: 'emp-4', name: 'Neha Gupta', initials: 'NG', color: '#f1e7ff', calls: 92, connected: 68, talkMinutes: 182, followUps: 14, status: 'Offline' },
]

export const recentActivities: RecentActivityItem[] = [
  { id: 'activity-1', kind: 'connected', title: 'Amit Patel connected a call', detail: '+91 98765 43210', time: '10:32 AM' },
  { id: 'activity-2', kind: 'missed', title: 'Missed call from', detail: '+91 87654 32109', time: '10:21 AM' },
  { id: 'activity-3', kind: 'followup', title: 'Priya Sharma added a follow-up', detail: 'Lead: Ramesh Traders', time: '09:58 AM' },
  { id: 'activity-4', kind: 'overdue', title: 'Rohit Verma marked lead overdue', detail: 'Lead: Shree Enterprises', time: '09:41 AM' },
  { id: 'activity-5', kind: 'connected', title: 'Neha Gupta connected a call', detail: '+91 91234 56789', time: '09:30 AM' },
]

export const activityIcons = {
  connected: PhoneCall,
  missed: PhoneMissed,
  followup: UserRoundCheck,
  overdue: TimerReset,
}
