import { useEffect, useId, useRef, useState } from 'react'
import { Info } from 'lucide-react'

export interface InfoTipProps {
  /** Plain-language explanation, 1–3 short sentences. Everyday words only. */
  text: string
  /** Accessible name for the icon button; defaults to "What is this?". */
  label?: string
}

/**
 * The little ⓘ that explains a heading or number in plain words (spec §21.6).
 * Hover or focus shows the note; tap toggles it on touch screens; Escape
 * hides it. Positioned `fixed` from the icon's rect so it never gets clipped
 * by table or drawer overflow.
 */
export function InfoTip({ text, label }: InfoTipProps) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      setPos({ top: rect.top, left: rect.left + rect.width / 2 })
      setOpen(true)
    }
  }
  const hide = () => setOpen(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onScroll = () => hide()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label ?? 'What is this?'}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation()
          open ? hide() : show()
        }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full align-middle text-muted transition-colors hover:text-fg focus-visible:text-fg"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && pos && (
        <span
          id={id}
          role="tooltip"
          className="pointer-events-none fixed z-[70] w-max max-w-[17rem] -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-fg shadow-raised animate-fade-in"
          style={{ top: pos.top - 6, left: pos.left }}
        >
          {text}
        </span>
      )}
    </>
  )
}

export default InfoTip
