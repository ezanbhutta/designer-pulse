import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { EmptyState } from '../ui/EmptyState'
import { ErrorBanner } from '../ui/ErrorBanner'
import { StatusBadge } from '../ui/StatusBadge'
import { STALE_LIVE, fetchTaskEvents, qk } from '../../lib/queries'
import { fmtDateTime, fmtDuration } from '../../lib/format'
import { minutesBetween } from '../../../shared/pkt'
import { STATUS_LABELS, TERMINAL_STATUSES } from '../../../shared/statuses'
import type { ClickupEvent } from '../../../shared/types'

export interface TaskTrailProps {
  taskId: string
}

function sourceLabel(source: ClickupEvent['source']): string | null {
  if (source === 'webhook') return null
  return source === 'reconciliation' ? 'via reconciliation' : 'backfilled'
}

/**
 * Vertical status trail for one task (§13.2 "10-second fault review" and the
 * board drill-down): every transition with its timestamp, how long the task
 * sat in each status, and the ingestion source when it wasn't the live webhook.
 */
export function TaskTrail({ taskId }: TaskTrailProps) {
  const { data: events, isLoading, error, refetch } = useQuery({
    queryKey: qk.taskEvents(taskId),
    queryFn: () => fetchTaskEvents(taskId),
    staleTime: STALE_LIVE,
  })

  if (isLoading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading task trail">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <div className="skeleton h-3 w-3 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-3 w-56" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <ErrorBanner
        message="Couldn't load this task's history — the trail below may be incomplete."
        onRetry={() => void refetch()}
      />
    )
  }

  if (!events || events.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No history yet"
        hint="Events appear here the moment the task moves in ClickUp."
      />
    )
  }

  const now = new Date()

  return (
    <ol className="relative space-y-5 border-l border-border pl-5" aria-label="Task status trail">
      {events.map((e, i) => {
        const next = events[i + 1]
        const isLast = i === events.length - 1
        const status = e.to_status
        const terminal = status != null && TERMINAL_STATUSES.includes(status)
        // Time spent in the status this event entered.
        const heldMin = next
          ? minutesBetween(e.event_time, next.event_time)
          : !terminal && e.event_type !== 'deleted'
            ? minutesBetween(e.event_time, now)
            : null
        const src = sourceLabel(e.source)

        return (
          <li key={e.id} className="relative">
            <span
              aria-hidden="true"
              className={`absolute -left-[26px] top-1.5 h-3 w-3 rounded-full border-2 border-surface ${
                e.event_type === 'deleted'
                  ? 'bg-danger'
                  : isLast
                    ? 'bg-brand'
                    : 'bg-border'
              }`}
            />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {e.event_type === 'created' ? (
                <>
                  <span className="text-sm font-medium text-fg">Assigned</span>
                  <StatusBadge status={status ?? 'pickup your projects'} />
                </>
              ) : e.event_type === 'deleted' ? (
                <span className="text-sm font-medium text-danger">Deleted in ClickUp</span>
              ) : (
                <>
                  {e.from_status && (
                    <span className="text-xs text-muted">{STATUS_LABELS[e.from_status]} →</span>
                  )}
                  {status && <StatusBadge status={status} />}
                </>
              )}
              {src && (
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                  {src}
                </span>
              )}
            </div>
            <p className="tnum mt-1 text-xs text-muted">
              {fmtDateTime(e.event_time)}
              {heldMin != null && status && e.event_type !== 'deleted' && (
                <>
                  {' · '}
                  {isLast
                    ? `in ${STATUS_LABELS[status]} for ${fmtDuration(heldMin)} so far`
                    : `held ${fmtDuration(heldMin)}`}
                </>
              )}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

export default TaskTrail
