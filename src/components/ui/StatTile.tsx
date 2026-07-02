import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { CircleCheck, Eye, TriangleAlert } from 'lucide-react'
import { CountUp } from './CountUp'
import { DeltaChip } from './DeltaChip'
import { Sparkline } from './Sparkline'

export interface StatTileProps {
  eyebrow: string
  icon?: LucideIcon
  value: string
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
  { icon: LucideIcon; className: string; label: string }
> = {
  ok: { icon: CircleCheck, className: 'bg-success-soft text-success', label: 'On track' },
  watch: { icon: Eye, className: 'bg-warning-soft text-warning', label: 'Watch' },
  flag: { icon: TriangleAlert, className: 'bg-danger-soft text-danger', label: 'Flag' },
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
 * Metric tile (spec §21.6/§20.2): the number never travels alone — delta vs
 * prior period, plain-language cause, and a reference point (team median)
 * ship inline. State flag pairs icon + label with its color (§20.10).
 * With onClick the whole tile is a drill-down button.
 */
export function StatTile({
  eyebrow,
  icon: Icon,
  value,
  delta,
  cause,
  reference,
  state,
  sparkline,
  onClick,
  loading,
}: StatTileProps) {
  if (loading) {
    return (
      <div className="card p-5" role="status" aria-label={`${eyebrow} — loading`}>
        <div className="skeleton h-3 w-24" />
        <div className="skeleton mt-3 h-9 w-24" />
        <div className="skeleton mt-2.5 h-3.5 w-4/5" />
        <div className="skeleton mt-1.5 h-3 w-1/2" />
      </div>
    )
  }

  const stateMeta = state ? STATE_META[state] : null
  const StateIcon = stateMeta?.icon

  const body: ReactNode = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
          <span className="eyebrow truncate">{eyebrow}</span>
        </span>
        {stateMeta && StateIcon && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${stateMeta.className}`}
          >
            <StateIcon className="h-3 w-3" aria-hidden="true" />
            {stateMeta.label}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="tnum text-3xl font-medium leading-tight text-fg">
          <AnimatedValue value={value} />
        </span>
        {delta && <DeltaChip direction={delta.direction} good={delta.good} label={delta.label} />}
      </div>

      {cause && <p className="mt-1.5 text-sm leading-snug text-muted">{cause}</p>}
      {reference && <p className="mt-1 text-xs text-muted/90">{reference}</p>}

      {sparkline && sparkline.length > 1 && (
        <div className="mt-3">
          <Sparkline data={sparkline} tone="muted" width={140} height={28} />
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
        className="card block min-h-[2.75rem] w-full cursor-pointer p-5 text-left transition-shadow duration-200 ease-out hover:shadow-raised"
      >
        {body}
      </button>
    )
  }

  return <div className="card p-5">{body}</div>
}

export default StatTile
