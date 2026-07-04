import { useEffect, useRef, useState } from 'react'
import { animate, useReducedMotion } from 'framer-motion'

/**
 * Numbers never snap (manifesto pillar 10): values tick to their new reading
 * with spring momentum. tabular-nums (set by callers or inherited from .tnum)
 * keeps the width steady while digits change. Reduced motion snaps instantly.
 */
export function AnimatedCounter({
  value,
  format,
}: {
  value: number
  /** Optional formatter (e.g. (n) => `${n}%`). Defaults to locale string. */
  format?: (n: number) => string
}) {
  const reduced = useReducedMotion()
  const [display, setDisplay] = useState(value)
  const previous = useRef(value)

  useEffect(() => {
    if (reduced || previous.current === value) {
      previous.current = value
      setDisplay(value)
      return
    }
    const controls = animate(previous.current, value, {
      duration: 0.8,
      type: 'spring',
      bounce: 0,
      onUpdate(current) {
        setDisplay(Math.round(current))
      },
    })
    previous.current = value
    return () => controls.stop()
  }, [value, reduced])

  return <span className="tabular-nums">{format ? format(display) : display.toLocaleString()}</span>
}
