import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  Gauge,
  Inbox,
  Info,
  OctagonAlert,
  PackagePlus,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AnimatedCounter } from '../../components/ui/AnimatedCounter'
import { Drawer } from '../../components/ui/Drawer'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InboxZeroReward } from '../../components/ui/InboxZeroReward'
import { InfoTip } from '../../components/ui/InfoTip'
import { StatTile } from '../../components/ui/StatTile'
import { staggerContainer, staggerItem } from '../../components/ui/motion'
import { PageHeader } from '../../components/layout/PageHeader'
import type { VerdictItem } from '../../components/ui/VerdictBlock'
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

/** Severity glyphs — a distinct icon per level, never color alone (§20.10). */
const SEVERITY_META: Record<
  VerdictItem['severity'],
  { icon: LucideIcon; className: string; label: string }
> = {
  info: { icon: Info, className: 'text-brand', label: 'Info' },
  warning: { icon: TriangleAlert, className: 'text-warning', label: 'Warning' },
  critical: { icon: OctagonAlert, className: 'text-danger', label: 'Critical' },
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

  // ── Inbox items, ranked (§20.1) ─────────────────────────────────────────────
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
          ? { label: `Open ${d ? firstName(d.name) : 'the'} list`, href }
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
        action: href ? { label: 'Open their list', href } : undefined,
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
  const inboxLoading = loading || alertsQ.isLoading

  // The hover-revealed 1-click action (manifesto pillar 6): parked invisible on
  // pointer screens until the row is hovered or focused; always visible on
  // touch. High-contrast neutral (bg-fg) — brand stays reserved.
  const actionCls =
    'ml-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-fg px-4 text-caption font-medium text-bg transition-[opacity,transform,background-color] duration-150 ease-out hover:opacity-90 motion-safe:active:scale-[0.97] md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100'

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-16">
      <PageHeader
        breadcrumbs={['Ops', 'Today']}
        title="Today"
        titleAccessory={
          <InfoTip text="A live picture of today — what needs you, today's numbers, who has room for more work, and what is stuck." />
        }
        history={
          inboxLoading
            ? `${fmtDate(today)} · all times PKT — checking the board…`
            : verdictItems.length === 0
              ? `${fmtDate(today)} · all times PKT — nothing needs a human, ${openTasks.length} project${
                  openTasks.length === 1 ? '' : 's'
                } moving on their own.`
              : `${fmtDate(today)} · all times PKT — ${verdictItems.length} thing${
                  verdictItems.length === 1 ? '' : 's'
                } need${verdictItems.length === 1 ? 's' : ''} a human, ${openTasks.length} project${
                  openTasks.length === 1 ? '' : 's'
                } in motion.`
        }
      />

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

      {/* ── 1 · THE INBOX — the reason this page exists ─────────────────────── */}
      <section aria-label="Action inbox">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <h2 className="inline-flex items-center gap-2.5 text-card text-fg">
            Needs a human
            {!inboxLoading && verdictItems.length > 0 && (
              <span className="tnum inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-surface-2 px-2 text-caption font-semibold text-fg ring-1 ring-border">
                <AnimatedCounter value={verdictItems.length} />
              </span>
            )}
            <InfoTip text="Everything that needs a person right now, worst first. Each row carries its own one-click next step." />
          </h2>
          <p className="text-label uppercase text-muted">worst first</p>
        </div>

        {/* One quiet announcement for screen readers as the inbox changes. */}
        <div aria-live="polite" className="sr-only">
          {inboxLoading
            ? 'Checking what needs attention'
            : verdictItems.length === 0
              ? 'Nothing needs you right now'
              : `${verdictItems.length} item${verdictItems.length === 1 ? '' : 's'} need attention`}
        </div>

        {inboxLoading ? (
          // Skeleton mirrors the final list — same card, same row anatomy.
          <div
            className="divide-y divide-border/60 rounded-2xl border border-border bg-surface shadow-edge"
            role="status"
            aria-label="Loading the inbox"
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-4 p-6">
                <div className="skeleton h-10 w-10 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2.5 py-1">
                  <div className="skeleton h-4 w-3/4" />
                  <div className="skeleton h-3.5 w-1/2" />
                </div>
                <div className="skeleton h-11 w-36 rounded-xl" />
              </div>
            ))}
          </div>
        ) : verdictItems.length === 0 ? (
          <InboxZeroReward
            title="All clear"
            message="Nothing needs you right now — everyone has enough work and nothing is stuck. New problems appear here the moment the app spots them."
          />
        ) : (
          <motion.ul
            variants={staggerContainer}
            initial={reduced ? false : 'hidden'}
            animate="show"
            className="divide-y divide-border/60 rounded-2xl border border-border bg-surface shadow-edge"
          >
            {verdictItems.map((item) => {
              const meta = SEVERITY_META[item.severity]
              const Icon = meta.icon
              return (
                <motion.li
                  key={item.id}
                  variants={staggerItem}
                  className="group flex flex-wrap items-center gap-x-4 gap-y-3 p-5 transition-colors duration-150 ease-out first:rounded-t-2xl last:rounded-b-2xl hover:bg-surface-2/50 sm:p-6"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 ring-1 ring-border">
                    <Icon className={`h-5 w-5 ${meta.className}`} aria-hidden="true" />
                  </span>
                  {/* flex-basis lets the action drop to its own line on narrow
                      screens instead of crushing the sentence into a sliver. */}
                  <div className="min-w-0 flex-[1_1_16rem]">
                    <p className="text-caption font-semibold leading-snug text-fg">
                      <span className="sr-only">{meta.label}: </span>
                      {item.text}
                    </p>
                    {item.detail && (
                      <p className="mt-1 max-w-prose text-caption leading-snug text-muted">
                        {item.detail}
                      </p>
                    )}
                  </div>
                  {item.action &&
                    (item.action.href ? (
                      <a href={item.action.href} target="_blank" rel="noreferrer" className={actionCls}>
                        {item.action.label}
                        <ExternalLink className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
                        <span className="sr-only">(opens in new tab)</span>
                      </a>
                    ) : (
                      <button type="button" onClick={item.action.onClick} className={actionCls}>
                        {item.action.label}
                        <ArrowUpRight className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
                      </button>
                    ))}
                </motion.li>
              )
            })}
          </motion.ul>
        )}
      </section>

      {/* ── 2 · Today's pulse — monitoring, pushed below the action layer ───── */}
      <section aria-label="Today's pulse">
        <div className="mb-6 flex items-baseline gap-2">
          <h2 className="inline-flex items-center gap-2 text-card text-fg">
            Today's pulse
            <InfoTip text="Today's numbers at a glance — each one says how it compares with yesterday and why." />
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
            eyebrow="Finished today"
            tip="Projects closed as done today."
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
            eyebrow="Fixes in progress"
            tip="Projects where someone asked for changes and the designer is fixing them now."
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
            eyebrow="Busy level"
            tip="How full today's plates are — only projects DUE today count, compared to today's total target."
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
        </div>
      </section>

      {/* ── 3 · Context panels ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        {/* ── Spare capacity right now (§20.11 hidden insight) ── */}
        <section className="card p-6 md:p-8">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="inline-flex items-center gap-2 text-card text-fg">
              Who has room for more
              <InfoTip text="People who can take more projects today. Only projects DUE today fill a plate — status doesn't matter. Giving them work is the team lead's job, not theirs." />
            </h2>
            <span className="text-label uppercase text-muted">most free first</span>
          </div>
          <div className="mt-6 space-y-1">
            {loading ? (
              [0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14" />)
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
                    className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors duration-150 ease-out hover:bg-surface-2"
                  >
                    <button
                      type="button"
                      onClick={() => openDesigner(r.designer.id)}
                      className="min-h-11 min-w-0 flex-1 text-left"
                      aria-label={`Open ${r.designer.name}'s details`}
                    >
                      <p className="truncate text-caption font-medium text-fg">
                        {r.designer.name}
                        <span className="ml-2 text-label font-normal tracking-normal text-muted">
                          {r.designer.team}
                        </span>
                      </p>
                      <p className="tnum text-label font-normal tracking-normal text-muted">
                        {r.filled} due today, target {r.expected}
                        {r.spare > 0
                          ? ` — ${r.spare} open slot${r.spare === 1 ? '' : 's'}`
                          : r.spare < 0
                            ? ` — ${-r.spare} over their target`
                            : ' — at their target'}
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
                        className="flex h-11 w-11 items-center justify-center rounded-xl text-brand transition-colors duration-150 ease-out hover:bg-brand-soft motion-safe:active:scale-95"
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
        <section className="card p-6 md:p-8">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="inline-flex items-center gap-2 text-card text-fg">
              Stuck projects
              <InfoTip text="Projects that have not moved for too long. The ones waiting on clients are the most important to chase." />
            </h2>
            <Link
              to="/ops/board"
              className="inline-flex items-center gap-1 text-caption font-medium text-brand hover:underline"
            >
              Open the board <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <div className="mt-6 space-y-2">
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
              <p className="text-label font-normal tracking-normal text-muted">
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
