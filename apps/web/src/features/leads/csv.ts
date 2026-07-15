import {
  MAX_LEAD_IMPORT_FILE_NAME_LENGTH,
  MAX_LEAD_IMPORT_ROWS,
  type LeadImportRow,
  type LeadSource,
} from '@callora/contracts'

export const MAX_LEAD_IMPORT_BYTES = 2 * 1024 * 1024

export interface LeadCsvIssue {
  rowNumber?: number
  field?: string
  message: string
}

export interface LeadCsvRow {
  rowNumber: number
  input: LeadImportRow
}

export interface LeadCsvParseResult {
  headers: string[]
  rows: LeadCsvRow[]
  issues: LeadCsvIssue[]
}

const SOURCE_VALUES = new Set<LeadSource>([
  'manual', 'csv_import', 'website', 'facebook', 'instagram', 'google_ads',
  'india_mart', 'api', 'integration', 'unknown',
])

const HEADER_ALIASES: Record<string, keyof LeadImportRow> = {
  firstname: 'firstName',
  first: 'firstName',
  name: 'firstName',
  leadname: 'firstName',
  lastname: 'lastName',
  surname: 'lastName',
  company: 'companyName',
  companyname: 'companyName',
  phone: 'phoneNumber',
  phonenumber: 'phoneNumber',
  mobile: 'phoneNumber',
  mobilenumber: 'phoneNumber',
  alternatephone: 'alternatePhoneNumber',
  alternatephonenumber: 'alternatePhoneNumber',
  email: 'email',
  source: 'source',
  status: 'statusName',
  statusname: 'statusName',
  owner: 'assignedEmployeeCode',
  ownercode: 'assignedEmployeeCode',
  assignedemployee: 'assignedEmployeeCode',
  assignedemployeecode: 'assignedEmployeeCode',
  tags: 'tagNames',
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function emptyImportRow(): LeadImportRow {
  return { firstName: '', phoneNumber: '' }
}

function splitCsv(text: string): { records: string[][]; issues: LeadCsvIssue[] } {
  const records: string[][] = []
  const issues: LeadCsvIssue[] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let closedQuote = false
  let line = 1
  let recordLine = 1

  const finishField = () => {
    record.push(field)
    field = ''
    closedQuote = false
  }
  const finishRecord = () => {
    finishField()
    // A delimiter-only record (for example `,,`) is still a submitted lead row.
    // Keep it for server-side validation while ignoring genuinely blank lines.
    if (record.length > 1 || record.some((value) => value.trim() !== '')) records.push(record)
    record = []
    recordLine = line + 1
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
        closedQuote = true
      } else {
        field += character
        if (character === '\n') line += 1
      }
      continue
    }
    if (closedQuote && character !== ',' && character !== '\n' && character !== '\r' && !/\s/.test(character)) {
      issues.push({ rowNumber: recordLine, message: 'Unexpected text after a closing quote.' })
      field += character
      closedQuote = false
      continue
    }
    if (character === '"') {
      if (field.trim() !== '') {
        issues.push({ rowNumber: recordLine, message: 'A quote must begin at the start of a CSV field.' })
        field += character
      } else {
        field = ''
        quoted = true
      }
    } else if (character === ',') {
      finishField()
    } else if (character === '\n') {
      finishRecord()
      line += 1
    } else if (character === '\r') {
      if (next === '\n') continue
      finishRecord()
      line += 1
    } else {
      field += character
    }
  }

  if (quoted) issues.push({ rowNumber: recordLine, message: 'Quoted field is not closed.' })
  if (field !== '' || record.length > 0) finishRecord()
  return { records, issues }
}

function putValue(row: LeadImportRow, key: keyof LeadImportRow, value: string): void {
  const trimmed = value.trim()
  if (key === 'tagNames') {
    if (trimmed) row.tagNames = trimmed.split(/[;|]/).map((tag) => tag.trim()).filter(Boolean)
    return
  }
  if (key === 'source') {
    const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, '_') as LeadSource
    row.source = SOURCE_VALUES.has(normalized) ? normalized : trimmed as LeadSource
    return
  }
  if (key === 'firstName' || key === 'phoneNumber') {
    row[key] = trimmed
    return
  }
  if (trimmed) {
    Object.assign(row, { [key]: trimmed })
  }
}

export function parseLeadCsvText(text: string, fileName = 'leads.csv'): LeadCsvParseResult {
  const content = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  const { records, issues } = splitCsv(content)
  if (fileName.trim().length === 0 || fileName.length > MAX_LEAD_IMPORT_FILE_NAME_LENGTH) {
    issues.push({ message: `File name must be between 1 and ${MAX_LEAD_IMPORT_FILE_NAME_LENGTH} characters.` })
  }
  const headerRecord = records[0] ?? []
  const headers = headerRecord.map((header) => header.trim())
  if (headers.length === 0) issues.push({ message: 'CSV file must include a header row.' })
  const normalized = headers.map(normalizedHeader)
  const duplicates = normalized.filter((header, index) => header && normalized.indexOf(header) !== index)
  if (duplicates.length > 0) issues.push({ message: `Duplicate CSV header: ${headers[normalized.indexOf(duplicates[0])]}.` })
  const mapped = normalized.map((header) => HEADER_ALIASES[header])
  if (!mapped.includes('firstName')) issues.push({ field: 'firstName', message: 'CSV needs a First name or Lead name column.' })
  if (!mapped.includes('phoneNumber')) issues.push({ field: 'phoneNumber', message: 'CSV needs a Phone column.' })

  const dataRecords = records.slice(1)
  if (dataRecords.length === 0) issues.push({ message: 'CSV file does not contain any lead rows.' })
  if (dataRecords.length > MAX_LEAD_IMPORT_ROWS) {
    issues.push({ message: `CSV contains ${dataRecords.length} rows; the maximum is ${MAX_LEAD_IMPORT_ROWS}.` })
  }

  const rows = dataRecords.slice(0, MAX_LEAD_IMPORT_ROWS).map((values, rowIndex) => {
    const row = emptyImportRow()
    mapped.forEach((key, columnIndex) => {
      if (key) putValue(row, key, values[columnIndex] ?? '')
    })
    if (values.length > headers.length) {
      issues.push({ rowNumber: rowIndex + 2, message: 'Row has more values than the header.' })
    }
    return { rowNumber: rowIndex + 2, input: row }
  })
  return { headers, rows, issues }
}

export async function parseLeadCsvFile(file: File): Promise<LeadCsvParseResult> {
  if (file.size > MAX_LEAD_IMPORT_BYTES) {
    return { headers: [], rows: [], issues: [{ message: `CSV files must be ${MAX_LEAD_IMPORT_BYTES / 1024 / 1024} MB or smaller.` }] }
  }
  if (!file.name.toLowerCase().endsWith('.csv')) {
    return { headers: [], rows: [], issues: [{ message: 'Choose a .csv file.' }] }
  }
  return parseLeadCsvText(await file.text(), file.name)
}
