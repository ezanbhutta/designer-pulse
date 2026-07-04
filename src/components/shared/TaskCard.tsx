import { memo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, Flag, Layers } from 'lucide-react'
import { Badge } from '../ui/Badge'
import { StatusBadge } from '../ui/StatusBadge'
import { STALE_ANALYTICS, fetchConfig, qk } from '../../lib/queries'
import { fmtDuration } from '../../lib/format'
import { ageMinutes } from '../../../shared/aggregate'
import { STATUS_LABELS, TERMINAL_STATUSES } from '../../../shared/statuses'
import { CONFIG_DEFAULTS } from '../../../shared/types'
import type { TaskState } from '../../../shared/types'

export interface TaskCardProps {
  task: TaskState
  onOpen?: (taskId: string) => void
  designerName?: string
  /** Aging threshold in days — pass it when the caller already has config
   *  (boards render hundreds of cards; one shared value beats per-card
   *  query observers). Falls back to its own config read when absent. */
  agingDaysDefault?: number
}

/**
 * Compact task card for the live board and drill-down lists. Status wears its
 * one semantic tone (§21.2); the age chip escalates warning→danger past the
 * aging threshold — with an icon, never color alone (§20.10). Memoized: board
 * re-renders skip cards whose props are unchanged (pass a stable onOpen).
 */
export const TaskCard = memo(function TaskCard({
  task,
  onOpen,
  designerName,
  agingDaysDefault,
}: TaskCardProps) {
  const { data: config } = useQuery({
    queryKey: qk.config,
    queryFn: fetchConfig,
    staleTime: STALE_ANALYTICS,
    enabled: agingDaysDefault === undefined,
  })
  const agingDays =
    agingDaysDefault ?? (config ?? CONFIG_DEFAULTS).aging_days_default

  const status = task.current_status
  const isOpen = status != null && !TERMINAL_STATUSES.includes(status)
  const age = ageMinutes(task)
  // Waiting on the client is never "stuck" — clients reply late, that's
  // normal — so client-response tasks never wear the aging badge.
  const thresholdMin = status === 'client response' ? Infinity : agingDays * 24 * 60
  const aging = isOpen && age >= thresholdMin
  const severe = isOpen && age >= thresholdMin * 2
  const priority = task.priority?.toLowerCase() ?? null

  const body = (
    <>
      <p className="truncate text-caption font-medium text-fg" title={task.name ?? task.task_id}>
        {task.name ?? 'Untitled project'}
      </p>
      {designerName && (
        <p className="mt-0.5 truncate text-label normal-case tracking-normal text-muted">
          {designerName}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {status && <StatusBadge status={status} />}
        {isOpen &&
          (aging ? (
            <Badge tone={severe ? 'danger' : 'warning'} icon={Clock}>
              <span className="tnum">{fmtDuration(age)}</span>
              <span className="sr-only">
                {' '}
                in {STATUS_LABELS[status]} — stuck too long
              </span>
            </Badge>
          ) : (
            <span className="inline-flex h-5 items-center gap-1 text-label normal-case tracking-normal text-muted">
              <Clock className="h-3 w-3" aria-hidden="true" />
              <span className="tnum">{fmtDuration(age)}</span>
              <span className="sr-only"> in {STATUS_LABELS[status]}</span>
            </span>
          ))}
        {(priority === 'urgent' || priority === 'high') && (
          <Badge tone={priority === 'urgent' ? 'danger' : 'warning'} icon={Flag}>
            {priority === 'urgent' ? 'Urgent' : 'High'}
          </Badge>
        )}
        {task.concept_count != null && (
          <span className="tnum inline-flex h-5 items-center gap-1 rounded-full bg-surface-2 px-2 text-label text-muted">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {task.concept_count} concepts
          </span>
        )}
      </div>
    </>
  )

  const frame = `w-full rounded-xl border bg-surface p-3.5 text-left shadow-soft ${
    severe ? 'border-danger/50' : aging ? 'border-warning/50' : 'border-border/60'
  }`

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={() => onOpen(task.task_id)}
        // hover:bg is the theme-safe cue — the ink shadow alone is invisible
        // on the dark cockpit background. active:scale is the tactile press
        // (manifesto pillar 8 — the card physically reacts to pressure).
        className={`${frame} block min-h-11 transition-[box-shadow,background-color,transform] duration-200 ease-out hover:bg-surface-2/50 hover:shadow-raised motion-safe:active:scale-[0.99]`}
        aria-label={`${task.name ?? 'Untitled project'} — ${
          status ? STATUS_LABELS[status] : 'no status'
        }, open history`}
      >
        {body}
      </button>
    )
  }
  return <div className={frame}>{body}</div>
})

export default TaskCard
