import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Undo2, X } from 'lucide-react'
import { SPRING_GENTLE } from './motion'

export interface ToastOptions {
  message: string
  undo?: () => void | Promise<void>
}

/** Callable both ways: `toast({...})` and `const { toast } = useToast()`. */
export interface ToastHandle {
  (opts: ToastOptions): void
  toast: (opts: ToastOptions) => void
}

interface ToastRecord extends ToastOptions {
  id: number
  /** Countdown frozen (hovered / focused) — WCAG 2.2.1 Timing Adjustable. */
  paused: boolean
  /** Ms left in the current countdown segment (full TOAST_MS at birth). */
  remainingMs: number
}

const TOAST_MS = 5000

const ToastContext = createContext<ToastHandle | null>(null)

/**
 * Countdown bar so the Undo window is visible, not guessed. Freezes in place
 * while the toast is paused (hovered or holding focus) and resumes over the
 * remaining time.
 */
function CountdownBar({ paused, remainingMs }: { paused: boolean; remainingMs: number }) {
  const [running, setRunning] = useState(false)
  useEffect(() => {
    if (paused) {
      setRunning(false)
      return
    }
    const raf = requestAnimationFrame(() => setRunning(true))
    return () => {
      cancelAnimationFrame(raf)
      setRunning(false)
    }
  }, [paused, remainingMs])

  const startPct = (Math.max(0, remainingMs) / TOAST_MS) * 100
  return (
    <div
      className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-b-xl"
      aria-hidden="true"
    >
      <div
        className="h-full bg-bg/50"
        style={
          paused || !running
            ? { width: `${startPct}%`, transition: 'none' }
            : { width: '0%', transition: `width ${remainingMs}ms linear` }
        }
      />
    </div>
  )
}

/**
 * Undo-over-confirm (spec §20.6, manifesto pillar 8 — zero anxiety): every
 * non-destructive action acts first, then offers a 5-second Undo here.
 * Snackbars spring up from the bottom edge (pillar 9; reduced motion snaps),
 * stack bottom-center, announce via an aria-live="polite" region, and
 * auto-dismiss with a visible countdown. Hovering or focusing a toast pauses
 * its timer so slow readers never lose the Undo (WCAG 2.2.1).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion()
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const expiresAt = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    expiresAt.current.delete(id)
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (opts: ToastOptions) => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { ...opts, id, paused: false, remainingMs: TOAST_MS }])
      expiresAt.current.set(id, Date.now() + TOAST_MS)
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_MS),
      )
    },
    [dismiss],
  )

  const pause = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (!timer) return // already paused or gone
    clearTimeout(timer)
    timers.current.delete(id)
    const remaining = Math.max(0, (expiresAt.current.get(id) ?? Date.now()) - Date.now())
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, paused: true, remainingMs: remaining } : t)),
    )
  }, [])

  const resume = useCallback(
    (id: number) => {
      if (timers.current.has(id)) return // already running
      setToasts((prev) => {
        const t = prev.find((x) => x.id === id)
        if (!t || !t.paused) return prev
        const remaining = Math.max(500, t.remainingMs) // always leave a beat to react
        expiresAt.current.set(id, Date.now() + remaining)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), remaining),
        )
        return prev.map((x) => (x.id === id ? { ...x, paused: false, remainingMs: remaining } : x))
      })
    },
    [dismiss],
  )

  // Clear pending timers on unmount.
  useEffect(() => {
    const map = timers.current
    return () => {
      for (const timer of map.values()) clearTimeout(timer)
      map.clear()
    }
  }, [])

  const handle = useMemo<ToastHandle>(() => {
    const fn = ((opts: ToastOptions) => push(opts)) as ToastHandle
    fn.toast = fn
    return fn
  }, [push])

  const handleUndo = useCallback(
    async (t: ToastRecord) => {
      dismiss(t.id)
      try {
        await t.undo?.()
      } catch {
        push({ message: 'That could not be undone. The change may already be saved.' })
      }
    },
    [dismiss, push],
  )

  const onToastBlur = useCallback(
    (id: number) => (e: FocusEvent<HTMLDivElement>) => {
      // Only resume when focus actually LEFT the toast, not moved within it.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      resume(id)
    },
    [resume],
  )

  return (
    <ToastContext.Provider value={handle}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-label="Notifications"
          role="region"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-toast flex flex-col items-center gap-2 px-4"
        >
          <AnimatePresence initial={false}>
            {toasts.map((t) => (
              <motion.div
                key={t.id}
                layout={!reduced}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
                transition={reduced ? { duration: 0.01 } : SPRING_GENTLE}
                role="status"
                onMouseEnter={() => pause(t.id)}
                onMouseLeave={() => resume(t.id)}
                onFocus={() => pause(t.id)}
                onBlur={onToastBlur(t.id)}
                className="pointer-events-auto relative flex w-full max-w-md items-center gap-3 overflow-hidden rounded-xl bg-fg px-4 py-3 text-bg shadow-raised"
              >
                <p className="min-w-0 flex-1 text-caption font-medium">{t.message}</p>
                {t.undo && (
                  <button
                    type="button"
                    onClick={() => void handleUndo(t)}
                    // before:-inset grows the hit area to ≥44px while the pill stays compact.
                    className="relative -my-1.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-bg/10 px-2.5 text-caption font-semibold text-bg transition-colors before:absolute before:-inset-2 before:content-[''] hover:bg-bg/20 motion-safe:active:scale-[0.97]"
                  >
                    <Undo2 className="h-4 w-4" aria-hidden="true" />
                    Undo
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss notification"
                  className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-bg/70 transition-colors hover:text-bg"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
                <CountdownBar paused={t.paused} remainingMs={t.remainingMs} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastHandle {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a <ToastProvider>')
  return ctx
}

export default ToastProvider
