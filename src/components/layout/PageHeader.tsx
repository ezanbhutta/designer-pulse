import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * The 4-question page header (manifesto pillar 7). Structurally answers:
 * Where am I? (breadcrumbs + title) · What happened? (history line) ·
 * What can I do? (ONE brand button max, top-right) — before any content.
 */
export function PageHeader({
  breadcrumbs,
  title,
  titleAccessory,
  history,
  actions,
}: {
  breadcrumbs?: string[]
  /** The definitive page title. */
  title: ReactNode
  /** Optional inline accessory (e.g. an InfoTip) rendered beside the title. */
  titleAccessory?: ReactNode
  /** "What happened" — a plain sentence of live context, never a mystery. */
  history?: ReactNode
  /** Right side: at most ONE brand-colored primary; the rest ghost/neutral. */
  actions?: ReactNode
}) {
  return (
    <header className="mb-12 flex flex-wrap items-start justify-between gap-6">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-label uppercase text-muted">
            {breadcrumbs.map((crumb, idx) => (
              <span key={crumb} className="flex items-center gap-1">
                {crumb}
                {idx < breadcrumbs.length - 1 && (
                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="inline-flex items-center gap-2 text-section tracking-tight text-fg">
          {title}
          {titleAccessory}
        </h1>
        {history && <p className="mt-2 max-w-prose text-caption text-muted">{history}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
    </header>
  )
}
