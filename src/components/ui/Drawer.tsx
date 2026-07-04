import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

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
 * jump. Esc and overlay-click close; focus is trapped inside and returned on
 * close; body scroll locks; slides in over 200ms ease-out (suppressed under
 * prefers-reduced-motion via the global rule).
 */
export function Drawer({ open, onClose, title, wide = false, children }: DrawerProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const lastActive = useRef<HTMLElement | null>(null)
  // Keep mounted 200ms after close so the slide-out is visible.
  const [rendered, setRendered] = useState(open)
  // `shown` flips one frame AFTER mount so the panel paints its off-screen
  // start state first — otherwise the slide-IN never animates.
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (open) {
      setRendered(true)
      return
    }
    setShown(false)
    const t = setTimeout(() => setRendered(false), 200)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open || !rendered) return
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [open, rendered])

  // Focus management: capture the opener, focus the panel once it is actually
  // MOUNTED (gating on `rendered` — on the `open` commit the panel may not
  // exist yet, and focusing nothing leaves Tab and Escape on the page behind),
  // restore on close.
  useEffect(() => {
    if (!open || !rendered) return
    lastActive.current = (document.activeElement as HTMLElement | null) ?? null
    const raf = requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      lastActive.current?.focus()
    }
  }, [open, rendered])

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
    if (!open || !rendered) return
    const onKeyDown = (e: KeyboardEvent) => {
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
  }, [open, rendered, onClose])

  if (!rendered) return null

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-bg/60 backdrop-blur-sm transition-opacity duration-200 ease-out ${shown && open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-surface shadow-raised transition-transform duration-200 ease-out ${
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md'
        } ${shown && open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-4">
          <h2 id={titleId} className="truncate text-lg font-semibold text-fg">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export default Drawer
