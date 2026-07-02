/**
 * CEO Cancellations (spec §13.2, §4.4): every cancelled task, one click to
 * its full status trail — the 10-second fault review. Cancelled is
 * designer-fault terminal by definition (§2), but fault attribution rests on
 * CSR judgment at close, so the integrity caveat rides the page as a quiet
 * info line and every judgment is aimed at the TREND, not a single row.
 * Grouped by designer with count + cancellation rate. Read-only (§22.1).
 */

import { useMemo, useState } from 'react'
import { ExternalLink, Info, OctagonX } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Drawer } from '../../components/ui/Drawer'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { Skeleton } from '../../components/ui/Skeleton'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { TaskTrail } from '../../components/shared/TaskTrail'
import { pktDateOf, pktToday } from '../../../shared/pkt'
import type { Designer, TaskState } from '../../../shared/types'
import { clickupTaskUrl } from '../../lib/queries'
import { fmtDate, fmtDateTime, fmtTime } from '../../lib/format'
import {
  activeDesigners,
  cancelledInPeriod,
  firstName,
  mergeTasks,
  sameWindowLastWeek,
  thisWeekRange,
  useCancelledTasks,
  useDesigners,
  useOpenTasksLive,
  useTasksWindow,
  weekBuckets,
} from './ceoData'

interface Group {
  designer: Designer | null
  tasks: TaskState[]
  assigned12w: number
  cancelled12w: number
}

export default function CeoCancellations() {
  const today = pktToday()
  const week = thisWeekRange(today)
  // Week-to-date vs the SAME window last week (Mon..same weekday) — §20.4.
  const prior = sameWindowLastWeek(week)
  const windowStart = weekBuckets(12, today)[0].start

  const designersQ = useDesigners()
  const cancelledQ = useCancelledTasks()
  const tasksQ = useTasksWindow(windowStart)
  const openQ = useOpenTasksLive()

  const [selected, setSelected] = useState<TaskState | null>(null)

  const loading = designersQ.isLoading || cancelledQ.isLoading || tasksQ.isLoading
  const failed = designersQ.error ?? cancelledQ.error ?? tasksQ.error

  const model = useMemo(() => {
    if (loading || !designersQ.data || !cancelledQ.data || !tasksQ.data) return null
    const designers = designersQ.data
    const byId = new Map(designers.map((d) => [d.id, d]))
    const allTasks = mergeTasks(tasksQ.data, openQ.data ?? [])
    const activeIds = new Set(activeDesigners(designers).map((d) => d.id))
    const allIds = new Set(designers.map((d) => d.id))

    // Trend: this week vs the same window last week (§20.4 — CEO default).
    const nowCount = cancelledInPeriod(allTasks, activeIds, week).length
    const prevCount = cancelledInPeriod(allTasks, activeIds, prior).length

    // Group every fetched cancellation by designer, count + 12-week rate.
    const groupsMap = new Map<string, TaskState[]>()
    for (const t of cancelledQ.data) {
      const key = t.designer_id ?? 'unassigned'
      groupsMap.set(key, [...(groupsMap.get(key) ?? []), t])
    }
    const cancelled12w = cancelledInPeriod(allTasks, allIds, { start: windowStart, end: today })
    const groups: Group[] = [...groupsMap.entries()]
      .map(([key, tasks]) => {
        const designer = key === 'unassigned' ? null : (byId.get(key) ?? null)
        const assigned12w = allTasks.filter(
          (t) =>
            !t.deleted && t.designer_id === key && t.created_at != null && pktDateOf(t.created_at) >= windowStart,
        ).length
        return {
          designer,
          tasks: [...tasks].sort((a, b) =>
            (b.closed_at ?? b.last_event_at ?? '').localeCompare(a.closed_at ?? a.last_event_at ?? ''),
          ),
          assigned12w,
          cancelled12w: cancelled12w.filter((t) => (t.designer_id ?? 'unassigned') === key).length,
        }
      })
      .sort((a, b) => b.tasks.length - a.tasks.length)

    // The verdict item — the trend, pre-interpreted.
    const verdicts: VerdictItem[] = []
    if (cancelledQ.data.length > 0) {
      const topThisWeek = new Map<string, number>()
      for (const t of cancelledInPeriod(allTasks, activeIds, week)) {
        const name = t.designer_id ? byId.get(t.designer_id)?.name : undefined
        if (name) topThisWeek.set(name, (topThisWeek.get(name) ?? 0) + 1)
      }
      const top = [...topThisWeek.entries()].sort((a, b) => b[1] - a[1])[0]
      const direction =
        nowCount > prevCount ? 'rising' : nowCount < prevCount ? 'falling' : 'holding steady'
      verdicts.push({
        id: 'cancellation-trend',
        severity: nowCount > 0 ? (nowCount > prevCount ? 'critical' : 'warning') : 'info',
        text:
          nowCount > 0
            ? `${nowCount} cancellation${nowCount === 1 ? '' : 's'} this week vs ${prevCount} at this point last week — ${direction}${top ? `; ${firstName(top[0])} accounts for ${top[1]}` : ''}.`
            : `No cancellations this week (${prevCount} at this point last week) — the trend is what matters, and it's clean.`,
        detail:
          'Cancelled = designer-fault terminal loss by definition; complete ≠ business win (§2). Review the trails below before acting.',
      })
    }

    return { groups, verdicts, total: cancelledQ.data.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, designersQ.data, cancelledQ.data, tasksQ.data, openQ.data])

  const selectedDesigner =
    selected?.designer_id && designersQ.data
      ? (designersQ.data.find((d) => d.id === selected.designer_id) ?? null)
      : null
  const selectedUrl = clickupTaskUrl(selected?.task_id)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold text-fg">Cancellations</h1>
        <p className="mt-1 text-sm text-muted">
          Every designer-fault terminal loss, with its full history one click away — the 10-second
          fault review (§4.4)
        </p>
      </header>

      {failed != null && (
        <ErrorBanner
          message={`Couldn't load cancellations — ${(failed as Error).message}`}
          asOf={
            cancelledQ.dataUpdatedAt > 0 ? fmtTime(new Date(cancelledQ.dataUpdatedAt).toISOString()) : null
          }
          onRetry={() => {
            void cancelledQ.refetch()
            void tasksQ.refetch()
          }}
        />
      )}

      <VerdictBlock
        title="The cancellation read"
        items={model?.verdicts ?? []}
        emptyMessage="No cancellations on record — nothing has been lost to designer fault."
        loading={loading}
      />

      {/* §4.4 integrity caveat — surfaced, never hidden; quiet, not alarming. */}
      <p className="flex items-start gap-2 text-sm text-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Cancellation fault is judged by the CSR at close — treat as a flag to investigate, not a
        verdict; act on the trend.
      </p>

      {loading && (
        <div className="space-y-3" role="status" aria-label="Loading cancellations">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      )}

      {!loading && model && model.total === 0 && (
        <EmptyState
          icon={OctagonX}
          title="No cancellations on record"
          hint="When a CSR sets a task to cancelled it lands here instantly, with its full status trail."
        />
      )}

      {model?.groups.map((g) => (
        <section
          key={g.designer?.id ?? 'unassigned'}
          className="card animate-fade-in p-6"
          aria-label={`Cancellations — ${g.designer?.name ?? 'unassigned'}`}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="text-base font-semibold text-fg">{g.designer?.name ?? 'Unassigned list'}</h2>
            {g.designer && <Badge tone="neutral">{g.designer.team}</Badge>}
            <Badge tone="danger" icon={OctagonX}>
              {g.tasks.length} cancelled
            </Badge>
            <span className="tnum text-xs text-muted">
              {g.assigned12w > 0
                ? `${g.cancelled12w} of ${g.assigned12w} assigned in the last 12 weeks — ${Math.round((g.cancelled12w / g.assigned12w) * 100)}% cancellation rate`
                : 'no assignments in the last 12 weeks'}
            </span>
          </div>
          <ul className="mt-3 divide-y divide-border/50">
            {g.tasks.map((t) => (
              <li key={t.task_id}>
                <button
                  type="button"
                  onClick={() => setSelected(t)}
                  className="flex min-h-[2.75rem] w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-2 text-left transition-colors duration-150 hover:bg-surface-2"
                  aria-label={`Open the status trail for ${t.name ?? t.task_id}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {t.name ?? t.task_id}
                  </span>
                  <span className="tnum text-xs text-muted">
                    assigned {fmtDate(t.created_at)} · cancelled {fmtDateTime(t.closed_at ?? t.last_event_at)}
                  </span>
                  <span className="text-xs font-medium text-brand">View trail</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Drawer
        open={selected != null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? 'Cancelled task'}
        wide
      >
        {selected && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status="cancelled" />
              {selectedDesigner && (
                <Badge tone="neutral">
                  {selectedDesigner.name} · {selectedDesigner.team}
                </Badge>
              )}
              {selectedUrl && (
                <a
                  href={selectedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 text-sm font-medium text-fg transition-colors duration-150 hover:bg-surface-2"
                >
                  Open in ClickUp
                  <ExternalLink className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              )}
            </div>
            <dl className="tnum grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted">Assigned</dt>
                <dd className="text-fg">{fmtDateTime(selected.created_at)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Cancelled</dt>
                <dd className="text-fg">{fmtDateTime(selected.closed_at ?? selected.last_event_at)}</dd>
              </div>
            </dl>
            <p className="flex items-start gap-2 rounded-xl bg-surface-2/70 p-3 text-xs text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Fault here is the CSR's call at close — read the trail, then judge the pattern across
              weeks, not this row alone (§4.4).
            </p>
            <div>
              <h3 className="eyebrow mb-3">Status trail</h3>
              <TaskTrail taskId={selected.task_id} />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
