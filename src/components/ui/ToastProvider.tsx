import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Undo2, X } from 'lucide-react'

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
}

const TOAST_MS = 5000

const ToastContext = createContext<ToastHandle | null>(null)

/** 5-second countdown bar so the Undo window is visible, not guessed. */
function CountdownBar() {
  const [started, setStarted] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setStarted(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div
      className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-b-xl"
      aria-hidden="true"
    >
      <div
        className="h-full bg-bg/50"
        style={{ width: started ? '0%' : '100%', transition: `width ${TOAST_MS}ms linear` }}
      />
    </div>
  )
}

/**
 * Undo-over-confirm (spec §20.6): every non-destructive action acts first,
 * then offers a 5-second Undo here. Toasts stack bottom-center, announce via
 * an aria-live="polite" region, and auto-dismiss with a visible countdown.
 * Success is felt, not just done (§20.7).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (opts: ToastOptions) => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { ...opts, id }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_MS),
      )
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
        push({ message: "Couldn't undo — the change may already be saved" })
      }
    },
    [dismiss, push],
  )

  return (
    <ToastContext.Provider value={handle}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-label="Notifications"
          role="region"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-4"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className="animate-fade-in pointer-events-auto relative flex w-full max-w-md items-center gap-3 rounded-xl bg-fg px-4 py-3 text-bg shadow-raised"
            >
              <p className="min-w-0 flex-1 text-sm font-medium">{t.message}</p>
              {t.undo && (
                <button
                  type="button"
                  onClick={() => void handleUndo(t)}
                  className="-my-2 inline-flex min-h-[2.75rem] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-bg underline-offset-2 hover:underline"
                >
                  <Undo2 className="h-4 w-4" aria-hidden="true" />
                  Undo
                </button>
              )}
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-bg/70 hover:text-bg"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
              <CountdownBar />
            </div>
          ))}
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
