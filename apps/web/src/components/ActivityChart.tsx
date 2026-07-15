import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ActivityPoint } from '../types'

interface ActivityChartProps {
  points: ActivityPoint[]
}

const chartWidth = 720
const chartHeight = 250
const plot = { left: 44, right: 18, top: 18, bottom: 38 }
const maxY = 100

function makeCoordinates(points: ActivityPoint[], key: 'incoming' | 'outgoing') {
  const innerWidth = chartWidth - plot.left - plot.right
  const innerHeight = chartHeight - plot.top - plot.bottom
  return points.map((point, index) => ({
    x: points.length === 1
      ? plot.left + innerWidth / 2
      : plot.left + (index / (points.length - 1)) * innerWidth,
    y: plot.top + innerHeight - (point[key] / maxY) * innerHeight,
    value: point[key],
  }))
}

function smoothPath(coordinates: Array<{ x: number; y: number }>): string {
  if (coordinates.length === 0) return ''
  return coordinates.slice(1).reduce((path, point, index) => {
    const previous = coordinates[index]
    const midpoint = (previous.x + point.x) / 2
    return `${path} C ${midpoint} ${previous.y}, ${midpoint} ${point.y}, ${point.x} ${point.y}`
  }, `M ${coordinates[0].x} ${coordinates[0].y}`)
}

export function ActivityChart({ points }: ActivityChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(3)
  const coordinates = useMemo(
    () => ({
      incoming: makeCoordinates(points, 'incoming'),
      outgoing: makeCoordinates(points, 'outgoing'),
    }),
    [points],
  )
  const activeHoveredIndex = hoveredIndex === null || points.length === 0
    ? null
    : Math.min(hoveredIndex, points.length - 1)
  const hovered = activeHoveredIndex === null ? null : points[activeHoveredIndex]
  const hoveredX = activeHoveredIndex === null ? null : coordinates.incoming[activeHoveredIndex].x

  return (
    <section className="panel activity-chart-panel">
      <div className="panel-heading">
        <div>
          <h2>Call activity (by hour)</h2>
          <div className="chart-legend" aria-label="Chart legend">
            <span><i className="legend-line legend-line--incoming" />Incoming</span>
            <span><i className="legend-line legend-line--outgoing" />Outgoing</span>
          </div>
        </div>
        <button className="select-button select-button--small" type="button">
          By hour <ChevronDown size={15} />
        </button>
      </div>

      {points.length === 0 ? (
        <div className="panel-empty" role="status">No call activity for this period.</div>
      ) : <div className="chart-wrap">
        <svg
          aria-label="Hourly incoming and outgoing call activity"
          className="line-chart"
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        >
          {[0, 20, 40, 60, 80, 100].map((tick) => {
            const y = plot.top + (chartHeight - plot.top - plot.bottom) - (tick / maxY) * (chartHeight - plot.top - plot.bottom)
            return (
              <g key={tick}>
                <line className="chart-grid" x1={plot.left} x2={chartWidth - plot.right} y1={y} y2={y} />
                <text className="chart-axis-label chart-axis-label--y" x={plot.left - 12} y={y + 4}>{tick}</text>
              </g>
            )
          })}
          {hoveredX !== null ? <line className="chart-hover-line" x1={hoveredX} x2={hoveredX} y1={plot.top} y2={chartHeight - plot.bottom} /> : null}
          <path className="activity-line activity-line--incoming" d={smoothPath(coordinates.incoming)} />
          <path className="activity-line activity-line--outgoing" d={smoothPath(coordinates.outgoing)} />
          {coordinates.incoming.map((point, index) => (
            <g key={points[index].label}>
              <circle className="chart-dot chart-dot--incoming" cx={point.x} cy={point.y} r="4" />
              <circle className="chart-dot chart-dot--outgoing" cx={coordinates.outgoing[index].x} cy={coordinates.outgoing[index].y} r="4" />
              <rect
                aria-label={`${points[index].label}: ${points[index].incoming} incoming, ${points[index].outgoing} outgoing`}
                className="chart-hitbox"
                height={chartHeight - plot.top - plot.bottom}
                onFocus={() => setHoveredIndex(index)}
                onMouseEnter={() => setHoveredIndex(index)}
                role="button"
                tabIndex={0}
                width={(chartWidth - plot.left - plot.right) / points.length}
                x={point.x - (chartWidth - plot.left - plot.right) / points.length / 2}
                y={plot.top}
              />
              <text className="chart-axis-label chart-axis-label--x" x={point.x} y={chartHeight - 11}>{points[index].label}</text>
            </g>
          ))}
        </svg>
        {hovered && hoveredX !== null ? (
          <div className="chart-tooltip" style={{ left: `${(hoveredX / chartWidth) * 100}%` }}>
            <strong>{hovered.label}</strong>
            <span><i className="tooltip-dot tooltip-dot--incoming" />Incoming <b>{hovered.incoming}</b></span>
            <span><i className="tooltip-dot tooltip-dot--outgoing" />Outgoing <b>{hovered.outgoing}</b></span>
          </div>
        ) : null}
      </div>}
    </section>
  )
}
