import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check } from 'lucide-react'
import { SPRING } from './motion'

type Phase = 'idle' | 'loading' | 'success'

/**
 * The stateful button (manifesto pillar 8): idle → tactile press → pulsing
 * dots while working → a crisp animated ✓ for a second — the user always
 * knows the click landed. Use for primary async actions; plain <Button> stays
 * for navigation and instant toggles.
 */
export function ActionButton({
  onAction,
  children,
  variant = 'primary',
  className = '',
  disabled,
  'aria-label': ariaLabel,
}: {
  onAction: () => Promise<void> | void
  children: ReactNode
  variant?: 'primary' | 'neutral' | 'danger'
  className?: string
  disabled?: boolean
  'aria-label'?: string
}) {
  const reduced = useReducedMotion()
  const [phase, setPhase] = useState<Phase>('idle')

  const handleClick = async () => {
    if (phase !== 'idle' || disabled) return
    setPhase('loading')
    try {
      await onAction()
      setPhase('success')
      setTimeout(() => setPhase('idle'), 1200)
    } catch {
      // The caller surfaces its own error toast — the button just resets.
      setPhase('idle')
    }
  }

  const skin =
    variant === 'primary'
      ? 'bg-brand text-brand-fg hover:opacity-90'
      : variant === 'danger'
        ? 'bg-danger text-danger-fg hover:opacity-90'
        : 'bg-surface-2 text-fg hover:bg-border'

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-busy={phase === 'loading'}
      whileTap={reduced ? undefined : { scale: 0.96 }}
      className={`relative flex h-10 min-w-[2.75rem] items-center justify-center gap-2 overflow-hidden rounded-lg px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 ${skin} ${className}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        {phase === 'idle' && (
          <motion.span
            key="idle"
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -8 }}
            transition={SPRING}
            className="flex items-center gap-2"
          >
            {children}
          </motion.span>
        )}
        {phase === 'loading' && (
          <motion.span
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-1"
            aria-label="Working"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70 motion-safe:animate-pulse" />
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70 motion-safe:animate-pulse [animation-delay:75ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70 motion-safe:animate-pulse [animation-delay:150ms]" />
          </motion.span>
        )}
        {phase === 'success' && (
          <motion.span
            key="success"
            initial={reduced ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            exit={reduced ? undefined : { scale: 0 }}
            transition={SPRING}
          >
            <Check className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">Done</span>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
