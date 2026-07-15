import { CalendarDays, ChevronDown, Menu, Phone, Search } from 'lucide-react'
import type { ReactNode } from 'react'

interface TopBarProps {
  displayName: string
  onMenuClick: () => void
  onSignOut?: () => void
  searchQuery: string
  onSearchChange: (value: string) => void
  notificationCenter?: ReactNode
}

export function TopBar({ displayName, onMenuClick, onSignOut, searchQuery, onSearchChange, notificationCenter }: TopBarProps) {
  const firstName = displayName.trim().split(/\s+/)[0] || 'there'
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U'
  return (
    <header className="topbar">
      <div className="topbar__greeting">
        <span className="topbar-mobile-brand"><Phone size={25} strokeWidth={2.2} />Callora</span>
        <button aria-label="Open navigation" className="icon-button menu-button" onClick={onMenuClick} type="button">
          <Menu size={22} />
        </button>
        <span>Good morning, {firstName}</span>
      </div>

      <label className="global-search">
        <Search aria-hidden="true" size={19} />
        <span className="sr-only">Search calls, leads or team</span>
        <input
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search calls, leads or team"
          type="search"
          value={searchQuery}
        />
        <kbd>⌘ K</kbd>
      </label>

      <div className="topbar__actions">
        <button className="date-button" type="button">
          <CalendarDays size={18} />
          <span>14 Jul 2026</span>
          <ChevronDown size={15} />
        </button>
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
