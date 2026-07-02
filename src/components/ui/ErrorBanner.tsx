import { RefreshCw, TriangleAlert } from 'lucide-react'

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
        <p className="text-sm font-medium leading-snug text-fg">{message}</p>
        {asOf && <p className="mt-0.5 text-xs text-muted">Showing data as of {asOf}.</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-[2.75rem] shrink-0 items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 text-sm font-medium text-fg transition-colors duration-150 hover:bg-surface-2"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  )
}

export default ErrorBanner
