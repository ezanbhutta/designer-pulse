import { useEffect, useRef, useState } from 'react'

export interface CountUpProps {
  value: number
  format?: (v: number) => string
  className?: string
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const defaultFormat = (v: number) => Math.round(v).toLocaleString('en')

/**
 * Animated number (spec §21.7): counts up ONLY when the value genuinely
 * changes — never on first mount, never on a cache refresh that lands the
 * same number, and never under prefers-reduced-motion. Screen readers are
 * given the final value immediately; the animated digits are aria-hidden
 * (spec §22.11 — no intermediate values announced).
 */
export function CountUp({ value, format = defaultFormat, className }: CountUpProps) {
  const [display, setDisplay] = useState(value)
  const prev = useRef<number | null>(null)
  const raf = useRef<number | null>(null)

  useEffect(() => {
    const from = prev.current
    prev.current = value
    // First mount, unchanged value, or reduced motion → render final, no animation.
    if (from === null || from === value || prefersReducedMotion()) {
      setDisplay(value)
      return
    }
    const start = performance.now()
    const duration = 300
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3) // ease-out cubic
      setDisplay(from + (value - from) * eased)
      if (t < 1) raf.current = requestAnimationFrame(step)
      else raf.current = null
    }
    raf.current = requestAnimationFrame(step)
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    }
  }, [value])

  return (
    <span className={className}>
      <span aria-hidden="true">{format(display)}</span>
      <span className="sr-only">{format(value)}</span>
    </span>
  )
}

export default CountUp
