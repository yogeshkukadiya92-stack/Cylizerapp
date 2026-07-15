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

const navItems = [
  { label: 'Dashboard', icon: Gauge },
  { label: 'Team', icon: UsersRound },
  { label: 'Call logs', icon: Phone },
  { label: 'Leads', icon: ContactRound },
  { label: 'Reports', icon: BarChart3 },
  { label: 'Recordings', icon: Waves },
  { label: 'Integrations', icon: Link2 },
  { label: 'Settings', icon: Settings },
]

interface SidebarProps {
  activeModule: string
  isOpen: boolean
  onClose: () => void
  onModuleChange: (module: string) => void
}

export function Sidebar({ activeModule, isOpen, onClose, onModuleChange }: SidebarProps) {
  return (
    <aside className={`sidebar ${isOpen ? 'sidebar--open' : ''}`}>
      <div className="brand-row">
        <div aria-hidden="true" className="brand-mark">
          <Phone size={23} strokeWidth={2.5} />
        </div>
        <span className="brand-name">Callora</span>
        <button aria-label="Close navigation" className="icon-button sidebar-close" onClick={onClose} type="button">
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
