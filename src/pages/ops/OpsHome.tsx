import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Gauge,
  PackagePlus,
  RotateCcw,
} from 'lucide-react'
import { Drawer } from '../../components/ui/Drawer'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InboxZeroReward } from '../../components/ui/InboxZeroReward'
import { InfoTip } from '../../components/ui/InfoTip'
import { OpenSection } from '../../components/ui/OpenSection'
import { StatTile } from '../../components/ui/StatTile'
import { staggerContainer } from '../../components/ui/motion'
import { PageHeader } from '../../components/layout/PageHeader'
import { DecisionCard, type Decision } from '../../components/ops/DecisionCard'
import { TaskTrail } from '../../components/shared/TaskTrail'
import {
  clearActed,
  followUp,
  loadActed,
  markActed,
  type ActedRecord,
} from '../../lib/actedOn'
import { buildDecisions } from './decisions'
import {
  STALE_LIVE,
  clickupListUrl,
  clickupTaskUrl,
  fetchCancelledTasks,
  qk,
} from '../../lib/queries'
import { fmtClock, fmtDate, fmtDurationLong, fmtPct } from '../../lib/format'
import { addDays, pktInstant, pktToday } from '../../../shared/pkt'
import {
  ageMinutes,
  agingDelay,
  expectedQuotaOn,
  scheduleFor,
} from '../../../shared/aggregate'
import { STATUS_LABELS } from '../../../shared/statuses'
import { isPerProject, type TaskState } from '../../../shared/types'
import {
  closedOn,
  createdOn,
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


/** Shared class for the quiet "Open in Work" link on a section header. */
const openInWork =
  'text-label font-medium text-brand underline-offset-2 transition-colors duration-150 hover:underline'

/** Group rows under a heading, biggest group first, so long lists read in parts. */
function byTeam<T>(rows: T[], key: (r: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    map.set(k, [...(map.get(k) ?? []), r])
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

/** How many rows a long list shows before asking to be opened further. */
const PAGE = 15

/**
 * A list of projects that pages rather than dumping. Opening a section that
 * holds a hundred projects should not put a hundred rows on the screen: the
 * first page is enough to judge, and the rest is one button away.
 */
function TaskList({
  rows,
  empty,
  designerById,
  onOpen,
}: {
  rows: Array<{ task: TaskState; age: number }>
  empty: string
  designerById: Map<string, { name: string }>
  onOpen: (t: TaskState) => void
}) {
  const [shown, setShown] = useState(PAGE)
  if (rows.length === 0) {
    return <p className="card px-5 py-4 text-caption text-muted">{empty}</p>
  }
  const visible = rows.slice(0, shown)
  return (
    <>
      <ul className="card divide-y divide-border/60 overflow-hidden">
        {visible.map(({ task, age }) => (
          <li key={task.task_id}>
            <button
              type="button"
              onClick={() => onOpen(task)}
              className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-150 hover:bg-surface-2/60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-caption font-medium text-fg">
                  {task.name ?? task.task_id}
                </span>
                <span className="block truncate text-label font-normal tracking-normal text-muted">
                  {task.designer_id
                    ? (designerById.get(task.designer_id)?.name ?? 'No designer')
                    : 'No designer'}
                  {task.current_status ? `, in ${STATUS_LABELS[task.current_status]}` : ''}
                </span>
              </span>
              <span className="tnum shrink-0 text-caption font-medium text-muted">
                {fmtDurationLong(age)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown(shown + PAGE * 4)}
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 text-caption font-medium text-fg transition-colors duration-150 hover:bg-surface-2"
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
          Show more, {rows.length - shown} still to see
        </button>
      )}
    </>
  )
}

/**
 * THE ACTION INBOX (manifesto pillar 6, adapted to real data): the page exists
 * so the Ops manager can fix blockages. The ranked verdict items ARE the page —
 * a staggered, spring-entering list where every row carries its own 1-click
 * next step (a ClickUp deep link or an in-app drill — the tool never writes to
 * ClickUp, §22.1). Empty inbox = the reward. Today's numbers are pushed below
 * as monitoring, not action.
 */
export default function OpsHome() {
  const navigate = useNavigate()
  const openDesigner = useDesignerDrawer()
  const cfg = useConfigValues()
  const reduced = useReducedMotion()
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
      .map((t) => {
        const d = agingDelay(t.current_status, cfg)
        return { task: t, age: ageMinutes(t, now), threshold: d.thresholdMin, owner: d.owner, ages: d.ages }
      })
      .filter((x) => x.ages && x.age >= x.threshold)
      .sort((a, b) => b.age - a.age)

    // "Busy level" and "Given out today" are target relative — measured against
    // the daily target. Per project designers carry no target, so their due and
    // assigned work would inflate the ratio (numerator up, zero target out of
    // the denominator). The studio target aggregates stay salaried only; per
    // project throughput still shows in "Finished today" and on the board.
    const salariedRows = rows.filter((r) => !isPerProject(r.designer))
    const totalExpected = salariedRows.reduce((s, r) => s + r.expected, 0)
    const totalAssignedToday = salariedRows.reduce((s, r) => s + r.assigned, 0)
    const totalFilled = salariedRows.reduce((s, r) => s + r.filled, 0)
    const salariedCount = salariedRows.length

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
      salariedCount,
      assignedYesterday,
      completedTodayTasks,
      completedYesterday,
    }
  }, [recentTasks, designers, openTasks, ctx, cfg, today, yesterday, now])

  // ── The decisions ───────────────────────────────────────────────────────────
  // Everything the app notices is a candidate. Only what it can fully explain
  // (urgency, reason, impact, one next step) becomes a decision and earns a
  // place at the top; the rest of what it knows lives below as evidence.
  const [acted, setActed] = useState<Record<string, ActedRecord>>(() => loadActed())

  const cancelledToday = useMemo(() => {
    const dayAgo = now.getTime() - 24 * 3600_000
    return recentCancelled.filter((t) => {
      const at = t.closed_at ?? t.last_event_at
      return at != null && new Date(at).getTime() >= dayAgo
    })
  }, [recentCancelled, now])

  const [showAllDecisions, setShowAllDecisions] = useState(false)
  const { decisions: topDecisions, all: allDecisions, heldBack } = useMemo(
    () =>
      buildDecisions({
        rows: derived.rows,
        agingTasks: derived.agingTasks,
        alerts: alertsQ.data ?? [],
        attendance: attendanceQ.data ?? [],
        cancelledToday,
        designerById,
        gapOffsetMin: cfg.assignment_gap_check_offset_min,
        clickupTaskUrl,
        clickupListUrl,
        openTaskTrail: setTrailTask,
        goToAttendance: () => navigate('/ops/attendance'),
      }),
    [derived, alertsQ.data, attendanceQ.data, cancelledToday, designerById, cfg, navigate],
  )

  // Studio Pulse cannot close anything in ClickUp, so the honest follow up is
  // to watch what happened after the manager went there. A decision that has
  // left the live list entirely is one that cleared.
  // Which list the page is showing right now.
  const decisions = showAllDecisions ? allDecisions : topDecisions
  // 'Cleared' is judged against EVERY live decision, never the visible slice,
  // or collapsing the list would fake a resolution for the ones it hid.
  const liveIds = useMemo(() => new Set(allDecisions.map((d) => d.id)), [allDecisions])
  const clearedSinceActing = useMemo(
    () => Object.values(acted).filter((r) => !liveIds.has(r.id)),
    [acted, liveIds],
  )

  const onAct = (d: Decision) =>
    setActed(markActed({ id: d.id, signature: d.signature, context: d.context }))
  const onDismissResolved = (id: string) => setActed(clearActed(id))

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

  // Split by cause, because each cause is a different job: a project a
  // designer has gone quiet on, one that is finished and waiting on us to
  // send it, one nobody is assigned to, and one whose ClickUp status the app
  // cannot read at all.
  const stalled = useMemo(() => {
    const designer: typeof derived.agingTasks = []
    const team: typeof derived.agingTasks = []
    for (const row of derived.agingTasks) {
      if (row.owner === 'team') team.push(row)
      else designer.push(row)
    }
    return { designer, team }
  }, [derived.agingTasks])

  const unassigned = useMemo(
    () =>
      openTasks
        .filter((t) => {
          const d = t.designer_id ? designerById.get(t.designer_id) : undefined
          return !d || d.status !== 'active'
        })
        .map((t) => ({ task: t, age: ageMinutes(t, now) })),
    [openTasks, designerById, now],
  )

  const unknownStatus = useMemo(
    () => openTasks.filter((t) => !t.current_status).map((t) => ({ task: t, age: ageMinutes(t, now) })),
    [openTasks, now],
  )

  const spareRows = useMemo(
    () => derived.rows.filter((r) => r.expected > 0).sort((a, b) => b.spare - a.spare),
    [derived.rows],
  )

  const loading = openTasksQ.isLoading || tasksQ.isLoading
  const inboxLoading = loading || alertsQ.isLoading

  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-7">
      <PageHeader
        breadcrumbs={['Ops', 'Command Center']}
        title="Command Center"
        titleAccessory={
          <InfoTip text="What needs a person right now, with the reason, what it costs to leave it, and the one next step. Today's numbers sit below as the evidence behind those calls." />
        }
        history={
          inboxLoading
            ? `${fmtDate(today)}. All times are shown in Pakistan time, and we are working out what needs you…`
            : decisions.length === 0
              ? `${fmtDate(today)}. All times are shown in Pakistan time, and nothing needs you, with ${openTasks.length} project${
                  openTasks.length === 1 ? '' : 's'
                } moving along on their own.`
              : `${fmtDate(today)}. All times are shown in Pakistan time, and ${decisions.length} decision${
                  decisions.length === 1 ? '' : 's'
                } need${decisions.length === 1 ? 's' : ''} you, with ${openTasks.length} project${
                  openTasks.length === 1 ? '' : 's'
                } in motion.`
        }
      />

      {openTasksQ.error && (
        <ErrorBanner
          message="We couldn't load the latest projects, so you're seeing the last saved view."
          asOf={
            openTasksQ.dataUpdatedAt > 0
              ? fmtClock(new Date(openTasksQ.dataUpdatedAt).toISOString())
              : null
          }
          onRetry={() => void openTasksQ.refetch()}
        />
      )}

      {/* ── 1 · THE INBOX — the reason this page exists ─────────────────────── */}
      <section aria-label="Decisions that need you">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <h2 className="inline-flex items-center gap-2.5 text-subhead text-fg">
            {inboxLoading || decisions.length === 0
              ? 'Decisions'
              : `${decisions.length} decision${decisions.length === 1 ? '' : 's'} need${decisions.length === 1 ? 's' : ''} you`}
            <InfoTip text="The things a person has to settle right now. Each one says why it is happening, what it costs to leave it, and the single next step. Everything else on this page is evidence, not a task." />
          </h2>
          <p className="text-label uppercase text-muted">most costly first</p>
        </div>

        {/* One quiet announcement for screen readers as the list changes. */}
        <div aria-live="polite" className="sr-only">
          {inboxLoading
            ? 'Working out what needs you'
            : decisions.length === 0
              ? 'Nothing needs you right now'
              : `${decisions.length} decision${decisions.length === 1 ? '' : 's'} need attention`}
        </div>

        {inboxLoading ? (
          <div className="card divide-y divide-border/60" role="status" aria-label="Loading decisions">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-4 p-6">
                <div className="skeleton h-10 w-10 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2.5 py-1">
                  <div className="skeleton h-4 w-3/4" />
                  <div className="skeleton h-3.5 w-1/2" />
                  <div className="skeleton h-3.5 w-2/3" />
                </div>
                <div className="skeleton h-11 w-36 rounded-xl" />
              </div>
            ))}
          </div>
        ) : decisions.length === 0 ? (
          <InboxZeroReward
            title="Nothing needs you"
            message="Every project is moving, everyone has work in front of them, and no day is waiting to be confirmed. Anything that changes will appear here on its own."
          />
        ) : (
          <motion.ul
            variants={staggerContainer}
            initial={reduced ? false : 'hidden'}
            animate="show"
            className="card divide-y divide-border/60 overflow-hidden"
          >
            {decisions.map((d) => (
              <DecisionCard
                key={d.id}
                decision={d}
                followUp={followUp(acted, d.id, d.signature)}
                now={now}
                onAct={onAct}
                onDismissResolved={onDismissResolved}
              />
            ))}
          </motion.ul>
        )}

        {/* What cleared after the manager went to ClickUp. Studio Pulse cannot
            close anything there, so this is how it closes the loop honestly. */}
        {clearedSinceActing.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {clearedSinceActing.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-success-soft/50 px-4 py-2.5"
              >
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-caption text-fg">
                  Cleared since you acted: {r.context}.
                </p>
                <button
                  type="button"
                  onClick={() => onDismissResolved(r.id)}
                  className="rounded-lg px-2 py-1 text-label font-medium text-muted underline-offset-2 transition-colors duration-150 hover:text-fg hover:underline"
                >
                  Clear it
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Nothing is discarded: the rest open in place rather than sending
            the manager to another page to find them. */}
        {!inboxLoading && heldBack > 0 && (
          <button
            type="button"
            onClick={() => setShowAllDecisions(!showAllDecisions)}
            aria-expanded={showAllDecisions}
            className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2 motion-safe:active:scale-[0.98]"
          >
            {showAllDecisions ? (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            )}
            {showAllDecisions
              ? 'Show only the most costly'
              : `Show ${heldBack} more decision${heldBack === 1 ? '' : 's'}`}
          </button>
        )}
      </section>

      <div className="flex items-center gap-3 pt-1">
        <p className="eyebrow shrink-0">Work to chase</p>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>

      {/* ── Everything behind the decisions ─────────────────────────────────
          Split by what you would DO about each one, not lumped into a single
          list. "106 things have stopped moving" is a wall; a project nobody is
          assigned to, one a designer has gone quiet on, and one that is
          finished and waiting on us to send it are three different jobs. Each
          gets its own section, its own count, and its own list. ────────── */}

      <OpenSection
        title="Stuck with the designer"
        count={stalled.designer.length}
        tone={stalled.designer.length > 0 ? 'warning' : 'success'}
        storageKey="pulse.ops.home.stuckDesigner"
        defaultOpen={false}
        tip="Projects that have gone quiet while a designer has them. A nudge is usually all it takes."
        trailing={
          <button type="button" onClick={() => navigate('/ops/work')} className={openInWork}>
            Open in Work
          </button>
        }
      >
        <TaskList rows={stalled.designer} empty="Nothing has gone quiet on a designer." designerById={designerById} onOpen={setTrailTask} />
      </OpenSection>

      <OpenSection
        title="Ready to send, waiting on us"
        count={stalled.team.length}
        tone={stalled.team.length > 0 ? 'warning' : 'success'}
        storageKey="pulse.ops.home.stuckTeam"
        defaultOpen={false}
        tip="Finished work sitting with the team, waiting for someone to pass it to the client. This delay is ours, not the designer's."
        trailing={
          <button type="button" onClick={() => navigate('/ops/work')} className={openInWork}>
            Open in Work
          </button>
        }
      >
        <TaskList rows={stalled.team} empty="Nothing finished is waiting to be sent." designerById={designerById} onOpen={setTrailTask} />
      </OpenSection>

      <OpenSection
        title="Nobody is on it"
        count={unassigned.length}
        tone={unassigned.length > 0 ? 'danger' : 'success'}
        storageKey="pulse.ops.home.unassigned"
        defaultOpen={false}
        tip="Open projects with no active designer. These cannot move at all until someone picks them up."
      >
        <TaskList rows={unassigned} empty="Every open project has someone on it." designerById={designerById} onOpen={setTrailTask} />
      </OpenSection>

      <OpenSection
        title="Status ClickUp does not recognise"
        count={unknownStatus.length}
        tone={unknownStatus.length > 0 ? 'danger' : 'success'}
        storageKey="pulse.ops.home.unknown"
        defaultOpen={false}
        tip="The status name on these does not match any stage the app knows, so none of their numbers are being counted. Renaming the status in ClickUp fixes it."
      >
        <TaskList rows={unknownStatus} empty="Every open project has a status the app understands." designerById={designerById} onOpen={setTrailTask} />
      </OpenSection>

      <div className="flex items-center gap-3 pt-2">
        <p className="eyebrow shrink-0">People and throughput</p>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>

      <OpenSection
        title="Who has room for more"
        count={spareRows.length}
        storageKey="pulse.ops.home.room"
        defaultOpen={false}
        tip="People who can take more projects today. Only projects due today fill a plate, whatever their status. Giving them the work is the team lead's job, not theirs."
        blurb="most free first"
      >
        <div className="space-y-4">
          {spareRows.length === 0 ? (
            <p className="card px-5 py-4 text-caption text-muted">
              Nobody is scheduled to work today. This happens on holidays, days off and leave.
            </p>
          ) : (
            byTeam(spareRows, (r) => r.designer.team).map(([team, rows]) => (
              <div key={team}>
                <p className="eyebrow mb-1.5">
                  {team} <span className="tnum text-muted">{rows.length}</span>
                </p>
                <ul className="card divide-y divide-border/60 overflow-hidden">
                  {rows.map((r) => {
                    const href = clickupListUrl(r.designer.clickup_list_id)
                    return (
                      <li key={r.designer.id} className="flex items-center gap-3 px-5 py-3">
                        <button
                          type="button"
                          onClick={() => openDesigner(r.designer.id)}
                          className="min-h-11 min-w-0 flex-1 text-left"
                          aria-label={`Open ${r.designer.name}'s details`}
                        >
                          <p className="truncate text-caption font-medium text-fg">{r.designer.name}</p>
                          <p className="tnum text-label font-normal tracking-normal text-muted">
                            {r.filled} due today, target {r.expected}
                            {r.spare > 0
                              ? `, room for ${r.spare} more`
                              : r.spare < 0
                                ? `, ${-r.spare} over their target`
                                : ', right at their target'}
                          </p>
                        </button>
                        <span
                          className={`tnum text-caption font-medium ${
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
                            aria-label={`Open ${r.designer.name}'s list in ClickUp`}
                            className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
                          >
                            <ExternalLink className="h-4 w-4" aria-hidden="true" />
                          </a>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </OpenSection>

      <OpenSection
        title="Finished today"
        count={derived.completedTodayTasks.length}
        tone="success"
        storageKey="pulse.ops.home.done"
        defaultOpen={false}
        tip="Everything closed as done today, grouped by the person who finished it."
      >
        <div className="space-y-4">
          {derived.completedTodayTasks.length === 0 ? (
            <p className="card px-5 py-4 text-caption text-muted">Nothing has finished yet today.</p>
          ) : (
            byTeam(derived.completedTodayTasks, (t) =>
              t.designer_id ? (designerById.get(t.designer_id)?.name ?? 'No designer') : 'No designer',
            ).map(([who, list]) => (
              <div key={who}>
                <p className="eyebrow mb-1.5">
                  {who} <span className="tnum text-muted">{list.length}</span>
                </p>
                <ul className="card divide-y divide-border/60 overflow-hidden">
                  {list.map((t) => (
                    <li key={t.task_id}>
                      <button
                        type="button"
                        onClick={() => setTrailTask(t)}
                        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-150 hover:bg-surface-2/60"
                      >
                        <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg">
                          {t.name ?? t.task_id}
                        </span>
                        <span className="shrink-0 text-label font-normal tracking-normal text-muted">
                          see history
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </OpenSection>

      {/* ── 2 · Today's pulse — monitoring, pushed below the action layer ───── */}
      <div className="flex items-center gap-3 pt-2">
        <p className="eyebrow shrink-0">Today's numbers</p>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <section aria-label="Today's pulse">
        <div className="mb-6 flex items-baseline gap-2">
          <h2 className="inline-flex items-center gap-2 text-subhead text-fg">
            Today's pulse
            <InfoTip text="Today's numbers at a glance. Each one shows how it compares with yesterday, and why." />
          </h2>
        </div>
        {/* 2-up inside the 1000px reading column — labels never truncate and
            each number gets breathing room (whitespace pillar). */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <StatTile
            eyebrow="Given out today"
            tip="How many new projects were handed to designers today, out of the team's total for the day."
            icon={PackagePlus}
            value={`${derived.totalAssignedToday} of ${derived.totalExpected}`}
            delta={metricDelta(derived.totalAssignedToday, derived.assignedYesterday, {
              goodWhen: 'up',
              vs: 'compared with yesterday at this time',
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
            eyebrow="Finished today"
            tip="Projects closed as done today."
            icon={CheckCircle2}
            value={String(derived.completedTodayTasks.length)}
            delta={metricDelta(derived.completedTodayTasks.length, derived.completedYesterday, {
              goodWhen: 'up',
              vs: 'compared with yesterday at this time',
            })}
            cause={
              derived.completedTodayTasks.length > 0
                ? `${completedClean} of ${derived.completedTodayTasks.length} were accepted without any changes`
                : 'nothing finished yet today'
            }
            loading={tasksQ.isLoading || metricsQ.isLoading}
          />
          <StatTile
            eyebrow="Fixes in progress"
            tip="Projects where someone asked for changes and the designer is fixing them now."
            icon={RotateCcw}
            value={String(openRevisions.length)}
            delta={metricDelta(openRevisions.length, revisionsAtDayStart, {
              goodWhen: 'down',
              vs: 'compared with the start of the day',
            })}
            cause={
              openRevisions.length > 0
                ? `${csrRounds} caught by our checkers and ${clientRounds} caught by clients`
                : 'no fixes in progress right now'
            }
            state={openRevisions.length > 0 ? 'watch' : 'ok'}
            loading={openTasksQ.isLoading}
            // Land on the stage-grouped board so the revision column is visible
            // no matter which grouping was used last.
            onClick={() => navigate('/ops/work?group=status')}
          />
          <StatTile
            eyebrow="Busy level"
            tip="How full today's plates are. Only projects due today count, measured against today's total target."
            icon={Gauge}
            value={fmtPct(utilization)}
            cause={`${derived.totalFilled} projects due today across ${derived.salariedCount} ${
              derived.salariedCount === 1 ? 'person' : 'people'
            }`}
            reference={
              heaviest && heaviest.util != null
                ? `busiest: ${heaviest.designer.name} at ${heaviest.util}%`
                : null
            }
            state={utilization == null ? null : utilization > 120 ? 'watch' : 'ok'}
            loading={openTasksQ.isLoading}
          />
        </div>
      </section>

      {/* The two panels that used to sit here ("Who has room for more" and
          "Stuck projects") listed the very same people and projects the
          decisions above already call out, one screen apart. Repeating a call
          to action as a table is the habit this redesign exists to break, so
          the decisions keep it and the full lists live on Board and Roster. */}

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
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2"
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
