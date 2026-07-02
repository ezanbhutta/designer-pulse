import { Minus, TrendingDown, TrendingUp } from 'lucide-react'

export interface DeltaChipProps {
  direction: 'up' | 'down' | 'flat'
  good: boolean
  label: string
}

/**
 * Delta vs prior period (spec §20.2): color follows the GOOD/BAD direction
 * for the metric, not the arithmetic sign — faster speed is green even though
 * the number went down. Icon + sr-only text keep color from being the only
 * signal (§20.10).
 */
export function DeltaChip({ direction, good, label }: DeltaChipProps) {
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus
  const tone =
    direction === 'flat'
      ? 'bg-surface-2 text-muted'
      : good
        ? 'bg-success-soft text-success'
        : 'bg-danger-soft text-danger'
  const srText =
    direction === 'flat'
      ? 'unchanged vs prior period'
      : `${direction === 'up' ? 'up' : 'down'} vs prior period, ${good ? 'improving' : 'worsening'}`

  return (
    <span
      className={`tnum inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">
        {label}, {srText}
      </span>
    </span>
  )
}

export default DeltaChip
