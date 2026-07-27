import { motion, useReducedMotion } from 'framer-motion'
import {
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react'
import { fmtDurationLong } from '../../lib/format'
import { staggerItem } from '../ui/motion'
import type { FollowUpState } from '../../lib/actedOn'

/**
 * One decision that needs a human.
 *
 * The rule this type enforces: nothing reaches the top of the Command Center
 * unless it can say all four things. If the app cannot explain why something is
 * happening, what it costs, and what to do about it, then it is evidence, not a
 * decision, and it belongs further down the page.
 */
export interface Decision {
  id: string
  /** How much it matters. Drives order and the icon chip, never colour alone. */
  urgency: 'critical' | 'warning' | 'info'
  /** Distinct glyph per kind, so a stalled project and a quiet day never read alike. */
  icon: LucideIcon
  /** The verdict, in one sentence. */
  headline: string
  /** Why it is happening. */
  reason: string
  /** What it costs if it is ignored. This is the part that earns the interrupt. */
  impact: string
  /** Exactly one recommended next step. Never a menu. */
  step: {
    label: string
    /** A ClickUp deep link. Opening it is the hand off; we never write there. */
    href?: string
    /** Or an in app drill, for things the manager settles inside Studio Pulse. */
    onClick?: () => void
  }
  /**
   * Fingerprint of the condition, so the page can tell afterwards whether the
   * situation actually moved. See lib/actedOn.
   */
  signature: string
  /** Plain words for the moment they acted, kept for the follow up line. */
  context: string
}

/**
 * Severity is carried by the ROW, not by the button.
 *
 * The first pass gave every decision the same solid dark action, which put
 * five identical black pills down the right edge. Squint at that and the
 * buttons are the loudest thing on the page, so the eye lands on "there are
 * five buttons" rather than "one of these is an order we just lost". Weight
 * now tracks urgency: a coloured rule down the row, a tinted chip, and a solid
 * action only where it is genuinely urgent. Everything else asks quietly.
 */
const URGENCY: Record<
  Decision['urgency'],
  { chip: string; label: string; rule: string; solid: boolean }
> = {
  critical: {
    chip: 'bg-danger-soft text-danger',
    label: 'Urgent',
    rule: 'before:bg-danger',
    solid: true,
  },
  warning: {
    chip: 'bg-warning-soft text-warning',
    label: 'Needs a look',
    rule: 'before:bg-warning/60',
    solid: false,
  },
  info: {
    chip: 'bg-brand-soft text-brand',
    label: 'For your awareness',
    rule: 'before:bg-border',
    solid: false,
  },
}

function sinceWords(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000))
  return min < 1 ? 'a moment ago' : `${fmtDurationLong(min)} ago`
}

export interface DecisionCardProps {
  decision: Decision
  followUp: FollowUpState
  now: Date
  /** Called when the manager takes the step, so the page can remember it. */
  onAct: (d: Decision) => void
  /** Called to forget a resolved decision once it has been acknowledged. */
  onDismissResolved: (id: string) => void
}

/**
 * A decision, rendered so the manager can act without reading twice: verdict
 * first, then why and what it costs, then one button. The follow up line only
 * appears once they have acted, and it is the honest half of the read only
 * promise: we cannot close the task in ClickUp, but we can tell them whether
 * anything happened after they went there.
 */
export function DecisionCard({
  decision: d,
  followUp,
  now,
  onAct,
  onDismissResolved,
}: DecisionCardProps) {
  const reduced = useReducedMotion()
  const u = URGENCY[d.urgency]
  const Icon = d.icon
  const resolved = followUp.kind === 'moved'

  // One solid action per screenful at most: the urgent one. The rest are
  // bordered, so they still read as the next step without shouting over the
  // sentence that explains why they exist.
  const stepClasses = u.solid
    ? 'inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-fg px-3.5 text-caption font-semibold text-bg transition-opacity duration-150 ease-out hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg motion-safe:active:scale-[0.98]'
    : 'inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-surface px-3.5 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:border-fg/25 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg motion-safe:active:scale-[0.98]'

  return (
    <motion.li
      variants={reduced ? undefined : staggerItem}
      className={`relative flex flex-wrap items-start gap-x-4 gap-y-3 py-4 pl-6 pr-4 before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] sm:pl-7 ${
        resolved ? 'before:bg-success' : u.rule
      }`}
    >
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
          resolved ? 'bg-success-soft text-success' : u.chip
        }`}
      >
        {resolved ? (
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Icon className="h-4 w-4" aria-hidden="true" />
        )}
      </span>

      <div className="min-w-0 flex-[1_1_18rem]">
        <p className="text-read font-semibold leading-snug text-fg">
          <span className="sr-only">{u.label}: </span>
          {d.headline}
        </p>
        <p className="mt-1 max-w-prose text-caption leading-relaxed text-muted">{d.reason}</p>
        {/* The cost of doing nothing, set apart so it is never skimmed past. */}
        <p className="mt-1.5 max-w-prose border-l-2 border-border pl-3 text-caption leading-relaxed text-muted">
          {d.impact}
        </p>

        {followUp.kind === 'waiting' && (
          <p className="mt-2.5 text-label font-normal leading-relaxed tracking-normal text-muted">
            You opened this {sinceWords(followUp.since, now)} and it has not moved yet.
          </p>
        )}
        {resolved && (
          <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-label font-normal leading-relaxed tracking-normal text-success">
            This moved on after you opened it {sinceWords(followUp.since, now)}.
            <button
              type="button"
              onClick={() => onDismissResolved(d.id)}
              className="rounded-lg px-1.5 py-0.5 text-label font-medium text-muted underline-offset-2 transition-colors duration-150 hover:text-fg hover:underline"
            >
              Clear it
            </button>
          </p>
        )}
      </div>

      {/* Exactly one next step. */}
      {d.step.href ? (
        <a
          href={d.step.href}
          target="_blank"
          rel="noreferrer"
          onClick={() => onAct(d)}
          className={stepClasses}
        >
          {d.step.label}
          <ExternalLink className="h-3.5 w-3.5 opacity-80" aria-hidden="true" />
          <span className="sr-only">(opens in new tab)</span>
        </a>
      ) : (
        <button
          type="button"
          onClick={() => {
            onAct(d)
            d.step.onClick?.()
          }}
          className={stepClasses}
        >
          {d.step.label}
          <ArrowUpRight className="h-3.5 w-3.5 opacity-80" aria-hidden="true" />
        </button>
      )}
    </motion.li>
  )
}

export default DecisionCard
