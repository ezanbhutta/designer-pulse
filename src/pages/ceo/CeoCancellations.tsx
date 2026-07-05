/**
 * CEO Cancellations (spec §13.2, §4.4): every cancelled task, one click to
 * its full status trail — the 10-second fault review. Cancelled is
 * designer-fault terminal by definition (§2), but fault attribution rests on
 * CSR judgment at close, so the integrity caveat rides the page as a quiet
 * info line and every judgment is aimed at the TREND, not a single row.
 * Grouped by designer with count + cancellation rate. Read-only (§22.1).
 */

import { useMemo, useState } from 'react'
import { ChevronRight, ExternalLink, Info, OctagonX } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge } from '../../components/ui/Badge'
import { Drawer } from '../../components/ui/Drawer'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InfoTip } from '../../components/ui/InfoTip'
import { Skeleton } from '../../components/ui/Skeleton'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { TaskTrail } from '../../components/shared/TaskTrail'
import { CalmClear, CornerTip, HeroMetric, Reveal, RevealItem } from './ceoKit'
import { pktDateOf, pktToday } from '../../../shared/pkt'
import type { Designer, TaskState } from '../../../shared/types'
import { clickupTaskUrl } from '../../lib/queries'
import { fmtClock, fmtDate } from '../../lib/format'
import {
  activeDesigners,
  cancelledInPeriod,
  firstName,
  mergeTasks,
  metricDelta,
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
        nowCount > prevCount ? 'going up' : nowCount < prevCount ? 'going down' : 'holding steady'
      verdicts.push({
        id: 'cancellation-trend',
        severity: nowCount > 0 ? (nowCount > prevCount ? 'critical' : 'warning') : 'info',
        text:
          nowCount > 0
            ? `${nowCount} order${nowCount === 1 ? '' : 's'} lost this week, next to ${prevCount} at this point last week, which is ${direction}${top ? `, with ${firstName(top[0])} accounting for ${top[1]}` : ''}.`
            : `No orders lost this week (${prevCount} at this point last week). The pattern over time is what matters, and it looks clean.`,
        detail:
          '"Cancelled" here always means an order lost because of a design problem. Open the full stories below before acting on anyone.',
      })
    }

    return { groups, verdicts, total: cancelledQ.data.length, nowCount, prevCount }
    // `today` stands in for week/prior/windowStart (all pure functions of it)
    // so the model recomputes at the PKT day/week rollover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, designersQ.data, cancelledQ.data, tasksQ.data, openQ.data, today])

  const selectedDesigner =
    selected?.designer_id && designersQ.data
      ? (designersQ.data.find((d) => d.id === selected.designer_id) ?? null)
      : null
  const selectedUrl = clickupTaskUrl(selected?.task_id)

  return (
    <div className="mx-auto w-full max-w-6xl space-y-12">
      <PageHeader
        breadcrumbs={['CEO', 'Cancellations']}
        title="Cancellations"
        titleAccessory={
          <InfoTip text="Orders lost because of design problems. Open each one to see its full story before judging anyone." />
        }
        history="Every order lost because of a design problem, with its full history one click away"
      />

      {failed != null && (
        <ErrorBanner
          message={`We could not load the cancellations just now, because ${(failed as Error).message}`}
          asOf={
            cancelledQ.dataUpdatedAt > 0 ? fmtClock(new Date(cancelledQ.dataUpdatedAt).toISOString()) : null
          }
          onRetry={() => {
            void cancelledQ.refetch()
            void tasksQ.refetch()
          }}
        />
      )}

      <CornerTip tip="How this week's lost orders compare with last week, since the pattern over time matters more than any single order.">
        <VerdictBlock
          title="The picture this week"
          items={model?.verdicts ?? []}
          emptyMessage="No lost orders on record. Nothing has been cancelled because of design problems."
          loading={loading}
        />
      </CornerTip>

      {/* ── The headline number: lost orders this week, calm even at zero ──── */}
      <HeroMetric
        eyebrow="Lost this week"
        tip="Orders cancelled because of design problems since Monday, compared with the same days last week."
        value={model ? model.nowCount : null}
        delta={
          model
            ? metricDelta(model.nowCount, model.prevCount, {
                goodWhen: 'down',
                vs: 'compared with the same days last week',
              })
            : null
        }
        caption="The pattern over weeks matters more than any single order, so open each story below before acting on anyone."
        loading={loading}
      />

      {/* §4.4 integrity caveat — surfaced, never hidden; quiet, not alarming. */}
      <p className="flex max-w-prose items-start gap-2 text-caption text-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Whether a cancellation was the designer&apos;s fault is decided by the person who closed
        the order. Treat each one as something to look into, not a final judgement, and watch the
        pattern over weeks.
      </p>

      {loading && (
        <div className="space-y-8" role="status" aria-label="Loading cancellations">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      )}

      {!loading && model && model.total === 0 && (
        <CalmClear
          title="No cancellations on record"
          message="Nothing has ever been lost to a design problem. If an order is cancelled, it will show up here right away with its full history."
        />
      )}

      {model && model.groups.length > 0 && (
        <Reveal className="space-y-8">
          {model.groups.map((g) => (
            <RevealItem key={g.designer?.id ?? 'unassigned'}>
              <section
                className="card p-8"
                aria-label={`Cancellations for ${g.designer?.name ?? 'unassigned'}`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h2 className="text-card text-fg">{g.designer?.name ?? 'No designer assigned'}</h2>
                  {g.designer && <Badge tone="neutral">{g.designer.team}</Badge>}
                  <Badge tone="danger" icon={OctagonX}>
                    {g.tasks.length} cancelled
                  </Badge>
                  <span className="tnum inline-flex items-center gap-1 text-label font-normal text-muted">
                    {g.assigned12w > 0
                      ? `${g.cancelled12w} of the ${g.assigned12w} projects given in the last 12 weeks ended cancelled, which is ${Math.round((g.cancelled12w / g.assigned12w) * 100)}%`
                      : 'no projects given in the last 12 weeks'}
                    <InfoTip text="Out of everything this designer was given in the last 12 weeks, the share that ended cancelled. A pattern here matters more than one bad order." />
                  </span>
                </div>
                <ul className="mt-6 divide-y divide-border/50">
                  {g.tasks.map((t) => (
                    <li key={t.task_id}>
                      <button
                        type="button"
                        onClick={() => setSelected(t)}
                        className="group flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-2.5 text-left transition-colors duration-150 hover:bg-surface-2"
                        aria-label={`See the full history of ${t.name ?? t.task_id}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg">
                          {t.name ?? t.task_id}
                        </span>
                        <span className="tnum text-label font-normal text-muted">
                          given {fmtDate(t.created_at)} and cancelled {fmtDate(t.closed_at ?? t.last_event_at)} at{' '}
                          {fmtClock(t.closed_at ?? t.last_event_at)}
                        </span>
                        <span className="inline-flex items-center gap-0.5 text-label text-muted transition-colors duration-150 group-hover:text-fg">
                          See history
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </RevealItem>
          ))}
        </Reveal>
      )}

      <Drawer
        open={selected != null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? 'Cancelled order'}
        wide
      >
        {selected && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status="cancelled" />
              {selectedDesigner && (
                <Badge tone="neutral">
                  {selectedDesigner.name} on the {selectedDesigner.team} team
                </Badge>
              )}
              {selectedUrl && (
                <a
                  href={selectedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 text-caption font-medium text-fg transition-colors duration-150 hover:bg-surface-2"
                >
                  Open in ClickUp
                  <ExternalLink className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              )}
            </div>
            <dl className="tnum grid grid-cols-2 gap-x-4 gap-y-2 text-caption">
              <div>
                <dt className="text-label font-normal text-muted">Given to the designer</dt>
                <dd className="text-fg">
                  {fmtDate(selected.created_at)} at {fmtClock(selected.created_at)}
                </dd>
              </div>
              <div>
                <dt className="text-label font-normal text-muted">Cancelled</dt>
                <dd className="text-fg">
                  {fmtDate(selected.closed_at ?? selected.last_event_at)} at{' '}
                  {fmtClock(selected.closed_at ?? selected.last_event_at)}
                </dd>
              </div>
            </dl>
            <p className="flex items-start gap-2 rounded-xl bg-surface-2/70 p-3 text-label font-normal text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Fault was decided by the person who closed this order. Read the history below, then
              judge the pattern across weeks rather than this one order alone.
            </p>
            <div>
              <h3 className="eyebrow mb-3 inline-flex items-center gap-1">
                Full history{' '}
                <InfoTip text="Every step this order went through, from start to cancellation." />
              </h3>
              <TaskTrail taskId={selected.task_id} />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
