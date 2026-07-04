import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  hint?: string
  action?: ReactNode
}

/**
 * Designed empty state (spec §20.7, manifesto pillar 11 — empty states teach,
 * never a dead grey icon): a layered icon composite with the brand's soft
 * tint, reassurance in plain words, and — wherever the caller can offer one —
 * a 1-click escape in the `action` slot.
 */
export function EmptyState({ icon: Icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="animate-fade-in flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface/50 px-8 py-12 text-center">
      {Icon && (
        <div className="relative mb-5" aria-hidden="true">
          {/* Rotated backplate makes the glyph a designed composite, not a lone icon. */}
          <span className="absolute inset-0 rotate-6 rounded-2xl bg-surface-2" />
          <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand ring-1 ring-border">
            <Icon className="h-6 w-6" />
          </span>
        </div>
      )}
      <p className="text-body font-medium text-fg">{title}</p>
      {hint && <p className="mt-1 max-w-prose text-caption text-muted">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export default EmptyState
