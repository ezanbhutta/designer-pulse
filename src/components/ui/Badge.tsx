import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface BadgeProps {
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'brand' | 'waiting'
  icon?: LucideIcon
  children: ReactNode
}

/**
 * Semantic pill (spec §21.2): one tone vocabulary worn identically on every
 * screen. `waiting` is the muted + dashed "client-owned, not our clock"
 * treatment. Always pair with an icon or a text label — color is never the
 * only signal (§20.10).
 */
const TONE_CLASSES: Record<BadgeProps['tone'], string> = {
  neutral: 'bg-surface-2 text-muted border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  brand: 'bg-brand-soft text-brand border-transparent',
  waiting: 'bg-surface-2 text-muted border-dashed border-border',
}

export function Badge({ tone, icon: Icon, children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {children}
    </span>
  )
}

export default Badge
