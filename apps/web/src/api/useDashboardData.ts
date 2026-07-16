import { useCallback, useEffect, useRef, useState } from 'react'
import type { CreateEmployeeInput } from '@callora/contracts'
import type { DashboardViewData, DataSourceState, DateRange, EmployeeRow } from '../types'
import {
  getDemoDashboard,
  getDemoEmployees,
  getEmptyDashboard,
  mergeEmployeesWithPerformance,
  mergePendingEmployees,
  normalizeDashboardOverview,
  normalizeEmployee,
} from './mappers'
import {
  ApiRequestError,
  CalloraApiClient,
  type DashboardPreset,
} from './client'
import { AuthenticationRequiredError, type AuthSession } from '../auth/types'
import type { AuthorizationFailure } from '../auth/useAuth'

const periodPresets: Record<DateRange, DashboardPreset> = {
  Today: 'today',
  Yesterday: 'yesterday',
  'Last 7 days': 'last_7_days',
}

interface RemoteDashboard {
  key: string
  data: DashboardViewData
}

export interface AddEmployeeResult {
  employee: EmployeeRow
  source: 'live' | 'local'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The live API is unavailable.'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function authorizationFailure(error: unknown): AuthorizationFailure | null {
  if (error instanceof AuthenticationRequiredError) return 'unauthenticated'
  if (!(error instanceof ApiRequestError)) return null
  if (error.status === 401 || error.code === 'UNAUTHENTICATED') return 'unauthenticated'
  if (error.status === 403 || error.code === 'FORBIDDEN') return 'forbidden'
  return null
}

export function useDashboardData(
  dateRange: DateRange,
  employeeFilter: string,
  authSession: AuthSession,
  onAuthenticationFailure?: (reason: AuthorizationFailure) => void,
) {
  const [client] = useState(() => new CalloraApiClient({ authMode: authSession.mode }))
  const [remoteDashboard, setRemoteDashboard] = useState<RemoteDashboard | null>(null)
  const [employees, setEmployees] = useState<EmployeeRow[]>([])
  const [canManageDevices, setCanManageDevices] = useState(false)
  const [dataSource, setDataSource] = useState<DataSourceState>({ status: 'loading', error: null })
  const localEmployeesRef = useRef(new Map<string, EmployeeRow>())
  const mutationControllersRef = useRef(new Set<AbortController>())
  const requestVersionRef = useRef(0)
  const preset = periodPresets[dateRange]
  const dashboardKey = `${preset}:${employeeFilter}`

  useEffect(() => {
    const controller = new AbortController()
    const requestVersion = ++requestVersionRef.current
    const selectedEmployeeId = employeeFilter === 'all' ? undefined : employeeFilter

    setDataSource({ status: 'loading', error: null })

    const load = async () => {
      try {
        const accessToken = await authSession.getAccessToken(controller.signal)
        if (!accessToken) throw new AuthenticationRequiredError()

        const [overview, employeeList] = await Promise.all([
          client.getDashboardOverview({ preset, employeeId: selectedEmployeeId }, accessToken, controller.signal),
          client.getEmployees(accessToken, controller.signal),
        ])

        let hasDeviceManagementPermission = false
        if (employeeList.items.some((employee) => employee.deviceIds.length > 0)) {
          try {
            const workspaceSession = await client.getSession(accessToken, controller.signal)
            hasDeviceManagementPermission = workspaceSession.permissions.includes('devices.manage')
          } catch (error) {
            const failure = authorizationFailure(error)
            if (failure === 'unauthenticated') throw error
            // Capability discovery fails closed without hiding otherwise healthy dashboard data.
          }
        }

        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) return
        const remoteEmployees = mergeEmployeesWithPerformance(employeeList.items, overview.teamPerformance ?? [])
        setEmployees(mergePendingEmployees(remoteEmployees, [...localEmployeesRef.current.values()]))
        setRemoteDashboard({ key: dashboardKey, data: normalizeDashboardOverview(overview, dateRange) })
        setCanManageDevices(hasDeviceManagementPermission)
        setDataSource({ status: 'live', error: null })
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        if (requestVersion !== requestVersionRef.current) return
        const failure = authorizationFailure(error)
        if (authSession.mode !== 'dev') {
          onAuthenticationFailure?.(failure ?? 'service_unavailable')
          return
        }
        setRemoteDashboard(null)
        setCanManageDevices(false)
        setEmployees(mergePendingEmployees(
          getDemoEmployees().map((employee) => ({ ...employee, isLocalOnly: false })),
          [...localEmployeesRef.current.values()],
        ))
        setDataSource({ status: 'demo', error: errorMessage(error) })
      }
    }

    void load()
    return () => controller.abort()
  }, [authSession, client, dashboardKey, dateRange, employeeFilter, onAuthenticationFailure, preset])

  useEffect(() => () => {
    mutationControllersRef.current.forEach((controller) => controller.abort())
    mutationControllersRef.current.clear()
  }, [])

  const addEmployee = useCallback(async (employee: EmployeeRow): Promise<AddEmployeeResult> => {
    if (dataSource.status !== 'live') {
      if (authSession.mode !== 'dev') {
        throw new Error('Live employee onboarding is not ready. No employee data was saved.')
      }
      const localEmployee = { ...employee, isLocalOnly: true }
      localEmployeesRef.current.set(localEmployee.id, localEmployee)
      setEmployees((current) => [...current, localEmployee])
      return { employee: localEmployee, source: 'local' }
    }
    const controller = new AbortController()
    mutationControllersRef.current.add(controller)
    try {
      const accessToken = await authSession.getAccessToken(controller.signal)
      if (!accessToken) throw new AuthenticationRequiredError()
      const input: CreateEmployeeInput = {
        displayName: employee.name,
        primaryPhone: employee.primaryPhone,
      }
      const created = await client.createEmployee(input, accessToken, controller.signal)
      if (controller.signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
      const remoteEmployee = normalizeEmployee(created)
      setEmployees((current) => current.some((item) => item.id === remoteEmployee.id)
        ? current.map((item) => item.id === remoteEmployee.id ? remoteEmployee : item)
        : [...current, remoteEmployee])
      return { employee: remoteEmployee, source: 'live' }
    } catch (error) {
      const failure = authorizationFailure(error)
      if (authSession.mode === 'oidc' && failure) onAuthenticationFailure?.(failure)
      throw error
    } finally {
      mutationControllersRef.current.delete(controller)
    }
  }, [authSession, client, dataSource.status, onAuthenticationFailure])

  const revokeDevice = useCallback(async (deviceId: string, reason: string): Promise<boolean> => {
    if (dataSource.status !== 'live' || !canManageDevices) {
      throw new Error('Live administrator device recovery is not available for this session.')
    }
    if (!globalThis.crypto?.randomUUID) {
      throw new Error('Secure device-recovery request IDs are unavailable in this browser.')
    }
    const controller = new AbortController()
    mutationControllersRef.current.add(controller)
    try {
      const accessToken = await authSession.getAccessToken(controller.signal)
      if (!accessToken) throw new AuthenticationRequiredError()
      const requestId = globalThis.crypto.randomUUID()
      await client.revokeDevice(deviceId, { requestId, reason }, accessToken, controller.signal)
      if (controller.signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
      setEmployees((current) => current.map((employee) => employee.deviceIds?.includes(deviceId)
        ? { ...employee, deviceIds: employee.deviceIds.filter((id) => id !== deviceId) }
        : employee))
      return true
    } catch (error) {
      const failure = authorizationFailure(error)
      if (failure === 'unauthenticated') onAuthenticationFailure?.(failure)
      throw error
    } finally {
      mutationControllersRef.current.delete(controller)
    }
  }, [authSession, canManageDevices, client, dataSource.status, onAuthenticationFailure])

  const hasCurrentRemoteData = remoteDashboard?.key === dashboardKey
  const dashboard = hasCurrentRemoteData
    ? remoteDashboard.data
    : dataSource.status === 'demo'
      ? getDemoDashboard(dateRange)
      : getEmptyDashboard(dateRange)
  const visibleDataSource: DataSourceState = hasCurrentRemoteData || dataSource.status === 'demo'
    ? dataSource
    : { status: 'loading', error: null }

  return {
    addEmployee,
    canManageDevices,
    dashboard,
    dataSource: visibleDataSource,
    employees,
    revokeDevice,
  }
}
