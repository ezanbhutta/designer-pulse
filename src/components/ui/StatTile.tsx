import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { CircleCheck, Eye, TriangleAlert } from 'lucide-react'
import { Badge, type BadgeProps } from './Badge'
import { CountUp } from './CountUp'
import { DeltaChip } from './DeltaChip'
import { InfoTip } from './InfoTip'
import { Sparkline } from './Sparkline'

export interface StatTileProps {
  eyebrow: string
  /** Plain-language ⓘ explainer — rendered OUTSIDE the truncating label so the icon never clips. */
  tip?: string
  icon?: LucideIcon
  value: string
  /** Optional custom value display (e.g. an <AnimatedCounter/>).
   *  `value` still provides the accessible text and drill-down label. */
  children?: ReactNode
  delta?: { label: string; direction: 'up' | 'down' | 'flat'; good: boolean } | null
  cause?: string | null // plain-language cause (§20.2)
  reference?: string | null // e.g. "team median 82%" (§22.5)
  state?: 'ok' | 'watch' | 'flag' | null // threshold flag
  sparkline?: number[]
  onClick?: () => void
  loading?: boolean
}

const STATE_META: Record<
  NonNullable<StatTileProps['state']>,
  { icon: LucideIcon; tone: BadgeProps['tone']; label: string }
> = {
  ok: { icon: CircleCheck, tone: 'success', label: 'On track' },
  watch: { icon: Eye, tone: 'warning', label: 'Watch' },
  flag: { icon: TriangleAlert, tone: 'danger', label: 'Flag' },
}

/**
 * The tile value is a display string ("82%", "3h 20m", "4 of 6"); animate the
 * numeric core via CountUp and keep prefix/suffix as-is, so counts settle
 * calmly on genuine change (§21.7) without giving up formatted values.
 */
function AnimatedValue({ value }: { value: string }) {
  const m = /-?\d+(?:\.\d+)?/.exec(value)
  if (!m) return <span>{value}</span>
  const num = Number(m[0])
  if (!Number.isFinite(num)) return <span>{value}</span>
  const decimals = (m[0].split('.')[1] ?? '').length
  const prefix = value.slice(0, m.index)
  const suffix = value.slice(m.index + m[0].length)
  return <CountUp value={num} format={(v) => `${prefix}${v.toFixed(decimals)}${suffix}`} />
}

/**
 * Structural metric tile (manifesto pillar 4): eyebrow anchored top-left,
 * state badge top-right, then the massive tabular value tracked at -0.03em on
 * a clean baseline with its delta. The number never travels alone (§20.2) —
 * delta vs prior period, plain-language cause, and a reference point (team
 * median) ship inline. With onClick the whole tile is a tactile drill-down
 * button. h-full keeps tiles in one grid row bottom-aligned.
 */
export function StatTile({
  eyebrow,
  tip,
  icon: Icon,
  value,
  children,
  delta,
  cause,
  reference,
  state,
  sparkline,
  onClick,
  loading,
}: StatTileProps) {
  if (loading) {
    // Mirrors the loaded layout exactly — nothing shifts when data lands.
    return (
      <div className="card h-full p-5" role="status" aria-label={`${eyebrow} — loading`}>
        <div className="mb-4 flex items-center justify-between">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-5 w-14 rounded-full" />
        </div>
        <div className="skeleton h-8 w-24" />
        <div className="skeleton mt-3 h-3.5 w-4/5" />
        <div className="skeleton mt-1.5 h-3 w-1/2" />
      </div>
    )
  }

  const stateMeta = state ? STATE_META[state] : null

  const body: ReactNode = (
    <>
      {/* Eyebrow row: anchored top-left, badge aligned top-right. */}
      <div className="mb-4 flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
          <span className="eyebrow truncate">{eyebrow}</span>
          {/* Outside the truncating span (and shrink-0) so it always survives. */}
          {tip && <InfoTip text={tip} />}
        </span>
        {stateMeta && (
          <Badge tone={stateMeta.tone} icon={stateMeta.icon}>
            {stateMeta.label}
          </Badge>
        )}
      </div>

      {/* Value: massive, tabular, tightly tracked, anchored to the baseline. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-section font-medium leading-none tracking-[-0.03em] text-fg tabular-nums">
          {children ?? <AnimatedValue value={value} />}
        </span>
        {delta && <DeltaChip direction={delta.direction} good={delta.good} label={delta.label} />}
      </div>

      {cause && <p className="mt-3 text-caption leading-snug text-muted">{cause}</p>}
      {reference && (
        <p className="mt-1 text-label normal-case tracking-normal text-muted/90">{reference}</p>
      )}

      {sparkline && sparkline.length > 1 && (
        <div className="mt-4">
          <Sparkline data={sparkline} tone="muted" height={28} />
        </div>
      )}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`${eyebrow}: ${value} — open details`}
        // hover:bg is the theme-safe cue — the ink shadow is invisible on the
        // dark cockpit background. active:scale gives the tactile press.
        className="card block h-full min-h-11 w-full cursor-pointer p-5 text-left transition-[box-shadow,background-color,border-color,transform] duration-200 ease-out hover:border-muted/30 hover:bg-surface-2/40 hover:shadow-raised motion-safe:active:scale-[0.99]"
      >
        {body}
      </button>
    )
  }

  return <div className="card h-full p-5">{body}</div>
}

export default StatTile
