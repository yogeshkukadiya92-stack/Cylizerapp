import {
  BarChart3,
  ContactRound,
  Gauge,
  Headphones,
  Link2,
  Phone,
  Settings,
  UsersRound,
  Waves,
  X,
} from 'lucide-react'
import type { AppModule } from '../navigation'
import type { RefObject } from 'react'

const navItems: Array<{ label: AppModule; icon: typeof Gauge }> = [
  { label: 'Dashboard', icon: Gauge },
  { label: 'Leads', icon: ContactRound },
  { label: 'Reports', icon: BarChart3 },
]

const plannedItems: Array<{ label: AppModule; icon: typeof Gauge }> = [
  { label: 'Team', icon: UsersRound },
  { label: 'Call logs', icon: Phone },
  { label: 'Recordings', icon: Waves },
  { label: 'Integrations', icon: Link2 },
  { label: 'Settings', icon: Settings },
]

interface SidebarProps {
  activeModule: AppModule
  isOpen: boolean
  onClose: () => void
  onModuleChange: (module: AppModule) => void
  sidebarRef?: RefObject<HTMLElement | null>
  closeButtonRef?: RefObject<HTMLButtonElement | null>
  isCompact?: boolean
}

export function Sidebar({ activeModule, closeButtonRef, isCompact = false, isOpen, onClose, onModuleChange, sidebarRef }: SidebarProps) {
  return (
    <aside aria-hidden={isCompact && !isOpen ? true : undefined} className={`sidebar ${isOpen ? 'sidebar--open' : ''}`} inert={isCompact && !isOpen ? true : undefined} ref={sidebarRef}>
      <div className="brand-row">
        <div aria-hidden="true" className="brand-mark">
          <Phone size={23} strokeWidth={2.5} />
        </div>
        <span className="brand-name">Callora</span>
        <button aria-label="Close navigation" className="icon-button sidebar-close" onClick={onClose} ref={closeButtonRef} type="button">
          <X size={20} />
        </button>
      </div>

      <nav aria-label="Primary navigation" className="sidebar-nav">
        {navItems.map(({ label, icon: Icon }) => {
          const isActive = activeModule === label
          return (
            <button
              aria-current={isActive ? 'page' : undefined}
              className={`nav-item ${isActive ? 'nav-item--active' : ''}`}
              key={label}
              onClick={() => {
                onModuleChange(label)
                onClose()
              }}
              type="button"
            >
              <Icon aria-hidden="true" size={21} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-coming-soon" aria-label="Features coming soon">
        <span className="sidebar-section-label">Coming soon</span>
        {plannedItems.map(({ label, icon: Icon }) => (
          <div className="nav-item nav-item--planned" key={label}>
            <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
            <span>{label}</span><small>Soon</small>
          </div>
        ))}
      </div>

      <div className="plan-card">
        <div className="plan-card__icon" aria-hidden="true">
          <Headphones size={20} />
        </div>
        <div>
          <span className="plan-card__label">Your plan</span>
          <strong>Growth Plan</strong>
          <button type="button">Manage</button>
        </div>
      </div>
    </aside>
  )
}
