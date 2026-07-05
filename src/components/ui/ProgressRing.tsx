import { useEffect, useId, useRef, useState } from 'react'

export interface ProgressRingProps {
  /** Completed count (the number the ring fills toward). */
  value: number
  /** Target/total (the denominator). When 0, the ring shows an empty track. */
  total: number
  /** Diameter in px. */
  size?: number
  /** Stroke width in px. */
  stroke?: number
  /** Small caption under the big number (default "of {total}"). */
  caption?: string
  className?: string
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * The hero of the Designer self-view: a brand-gradient arc that sweeps to
 * today's completion the moment it mounts, with the count ticking up in its
 * centre. Sweep and count re-run only when the value genuinely changes (a real
 * completion), animating from the previous value — never on an idle refetch.
 * Under reduced motion both land on their final state instantly. The final
 * "N of M" is exposed to screen readers; the animated digits are aria-hidden.
 */
export function ProgressRing({
  value,
  total,
  size = 128,
  stroke = 12,
  caption,
  className,
}: ProgressRingProps) {
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const fraction = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0
  const targetOffset = circumference * (1 - fraction)
  const gid = useId().replace(/:/g, '')

  // Arc offset animates via CSS transition; start empty on first mount so the
  // arc visibly sweeps in.
  const [offset, setOffset] = useState(circumference)
  useEffect(() => {
    if (prefersReducedMotion()) {
      setOffset(targetOffset)
      return
    }
    const raf = requestAnimationFrame(() => setOffset(targetOffset))
    return () => cancelAnimationFrame(raf)
  }, [targetOffset])

  // Centre number counts from its previous value (0 on first mount) to `value`.
  const [display, setDisplay] = useState(prefersReducedMotion() ? value : 0)
  const prev = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  useEffect(() => {
    const from = prev.current ?? 0
    prev.current = value
    if (from === value || prefersReducedMotion()) {
      setDisplay(value)
      return
    }
    const start = performance.now()
    const dur = 1100
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(from + (value - from) * eased)
      if (t < 1) rafRef.current = requestAnimationFrame(step)
      else rafRef.current = null
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [value])

  return (
    <div
      className={`relative shrink-0 ${className ?? ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${value} of ${total} done`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`ring-${gid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgb(var(--color-brand))" />
            <stop offset="1" stopColor="rgb(var(--color-brand) / 0.65)" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ring-track)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#ring-${gid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tnum text-section leading-none text-fg" aria-hidden="true">
          {Math.round(display)}
        </span>
        {caption != null && (
          <span className="mt-1 text-label uppercase tracking-[0.1em] text-muted" aria-hidden="true">
            {caption}
          </span>
        )}
      </div>
    </div>
  )
}

export default ProgressRing
