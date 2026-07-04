/**
 * CEO-surface kit — the calm decision room's shared pieces (manifesto
 * pillars 2, 5, 9–11): the hero-tier headline metric with a ticking counter,
 * spring-staggered reveal wrappers for card grids, a calm (confetti-free)
 * all-clear block, and the corner ⓘ for components that only take a plain
 * string heading. Everything respects prefers-reduced-motion.
 */

import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { CircleCheck } from 'lucide-react'
import { AnimatedCounter } from '../../components/ui/AnimatedCounter'
import { DeltaChip } from '../../components/ui/DeltaChip'
import { InfoTip } from '../../components/ui/InfoTip'
import { Sparkline } from '../../components/ui/Sparkline'
import { SPRING_GENTLE, staggerContainer, staggerItem } from '../../components/ui/motion'
import type { TileDelta } from './ceoData'

/**
 * Staggered-reveal container (manifesto pillar 9): children cascade in at
 * 50ms intervals with spring momentum instead of appearing as one block.
 * Wrap direct children in <RevealItem>. Reduced motion renders instantly.
 */
export function Reveal({ className, children }: { className?: string; children: ReactNode }) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      variants={staggerContainer}
      initial={reduced ? false : 'hidden'}
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  )
}

/** One staggered child — slides up with momentum inside a <Reveal>. */
export function RevealItem({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <motion.div variants={staggerItem} className={className}>
      {children}
    </motion.div>
  )
}

/**
 * The page's ONE hero-tier number (manifesto pillar 2): a massive,
 * grayscale, tabular figure that ticks to its reading — severity lives in
 * the delta chip and the verdicts, never in the number itself. Null renders
 * a calm em dash. The sr-only sentence carries the final reading so screen
 * readers are never fed intermediate animation frames.
 */
export function HeroMetric({
  eyebrow,
  tip,
  value,
  format,
  delta,
  caption,
  sparkline,
  loading,
}: {
  eyebrow: string
  /** Plain-language ⓘ explainer for the metric. */
  tip?: string
  /** The numeric core — animated. Null shows an em dash. */
  value: number | null
  /** Formatter for the animated number (e.g. (n) => `${n}%`). */
  format?: (n: number) => string
  delta?: TileDelta | null
  /** One plain sentence of context under the number. */
  caption?: ReactNode
  /** Optional quiet context line (e.g. the 8-week shape). */
  sparkline?: number[]
  loading?: boolean
}) {
  if (loading) {
    return (
      <section role="status" aria-label={`${eyebrow} — loading`}>
        <div className="skeleton h-3 w-32" />
        <div className="skeleton mt-4 h-12 w-44" />
        <div className="skeleton mt-4 h-4 w-3/5 max-w-md" />
      </section>
    )
  }
  const reading = value == null ? 'nothing to show yet' : (format ? format(value) : value.toLocaleString())
  return (
    <section aria-label={`${eyebrow}: ${reading}`}>
      <p className="eyebrow flex items-center gap-1.5">
        {eyebrow}
        {tip && <InfoTip text={tip} />}
      </p>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span aria-hidden="true" className="tnum text-hero text-fg">
          {value == null ? '—' : <AnimatedCounter value={value} format={format} />}
        </span>
        {delta && <DeltaChip direction={delta.direction} good={delta.good} label={delta.label} />}
      </div>
      {caption && <p className="mt-3 max-w-prose text-caption text-muted">{caption}</p>}
      {sparkline && sparkline.length > 1 && (
        <div className="mt-4 max-w-xs">
          <Sparkline data={sparkline} tone="muted" height={28} />
        </div>
      )}
    </section>
  )
}

/**
 * The calm all-clear (manifesto pillar 11, CEO-tuned): the InboxZeroReward
 * shape WITHOUT confetti — a decision room celebrates with stillness. Spring
 * scale-in, definitive sentence, aria-live announcement.
 */
export function CalmClear({ title, message }: { title: string; message: string }) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      initial={reduced ? false : { scale: 0.94, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={SPRING_GENTLE}
      aria-live="polite"
      className="flex flex-col items-center justify-center rounded-2xl border border-border bg-surface py-24 text-center shadow-edge"
    >
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-success-soft text-success">
        <CircleCheck className="h-8 w-8" aria-hidden="true" />
      </div>
      <h2 className="text-card text-fg">{title}</h2>
      <p className="mt-2 max-w-prose px-6 text-caption text-muted">{message}</p>
    </motion.div>
  )
}

/**
 * Places a small ⓘ in the corner of a card whose component only accepts a
 * plain-string heading (VerdictBlock). `below` drops the icon under the
 * card's top-right pill so the two never overlap.
 */
export function CornerTip({
  tip,
  below,
  children,
}: {
  tip: string
  below?: boolean
  children: ReactNode
}) {
  return (
    <div className="relative">
      {children}
      <span className={`absolute right-4 ${below ? 'top-11' : 'top-4'}`}>
        <InfoTip text={tip} />
      </span>
    </div>
  )
}
