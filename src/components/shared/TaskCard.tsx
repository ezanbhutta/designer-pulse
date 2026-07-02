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
}

/**
 * Compact task card for the live board and drill-down lists. Status wears its
 * one semantic tone (§21.2); the age chip escalates warning→danger past the
 * aging threshold — with an icon, never color alone (§20.10).
 */
export function TaskCard({ task, onOpen, designerName }: TaskCardProps) {
  const { data: config } = useQuery({
    queryKey: qk.config,
    queryFn: fetchConfig,
    staleTime: STALE_ANALYTICS,
  })
  const cfg = config ?? CONFIG_DEFAULTS

  const status = task.current_status
  const isOpen = status != null && !TERMINAL_STATUSES.includes(status)
  const age = ageMinutes(task)
  const thresholdMin =
    (status === 'client response' ? cfg.aging_days_client_response : cfg.aging_days_default) *
    24 *
    60
  const aging = isOpen && age >= thresholdMin
  const severe = isOpen && age >= thresholdMin * 2
  const priority = task.priority?.toLowerCase() ?? null

  const body = (
    <>
      <p className="truncate text-sm font-medium text-fg" title={task.name ?? task.task_id}>
        {task.name ?? 'Untitled task'}
      </p>
      {designerName && <p className="mt-0.5 truncate text-xs text-muted">{designerName}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {status && <StatusBadge status={status} />}
        {isOpen &&
          (aging ? (
            <Badge tone={severe ? 'danger' : 'warning'} icon={Clock}>
              <span className="tnum">{fmtDuration(age)}</span>
              <span className="sr-only">
                {' '}
                in {STATUS_LABELS[status]} — past the aging threshold
              </span>
            </Badge>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
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
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {task.concept_count} concepts
          </span>
        )}
      </div>
    </>
  )

  const frame = `w-full rounded-xl border bg-surface p-3 text-left shadow-soft ${
    severe ? 'border-danger/50' : aging ? 'border-warning/50' : 'border-border/60'
  }`

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={() => onOpen(task.task_id)}
        className={`${frame} block min-h-[2.75rem] transition-shadow duration-200 ease-out hover:shadow-raised`}
        aria-label={`${task.name ?? 'Untitled task'} — ${
          status ? STATUS_LABELS[status] : 'no status'
        }, open trail`}
      >
        {body}
      </button>
    )
  }
  return <div className={frame}>{body}</div>
}

export default TaskCard
