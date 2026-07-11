import { memo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, Flag, Layers } from 'lucide-react'
import { StatusBadge } from '../ui/StatusBadge'
import { STALE_ANALYTICS, fetchConfig, qk } from '../../lib/queries'
import { fmtAgeShort } from '../../lib/format'
import { ageMinutes, agingDelay } from '../../../shared/aggregate'
import { STATUS_LABELS, TERMINAL_STATUSES } from '../../../shared/statuses'
import { CONFIG_DEFAULTS } from '../../../shared/types'
import type { TaskState } from '../../../shared/types'

export interface TaskCardProps {
  task: TaskState
  onOpen?: (taskId: string) => void
  designerName?: string
  /** Hide the status chip when the surrounding column already names the stage
   *  (the by-stage board) — keeps it in the by-person view where tasks span
   *  many stages. Defaults to showing it. */
  showStatus?: boolean
  /** Aging threshold in days — pass it when the caller already has config
   *  (boards render hundreds of cards; one shared value beats per-card
   *  query observers). Falls back to its own config read when absent. */
  agingDaysDefault?: number
}

/**
 * Compact task card for the live board and drill-down lists. One calm meta row:
 * only genuine signals carry colour — an urgent flag, or an age that has grown
 * past the point of being stuck (with an icon, never colour alone, §20.10).
 * Everything else is quiet. Memoized: board re-renders skip cards whose props
 * are unchanged (pass a stable onOpen).
 */
export const TaskCard = memo(function TaskCard({
  task,
  onOpen,
  designerName,
  showStatus = true,
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
  // The "stuck" badge lives on the DESIGNER's card, so only a designer-owned
  // stall reddens it. Waiting on the client, and the team handoff (revision
  // complete = ready to send), are never the designer's fault, so they never
  // wear the badge here — the team delay still surfaces, correctly attributed,
  // in the alerts. The shared helper is the single source of that ownership.
  const cfg = config ?? CONFIG_DEFAULTS
  const delay = agingDelay(status, {
    aging_days_default: agingDays,
    aging_days_client_response: cfg.aging_days_client_response,
  })
  const stuckOwned = delay.owner === 'designer'
  const aging = isOpen && stuckOwned && age >= delay.thresholdMin
  const severe = isOpen && stuckOwned && age >= delay.thresholdMin * 2
  const priority = task.priority?.toLowerCase() ?? null

  const body = (
    <>
      <p className="truncate text-caption font-semibold text-fg" title={task.name ?? task.task_id}>
        {task.name ?? 'Untitled project'}
      </p>
      {designerName && (
        <p className="mt-0.5 truncate text-label normal-case tracking-normal text-muted">
          {designerName}
        </p>
      )}
      {showStatus && status && (
        <div className="mt-2.5">
          <StatusBadge status={status} />
        </div>
      )}
      {/* One quiet meta line: only an urgent flag or a genuinely stuck age
          carries colour; everything else stays muted so the eye can rest. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-label normal-case tracking-normal">
        {isOpen && (
          <span
            className={`inline-flex items-center gap-1 ${
              aging ? (severe ? 'font-medium text-danger' : 'font-medium text-warning') : 'text-muted'
            }`}
          >
            <Clock className="h-3 w-3" aria-hidden="true" />
            <span className="tnum">{fmtAgeShort(age)}</span>
            <span className="sr-only">
              {' '}
              at this stage{aging ? ', stuck too long' : ''}
            </span>
          </span>
        )}
        {priority === 'urgent' && (
          <span className="inline-flex items-center gap-1 font-medium text-danger">
            <Flag className="h-3 w-3" aria-hidden="true" />
            Urgent
          </span>
        )}
        {priority === 'high' && (
          <span className="inline-flex items-center gap-1 text-warning">
            <Flag className="h-3 w-3" aria-hidden="true" />
            High
          </span>
        )}
        {task.concept_count != null && (
          <span className="inline-flex items-center gap-1 text-muted">
            <Layers className="h-3 w-3" aria-hidden="true" />
            <span className="tnum">{task.concept_count}</span> concepts
          </span>
        )}
      </div>
    </>
  )

  const frame = `w-full rounded-xl border bg-surface p-4 text-left shadow-soft ${
    severe ? 'border-danger/50' : aging ? 'border-warning/50' : 'border-border/70'
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
        aria-label={`${task.name ?? 'Untitled project'}, ${
          status ? STATUS_LABELS[status] : 'no status'
        }. Open its history.`}
      >
        {body}
      </button>
    )
  }
  return <div className={frame}>{body}</div>
})

export default TaskCard
