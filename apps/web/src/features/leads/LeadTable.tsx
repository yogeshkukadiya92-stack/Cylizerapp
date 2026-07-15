import { MoreVertical } from 'lucide-react'
import { formatLeadDate, formatLeadPhone, leadSourceLabel } from './formatters'
import { LeadStatusBadge } from './LeadStatusBadge'
import type { LeadListItemView } from './types'

interface LeadTableProps {
  leads: LeadListItemView[]
  referenceAt: string
  selectedLeadId: string | null
  timeZone: string
  total: number
  onSelect: (leadId: string) => void
}
export function LeadTable({ leads, referenceAt, selectedLeadId, timeZone, total, onSelect }: LeadTableProps) {
  return (
    <section aria-label="Lead list" className="lead-table-panel">
      <div className="lead-table-scroll">
        <table className="lead-table">
          <thead>
            <tr>
              <th aria-label="Selected lead" />
              <th>Lead</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Last contact</th>
              <th>Next follow-up</th>
              <th>Source</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {leads.length > 0 ? leads.map((lead) => {
              const isSelected = selectedLeadId === lead.id
              return (
                <tr aria-selected={isSelected} className={isSelected ? 'lead-row--selected' : ''} key={lead.id}>
                  <td className="lead-select-cell">
                    <button
                      aria-checked={isSelected}
                      aria-label={`Select ${lead.displayName}`}
                      className="lead-row-check"
                      onClick={() => onSelect(lead.id)}
                      role="checkbox"
                      type="button"
                    >
                      {isSelected ? '✓' : null}
                    </button>
                  </td>
                  <td className="lead-name-cell">
                    <button className="lead-name-button" onClick={() => onSelect(lead.id)} type="button">
                      <strong>{lead.displayName}</strong>
                      <span>{formatLeadPhone(lead.phoneNumber)}</span>
                      {lead.isLocalDraft ? <small>Local draft · not synced</small> : null}
                    </button>
                  </td>
                  <td className="lead-status-cell"><LeadStatusBadge color={lead.statusColor} name={lead.statusName} /></td>
                  <td className="lead-owner-cell">{lead.assignedEmployeeName ?? 'Unassigned'}</td>
                  <td className="lead-last-contact-cell">{formatLeadDate(lead.lastContactedAt, referenceAt, timeZone)}</td>
                  <td className="lead-follow-up-cell">
                    <span className={lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) < new Date(referenceAt) ? 'text-danger' : ''}>
                      {formatLeadDate(lead.nextFollowUpAt, referenceAt, timeZone)}
                    </span>
                  </td>
                  <td className="lead-source-cell">{leadSourceLabel(lead.source)}</td>
                  <td className="lead-more-cell">
                    <button aria-label={`Open ${lead.displayName}`} className="icon-button lead-more-button" onClick={() => onSelect(lead.id)} type="button">
                      <MoreVertical size={18} />
                    </button>
                  </td>
                </tr>
              )
            }) : (
              <tr>
                <td className="empty-table" colSpan={8}>No leads match these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="lead-table-footer">
        <span>Showing {leads.length === 0 ? 0 : 1} to {leads.length} of {total} leads</span>
        <div aria-label="Lead list pagination" className="lead-pagination">
          <button aria-label="Previous page" disabled type="button">‹</button>
          <button aria-current="page" type="button">1</button>
          <button aria-label="Next page" disabled type="button">›</button>
        </div>
      </footer>
    </section>
  )
}
