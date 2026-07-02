import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Gauge,
  Inbox,
  PackagePlus,
  RotateCcw,
} from 'lucide-react'
import { Drawer } from '../../components/ui/Drawer'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { StatTile } from '../../components/ui/StatTile'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { TaskCard } from '../../components/shared/TaskCard'
import { TaskTrail } from '../../components/shared/TaskTrail'
import {
  STALE_LIVE,
  clickupListUrl,
  clickupTaskUrl,
  fetchCancelledTasks,
  qk,
} from '../../lib/queries'
import { fmtDate, fmtDuration, fmtPct, fmtShiftTime, fmtTime } from '../../lib/format'
import { addDays, pktInstant, pktToday } from '../../../shared/pkt'
import {
  activeLoad,
  ageMinutes,
  expectedQuotaOn,
  scheduleFor,
  utilizationPct,
} from '../../../shared/aggregate'
import { STATUS_LABELS } from '../../../shared/statuses'
import type { TaskState } from '../../../shared/types'
import {
  activeDesigners,
  agingThresholdMin,
  closedOn,
  createdOn,
  firstName,
  metricDelta,
  minutesSinceShiftStart,
  useAttendanceRange,
  useConfigValues,
  useDesignerDrawer,
  useDesigners,
  useMetricsSince,
  useOpenAlerts,
  useOpenTasks,
  useQuotaCtx,
  useTasksSince,
} from './opsData'

/**
 * The Ops attention surface (spec §13.1 / §20.11): what needs a human NOW,
 * ranked — assignment gaps, aging tasks (the client-response swamp called
 * out), fresh cancellations, attendance flags — then today's numbers with
 * deltas and causes, spare capacity, and the aging preview.
 */
export default function OpsHome() {
  const navigate = useNavigate()
  const openDesigner = useDesignerDrawer()
  const cfg = useConfigValues()
  const today = pktToday()
  const yesterday = addDays(today, -1)

  const designersQ = useDesigners()
  const { ctx } = useQuotaCtx()
  const openTasksQ = useOpenTasks()
  const alertsQ = useOpenAlerts()
  const attendanceQ = useAttendanceRange(today, today)
  const tasksQ = useTasksSince(yesterday)
  const metricsQ = useMetricsSince(yesterday, today)
  // Standard limit from the query fn; this surface only needs the newest 50.
  const cancelledQ = useQuery({
    queryKey: qk.cancelledTasks,
    queryFn: () => fetchCancelledTasks(),
    staleTime: STALE_LIVE,
  })
  const recentCancelled = useMemo(() => (cancelledQ.data ?? []).slice(0, 50), [cancelledQ.data])

  const [trailTask, setTrailTask] = useState<TaskState | null>(null)

  const designers = activeDesigners(designersQ.data)
  const designerById = useMemo(
    () => new Map((designersQ.data ?? []).map((d) => [d.id, d])),
    [designersQ.data],
  )
  const openTasks = openTasksQ.data ?? []
  const recentTasks = tasksQ.data ?? []

  const derived = useMemo(() => {
    const now = new Date()
    const assignedToday = new Map<string, number>()
    for (const t of recentTasks) {
      if (t.designer_id && createdOn(t, today)) {
        assignedToday.set(t.designer_id, (assignedToday.get(t.designer_id) ?? 0) + 1)
      }
    }

    const rows = designers.map((d) => {
      const expected = expectedQuotaOn(d.id, today, ctx)
      const schedule = scheduleFor(ctx.schedules, d.id, today)
      const sinceShift = minutesSinceShiftStart(schedule, today, now)
      const assigned = assignedToday.get(d.id) ?? 0
      const load = activeLoad(openTasks, d.id)
      return {
        designer: d,
        expected,
        schedule,
        sinceShift,
        assigned,
        load,
        spare: expected - load,
        util: utilizationPct(openTasks, d.id, expected),
      }
    })

    const agingTasks = openTasks
      .map((t) => ({ task: t, age: ageMinutes(t, now), threshold: agingThresholdMin(t.current_status, cfg) }))
      .filter((x) => x.age >= x.threshold)
      .sort((a, b) => b.age - a.age)

    const totalExpected = rows.reduce((s, r) => s + r.expected, 0)
    const totalAssignedToday = rows.reduce((s, r) => s + r.assigned, 0)
    const totalLoad = rows.reduce((s, r) => s + r.load, 0)

    const assignedYesterday = recentTasks.filter(
      (t) => t.designer_id && createdOn(t, yesterday),
    ).length
    const completedTodayTasks = recentTasks.filter((t) => closedOn(t, today, 'complete'))
    const completedYesterday = recentTasks.filter((t) => closedOn(t, yesterday, 'complete')).length

    return {
      rows,
      agingTasks,
      totalExpected,
      totalAssignedToday,
      totalLoad,
      assignedYesterday,
      completedTodayTasks,
      completedYesterday,
    }
  }, [recentTasks, designers, openTasks, ctx, cfg, today, yesterday])

  // ── Verdict items, ranked (§20.1) ───────────────────────────────────────────
  const verdictItems = useMemo(() => {
    const items: VerdictItem[] = []
    const alerts = alertsQ.data ?? []

    // 1. Assignment gaps past shift-start + offset (fired by the pulse cron).
    for (const a of alerts.filter((x) => x.alert_type === 'assignment_gap' && x.status === 'open')) {
      const d = a.designer_id ? designerById.get(a.designer_id) : undefined
      const row = derived.rows.find((r) => r.designer.id === a.designer_id)
      const href = d ? clickupListUrl(d.clickup_list_id) : null
      items.push({
        id: `gap-${a.id}`,
        severity: 'warning',
        text:
          a.message ??
          `${d?.name ?? 'A designer'} is under quota past shift-start +${cfg.assignment_gap_check_offset_min}m`,
        detail: row
          ? `${row.assigned} assigned of ${row.expected} expected today — idle paid capacity, attributed to assignment, not the designer`
          : undefined,
        action: href
          ? { label: `Open ${d ? firstName(d.name) : 'the'} list in ClickUp`, href }
          : { label: 'Review in Alerts', onClick: () => navigate('/ops/alerts') },
      })
    }

    // 2. Aging open tasks, worst first — client response called out (§20.3).
    for (const { task, age, threshold } of derived.agingTasks.slice(0, 5)) {
      const d = task.designer_id ? designerById.get(task.designer_id) : undefined
      const days = Math.floor(age / (24 * 60))
      const href = clickupTaskUrl(task.task_id)
      if (task.current_status === 'client response') {
        items.push({
          id: `age-${task.task_id}`,
          severity: age >= threshold * 2 ? 'critical' : 'warning',
          text: `Nudge client — "${task.name ?? task.task_id}" parked ${days} day${days === 1 ? '' : 's'} in client response`,
          detail: `${d?.name ?? 'Unassigned'} · client-owned wait; never counts against the designer (§4.1)`,
          action: href ? { label: 'Open task in ClickUp', href } : undefined,
        })
      } else {
        items.push({
          id: `age-${task.task_id}`,
          severity: age >= threshold * 2 ? 'critical' : 'warning',
          text: `"${task.name ?? task.task_id}" stuck in ${
            task.current_status ? STATUS_LABELS[task.current_status] : 'its status'
          } for ${fmtDuration(age)}`,
          detail: `${d?.name ?? 'Unassigned'} · threshold ${Math.round(threshold / (24 * 60))} days`,
          action: href ? { label: 'Open task in ClickUp', href } : undefined,
        })
      }
    }

    // 3. Fresh cancellations — designer-fault terminal loss (last 24h).
    const dayAgo = Date.now() - 24 * 3600_000
    for (const t of recentCancelled.filter((x) => {
      const at = x.closed_at ?? x.last_event_at
      return at != null && new Date(at).getTime() >= dayAgo
    })) {
      const d = t.designer_id ? designerById.get(t.designer_id) : undefined
      const href = clickupTaskUrl(t.task_id)
      items.push({
        id: `cancel-${t.task_id}`,
        severity: 'critical',
        text: `Cancelled: "${t.name ?? t.task_id}"${d ? ` — ${d.name}` : ''}`,
        detail: 'Designer-fault terminal loss by definition (§2) — review the trail before judging (§4.4)',
        action: href ? { label: 'Open task in ClickUp', href } : undefined,
      })
    }

    // 4. Forgotten checkouts / needs-review attendance.
    for (const row of (attendanceQ.data ?? []).filter((a) => a.needs_review)) {
      const d = designerById.get(row.designer_id)
      items.push({
        id: `review-${row.id}`,
        severity: 'info',
        text: `Verify ${d?.name ?? 'a designer'}'s day — auto-closed at shift end with no ClickUp activity`,
        detail: 'No check-out and nothing corroborates work (§9.2) — confirm before it counts',
        action: { label: 'Open attendance', onClick: () => navigate('/ops/attendance') },
      })
    }

    // 5. Spare-capacity insight: under quota now, shift running, no alert yet.
    const alertedIds = new Set(
      alerts.filter((x) => x.alert_type === 'assignment_gap' && x.status === 'open').map((x) => x.designer_id),
    )
    for (const r of derived.rows) {
      if (r.expected <= 0 || alertedIds.has(r.designer.id)) continue
      if (r.sinceShift == null || r.sinceShift < cfg.assignment_gap_check_offset_min) continue
      const slots = r.expected - r.assigned
      if (slots <= 0) continue
      const href = clickupListUrl(r.designer.clickup_list_id)
      items.push({
        id: `slots-${r.designer.id}`,
        severity: 'info',
        text: `${r.designer.name} has ${slots} open slot${slots === 1 ? '' : 's'} — open ${
          firstName(r.designer.name)
        }'s list in ClickUp`,
        detail: `${r.assigned} assigned of ${r.expected} expected · shift started ${
          r.schedule ? fmtShiftTime(r.schedule.shift_start) : '—'
        } PKT`,
        action: href ? { label: 'Open list in ClickUp', href } : undefined,
      })
    }

    const rank = { critical: 0, warning: 1, info: 2 } as const
    return items.sort((a, b) => rank[a.severity] - rank[b.severity])
  }, [alertsQ.data, recentCancelled, attendanceQ.data, derived, designerById, cfg, navigate])

  // ── Today's tiles ───────────────────────────────────────────────────────────
  const underQuotaCount = derived.rows.filter(
    (r) =>
      r.expected > 0 &&
      r.assigned < r.expected &&
      r.sinceShift != null &&
      r.sinceShift >= cfg.assignment_gap_check_offset_min,
  ).length

  const completedIds = new Set(derived.completedTodayTasks.map((t) => t.task_id))
  const completedClean = (metricsQ.data ?? []).filter(
    (m) => completedIds.has(m.task_id) && m.first_pass_clean,
  ).length

  const openRevisions = openTasks.filter((t) => t.current_status === 'revision')
  // Prior-day reference: revisions still open that ENTERED revision before
  // today's PKT day started — the carry-over the team woke up to. Historical
  // open counts aren't stored, so this is the honest available comparison.
  const dayStartMs = pktInstant(today, '00:00').getTime()
  const revisionsAtDayStart = openRevisions.filter((t) => {
    const at = t.last_event_at ?? t.created_at
    return at != null && new Date(at).getTime() < dayStartMs
  }).length
  const revisionIds = new Set(openRevisions.map((t) => t.task_id))
  const revMetrics = (metricsQ.data ?? []).filter((m) => revisionIds.has(m.task_id))
  const csrRounds = revMetrics.reduce((s, m) => s + m.csr_caught_rounds, 0)
  const clientRounds = revMetrics.reduce((s, m) => s + m.client_caught_rounds, 0)

  const utilization =
    derived.totalExpected > 0
      ? Math.round((derived.totalLoad / derived.totalExpected) * 100)
      : null
  const heaviest = [...derived.rows]
    .filter((r) => r.util != null)
    .sort((a, b) => (b.util ?? 0) - (a.util ?? 0))[0]

  const spareRows = derived.rows
    .filter((r) => r.expected > 0)
    .sort((a, b) => b.spare - a.spare)
  const anySpare = spareRows.some((r) => r.spare > 0)

  const loading = openTasksQ.isLoading || tasksQ.isLoading

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Ops cockpit · {fmtDate(today)} · all times PKT</p>
        <h1 className="mt-1 text-3xl font-semibold text-fg">Today</h1>
      </header>

      {openTasksQ.error && (
        <ErrorBanner
          message="Couldn't refresh the live board — showing the last loaded tasks."
          asOf={
            openTasksQ.dataUpdatedAt > 0
              ? fmtTime(new Date(openTasksQ.dataUpdatedAt).toISOString())
              : null
          }
          onRetry={() => void openTasksQ.refetch()}
        />
      )}

      <VerdictBlock
        title="Needs attention now"
        items={verdictItems}
        emptyMessage="All designers staffed to quota, no aging tasks."
        loading={loading || alertsQ.isLoading}
      />

      {/* ── Today's numbers (§20.2: delta + cause on every tile) ── */}
      <section aria-label="Today's numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          eyebrow="Assigned today"
          icon={PackagePlus}
          value={`${derived.totalAssignedToday} of ${derived.totalExpected}`}
          delta={metricDelta(derived.totalAssignedToday, derived.assignedYesterday, {
            goodWhen: 'up',
            vs: 'vs yesterday',
          })}
          cause={
            underQuotaCount > 0
              ? `${underQuotaCount} designer${underQuotaCount === 1 ? '' : 's'} under quota past shift +${cfg.assignment_gap_check_offset_min}m`
              : 'every running shift staffed to quota'
          }
          state={underQuotaCount > 0 ? 'watch' : 'ok'}
          loading={tasksQ.isLoading}
        />
        <StatTile
          eyebrow="Completed today"
          icon={CheckCircle2}
          value={String(derived.completedTodayTasks.length)}
          delta={metricDelta(derived.completedTodayTasks.length, derived.completedYesterday, {
            goodWhen: 'up',
            vs: 'vs yesterday',
          })}
          cause={
            derived.completedTodayTasks.length > 0
              ? `${completedClean} of ${derived.completedTodayTasks.length} first-pass clean — complete ≠ business win (§2)`
              : 'nothing closed yet today'
          }
          loading={tasksQ.isLoading || metricsQ.isLoading}
        />
        <StatTile
          eyebrow="Open revisions"
          icon={RotateCcw}
          value={String(openRevisions.length)}
          delta={metricDelta(openRevisions.length, revisionsAtDayStart, {
            goodWhen: 'down',
            vs: 'vs carried in from yesterday',
          })}
          cause={
            openRevisions.length > 0
              ? `${csrRounds} CSR-caught · ${clientRounds} client-caught rounds on these tasks — designer clock running`
              : 'no recoverable defects in flight'
          }
          state={openRevisions.length > 0 ? 'watch' : 'ok'}
          loading={openTasksQ.isLoading}
          onClick={() => navigate('/ops/board')}
        />
        <StatTile
          eyebrow="Live utilization"
          icon={Gauge}
          value={fmtPct(utilization)}
          cause={`${derived.totalLoad} active tasks (pickup · in progress · revision) across ${designers.length} designers`}
          reference={
            heaviest && heaviest.util != null
              ? `heaviest: ${heaviest.designer.name} at ${heaviest.util}%`
              : null
          }
          state={utilization == null ? null : utilization > 120 ? 'watch' : 'ok'}
          loading={openTasksQ.isLoading}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* ── Spare capacity right now (§20.11 hidden insight) ── */}
        <section className="card p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold text-fg">Spare capacity right now</h2>
            <span className="text-xs text-muted">active load vs today's quota · most idle first</span>
          </div>
          <div className="mt-4 space-y-1">
            {loading ? (
              [0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12" />)
            ) : spareRows.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No one is scheduled today"
                hint="Quotas resolve to zero on holidays, leave and weekly offs."
              />
            ) : !anySpare ? (
              <EmptyState
                icon={CheckCircle2}
                title="No spare capacity"
                hint="Every scheduled designer is at or above today's quota — overflow needs the next shift or a rebalance."
              />
            ) : (
              spareRows.map((r) => {
                const href = clickupListUrl(r.designer.clickup_list_id)
                return (
                  <div
                    key={r.designer.id}
                    className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2"
                  >
                    <button
                      type="button"
                      onClick={() => openDesigner(r.designer.id)}
                      className="min-h-[2.75rem] min-w-0 flex-1 text-left"
                      aria-label={`Open ${r.designer.name}'s details`}
                    >
                      <p className="truncate text-sm font-medium text-fg">
                        {r.designer.name}
                        <span className="ml-2 text-xs font-normal text-muted">{r.designer.team}</span>
                      </p>
                      <p className="tnum text-xs text-muted">
                        {r.load} active of {r.expected} quota
                        {r.spare > 0
                          ? ` — ${r.spare} slot${r.spare === 1 ? '' : 's'} open`
                          : r.spare < 0
                            ? ` — ${-r.spare} over (drowning)`
                            : ' — at quota'}
                      </p>
                    </button>
                    <span
                      className={`tnum text-sm font-medium ${
                        r.spare > 0 ? 'text-success' : r.spare < 0 ? 'text-danger' : 'text-muted'
                      }`}
                    >
                      {fmtPct(r.util)}
                    </span>
                    {href && (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-brand hover:bg-brand-soft"
                        aria-label={`Open ${r.designer.name}'s list in ClickUp`}
                        title="Open list in ClickUp"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </section>

        {/* ── Aging preview ── */}
        <section className="card p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold text-fg">Aging tasks</h2>
            <Link
              to="/ops/board"
              className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
            >
              Full board <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <div className="mt-4 space-y-2">
            {openTasksQ.isLoading ? (
              [0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)
            ) : derived.agingTasks.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="No aging tasks — the board is clean"
                hint={`Nothing has crossed ${cfg.aging_days_default} days in a status (${cfg.aging_days_client_response} for client response).`}
              />
            ) : (
              derived.agingTasks.slice(0, 5).map(({ task }) => (
                <TaskCard
                  key={task.task_id}
                  task={task}
                  designerName={
                    task.designer_id ? designerById.get(task.designer_id)?.name : undefined
                  }
                  onOpen={() => setTrailTask(task)}
                />
              ))
            )}
            {derived.agingTasks.length > 5 && (
              <p className="text-xs text-muted">
                +{derived.agingTasks.length - 5} more on the board
              </p>
            )}
          </div>
        </section>
      </div>

      <Drawer
        open={trailTask != null}
        onClose={() => setTrailTask(null)}
        title={trailTask?.name ?? 'Task trail'}
      >
        {trailTask && (
          <div className="space-y-4">
            <a
              href={clickupTaskUrl(trailTask.task_id) ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open in ClickUp
            </a>
            <TaskTrail taskId={trailTask.task_id} />
          </div>
        )}
      </Drawer>
    </div>
  )
}
