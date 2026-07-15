import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import type { DashboardMetric } from '../types'

interface MetricCardProps {
  metric: DashboardMetric
}

export function MetricCard({ metric }: MetricCardProps) {
  const Icon = metric.icon
  const TrendIcon = metric.trend === null || metric.trend >= 0 ? ArrowUpRight : ArrowDownRight

  return (
    <article className="metric-card">
      <div className={`metric-card__icon tone-${metric.tone}`}>
        <Icon size={20} strokeWidth={1.9} />
      </div>
      <div className="metric-card__content">
        <span>{metric.label}</span>
        <strong>{metric.value}</strong>
        {metric.trend === null ? (
          <div className="metric-card__trend metric-card__trend--unavailable">
            <span>No comparison available</span>
          </div>
        ) : (
          <div className={`metric-card__trend ${metric.trend < 0 ? 'metric-card__trend--danger' : ''}`}>
            <TrendIcon aria-hidden="true" size={15} />
            <b>{Math.abs(metric.trend)}%</b>
            <span>{metric.comparison}</span>
          </div>
        )}
      </div>
    </article>
  )
}
