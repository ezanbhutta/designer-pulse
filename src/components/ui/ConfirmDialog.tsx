import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { TriangleAlert } from 'lucide-react'
import { Button } from './Button'
import { SPRING } from './motion'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Explicit confirmation dialog — reserved by spec §20.6 for exactly two
 * cases: hard-deleting a designer and bulk actions. Everything else uses
 * act-then-Undo toasts. The panel is a depth layer that springs in over the
 * dimmed void (pillar 9; reduced motion snaps). Focus starts on Cancel (the
 * safe choice), Esc cancels, focus is trapped and returned to the opener.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const reduced = useReducedMotion()
  const titleId = useId()
  const bodyId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const lastActive = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    lastActive.current = (document.activeElement as HTMLElement | null) ?? null
    const raf = requestAnimationFrame(() => cancelRef.current?.focus())
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(raf)
      document.body.style.overflow = prev
      lastActive.current?.focus()
    }
  }, [open])

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key !== 'Tab' || !panelRef.current) return
    const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div key="confirm" className="fixed inset-0 z-overlay flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.15 }}
            className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
            onClick={onCancel}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            onKeyDown={handleKeyDown}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
            transition={reduced ? { duration: 0.01 } : SPRING}
            className="card relative w-full max-w-md p-6 shadow-raised"
          >
            <div className="flex items-start gap-3">
              {destructive && (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft">
                  <TriangleAlert className="h-5 w-5 text-danger" aria-hidden="true" />
                </span>
              )}
              <div className="min-w-0">
                <h2 id={titleId} className="text-card text-fg">
                  {title}
                </h2>
                <p id={bodyId} className="mt-1.5 max-w-prose text-caption leading-relaxed text-muted">
                  {body}
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

export default ConfirmDialog
