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
 * dot. All color via currentColor from semantic token classes. The min / max /
 * baseline labels live in HTML OUTSIDE the scaling SVG so they keep their
 * 10px size at every container width (SVG text would scale with the chart).
 * role="img" + ariaLabel make the reading available to assistive tech in one
 * sentence instead of a point firehose.
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
        aria-label={`${ariaLabel}. There is no data yet.`}
        className="flex items-center justify-center rounded-xl bg-surface-2/60 text-caption text-muted"
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
  const single = points.length === 1

  const xy = (v: number, i: number): [number, number] => [
    padX + (points.length > 1 ? i * stepX : innerW / 2),
    padY + (1 - (v - min) / span) * innerH,
  ]
  const coords = values.map((v, i) => xy(v, i))
  const linePath = single
    ? // One data point: a short level segment through the dot, so a lone week
      // reads as "flat so far", not a floating speck.
      `M${(padX + innerW * 0.35).toFixed(2)} ${coords[0][1].toFixed(2)} L${(padX + innerW * 0.65).toFixed(2)} ${coords[0][1].toFixed(2)}`
    : coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  const areaPath = single
    ? null
    : `${linePath} L${coords[coords.length - 1][0].toFixed(2)} ${height - padY} L${coords[0][0].toFixed(2)} ${height - padY} Z`
  const [lastX, lastY] = coords[coords.length - 1]
  const baselineY = baseline != null ? padY + (1 - (baseline - min) / span) * innerH : null

  return (
    <div>
      <div role="img" aria-label={ariaLabel} className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className={`h-auto w-full ${TONE_CLASS[tone ?? 'brand']}`}
          aria-hidden="true"
          focusable="false"
        >
          {/* Soft area fill under the line */}
          {areaPath && <path d={areaPath} fill="currentColor" fillOpacity={0.08} stroke="none" />}
          {/* Own-past baseline (spec §22.5) — dashed, muted, never alarming */}
          {baselineY != null && (
            <line
              className="text-muted"
              x1={padX}
              x2={width - padX}
              y1={baselineY}
              y2={baselineY}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray="4 4"
              strokeOpacity={0.8}
            />
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
        </svg>

        {/* Min / max / baseline labels — HTML so they never scale with the SVG.
            Soft surface halos keep them readable where the line crosses. */}
        <span className="tnum absolute left-1 top-0 rounded bg-surface/80 px-1 text-label normal-case leading-tight tracking-normal text-muted">
          {formatValue(max)}
        </span>
        {max !== min && (
          <span className="tnum absolute bottom-0 left-1 rounded bg-surface/80 px-1 text-label normal-case leading-tight tracking-normal text-muted">
            {formatValue(min)}
          </span>
        )}
        {baselineY != null && (
          <span
            className="tnum absolute right-1 -translate-y-full rounded bg-surface/80 px-1 text-label normal-case leading-tight tracking-normal text-muted"
            style={{ top: `${(baselineY / height) * 100}%` }}
          >
            baseline {formatValue(baseline as number)}
          </span>
        )}
      </div>
      {single && (
        <p className="mt-1.5 text-caption text-muted">
          There is only one week of data so far. The line will fill in as more weeks pass.
        </p>
      )}
    </div>
  )
}

export default TrendLine
