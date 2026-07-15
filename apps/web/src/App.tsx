import { useEffect, useState } from 'react'
import { createRuntimeAuthSession } from './auth/factory'
import type { AuthSession, AuthUserSummary } from './auth/types'
import { useAuth } from './auth/useAuth'
import type { AuthorizationFailure } from './auth/useAuth'
import { AppShell } from './components/AppShell'
import { AuthGate } from './components/AuthGate'
import { DashboardWorkspace } from './components/DashboardWorkspace'
import { ModulePreview } from './components/ModulePreview'
import { LeadsWorkspace } from './features/leads/LeadsWorkspace'
import { ReportsWorkspace } from './features/reports/ReportsWorkspace'
import type { AppModule } from './navigation'

interface DashboardApplicationProps {
  authSession: AuthSession
  authUser: AuthUserSummary
  onAuthenticationFailure: (reason: AuthorizationFailure) => void
  onSignOut: () => void
}

function DashboardApplication({ authSession, authUser, onAuthenticationFailure, onSignOut }: DashboardApplicationProps) {
  const [activeModule, setActiveModule] = useState<AppModule>('Dashboard')
  const [searchQuery, setSearchQuery] = useState('')
  const [isSidebarOpen, setSidebarOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

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

  const changeModule = (module: AppModule) => {
    setActiveModule(module)
    setSearchQuery('')
  }

  return (
    <AppShell
      activeModule={activeModule}
      displayName={authUser.displayName}
      isSidebarOpen={isSidebarOpen}
      onModuleChange={changeModule}
      onSearchChange={setSearchQuery}
      onSignOut={authSession.mode === 'oidc' ? onSignOut : undefined}
      onSidebarClose={() => setSidebarOpen(false)}
      onSidebarOpen={() => setSidebarOpen(true)}
      searchQuery={searchQuery}
    >
      {activeModule === 'Dashboard' ? (
        <DashboardWorkspace
          authSession={authSession}
          onAuthenticationFailure={onAuthenticationFailure}
          onNotify={setToast}
          searchQuery={searchQuery}
        />
      ) : activeModule === 'Leads' ? (
        <LeadsWorkspace
          authSession={authSession}
          onAuthenticationFailure={onAuthenticationFailure}
          onNotify={setToast}
          onSearchChange={setSearchQuery}
          searchQuery={searchQuery}
        />
      ) : activeModule === 'Reports' ? (
        <ReportsWorkspace
          authSession={authSession}
          onAuthenticationFailure={onAuthenticationFailure}
          onNotify={setToast}
          searchQuery={searchQuery}
        />
      ) : (
        <ModulePreview module={activeModule} onBack={() => setActiveModule('Dashboard')} />
      )}
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
