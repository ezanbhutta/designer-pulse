/**
 * The single motion vocabulary (manifesto pillar 9): spring physics, never
 * robotic easing; staggered reveals, never block-fades. Every animated
 * component imports from here so the whole product moves as one object.
 * Framer Motion respects prefers-reduced-motion via useReducedMotion at the
 * call sites; CSS animations stay behind motion-safe:.
 */

export const SPRING = { type: 'spring', stiffness: 400, damping: 30 } as const
export const SPRING_GENTLE = { type: 'spring', stiffness: 300, damping: 24 } as const

/** List container: cascades children in at 50ms intervals (progressive reveal). */
export const staggerContainer = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.05 } },
} as const

/** List item: slides up with momentum. */
export const staggerItem = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: SPRING_GENTLE },
} as const
