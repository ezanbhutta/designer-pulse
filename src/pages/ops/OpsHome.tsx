import { useEffect, useMemo, useState } from 'react'
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
import { InfoTip } from '../../components/ui/InfoTip'
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
  ageMinutes,
  expectedQuotaOn,
  scheduleFor,
} from '../../../shared/aggregate'
import { STATUS_LABELS } from '../../../shared/statuses'
import type { TaskState } from '../../../shared/types'
import {
  agingThresholdMin,
  closedOn,
  createdOn,
  firstName,
  metricDelta,
  minutesSinceShiftStart,
  slotsFilledToday,
  useActiveDesigners,
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
 * Label + ⓘ for StatTile's string-typed `eyebrow` (copy-pass workaround, local
 * to this file — StatTile's props are owned elsewhere). The node keeps a
 * readable toString so StatTile's template-literal aria-labels stay sensible.
 */
function labelTip(label: string, tip: string): string {
  const node = (
    <span className="inline-flex items-center gap-1">
      {label}
      <InfoTip text={tip} />
    </span>
  )
  return Object.assign({}, node, { toString: () => label }) as unknown as string
}

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
  // Minute tick so an unattended cockpit rolls over PKT midnight and task
  // ages/shift math never freeze at the last render.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  const today = pktToday(now)
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

  const designers = useActiveDesigners()
  const designerById = useMemo(
    () => new Map((designersQ.data ?? []).map((d) => [d.id, d])),
    [designersQ.data],
  )
  const openTasks = openTasksQ.data ?? []
  const recentTasks = tasksQ.data ?? []

  const derived = useMemo(() => {
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
      // Owner's rule: ONLY projects due today are today's plate — status and
      // creation date don't matter.
      const filled = slotsFilledToday(openTasks, recentTasks, d.id, today)
      return {
        designer: d,
        expected,
        schedule,
        sinceShift,
        assigned,
        filled,
        spare: expected - filled,
        util: expected > 0 ? Math.round((filled / expected) * 100) : null,
      }
    })

    const agingTasks = openTasks
      .map((t) => ({ task: t, age: ageMinutes(t, now), threshold: agingThresholdMin(t.current_status, cfg) }))
      .filter((x) => x.age >= x.threshold)
      .sort((a, b) => b.age - a.age)

    const totalExpected = rows.reduce((s, r) => s + r.expected, 0)
    const totalAssignedToday = rows.reduce((s, r) => s + r.assigned, 0)
    const totalFilled = rows.reduce((s, r) => s + r.filled, 0)

    // Like-for-like deltas: today-so-far is compared with yesterday UP TO THE
    // SAME TIME OF DAY, never with all of yesterday — otherwise every morning
    // reads as a big fake drop.
    const cutoffMs = now.getTime() - 86_400_000
    const assignedYesterday = recentTasks.filter(
      (t) =>
        t.designer_id &&
        createdOn(t, yesterday) &&
        new Date(t.created_at as string).getTime() <= cutoffMs,
    ).length
    const completedTodayTasks = recentTasks.filter((t) => closedOn(t, today, 'complete'))
    const completedYesterday = recentTasks.filter((t) => {
      if (!closedOn(t, yesterday, 'complete')) return false
      const at = t.closed_at ?? t.last_event_at
      return at != null && new Date(at).getTime() <= cutoffMs
    }).length

    return {
      rows,
      agingTasks,
      totalExpected,
      totalAssignedToday,
      totalFilled,
      assignedYesterday,
      completedTodayTasks,
      completedYesterday,
    }
  }, [recentTasks, designers, openTasks, ctx, cfg, today, yesterday, now])

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
          `${d?.name ?? 'A designer'} has open slots — they can take more projects today`,
        detail: row
          ? `Has ${row.filled} of ${row.expected} projects due today. Handing out work is the team lead's job, not theirs.`
          : undefined,
        action: href
          ? { label: `Open ${d ? firstName(d.name) : 'the'} list in ClickUp`, href }
          : { label: 'Open Alerts', onClick: () => navigate('/ops/alerts') },
      })
    }

    // 2. Aging open tasks, worst first. Tasks waiting on the client are never
    // here — waiting for a reply is normal, not an error.
    for (const { task, age, threshold } of derived.agingTasks.slice(0, 5)) {
      const d = task.designer_id ? designerById.get(task.designer_id) : undefined
      const href = clickupTaskUrl(task.task_id)
      items.push({
        id: `age-${task.task_id}`,
        severity: age >= threshold * 2 ? 'critical' : 'warning',
        text: `"${task.name ?? task.task_id}" stuck in ${
          task.current_status ? STATUS_LABELS[task.current_status] : 'one stage'
        } for ${fmtDuration(age)}`,
        detail: `${d?.name ?? 'No one yet'} · flagged after ${Math.round(threshold / (24 * 60))} days without moving`,
        action: href ? { label: 'Open in ClickUp', href } : undefined,
      })
    }

    // 3. Fresh cancellations — designer-fault terminal loss (last 24h).
    const dayAgo = Date.now() - 24 * 3600_000
    for (const t of recentCancelled.filter((x) => {
      const at = x.closed_at ?? x.last_event_at
      return at != null && new Date(at).getTime() >= dayAgo
    })) {
      const d = t.designer_id ? designerById.get(t.designer_id) : undefined
      items.push({
        id: `cancel-${t.task_id}`,
        severity: 'critical',
        text: `Cancelled: "${t.name ?? t.task_id}"${d ? ` — ${d.name}` : ''}`,
        detail: 'The order was lost because of a design problem. Check the project history before judging anyone.',
        // The 10-second fault check happens in-app: the trail drawer shows the
        // full history (with the ClickUp deep link inside, one tap away).
        action: { label: 'See what happened', onClick: () => setTrailTask(t) },
      })
    }

    // 4. Forgotten checkouts / needs-review attendance.
    for (const row of (attendanceQ.data ?? []).filter((a) => a.needs_review)) {
      const d = designerById.get(row.designer_id)
      items.push({
        id: `review-${row.id}`,
        severity: 'info',
        text: `Double-check ${d?.name ?? 'a designer'}'s day — the system closed it because they forgot to press Check out`,
        detail: 'There was no check-out and no sign of work. Please confirm before the day counts.',
        action: { label: 'Open Attendance', onClick: () => navigate('/ops/attendance') },
      })
    }

    // 5. Spare-capacity insight: under quota now, shift running, no alert yet.
    const alertedIds = new Set(
      alerts.filter((x) => x.alert_type === 'assignment_gap' && x.status === 'open').map((x) => x.designer_id),
    )
    for (const r of derived.rows) {
      if (r.expected <= 0 || alertedIds.has(r.designer.id)) continue
      if (r.sinceShift == null || r.sinceShift < cfg.assignment_gap_check_offset_min) continue
      const slots = r.expected - r.filled
      if (slots <= 0) continue
      const href = clickupListUrl(r.designer.clickup_list_id)
      items.push({
        id: `slots-${r.designer.id}`,
        severity: 'info',
        text: `${r.designer.name} has ${slots} open slot${slots === 1 ? '' : 's'} — ${
          firstName(r.designer.name)
        } can take more projects today`,
        detail: `Has ${r.filled} of ${r.expected} projects due today · day started ${
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
      ? Math.round((derived.totalFilled / derived.totalExpected) * 100)
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
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Team overview · {fmtDate(today)} · all times PKT</p>
        <h1 className="mt-1 inline-flex items-center gap-2 text-3xl font-semibold text-fg">
          Today
          <InfoTip text="A live picture of today — what needs you, today's numbers, who has room for more work, and what is stuck." />
        </h1>
      </header>

      {openTasksQ.error && (
        <ErrorBanner
          message="Could not load the latest projects — you are seeing the last saved view."
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
        emptyMessage="Nothing needs you right now — everyone has enough work and nothing is stuck."
        loading={loading || alertsQ.isLoading}
      />

      {/* ── Today's numbers (§20.2: delta + cause on every tile) ── */}
      <section aria-label="Today's numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          eyebrow={labelTip(
            'Given out today',
            "How many new projects were handed to designers today, out of the team's total for the day.",
          )}
          icon={PackagePlus}
          value={`${derived.totalAssignedToday} of ${derived.totalExpected}`}
          delta={metricDelta(derived.totalAssignedToday, derived.assignedYesterday, {
            goodWhen: 'up',
            vs: 'vs yesterday by this time',
          })}
          cause={
            underQuotaCount > 0
              ? `${underQuotaCount} ${underQuotaCount === 1 ? 'person still needs' : 'people still need'} more work`
              : 'everyone working today has enough work'
          }
          state={underQuotaCount > 0 ? 'watch' : 'ok'}
          loading={tasksQ.isLoading}
        />
        <StatTile
          eyebrow={labelTip('Finished today', 'Projects closed as done today.')}
          icon={CheckCircle2}
          value={String(derived.completedTodayTasks.length)}
          delta={metricDelta(derived.completedTodayTasks.length, derived.completedYesterday, {
            goodWhen: 'up',
            vs: 'vs yesterday by this time',
          })}
          cause={
            derived.completedTodayTasks.length > 0
              ? `${completedClean} of ${derived.completedTodayTasks.length} were right first time — no changes asked`
              : 'nothing finished yet today'
          }
          loading={tasksQ.isLoading || metricsQ.isLoading}
        />
        <StatTile
          eyebrow={labelTip(
            'Fixes in progress',
            'Projects where someone asked for changes and the designer is fixing them now.',
          )}
          icon={RotateCcw}
          value={String(openRevisions.length)}
          delta={metricDelta(openRevisions.length, revisionsAtDayStart, {
            goodWhen: 'down',
            vs: 'vs start of day',
          })}
          cause={
            openRevisions.length > 0
              ? `${csrRounds} caught by our checkers · ${clientRounds} caught by clients`
              : 'no fixes in progress right now'
          }
          state={openRevisions.length > 0 ? 'watch' : 'ok'}
          loading={openTasksQ.isLoading}
          // Land on the stage-grouped board so the revision column is visible
          // no matter which grouping was used last.
          onClick={() => navigate('/ops/board?group=status')}
        />
        <StatTile
          eyebrow={labelTip(
            'Busy level',
            "How full today's plates are — only projects DUE today count, compared to today's total target.",
          )}
          icon={Gauge}
          value={fmtPct(utilization)}
          cause={`${derived.totalFilled} projects due today across ${designers.length} ${
            designers.length === 1 ? 'person' : 'people'
          }`}
          reference={
            heaviest && heaviest.util != null
              ? `busiest: ${heaviest.designer.name} at ${heaviest.util}%`
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
            <h2 className="inline-flex items-center gap-1 text-lg font-semibold text-fg">
              Who has room for more
              <InfoTip text="People who can take more projects today. Only projects DUE today fill a plate — status doesn't matter. Giving them work is the team lead's job, not theirs." />
            </h2>
            <span className="text-xs text-muted">most free first</span>
          </div>
          <div className="mt-4 space-y-1">
            {loading ? (
              [0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12" />)
            ) : spareRows.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No one is scheduled to work today"
                hint="This happens on holidays, days off and leave."
              />
            ) : !anySpare ? (
              <EmptyState
                icon={CheckCircle2}
                title="Everyone's plate is full"
                hint="Everyone has reached their target for today. Extra work will need to wait or be shared out differently."
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
                        {r.filled} due today, target {r.expected}
                        {r.spare > 0
                          ? ` — ${r.spare} open slot${r.spare === 1 ? '' : 's'}`
                          : r.spare < 0
                            ? ` — ${-r.spare} over their target`
                            : ' — at their target'}
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
                        className="flex h-11 w-11 items-center justify-center rounded-xl text-brand hover:bg-brand-soft"
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
            <h2 className="inline-flex items-center gap-1 text-lg font-semibold text-fg">
              Stuck projects
              <InfoTip text="Projects that have not moved for too long. The ones waiting on clients are the most important to chase." />
            </h2>
            <Link
              to="/ops/board"
              className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
            >
              Open the board <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <div className="mt-4 space-y-2">
            {openTasksQ.isLoading ? (
              [0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)
            ) : derived.agingTasks.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="Nothing is stuck"
                hint={`Nothing has sat still for more than ${cfg.aging_days_default} days. Waiting for a client never counts as stuck.`}
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
                +{derived.agingTasks.length - 5} more on the Board page
              </p>
            )}
          </div>
        </section>
      </div>

      <Drawer
        open={trailTask != null}
        onClose={() => setTrailTask(null)}
        title={trailTask?.name ?? 'Project history'}
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
