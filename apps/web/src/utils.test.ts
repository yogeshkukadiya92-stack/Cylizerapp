import { describe, expect, it } from 'vitest'
import type { EmployeeRow } from './types'
import { buildEmployeeCsv, escapeCsvCell } from './utils'

describe('CSV export safety', () => {
  it.each([
    '=HYPERLINK("https://example.test")',
    '+cmd',
    '-2+3',
    '@SUM(A1:A2)',
    '   =1+1',
    '\t@payload',
  ])('neutralizes a formula-leading cell: %s', (value) => {
    expect(escapeCsvCell(value)).toMatch(/^"'/)
  })

  it('neutralizes employee names and still escapes embedded quotes', () => {
    const employee: EmployeeRow = {
      id: 'emp-export',
      name: '  =HYPERLINK("https://example.test")',
      initials: 'EH',
      color: '#fff',
      calls: 0,
      connected: 0,
      talkMinutes: 0,
      followUps: 0,
      status: 'Offline',
    }

    const csv = buildEmployeeCsv([employee])

    expect(csv).toContain('"\'  =HYPERLINK(""https://example.test"")"')
  })
})
