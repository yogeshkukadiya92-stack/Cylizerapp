import { useEffect, useState } from 'react'
import { createRuntimeAuthSession } from './auth/factory'
import type { AuthSession, AuthUserSummary } from './auth/types'
import { useAuth } from './auth/useAuth'
import type { AuthorizationFailure } from './auth/useAuth'
import { AddEmployeeDialog } from './components/AddEmployeeDialog'
import { AppShell } from './components/AppShell'
import { AuthGate } from './components/AuthGate'
import { DashboardPage } from './components/DashboardPage'
import { ModulePreview } from './components/ModulePreview'
import { useDashboardData } from './api/useDashboardData'
import type { AttentionItem, DateRange, EmployeeRow } from './types'

interface DashboardApplicationProps {
  authSession: AuthSession
  authUser: AuthUserSummary
  onAuthenticationFailure: (reason: AuthorizationFailure) => void
  onSignOut: () => void
}

function DashboardApplication({ authSession, authUser, onAuthenticationFailure, onSignOut }: DashboardApplicationProps) {
  const [activeModule, setActiveModule] = useState('Dashboard')
  const [dateRange, setDateRange] = useState<DateRange>('Today')
  const [employeeFilter, setEmployeeFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [isSidebarOpen, setSidebarOpen] = useState(false)
  const [isAddEmployeeOpen, setAddEmployeeOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const {
    addEmployee: addEmployeeToDataSource,
    canManageDevices,
    dashboard,
    dataSource,
    employees,
    revokeDevice: revokeDeviceFromDataSource,
  } = useDashboardData(
    dateRange,
    employeeFilter,
    authSession,
    onAuthenticationFailure,
  )

  useEffect(() => {
    if (!toast) return undefined
    const timeout = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.global-search input')?.focus()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  const addEmployee = async (employee: EmployeeRow): Promise<boolean> => {
    try {
      const result = await addEmployeeToDataSource(employee)
      setToast(result.source === 'live'
        ? `${employee.name} added to your team`
        : `${employee.name} added as a local draft · not synced`)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Please try again.'
      setToast(`Could not add ${employee.name}: ${detail}`)
      return false
    }
  }

  const selectAttentionItem = (item: AttentionItem) => {
    setToast(`${item.value} ${item.label.toLowerCase()} queued for review`)
  }

  const revokeDevice = async (deviceId: string, reason: string): Promise<boolean> => {
    try {
      await revokeDeviceFromDataSource(deviceId, reason)
      setToast('Device revoked, credentials disabled, and consent withdrawn')
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Please try again.'
      setToast(`Could not revoke device: ${detail}`)
      return false
    }
  }

  return (
    <AppShell
      activeModule={activeModule}
      displayName={authUser.displayName}
      isSidebarOpen={isSidebarOpen}
      onModuleChange={setActiveModule}
      onSearchChange={setSearchQuery}
      onSignOut={authSession.mode === 'oidc' ? onSignOut : undefined}
      onSidebarClose={() => setSidebarOpen(false)}
      onSidebarOpen={() => setSidebarOpen(true)}
      searchQuery={searchQuery}
    >
      {activeModule === 'Dashboard' ? (
        <DashboardPage
          canManageDevices={canManageDevices}
          dateRange={dateRange}
          dashboard={dashboard}
          dataSource={dataSource}
          employeeFilter={employeeFilter}
          employees={employees}
          onAddEmployee={() => setAddEmployeeOpen(true)}
          onAttentionSelect={selectAttentionItem}
          onDateRangeChange={setDateRange}
          onEmployeeFilterChange={setEmployeeFilter}
          onRevokeDevice={revokeDevice}
          searchQuery={searchQuery}
        />
      ) : (
        <ModulePreview module={activeModule} onBack={() => setActiveModule('Dashboard')} />
      )}
      <AddEmployeeDialog
        isOpen={isAddEmployeeOpen}
        onAdd={addEmployee}
        onClose={() => setAddEmployeeOpen(false)}
      />
      {toast ? <div aria-live="polite" className="toast">{toast}</div> : null}
    </AppShell>
  )
}

interface AppProps {
  authSession?: AuthSession
}

function App({ authSession: providedAuthSession }: AppProps) {
  const [authSession] = useState(() => providedAuthSession ?? createRuntimeAuthSession())
  const auth = useAuth(authSession)

  if (auth.status !== 'signed_in') {
    return (
      <AuthGate
        canSignIn={auth.canSignIn}
        error={auth.error}
        onSignIn={() => void auth.signIn()}
        status={auth.status}
      />
    )
  }

  return (
    <DashboardApplication
      authSession={authSession}
      authUser={auth.user}
      onAuthenticationFailure={auth.handleAuthorizationFailure}
      onSignOut={() => void auth.signOut()}
    />
  )
}

export default App
