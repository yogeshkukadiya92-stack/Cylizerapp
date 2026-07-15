import type { ReactNode } from 'react'
import type { AppModule } from '../navigation'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

interface AppShellProps {
  children: ReactNode
  activeModule: AppModule
  displayName: string
  isSidebarOpen: boolean
  onModuleChange: (module: AppModule) => void
  onSidebarClose: () => void
  onSidebarOpen: () => void
  searchQuery: string
  onSearchChange: (value: string) => void
  onSignOut?: () => void
}

export function AppShell({
  children,
  activeModule,
  displayName,
  isSidebarOpen,
  onModuleChange,
  onSidebarClose,
  onSidebarOpen,
  searchQuery,
  onSearchChange,
  onSignOut,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <Sidebar
        activeModule={activeModule}
        isOpen={isSidebarOpen}
        onClose={onSidebarClose}
        onModuleChange={onModuleChange}
      />
      {isSidebarOpen ? (
        <button
          aria-label="Close navigation"
          className="sidebar-backdrop"
          onClick={onSidebarClose}
          type="button"
        />
      ) : null}
      <div className="workspace">
        <TopBar
          displayName={displayName}
          onMenuClick={onSidebarOpen}
          onSearchChange={onSearchChange}
          onSignOut={onSignOut}
          searchQuery={searchQuery}
        />
        <main className="main-content">{children}</main>
      </div>
    </div>
  )
}
