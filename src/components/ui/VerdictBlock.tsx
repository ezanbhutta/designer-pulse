import { CheckCircle2, ExternalLink, Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { buttonClasses } from './Button'

export interface VerdictItem {
  id: string
  severity: 'info' | 'warning' | 'critical'
  text: string
  detail?: string
  action?: { label: string; href?: string; onClick?: () => void }
}

export interface VerdictBlockProps {
  title: string
  items: VerdictItem[]
  emptyMessage: string
  loading?: boolean
}

const SEVERITY_META: Record<
  VerdictItem['severity'],
  { icon: LucideIcon; className: string; label: string }
> = {
  // Info wears a calm ⓘ — an exclamation glyph would make "steady, nothing
  // needs you" items look like alarms (§20.7: calm verdicts are a feature).
  info: { icon: Info, className: 'text-brand', label: 'Info' },
  warning: { icon: TriangleAlert, className: 'text-warning', label: 'Warning' },
  critical: { icon: OctagonAlert, className: 'text-danger', label: 'Critical' },
}

const actionClasses = buttonClasses('secondary')

/**
 * The §20.1 lead block — visually dominant (§20.8): every surface opens with
 * this, not a table. Each item is a pre-interpreted call with a severity
 * glyph (distinct icon per severity, never color alone) and, where the system
 * can propose a next move, an action rendered as a compact button or a
 * ClickUp deep link (§22.1 — links navigate, they never write).
 * A calm empty state is a feature (§20.7).
 */
export function VerdictBlock({ title, items, emptyMessage, loading }: VerdictBlockProps) {
  return (
    <section className="card animate-fade-in p-6" aria-label={title}>
      <p className="eyebrow">What needs you now</p>
      <h2 className="mt-1 text-xl font-semibold text-fg">{title}</h2>

      {loading ? (
        <div className="mt-5 space-y-4" role="status" aria-label="Loading verdicts">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="skeleton h-5 w-5 rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="skeleton h-4 w-3/4" />
                <div className="skeleton mt-2 h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-5 flex items-center gap-3 rounded-xl bg-success-soft/60 p-4">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
          <p className="text-sm font-medium text-fg">{emptyMessage}</p>
        </div>
      ) : (
        <ul className="mt-5 space-y-4">
          {items.map((item) => {
            const meta = SEVERITY_META[item.severity]
            const Icon = meta.icon
            return (
              <li key={item.id} className="flex items-start gap-3 animate-fade-in">
                <Icon
                  className={`mt-0.5 h-5 w-5 shrink-0 ${meta.className}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold leading-snug text-fg">
                    <span className="sr-only">{meta.label}: </span>
                    {item.text}
                  </p>
                  {item.detail && (
                    <p className="mt-0.5 text-sm leading-snug text-muted">{item.detail}</p>
                  )}
                </div>
                {item.action &&
                  (item.action.href ? (
                    <a
                      href={item.action.href}
                      target="_blank"
                      rel="noreferrer"
                      className={actionClasses}
                    >
                      {item.action.label}
                      <ExternalLink className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                      <span className="sr-only">(opens in new tab)</span>
                    </a>
                  ) : (
                    <button type="button" onClick={item.action.onClick} className={actionClasses}>
                      {item.action.label}
                    </button>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default VerdictBlock
