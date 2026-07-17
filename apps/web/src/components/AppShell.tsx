import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  notificationCenter?: ReactNode
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
  notificationCenter,
}: AppShellProps) {
  const [isCompact, setCompact] = useState(() => globalThis.matchMedia?.('(max-width: 980px)').matches ?? false)
  const sidebarRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const media = globalThis.matchMedia?.('(max-width: 980px)')
    if (!media) return undefined
    const update = () => setCompact(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!isCompact) return undefined
    if (isSidebarOpen) {
      wasOpenRef.current = true
      closeButtonRef.current?.focus()
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false
      menuButtonRef.current?.focus()
    }
    return undefined
  }, [isCompact, isSidebarOpen])

  useEffect(() => {
    if (!isCompact || !isSidebarOpen) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onSidebarClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(sidebarRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isCompact, isSidebarOpen, onSidebarClose])

  return (
    <div className="app-shell">
      <Sidebar
        activeModule={activeModule}
        isOpen={isSidebarOpen}
        isCompact={isCompact}
        closeButtonRef={closeButtonRef}
        onClose={onSidebarClose}
        onModuleChange={onModuleChange}
        sidebarRef={sidebarRef}
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
          menuButtonRef={menuButtonRef}
          onMenuClick={onSidebarOpen}
          onSearchChange={onSearchChange}
          onSignOut={onSignOut}
          searchQuery={searchQuery}
          notificationCenter={notificationCenter}
        />
        <main className="main-content">{children}</main>
      </div>
    </div>
  )
}
