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
  // /70 keeps the client-owned bar visibly lighter than solid `neutral`
  // while clearing the 3:1 non-text contrast floor against the track.
  waiting: 'bg-muted/70',
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
          <div key={row.label} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1">
            {/* Full-width line on phones; a fixed column from sm up. The label
                and its explainer truncate separately so neither hides the other. */}
            <div className="w-full min-w-0 text-caption sm:w-56 sm:shrink-0">
              <span className="block truncate text-fg">{row.label}</span>
              {row.secondary && (
                <span className="block truncate text-label normal-case tracking-normal text-muted">
                  {row.secondary}
                </span>
              )}
            </div>
            <div className="h-2 min-w-0 flex-1 basis-24 overflow-hidden rounded-full bg-surface-2">
              {/* Fluid progress (manifesto pillar 10) — the bar never snaps. */}
              <div
                className={`h-full rounded-full transition-[width] duration-500 ease-out ${FILL_CLASS[row.tone ?? 'neutral']}`}
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="tnum w-16 shrink-0 text-right text-caption font-medium text-fg">
              {formatValue(row.value)}
            </div>
          </div>
        )
      })}
      {rows.length === 0 && <p className="py-2 text-caption text-muted">No data yet.</p>}
    </div>
  )
}

export default HBar
