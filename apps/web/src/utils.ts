import type { EmployeeRow } from './types'

export function formatTalkTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes.toString().padStart(2, '0')}m`
}

export function connectionRate(employee: EmployeeRow): string {
  if (employee.calls === 0) return '0%'
  return `${((employee.connected / employee.calls) * 100).toFixed(1)}%`
}

export function escapeCsvCell(cell: string | number): string {
  const value = String(cell)
  const neutralized = /^\s*[=+\-@]/.test(value) ? `'${value}` : value
  return `"${neutralized.replaceAll('"', '""')}"`
}

export function buildEmployeeCsv(employees: EmployeeRow[]): string {
  const header = ['Employee', 'Calls', 'Connected', 'Connection rate', 'Talk time', 'Follow-ups', 'Status']
  const rows = employees.map((employee) => [
    employee.name,
    employee.calls,
    employee.connected,
    connectionRate(employee),
    formatTalkTime(employee.talkMinutes),
    employee.followUps,
    employee.status,
  ])

  return [header, ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\n')
}

export function downloadEmployeeCsv(employees: EmployeeRow[]): void {
  const csv = buildEmployeeCsv(employees)
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'callora-team-performance.csv'
  anchor.click()
  URL.revokeObjectURL(url)
}
