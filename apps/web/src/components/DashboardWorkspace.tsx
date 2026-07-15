import { useState } from 'react'
import type { AuthSession } from '../auth/types'
import type { AuthorizationFailure } from '../auth/useAuth'
import { useDashboardData } from '../api/useDashboardData'
import type { AttentionItem, DateRange, EmployeeRow } from '../types'
import { AddEmployeeDialog } from './AddEmployeeDialog'
import { DashboardPage } from './DashboardPage'

interface DashboardWorkspaceProps {
  authSession: AuthSession
  onAuthenticationFailure: (reason: AuthorizationFailure) => void
  onNotify: (message: string) => void
  searchQuery: string
}
export function DashboardWorkspace({
  authSession,
  onAuthenticationFailure,
  onNotify,
  searchQuery,
}: DashboardWorkspaceProps) {
  const [dateRange, setDateRange] = useState<DateRange>('Today')
  const [employeeFilter, setEmployeeFilter] = useState('all')
  const [isAddEmployeeOpen, setAddEmployeeOpen] = useState(false)
  const {
    addEmployee: addEmployeeToDataSource,
    canManageDevices,
    dashboard,
    dataSource,
    employees,
    revokeDevice: revokeDeviceFromDataSource,
  } = useDashboardData(dateRange, employeeFilter, authSession, onAuthenticationFailure)

  const addEmployee = async (employee: EmployeeRow): Promise<boolean> => {
    try {
      const result = await addEmployeeToDataSource(employee)
      onNotify(result.source === 'live'
        ? `${employee.name} added to your team`
        : `${employee.name} added as a local draft · not synced`)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Please try again.'
      onNotify(`Could not add ${employee.name}: ${detail}`)
      return false
    }
  }

  const selectAttentionItem = (item: AttentionItem) => {
    onNotify(`${item.value} ${item.label.toLowerCase()} queued for review`)
  }

  const revokeDevice = async (deviceId: string, reason: string): Promise<boolean> => {
    try {
      await revokeDeviceFromDataSource(deviceId, reason)
      onNotify('Device revoked, credentials disabled, and consent withdrawn')
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Please try again.'
      onNotify(`Could not revoke device: ${detail}`)
      return false
    }
  }

  return (
    <>
      <DashboardPage
        canManageDevices={canManageDevices}
        dashboard={dashboard}
        dataSource={dataSource}
        dateRange={dateRange}
        employeeFilter={employeeFilter}
        employees={employees}
        onAddEmployee={() => setAddEmployeeOpen(true)}
        onAttentionSelect={selectAttentionItem}
        onDateRangeChange={setDateRange}
        onEmployeeFilterChange={setEmployeeFilter}
        onRevokeDevice={revokeDevice}
        searchQuery={searchQuery}
      />
      <AddEmployeeDialog
        isOpen={isAddEmployeeOpen}
        onAdd={addEmployee}
        onClose={() => setAddEmployeeOpen(false)}
      />
    </>
  )
}
