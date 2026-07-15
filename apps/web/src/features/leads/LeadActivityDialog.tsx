import { Clock3, X } from 'lucide-react'
import { AccessibleDialog } from '../../components/AccessibleDialog'
import { LeadTimeline } from './LeadTimeline'
import type { LeadTimelineItem } from './types'

interface LeadActivityDialogProps {
  canCorrectCallLinks: boolean
  leadName: string
  items: LeadTimelineItem[]
  referenceAt: string
  timeZone: string
  onClose: () => void
  onCorrectCallLink: (item: LeadTimelineItem) => void
}

export function LeadActivityDialog({ canCorrectCallLinks, leadName, items, referenceAt, timeZone, onClose, onCorrectCallLink }: LeadActivityDialogProps) {
  return (
    <AccessibleDialog className="lead-activity-dialog" labelledBy="lead-activity-heading" onClose={onClose}>
      <header><div className="dialog__icon"><Clock3 size={21} /></div><div><h2 id="lead-activity-heading">Lead activity</h2><p>{leadName}</p></div><button aria-label="Close lead activity" className="icon-button" onClick={onClose} type="button"><X size={20} /></button></header>
      <LeadTimeline canCorrectCallLinks={canCorrectCallLinks} items={items} onCorrectCallLink={onCorrectCallLink} referenceAt={referenceAt} timeZone={timeZone} />
    </AccessibleDialog>
  )
}
