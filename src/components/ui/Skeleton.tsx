export interface SkeletonProps {
  className?: string
}

/**
 * Loading placeholder (spec §20.7/§21.8 — skeletons, never spinners).
 * Size it with the className to match the shape of the incoming content so
 * the layout never jumps. The `.skeleton` shimmer lives in index.css and is
 * suppressed globally under prefers-reduced-motion.
 */
export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />
}

export default Skeleton
