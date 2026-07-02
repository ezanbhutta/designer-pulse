import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  hint?: string
  action?: ReactNode
}

/**
 * Designed empty state (spec §20.7 — empty states teach, never a blank
 * panel): either reassurance ("No aging tasks — the board is clean") or an
 * inline first step ("Add your first designer" with the action right here).
 */
export function EmptyState({ icon: Icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="animate-fade-in flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface/50 p-8 text-center">
      {Icon && (
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2">
          <Icon className="h-6 w-6 text-muted" aria-hidden="true" />
        </span>
      )}
      <p className="mt-1 font-medium text-fg">{title}</p>
      {hint && <p className="max-w-sm text-sm leading-relaxed text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export default EmptyState
