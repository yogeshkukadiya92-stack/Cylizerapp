import {
  CalendarCheck2,
  Link2,
  NotebookPen,
  PhoneMissed,
  Tag,
  Unlink,
  UserRoundCheck,
} from 'lucide-react'
import { formatLeadDate } from './formatters'
import type { LeadTimelineItem } from './types'

interface LeadTimelineProps {
  canCorrectCallLinks: boolean
  items: LeadTimelineItem[]
  referenceAt: string
  timeZone: string
  onCorrectCallLink: (item: LeadTimelineItem) => void
}

function TimelineIcon({ kind }: { kind: LeadTimelineItem['kind'] }) {
  if (kind === 'missed_call') return <PhoneMissed size={17} />
  if (kind === 'call_linked') return <Link2 size={17} />
  if (kind === 'call_unlinked') return <Unlink size={17} />
  if (kind === 'follow_up_created' || kind === 'follow_up_completed') return <CalendarCheck2 size={17} />
  if (kind === 'status_changed') return <Tag size={17} />
  if (kind === 'note_added') return <NotebookPen size={17} />
  return <UserRoundCheck size={17} />
}

export function LeadTimeline({ canCorrectCallLinks, items, referenceAt, timeZone, onCorrectCallLink }: LeadTimelineProps) {
  return (
    <div className="lead-timeline" role="list">
      {items.length > 0 ? [...items].sort((left, right) => (
        new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()
      )).map((item) => (
        <div className={`lead-timeline-item lead-timeline-item--${item.kind}`} key={item.id} role="listitem">
          <span className="lead-timeline-icon"><TimelineIcon kind={item.kind} /></span>
          <div>
            <strong>{item.summary}</strong>
            {item.detail ? <p>“{item.detail}”</p> : null}
            <time dateTime={item.occurredAt}>{formatLeadDate(item.occurredAt, referenceAt, timeZone)}</time>
            {item.isLocalDraft ? <small>Local draft</small> : null}
            {canCorrectCallLinks && item.kind === 'call_linked' && item.callLogId ? (
              <button className="lead-correct-link-button" onClick={() => onCorrectCallLink(item)} type="button">Correct link</button>
            ) : null}
          </div>
          <span className="lead-timeline-actor">by {item.actorName ?? 'System'}</span>
        </div>
      )) : <div className="compact-empty">No timeline activity yet.</div>}
    </div>
  )
}
