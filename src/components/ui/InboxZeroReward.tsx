import { useEffect } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import confetti from 'canvas-confetti'
import { Sparkles } from 'lucide-react'
import { SPRING_GENTLE } from './motion'

/**
 * The reward for clearing the board (manifesto pillar 11): a single, subtle
 * confetti burst in the brand's own colors, then a definitive, calm success
 * block. aria-live announces the state to screen readers; reduced motion
 * skips the confetti entirely.
 */
export function InboxZeroReward({
  title = 'All clear',
  message = 'Nothing needs you right now. Everyone has work in hand, and nothing is stuck.',
}: {
  title?: string
  message?: string
}) {
  const reduced = useReducedMotion()

  useEffect(() => {
    if (reduced) return
    confetti({
      particleCount: 50,
      spread: 60,
      origin: { y: 0.35 },
      colors: ['#7229FF', '#9F66FF', '#10B981', '#FAFAFA'],
      disableForReducedMotion: true,
    })
  }, [reduced])

  return (
    <motion.div
      initial={reduced ? false : { scale: 0.94, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={SPRING_GENTLE}
      aria-live="polite"
      className="flex flex-col items-center justify-center rounded-2xl border border-border bg-surface py-24 text-center shadow-edge"
    >
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-success-soft text-success shadow-[0_0_40px_rgb(var(--color-success)/0.18)]">
        <Sparkles className="h-8 w-8" aria-hidden="true" />
      </div>
      <h2 className="text-card text-fg">{title}</h2>
      <p className="mt-2 max-w-prose px-6 text-caption text-muted">{message}</p>
    </motion.div>
  )
}
