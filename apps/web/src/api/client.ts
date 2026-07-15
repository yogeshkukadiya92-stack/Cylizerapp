import type {
  AdminDeviceRevocationInput,
  AdminDeviceRevocationResult,
  ApplyLeadAssignmentRulesInput,
  ApplyLeadAssignmentRulesResult,
  CompleteFollowUpInput,
  CommitLeadImportInput,
  CorrectCallLeadLinkInput,
  CorrectCallLeadLinkResult,
  CreateLeadAssignmentRuleInput,
  CreateEmployeeInput,
  DashboardSummary,
  Employee,
  EmployeePerformanceRow,
  LeadAssignmentDryRun,
  LeadAssignmentRule,
  LeadImportJob,
  LeadImportPreview,
  LeadImportResult,
  LeadReport,
  LeadReportFilter,
  ReportAutomationSnapshot,
  SavedReportView,
  ReportSchedule,
  NotificationPreference,
  ReportExportJob,
  CreateSavedReportViewInput,
  CreateReportScheduleInput,
  Permission,
  PreviewLeadImportInput,
  UpdateLeadAssignmentRuleInput,
} from '@callora/contracts'
import type {
  CreateLeadFollowUpRequest,
  CreateLeadRequest,
  LeadApiDetail,
  LeadApiListResponse,
  LeadApiUpdateRequest,
  LeadNoteRequest,
  LeadOwnerApiResponse,
  LeadQuery,
  LeadStatusApiResponse,
} from '../features/leads/types'

const DEFAULT_API_URL = 'http://localhost:4100'
const EMPLOYEE_PAGE_SIZE = 50
export const MAX_EMPLOYEE_PAGES = 20

export type DevOrganizationId = 'org_alpha' | 'org_beta'
export type DevRole = 'owner' | 'admin' | 'manager' | 'analyst' | 'employee'
export type DashboardPreset = 'today' | 'yesterday' | 'last_7_days'

export interface DevSessionActor {
  userId: string
  displayName: string
  email: string
  organizationId: string
  organizationName: string
  role: DevRole
  permissions: string[]
}

export interface DevSessionData {
  accessToken: string
  tokenType: 'Bearer'
  expiresAt: string
  actor: DevSessionActor
}

export interface DashboardOverviewData {
  summary: DashboardSummary
  metrics: {
    totalCalls: number
    totalTalkDurationSeconds: number
    connectedCalls: number
    missedCalls: number
    uniqueClients: number
    workingHoursSeconds: number
  }
  hourlyActivity: Array<{
    hour: string
    label: string
    incoming: number
    outgoing: number
  }>
  outcomes: Array<{
    key: string
    label: string
    value: number
    color: string
  }>
  attention: Array<{
    key: 'missed' | 'leads' | 'devices'
    label: string
    value: number
  }>
  teamPerformance: EmployeePerformanceRow[]
  recentActivity: Array<{
    id: string
    kind: 'connected' | 'missed' | 'employee' | 'device'
    title: string
    detail?: string
    occurredAt: string
  }>
}

export interface EmployeeListData {
  items: Employee[]
  cursorInfo: {
    nextCursor?: string
    hasMore: boolean
  }
}

export interface WorkspaceSessionData {
  userId: string
  displayName: string
  email: string
  organizationId: string
  organizationName: string
  role: DevRole
  permissions: Permission[]
}

export interface LeadImportJobListData {
  items: LeadImportJob[]
}

export interface LeadAssignmentRuleListData {
  items: LeadAssignmentRule[]
}

export interface DownloadedFile {
  blob: Blob
  fileName: string
}

interface ApiSuccessEnvelope<T> {
  ok: true
  data: T
  requestId?: string
}

interface ApiFailureEnvelope {
  ok: false
  error: {
    code?: string
    message?: string
  }
  requestId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isApiFailure(value: unknown): value is ApiFailureEnvelope {
  return isRecord(value) && value.ok === false && isRecord(value.error)
}

function isApiSuccess<T>(value: unknown): value is ApiSuccessEnvelope<T> {
  return isRecord(value) && value.ok === true && 'data' in value
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export interface DashboardOverviewQuery {
  preset: DashboardPreset
  employeeId?: string
}

export interface CalloraApiClientOptions {
  baseUrl?: string
  fetcher?: typeof fetch
  authMode?: 'dev' | 'oidc'
  currentOrigin?: string
  isProduction?: boolean
}

function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname)
}

export function resolveApiBaseUrl(
  configuredUrl: string | undefined,
  {
    authMode = 'dev',
    currentOrigin = window.location.origin,
    isProduction = import.meta.env.PROD,
  }: Pick<CalloraApiClientOptions, 'authMode' | 'currentOrigin' | 'isProduction'> = {},
): string {
  const value = configuredUrl?.trim()
  if (!value && (authMode === 'oidc' || isProduction)) {
    throw new ApiRequestError('VITE_API_URL is required for OIDC and production runtimes.', undefined, 'INVALID_API_URL')
  }
  let parsed: URL
  try {
    parsed = new URL(value ?? DEFAULT_API_URL)
  } catch {
    throw new ApiRequestError('VITE_API_URL must be an absolute URL.', undefined, 'INVALID_API_URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiRequestError('VITE_API_URL must use http or https.', undefined, 'INVALID_API_URL')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ApiRequestError(
      'VITE_API_URL cannot contain credentials, query parameters, or a fragment.',
      undefined,
      'INVALID_API_URL',
    )
  }
  const applicationUrl = new URL(currentOrigin)
  const localHttpAllowed = isLocalHostname(applicationUrl.hostname) && isLocalHostname(parsed.hostname)
  if (parsed.protocol !== 'https:' && !localHttpAllowed) {
    throw new ApiRequestError('VITE_API_URL must use HTTPS outside localhost.', undefined, 'INVALID_API_URL')
  }
  return parsed.toString().replace(/\/$/, '')
}

export class CalloraApiClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch

  constructor(options: CalloraApiClientOptions = {}) {
    this.baseUrl = resolveApiBaseUrl(options.baseUrl ?? import.meta.env.VITE_API_URL, options)
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  createDevSession(
    input: { organizationId: DevOrganizationId; role: DevRole },
    signal?: AbortSignal,
  ): Promise<DevSessionData> {
    return this.request('/v1/dev/session', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    })
  }

  getSession(accessToken: string, signal?: AbortSignal): Promise<WorkspaceSessionData> {
    return this.request('/v1/session', { accessToken, signal })
  }

  getDashboardOverview(
    query: DashboardOverviewQuery,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<DashboardOverviewData> {
    const search = new URLSearchParams({ preset: query.preset })
    if (query.employeeId) search.set('employeeId', query.employeeId)
    return this.request(`/v1/dashboard/overview?${search.toString()}`, {
      accessToken,
      signal,
    })
  }

  async getEmployees(accessToken: string, signal?: AbortSignal): Promise<EmployeeListData> {
    const employeesById = new Map<string, Employee>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined

    for (let pageNumber = 0; pageNumber < MAX_EMPLOYEE_PAGES; pageNumber += 1) {
      const search = new URLSearchParams({ limit: String(EMPLOYEE_PAGE_SIZE) })
      if (cursor) search.set('cursor', cursor)
      const page = await this.request<EmployeeListData>(`/v1/employees?${search.toString()}`, {
        accessToken,
        signal,
      })
      page.items.forEach((employee) => employeesById.set(employee.id, employee))

      if (!page.cursorInfo.hasMore) {
        return {
          items: [...employeesById.values()],
          cursorInfo: { hasMore: false },
        }
      }

      const nextCursor = page.cursorInfo.nextCursor
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new ApiRequestError('Employee pagination returned an invalid cursor.')
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    throw new ApiRequestError(`Employee pagination exceeded the ${MAX_EMPLOYEE_PAGES}-page safety limit.`)
  }

  createEmployee(
    input: CreateEmployeeInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<Employee> {
    return this.request('/v1/employees', {
      method: 'POST',
      body: JSON.stringify(input),
      accessToken,
      signal,
    })
  }

  getLeads(
    query: LeadQuery,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadApiListResponse> {
    const search = new URLSearchParams({ limit: String(query.limit ?? 50) })
    if (query.search) search.set('search', query.search)
    if (query.queue && query.queue !== 'all') search.set('queue', query.queue)
    if (query.statusId) search.set('statusId', query.statusId)
    if (query.assignedEmployeeId) search.set('assignedEmployeeId', query.assignedEmployeeId)
    if (query.cursor) search.set('cursor', query.cursor)
    return this.request(`/v1/leads?${search.toString()}`, { accessToken, signal })
  }

  getLeadStatuses(accessToken: string, signal?: AbortSignal): Promise<LeadStatusApiResponse> {
    return this.request('/v1/lead-statuses', { accessToken, signal })
  }

  getLeadOwners(accessToken: string, signal?: AbortSignal): Promise<LeadOwnerApiResponse> {
    return this.request('/v1/lead-owners', { accessToken, signal })
  }

  getLeadDetail(leadId: string, accessToken: string, signal?: AbortSignal): Promise<LeadApiDetail> {
    return this.request(`/v1/leads/${encodeURIComponent(leadId)}`, { accessToken, signal })
  }

  createLead(
    input: CreateLeadRequest,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadApiDetail> {
    return this.request('/v1/leads', {
      method: 'POST',
      body: JSON.stringify(input),
      accessToken,
      signal,
    })
  }

  updateLead(
    leadId: string,
    input: LeadApiUpdateRequest,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadApiDetail> {
    return this.request(`/v1/leads/${encodeURIComponent(leadId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
      accessToken,
      signal,
    })
  }

  addLeadNote(
    leadId: string,
    input: LeadNoteRequest,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadApiDetail> {
    return this.request(`/v1/leads/${encodeURIComponent(leadId)}/notes`, {
      method: 'POST',
      body: JSON.stringify(input),
      accessToken,
      signal,
    })
  }

  createLeadFollowUp(
    leadId: string,
    input: CreateLeadFollowUpRequest,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadApiDetail> {
    return this.request(`/v1/leads/${encodeURIComponent(leadId)}/follow-ups`, {
      method: 'POST',
      body: JSON.stringify(input),
      accessToken,
      signal,
    })
  }

  completeFollowUp(
    followUpId: string,
    input: CompleteFollowUpInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadApiDetail> {
    return this.request(`/v1/follow-ups/${encodeURIComponent(followUpId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(input),
      accessToken,
      signal,
    })
  }

  previewLeadImport(
    input: PreviewLeadImportInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadImportPreview> {
    return this.request('/v1/lead-imports/preview', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': input.requestId },
      accessToken,
      signal,
    })
  }

  getLeadImportJobs(accessToken: string, signal?: AbortSignal): Promise<LeadImportJobListData> {
    return this.request('/v1/lead-imports', { accessToken, signal })
  }

  getLeadImport(jobId: string, accessToken: string, signal?: AbortSignal): Promise<LeadImportPreview> {
    return this.request(`/v1/lead-imports/${encodeURIComponent(jobId)}`, { accessToken, signal })
  }

  commitLeadImport(
    jobId: string,
    input: CommitLeadImportInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadImportResult> {
    return this.request(`/v1/lead-imports/${encodeURIComponent(jobId)}/commit`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': input.requestId },
      accessToken,
      signal,
    })
  }

  downloadLeadImportErrors(
    jobId: string,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<DownloadedFile> {
    return this.requestFile(`/v1/lead-imports/${encodeURIComponent(jobId)}/errors`, {
      accessToken,
      signal,
    }, `${jobId}-errors.csv`)
  }

  getLeadAssignmentRules(accessToken: string, signal?: AbortSignal): Promise<LeadAssignmentRuleListData> {
    return this.request('/v1/lead-assignment-rules', { accessToken, signal })
  }

  createLeadAssignmentRule(
    input: CreateLeadAssignmentRuleInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadAssignmentRule> {
    return this.request('/v1/lead-assignment-rules', {
      method: 'POST',
      body: JSON.stringify(input),
      accessToken,
      signal,
    })
  }

  updateLeadAssignmentRule(
    ruleId: string,
    input: UpdateLeadAssignmentRuleInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadAssignmentRule> {
    return this.request(`/v1/lead-assignment-rules/${encodeURIComponent(ruleId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
      accessToken,
      signal,
    })
  }

  dryRunLeadAssignmentRules(accessToken: string, signal?: AbortSignal): Promise<LeadAssignmentDryRun> {
    return this.request('/v1/lead-assignment-rules/dry-run', {
      method: 'POST',
      body: JSON.stringify({}),
      accessToken,
      signal,
    })
  }

  applyLeadAssignmentRules(
    input: ApplyLeadAssignmentRulesInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<ApplyLeadAssignmentRulesResult> {
    return this.request('/v1/lead-assignment-rules/apply', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': input.requestId },
      accessToken,
      signal,
    })
  }

  correctCallLeadLink(
    callLogId: string,
    input: CorrectCallLeadLinkInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<CorrectCallLeadLinkResult> {
    return this.request(`/v1/calls/${encodeURIComponent(callLogId)}/lead-link/correct`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': input.requestId },
      accessToken,
      signal,
    })
  }

  getLeadReport(
    query: LeadReportFilter,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<LeadReport> {
    const search = new URLSearchParams({ from: query.from, to: query.to })
    if (query.employeeId) search.set('employeeId', query.employeeId)
    if (query.team) search.set('team', query.team)
    if (query.source) search.set('source', query.source)
    return this.request(`/v1/lead-reports?${search.toString()}`, { accessToken, signal })
  }

  getReportAutomation(accessToken: string, signal?: AbortSignal): Promise<ReportAutomationSnapshot> {
    return this.request('/v1/report-automation', { accessToken, signal })
  }

  createSavedReportView(input: CreateSavedReportViewInput, accessToken: string, signal?: AbortSignal): Promise<SavedReportView> {
    return this.request('/v1/report-views', { method: 'POST', body: JSON.stringify(input), accessToken, signal })
  }

  createReportSchedule(input: CreateReportScheduleInput, accessToken: string, signal?: AbortSignal): Promise<ReportSchedule> {
    return this.request('/v1/report-schedules', { method: 'POST', body: JSON.stringify(input), accessToken, signal })
  }

  updateReportSchedule(scheduleId: string, status: ReportSchedule['status'], accessToken: string, signal?: AbortSignal): Promise<ReportSchedule> {
    return this.request(`/v1/report-schedules/${encodeURIComponent(scheduleId)}`, { method: 'PATCH', body: JSON.stringify({ status }), accessToken, signal })
  }

  updateNotificationPreferences(preferences: NotificationPreference[], accessToken: string, signal?: AbortSignal): Promise<{ preferences: NotificationPreference[] }> {
    return this.request('/v1/notification-preferences', { method: 'PUT', body: JSON.stringify({ preferences }), accessToken, signal })
  }

  createReportExport(input: { kind: ReportExportJob['kind']; format: ReportExportJob['format']; parameters?: Record<string, unknown> }, accessToken: string, signal?: AbortSignal): Promise<ReportExportJob> {
    return this.request('/v1/report-exports', { method: 'POST', body: JSON.stringify(input), accessToken, signal })
  }

  revokeDevice(
    deviceId: string,
    input: AdminDeviceRevocationInput,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<AdminDeviceRevocationResult> {
    return this.request(`/v1/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': input.requestId },
      accessToken,
      signal,
    })
  }

  private async request<T>(
    path: string,
    options: RequestInit & { accessToken?: string } = {},
  ): Promise<T> {
    const { accessToken, ...requestOptions } = options
    const headers = new Headers(requestOptions.headers)
    headers.set('Accept', 'application/json')
    if (requestOptions.body !== undefined) headers.set('Content-Type', 'application/json')
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...requestOptions,
      credentials: accessToken ? 'omit' : 'same-origin',
      headers,
    })

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new ApiRequestError('The API returned an unreadable response.', response.status)
    }

    if (isApiFailure(payload)) {
      const message = typeof payload.error.message === 'string'
        ? payload.error.message
        : 'The API request failed.'
      const code = typeof payload.error.code === 'string' ? payload.error.code : undefined
      throw new ApiRequestError(message, response.status, code)
    }

    if (!response.ok) {
      throw new ApiRequestError(`The API request failed with status ${response.status}.`, response.status)
    }

    // The production API uses ApiSuccess envelopes. Accepting a direct body keeps
    // local mocks and incremental backend migrations backwards compatible.
    return isApiSuccess<T>(payload) ? payload.data : payload as T
  }

  private async requestFile(
    path: string,
    options: RequestInit & { accessToken: string },
    fallbackFileName: string,
  ): Promise<DownloadedFile> {
    const { accessToken, ...requestOptions } = options
    const headers = new Headers(requestOptions.headers)
    headers.set('Accept', 'text/csv')
    headers.set('Authorization', `Bearer ${accessToken}`)
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...requestOptions,
      credentials: 'omit',
      headers,
    })
    if (!response.ok) {
      let message = `The download failed with status ${response.status}.`
      try {
        const payload = await response.json() as unknown
        if (isApiFailure(payload) && typeof payload.error.message === 'string') message = payload.error.message
      } catch {
        // A non-JSON error body is intentionally reduced to the status message.
      }
      throw new ApiRequestError(message, response.status)
    }
    const disposition = response.headers.get('Content-Disposition')
    const encodedName = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
    const quotedName = disposition?.match(/filename="([^"]+)"/i)?.[1]
    let fileName = quotedName ?? fallbackFileName
    if (encodedName) {
      try {
        fileName = decodeURIComponent(encodedName)
      } catch {
        fileName = fallbackFileName
      }
    }
    return { blob: await response.blob(), fileName }
  }
}

export const defaultDevSession = {
  organizationId: import.meta.env.VITE_DEV_ORGANIZATION_ID ?? 'org_alpha',
  role: import.meta.env.VITE_DEV_ROLE ?? 'owner',
} satisfies { organizationId: DevOrganizationId; role: DevRole }
