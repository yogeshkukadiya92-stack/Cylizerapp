import { ChevronRight } from 'lucide-react'
import type { AttentionItem } from '../types'

interface AttentionPanelProps {
  items: AttentionItem[]
  onSelect: (item: AttentionItem) => void
}

export function AttentionPanel({ items, onSelect }: AttentionPanelProps) {
  return (
    <section className="panel attention-panel">
      <div className="panel-heading">
        <h2>Needs attention</h2>
      </div>
      <div className="attention-list">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <button className="attention-item" key={item.id} onClick={() => onSelect(item)} type="button">
              <span className={`attention-item__icon tone-${item.tone}`}><Icon size={19} /></span>
              <span className="attention-item__body">
                <span>{item.label}</span>
                <b>View list</b>
              </span>
              <strong className={`text-${item.tone}`}>{item.value}</strong>
              <ChevronRight aria-hidden="true" size={17} />
            </button>
          )
        })}
      </div>
    </section>
  )
}
