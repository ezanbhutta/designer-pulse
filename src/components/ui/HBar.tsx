export interface HBarRow {
  label: string
  value: number
  secondary?: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'waiting'
}

export interface HBarProps {
  rows: HBarRow[]
  formatValue?: (v: number) => string
  ariaLabel: string
}

const FILL_CLASS: Record<NonNullable<HBarRow['tone']>, string> = {
  neutral: 'bg-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  waiting: 'bg-muted/50',
}

const defaultFormat = (v: number) => String(Math.round(v))

/**
 * Horizontal bar rows (spec §22.5 — the "Pipeline Bottleneck" form): label
 * left, tabular value right, bar in between. Every value is printed as text,
 * so the bar length and tone are reinforcement, never the only signal
 * (§20.10). Tones map to the shared status semantics (§21.2).
 */
export function HBar({ rows, formatValue = defaultFormat, ariaLabel }: HBarProps) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1

  return (
    <div role="group" aria-label={ariaLabel} className="space-y-1">
      {rows.map((row) => {
        const pct = Math.max(0, Math.min(100, (row.value / max) * 100))
        return (
          <div key={row.label} className="flex items-center gap-3 py-1">
            <div className="w-36 shrink-0 truncate text-sm">
              <span className="text-fg">{row.label}</span>
              {row.secondary && (
                <span className="ml-1.5 text-xs text-muted">{row.secondary}</span>
              )}
            </div>
            <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full transition-[width] duration-200 ease-out ${FILL_CLASS[row.tone ?? 'neutral']}`}
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="tnum w-16 shrink-0 text-right text-sm font-medium text-fg">
              {formatValue(row.value)}
            </div>
          </div>
        )
      })}
      {rows.length === 0 && <p className="py-2 text-sm text-muted">No data yet.</p>}
    </div>
  )
}

export default HBar
