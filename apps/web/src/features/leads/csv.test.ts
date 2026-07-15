import { MAX_LEAD_IMPORT_ROWS } from '@callora/contracts'
import { describe, expect, it } from 'vitest'
import { parseLeadCsvText } from './csv'

describe('lead CSV parser', () => {
  it('normalizes a UTF-8 BOM, CRLF records and supported header aliases', () => {
    const result = parseLeadCsvText(
      '\uFEFFLead Name,Mobile Number,Company,Tags,Source\r\n  Asha Patel  , +91 98765 43210 , Acme , vip; west ,Google Ads\r\n',
      'contacts.csv',
    )

    expect(result.issues).toEqual([])
    expect(result.rows).toEqual([{
      rowNumber: 2,
      input: {
        firstName: 'Asha Patel',
        phoneNumber: '+91 98765 43210',
        companyName: 'Acme',
        tagNames: ['vip', 'west'],
        source: 'google_ads',
      },
    }])
  })

  it('supports quoted commas, embedded newlines and escaped quotes', () => {
    const result = parseLeadCsvText(
      'First name,Phone,Company\n"Asha, Enterprise\nDesk","+91,98765","North ""Star"" Trading"',
    )

    expect(result.issues).toEqual([])
    expect(result.rows[0].input).toEqual({
      firstName: 'Asha, Enterprise\nDesk',
      phoneNumber: '+91,98765',
      companyName: 'North "Star" Trading',
    })
  })

  it('retains incomplete and delimiter-only rows for authoritative server validation', () => {
    const result = parseLeadCsvText('First name,Phone,Email\nOnly a name,,\n,,')

    expect(result.issues).toEqual([])
    expect(result.rows).toEqual([
      { rowNumber: 2, input: { firstName: 'Only a name', phoneNumber: '' } },
      { rowNumber: 3, input: { firstName: '', phoneNumber: '' } },
    ])
  })

  it('reports malformed quote structure without silently discarding parsed rows', () => {
    const result = parseLeadCsvText('First name,Phone\n"Unclosed,+919876543210')

    expect(result.rows).toHaveLength(1)
    expect(result.issues).toContainEqual({ rowNumber: 2, message: 'Quoted field is not closed.' })
  })

  it('reports duplicate headers and extra values', () => {
    const result = parseLeadCsvText('First name,Phone,phone\nAsha,111,222,extra')

    expect(result.issues).toEqual(expect.arrayContaining([
      { message: 'Duplicate CSV header: Phone.' },
      { rowNumber: 2, message: 'Row has more values than the header.' },
    ]))
  })

  it('bounds the preview payload while reporting the full row count', () => {
    const rows = Array.from({ length: MAX_LEAD_IMPORT_ROWS + 1 }, (_, index) => `Lead ${index},${index}`).join('\n')
    const result = parseLeadCsvText(`First name,Phone\n${rows}`)

    expect(result.rows).toHaveLength(MAX_LEAD_IMPORT_ROWS)
    expect(result.issues).toContainEqual({
      message: `CSV contains ${MAX_LEAD_IMPORT_ROWS + 1} rows; the maximum is ${MAX_LEAD_IMPORT_ROWS}.`,
    })
  })
})
