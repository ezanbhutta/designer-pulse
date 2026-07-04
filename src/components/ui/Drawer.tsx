import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { X } from 'lucide-react'
import { SPRING } from './motion'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  wide?: boolean
  children: ReactNode
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Right-side panel (spec §20.6 — act in place, never lose your place):
 * leave-logging, drill-downs, and alert work happen here instead of a page
 * jump. The panel is a depth layer over the dimmed void and slides in on
 * spring physics (manifesto pillar 9; reduced motion snaps instantly).
 * Esc and overlay-click close; focus is trapped inside and returned on
 * close; body scroll locks.
 */
export function Drawer({ open, onClose, title, wide = false, children }: DrawerProps) {
  const reduced = useReducedMotion()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const lastActive = useRef<HTMLElement | null>(null)

  // Focus management: capture the opener, focus the panel once mounted,
  // restore on close (while the exit animation plays out underneath).
  useEffect(() => {
    if (!open) return
    lastActive.current = (document.activeElement as HTMLElement | null) ?? null
    const raf = requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      lastActive.current?.focus()
    }
  }, [open])

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Escape / Tab containment at the DOCUMENT level while open: aria-modal
  // promises the page behind is inert, so the trap must hold even if focus
  // ever ends up outside the panel.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      // A stacked modal (e.g. a nested drawer or confirm dialog portaled on
      // top) owns the keys while focus is inside it — don't close under it.
      const target = e.target instanceof Element ? e.target : null
      if (target && panelRef.current && !panelRef.current.contains(target)) {
        const otherModal = target.closest('[role="dialog"], [role="alertdialog"]')
        if (otherModal && otherModal !== panelRef.current) return
      }
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const panel = panelRef.current
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      // Focus escaped the dialog entirely — pull it back in.
      if (active && !panel.contains(active) && active !== panel) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <div key="drawer" className="fixed inset-0 z-overlay">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }}
            className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduced ? { opacity: 0 } : { x: '100%' }}
            animate={reduced ? { opacity: 1 } : { x: 0 }}
            exit={reduced ? { opacity: 0 } : { x: '100%' }}
            transition={reduced ? { duration: 0.01 } : SPRING}
            className={`absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-surface shadow-raised ${
              wide ? 'sm:max-w-2xl' : 'sm:max-w-md'
            }`}
          >
            <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-4">
              <h2 id={titleId} className="truncate text-card text-fg">
                {title}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close panel"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg motion-safe:active:scale-95"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

export default Drawer
