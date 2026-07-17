import { ChevronDown, Menu, Phone, Search } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'

interface TopBarProps {
  displayName: string
  onMenuClick: () => void
  onSignOut?: () => void
  searchQuery: string
  onSearchChange: (value: string) => void
  notificationCenter?: ReactNode
  menuButtonRef?: RefObject<HTMLButtonElement | null>
}

export function TopBar({ displayName, menuButtonRef, onMenuClick, onSignOut, searchQuery, onSearchChange, notificationCenter }: TopBarProps) {
  const firstName = displayName.trim().split(/\s+/)[0] || 'there'
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U'
  return (
    <header className="topbar">
      <div className="topbar__greeting">
        <span className="topbar-mobile-brand"><Phone size={25} strokeWidth={2.2} />Callora</span>
        <button aria-label="Open navigation" className="icon-button menu-button" onClick={onMenuClick} ref={menuButtonRef} type="button">
          <Menu size={22} />
        </button>
        <span>Good morning, {firstName}</span>
      </div>

      <label className="global-search">
        <Search aria-hidden="true" size={19} />
        <span className="sr-only">Search leads or team members</span>
        <input
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search leads or team members"
          type="search"
          value={searchQuery}
        />
        <kbd>⌘ K</kbd>
      </label>

      <div className="topbar__actions">
        {notificationCenter}
        <button
          aria-label={onSignOut ? `Sign out ${displayName}` : 'Open profile menu'}
          className="profile-button"
          onClick={onSignOut}
          title={onSignOut ? 'Sign out' : undefined}
          type="button"
        >
          <span>{initials}</span>
          <ChevronDown size={15} />
        </button>
      </div>
    </header>
  )
}
