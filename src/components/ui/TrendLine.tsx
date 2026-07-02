import type { SparklineProps } from './Sparkline'

export interface TrendPoint {
  label: string
  value: number
}

export interface TrendLineProps {
  points: TrendPoint[]
  baseline?: number | null
  height?: number
  tone?: SparklineProps['tone']
  formatValue?: (v: number) => string
  ariaLabel: string
}

const TONE_CLASS: Record<NonNullable<SparklineProps['tone']>, string> = {
  brand: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-muted',
}

const defaultFormat = (v: number) => String(Math.round(v))

/**
 * Hand-rolled SVG trend chart (spec §22.5): line + soft area fill, the
 * subject's OWN baseline drawn dashed when provided, last point marked with a
 * dot, min/max labelled small and muted. All color via currentColor from
 * semantic token classes. role="img" + ariaLabel make the reading available
 * to assistive tech in one sentence instead of a point firehose.
 */
export function TrendLine({
  points,
  baseline = null,
  height = 96,
  tone = 'brand',
  formatValue = defaultFormat,
  ariaLabel,
}: TrendLineProps) {
  const width = 320
  const padX = 6
  const padY = 12

  if (points.length === 0) {
    return (
      <div
        role="img"
        aria-label={`${ariaLabel} — no data yet`}
        className="flex items-center justify-center rounded-xl bg-surface-2/60 text-xs text-muted"
        style={{ height }}
      >
        No data yet
      </div>
    )
  }

  const values = points.map((p) => p.value)
  const domainValues = baseline != null ? [...values, baseline] : values
  const min = Math.min(...domainValues)
  const max = Math.max(...domainValues)
  const span = max - min || 1
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0

  const xy = (v: number, i: number): [number, number] => [
    padX + (points.length > 1 ? i * stepX : innerW / 2),
    padY + (1 - (v - min) / span) * innerH,
  ]
  const coords = values.map((v, i) => xy(v, i))
  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(2)} ${height - padY} L${coords[0][0].toFixed(2)} ${height - padY} Z`
  const [lastX, lastY] = coords[coords.length - 1]
  const baselineY = baseline != null ? padY + (1 - (baseline - min) / span) * innerH : null

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`h-auto w-full ${TONE_CLASS[tone ?? 'brand']}`}
      role="img"
      aria-label={ariaLabel}
    >
      {/* Soft area fill under the line */}
      <path d={areaPath} fill="currentColor" fillOpacity={0.08} stroke="none" />
      {/* Own-past baseline (spec §22.5) — dashed, muted, never alarming */}
      {baselineY != null && (
        <g className="text-muted">
          <line
            x1={padX}
            x2={width - padX}
            y1={baselineY}
            y2={baselineY}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="4 4"
            strokeOpacity={0.8}
          />
          <text
            x={width - padX}
            y={baselineY - 4}
            textAnchor="end"
            fontSize={10}
            fill="currentColor"
          >
            baseline {formatValue(baseline as number)}
          </text>
        </g>
      )}
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Last point dot — where the trend stands now */}
      <circle cx={lastX} cy={lastY} r={3} fill="currentColor" />
      {/* Min / max labels, small and muted */}
      <g className="text-muted">
        <text x={padX} y={padY - 3} fontSize={10} fill="currentColor">
          {formatValue(max)}
        </text>
        <text x={padX} y={height - 2} fontSize={10} fill="currentColor">
          {formatValue(min)}
        </text>
      </g>
    </svg>
  )
}

export default TrendLine
