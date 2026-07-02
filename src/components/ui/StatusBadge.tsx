import type { LucideIcon } from 'lucide-react'
import {
  Ban,
  CheckCheck,
  CircleCheck,
  Hourglass,
  Inbox,
  Package,
  Play,
  RotateCcw,
  Send,
} from 'lucide-react'
import {
  STATUS_LABELS,
  STATUS_TONES,
  type CanonicalStatus,
  type StatusTone,
} from '../../../shared/statuses'
import { Badge, type BadgeProps } from './Badge'

export interface StatusBadgeProps {
  status: CanonicalStatus
  showLabel?: boolean
}

/** One icon per pipeline status, so color is never the sole signal (§20.10). */
const STATUS_ICONS: Record<CanonicalStatus, LucideIcon> = {
  'pickup your projects': Inbox,
  'in progress': Play,
  'deliver to client': Send,
  revision: RotateCcw,
  'revision complete': CheckCheck,
  'client response': Hourglass,
  'final files': Package,
  cancelled: Ban,
  complete: CircleCheck,
}

const TONE_TO_BADGE: Record<StatusTone, BadgeProps['tone']> = {
  neutral: 'neutral',
  success: 'success',
  warning: 'warning',
  waiting: 'waiting',
  danger: 'danger',
}

/**
 * Pipeline status pill (spec §21.2): the same status wears the same tone and
 * icon on every screen — board, badge, chart, drawer. With showLabel=false
 * the label collapses to screen-reader-only text.
 */
export function StatusBadge({ status, showLabel = true }: StatusBadgeProps) {
  const label = STATUS_LABELS[status]
  return (
    <Badge tone={TONE_TO_BADGE[STATUS_TONES[status]]} icon={STATUS_ICONS[status]}>
      {showLabel ? label : <span className="sr-only">{label}</span>}
    </Badge>
  )
}

export default StatusBadge
