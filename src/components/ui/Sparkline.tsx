export interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'muted'
}

const TONE_CLASS: Record<NonNullable<SparklineProps['tone']>, string> = {
  brand: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-muted',
}

/**
 * Hand-rolled SVG micro-trend (spec §22.5): at-a-glance context ONLY — never
 * a metric the user must judge, so it carries no axes, no labels, and is
 * hidden from assistive tech. Color comes from currentColor via a semantic
 * text-* token class; no raw values anywhere.
 */
export function Sparkline({ data, width = 120, height = 32, tone = 'muted' }: SparklineProps) {
  if (data.length < 2) return null

  const pad = 2
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const stepX = (width - pad * 2) / (data.length - 1)
  const points = data
    .map((v, i) => {
      const x = pad + i * stepX
      const y = pad + (1 - (v - min) / span) * (height - pad * 2)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={TONE_CLASS[tone]}
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default Sparkline
