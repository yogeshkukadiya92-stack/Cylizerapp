import { ArrowUpRight } from 'lucide-react'
import type { OutcomeItem } from '../types'

interface OutcomeChartProps {
  outcomes: OutcomeItem[]
}

export function OutcomeChart({ outcomes }: OutcomeChartProps) {
  const total = outcomes.reduce((sum, outcome) => sum + outcome.value, 0)
  let offset = 0
  const stops = outcomes.map((outcome) => {
    const start = total > 0 ? (offset / total) * 100 : 0
    offset += outcome.value
    const end = total > 0 ? (offset / total) * 100 : 0
    return `${outcome.color} ${start}% ${end}%`
  })
  const chartBackground = total > 0 && stops.length > 0
    ? `conic-gradient(${stops.join(',')})`
    : 'conic-gradient(#e8edf2 0% 100%)'

  return (
    <section className="panel outcome-panel">
      <div className="panel-heading">
        <h2>Call outcome distribution</h2>
      </div>
      <div className="donut-row">
        <div className="donut-chart" style={{ background: chartBackground }}>
          <div className="donut-chart__center">
            <strong>{total}</strong>
            <span>Total calls</span>
          </div>
        </div>
        <div className="outcome-list">
          {outcomes.map((outcome) => (
            <div className="outcome-row" key={outcome.label}>
              <span className="outcome-row__label"><i style={{ backgroundColor: outcome.color }} />{outcome.label}</span>
              <strong>{outcome.value}</strong>
              <span>{total > 0 ? ((outcome.value / total) * 100).toFixed(1) : '0.0'}%</span>
            </div>
          ))}
          {outcomes.length === 0 ? <div className="compact-empty" role="status">No call outcomes yet.</div> : null}
        </div>
      </div>
      <button className="text-link" type="button">View full report <ArrowUpRight size={15} /></button>
    </section>
  )
}
