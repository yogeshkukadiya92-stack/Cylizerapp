import type { CSSProperties } from 'react'

interface LeadStatusBadgeProps {
  color: string
  name: string
}
export function LeadStatusBadge({ color, name }: LeadStatusBadgeProps) {
  return (
    <span className="lead-status-badge" style={{ '--lead-status-color': color } as CSSProperties}>
      <i aria-hidden="true" />{name}
    </span>
  )
}
