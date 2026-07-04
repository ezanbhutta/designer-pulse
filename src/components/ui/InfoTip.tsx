import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

export interface InfoTipProps {
  /** Plain-language explanation, 1–3 short sentences. Everyday words only. */
  text: string
  /** Accessible name for the icon button; defaults to "What is this?". */
  label?: string
}

/** Half the note's max width (17rem = 272px) plus a 12px viewport gutter. */
const CLAMP_PX = 148

/**
 * The little ⓘ that explains a heading or number in plain words (spec §21.6).
 * Hover or focus shows the note; tap toggles it on touch screens; Escape,
 * scrolling, or tapping anywhere else hides it. Positioned `fixed` from the
 * icon's rect so it never gets clipped by table or drawer overflow; the left
 * edge is clamped to the viewport and the note flips below the icon near the
 * top of the screen so it is never cut off.
 */
export function InfoTip({ text, label }: InfoTipProps) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  // A tap fires compatibility mouseenter/focus/click/mouseleave events;
  // without this latch those synthesized mouse events would immediately
  // toggle the just-opened note closed again, making the ⓘ dead on touch
  // screens. The latch releases only when a REAL mouse pointer arrives, so
  // hybrid devices get hover behavior back.
  const touched = useRef(false)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null)

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, CLAMP_PX),
      window.innerWidth - CLAMP_PX,
    )
    const below = rect.top < 110
    setPos({ top: below ? rect.bottom + 6 : rect.top - 6, left, below })
    setOpen(true)
  }
  const hide = () => setOpen(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onScroll = () => hide()
    // Outside tap/click dismisses (the note itself is pointer-events-none;
    // presses on the button are handled by its own click toggle).
    const onPointerDown = (e: PointerEvent) => {
      if (
        buttonRef.current &&
        e.target instanceof Node &&
        buttonRef.current.contains(e.target)
      ) {
        return
      }
      hide()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('pointerdown', onPointerDown)
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
        onTouchStart={() => {
          touched.current = true
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') touched.current = false
        }}
        onMouseEnter={() => {
          if (!touched.current) show()
        }}
        onMouseLeave={() => {
          if (!touched.current) hide()
        }}
        onFocus={() => {
          if (!touched.current) show()
        }}
        onBlur={() => {
          if (!touched.current) hide()
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (open) hide()
          else show()
        }}
        // before:-inset-3 grows the tap target to ~44×44 while the icon stays 20px.
        className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full align-middle text-muted transition-colors before:absolute before:-inset-3 before:content-[''] hover:text-fg focus-visible:text-fg"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open &&
        pos &&
        // Portal to <body>: a transformed ancestor (e.g. the slide-in drawer
        // panel) re-anchors position:fixed to itself, which would throw the
        // note off-screen. From <body> the viewport coords are always true.
        // animate-tip-in is opacity-only — a transform keyframe would override
        // the -translate-* positioning utilities for the animation's fill.
        createPortal(
          <span
            id={id}
            role="tooltip"
            className={`pointer-events-none fixed z-tip w-max max-w-[17rem] -translate-x-1/2 rounded-lg border border-border bg-surface px-3 py-2 text-caption font-normal normal-case leading-relaxed tracking-normal text-fg shadow-raised animate-tip-in ${
              pos.below ? '' : '-translate-y-full'
            }`}
            style={{ top: pos.top, left: pos.left }}
          >
            {text}
          </span>,
          document.body,
        )}
    </>
  )
}

export default InfoTip
