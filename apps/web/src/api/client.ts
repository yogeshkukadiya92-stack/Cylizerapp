import type {
  AdminDeviceRevocationInput,
  AdminDeviceRevocationResult,
  CreateEmployeeInput,
  DashboardSummary,
  Employee,
  EmployeePerformanceRow,
  Permission,
} from '@callora/contracts'

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
}

export const defaultDevSession = {
  organizationId: import.meta.env.VITE_DEV_ORGANIZATION_ID ?? 'org_alpha',
  role: import.meta.env.VITE_DEV_ROLE ?? 'owner',
} satisfies { organizationId: DevOrganizationId; role: DevRole }
