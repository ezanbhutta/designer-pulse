import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from './Button'

export interface ErrorBannerProps {
  message: string
  asOf?: string | null
  onRetry?: () => void
}

/**
 * Specific, actionable error (spec §20.7/§21.8): says what happened, what the
 * user is looking at ("showing data as of 14:32"), and what they can do about
 * it — never a bare "Something went wrong". Icon pairs with color (§20.10).
 */
export function ErrorBanner({ message, asOf, onRetry }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="animate-fade-in flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3"
    >
      <TriangleAlert className="h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-caption font-medium leading-snug text-fg">{message}</p>
        {asOf && (
          <p className="tnum mt-0.5 text-label normal-case tracking-normal text-muted">
            Showing data as of {asOf}.
          </p>
        )}
      </div>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </Button>
      )}
    </div>
  )
}

export default ErrorBanner
