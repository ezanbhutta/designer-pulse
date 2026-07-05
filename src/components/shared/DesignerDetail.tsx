import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  ClipboardList,
  ExternalLink,
  Gauge,
  Inbox,
  LogIn,
  LogOut,
  RotateCcw,
  ShieldCheck,
  Timer,
  XCircle,
} from 'lucide-react'
import { Badge } from '../ui/Badge'
import { Button, buttonClasses } from '../ui/Button'
import { Drawer } from '../ui/Drawer'
import { EmptyState } from '../ui/EmptyState'
import { ErrorBanner } from '../ui/ErrorBanner'
import { HBar } from '../ui/HBar'
import { InfoTip } from '../ui/InfoTip'
import { SegmentedControl } from '../ui/SegmentedControl'
import { StatTile } from '../ui/StatTile'
import { useToast } from '../ui/ToastProvider'
import { TaskCard } from './TaskCard'
import { TaskTrail } from './TaskTrail'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import {
  STALE_ANALYTICS,
  STALE_LIVE,
  clickupListUrl,
  clickupTaskUrl,
  fetchAttendance,
  fetchDesigners,
  fetchHolidayWorkers,
  fetchHolidays,
  fetchLeaves,
  fetchOpenTasks,
  fetchQuotaExceptions,
  fetchSchedules,
  fetchTaskMetricsSince,
  fetchTasksSince,
  insertShiftMark,
  qk,
} from '../../lib/queries'
import { DOW_LABELS, fmtDate, fmtDuration, fmtPct, fmtShiftTime, fmtTime } from '../../lib/format'
import { addDays, dateRange, pktInstant, pktToday } from '../../../shared/pkt'
import {
  ageMinutes,
  median,
  priorPeriod,
  scheduleFor,
  summarizeDesigner,
  type DesignerPeriodSummary,
  type QuotaContext,
} from '../../../shared/aggregate'
import type {
  AttendanceDaily,
  AttendanceStatus,
  TaskMetrics,
  TaskState,
} from '../../../shared/types'

export interface DesignerDetailProps {
  designerId: string
  /** 'ops' adds manual marks + roster link and team reference points; 'self' is own-data only (§22.10). */
  scope: 'ops' | 'self'
}

type Period = 'week' | 'month'

interface TileDelta {
  label: string
  direction: 'up' | 'down' | 'flat'
  good: boolean
}

function metricDelta(
  current: number | null | undefined,
  prior: number | null | undefined,
  goodWhen: 'up' | 'down',
  format: (abs: number) => string,
  vs: string,
): TileDelta | null {
  if (current == null || prior == null) return null
  const diff = current - prior
  if (diff === 0) return { label: `no change ${vs}`, direction: 'flat', good: true }
  return {
    label: `${diff > 0 ? '+' : '−'}${format(Math.abs(diff))} ${vs}`,
    direction: diff > 0 ? 'up' : 'down',
    good: goodWhen === 'up' ? diff > 0 : diff < 0,
  }
}

const ATTENDANCE_CHIP: Record<AttendanceStatus, { letter: string; className: string }> = {
  Present: { letter: 'P', className: 'bg-success-soft text-success' },
  HolidayWorked: { letter: 'HW', className: 'bg-success-soft text-success' },
  Leave: { letter: 'L', className: 'bg-surface-2 text-muted' },
  Holiday: { letter: 'H', className: 'bg-surface-2 text-muted' },
  WeeklyOff: { letter: 'W', className: 'bg-surface-2 text-muted' },
  Absent: { letter: 'A', className: 'bg-danger-soft text-danger' },
  Incomplete: { letter: 'I', className: 'bg-warning-soft text-warning' },
}

// ── Shared metrics panel (§22.3 — same component, different scope) ────────────

export interface MetricsPeriod {
  /** Current window, PKT dates inclusive. */
  start: string
  end: string
  /** Prior comparison window (same elapsed span for week-to-date views). */
  priorStart: string
  priorEnd: string
  /** Plain-language period name, e.g. "last 7 days" / "this week". */
  label: string
  /** Delta wording, e.g. "vs prior" / "vs same point last week". */
  vs: string
}

export interface DesignerMetricsPanelProps {
  designerId: string
  /** 'ops' shows team-median reference points; 'self' NEVER sees peers (§22.10). */
  scope: 'ops' | 'self'
  period: MetricsPeriod
  /** Pre-fetched task rows covering AT LEAST priorStart..end — when given,
   *  the panel skips its own tasks fetch (the self-view already holds an
   *  8-week superset; refetching per panel doubles the REST calls). */
  tasks?: TaskState[]
  /** Pre-fetched metrics rows covering at least priorStart..end. */
  metrics?: TaskMetrics[]
  /** Pre-fetched attendance rows covering at least priorStart..end. */
  attendance?: AttendanceDaily[]
}

/**
 * The metric StatTile grid + defect-source split for one designer, shared by
 * the Ops drill-down drawer and the Designer self-view (spec §22.3). Every
 * metric ships with delta + cause (§20.2). scope='ops' adds team-median
 * reference points (§22.5); scope='self' omits all peer data and compares the
 * designer only to their own past (§22.10). Single-column on small screens —
 * the self-view is mobile-first (§20.10).
 */
export function DesignerMetricsPanel({
  designerId,
  scope,
  period,
  tasks: tasksProp,
  metrics: metricsProp,
  attendance: attendanceProp,
}: DesignerMetricsPanelProps) {
  const sinceIso = pktInstant(period.priorStart, '00:00').toISOString()

  const designersQ = useQuery({ queryKey: qk.designers, queryFn: fetchDesigners, staleTime: STALE_ANALYTICS })
  const schedulesQ = useQuery({ queryKey: qk.schedules, queryFn: fetchSchedules, staleTime: STALE_ANALYTICS })
  const exceptionsQ = useQuery({ queryKey: qk.quotaExceptions, queryFn: fetchQuotaExceptions, staleTime: STALE_ANALYTICS })
  const leavesQ = useQuery({ queryKey: qk.leaves, queryFn: fetchLeaves, staleTime: STALE_ANALYTICS })
  const holidaysQ = useQuery({ queryKey: qk.holidays, queryFn: fetchHolidays, staleTime: STALE_ANALYTICS })
  const workersQ = useQuery({ queryKey: qk.holidayWorkers, queryFn: fetchHolidayWorkers, staleTime: STALE_ANALYTICS })
  // Window queries run only when the caller didn't hand us the data already.
  const tasksQ = useQuery({
    queryKey: ['tasks', 'since', period.priorStart] as const,
    queryFn: () => fetchTasksSince(sinceIso),
    staleTime: STALE_LIVE,
    enabled: !tasksProp,
  })
  const metricsQ = useQuery({
    queryKey: qk.taskMetrics(period.priorStart, period.end),
    queryFn: () => fetchTaskMetricsSince(sinceIso),
    staleTime: STALE_ANALYTICS,
    enabled: !metricsProp,
  })
  const attendanceQ = useQuery({
    queryKey: qk.attendance(period.priorStart, period.end),
    queryFn: () => fetchAttendance(period.priorStart, period.end),
    staleTime: STALE_LIVE,
    enabled: !attendanceProp,
  })
  const taskRows = tasksProp ?? tasksQ.data
  const metricRows = metricsProp ?? metricsQ.data
  const attendanceRows = attendanceProp ?? attendanceQ.data

  const quota: QuotaContext = useMemo(
    () => ({
      schedules: schedulesQ.data ?? [],
      exceptions: exceptionsQ.data ?? [],
      leaves: leavesQ.data ?? [],
      holidays: holidaysQ.data ?? [],
      holidayWorkers: workersQ.data ?? [],
    }),
    [schedulesQ.data, exceptionsQ.data, leavesQ.data, holidaysQ.data, workersQ.data],
  )

  const summaries = useMemo(() => {
    const tasks = taskRows ?? []
    const metrics = metricRows ?? []
    const cur = summarizeDesigner(designerId, { start: period.start, end: period.end, tasks, metrics, quota })
    const prev = summarizeDesigner(designerId, {
      start: period.priorStart,
      end: period.priorEnd,
      tasks,
      metrics,
      quota,
    })
    return { cur, prev }
  }, [designerId, taskRows, metricRows, quota, period])

  /** Team reference points (§22.5) — ops scope only; the self view never sees peers (§22.10). */
  const teamRef = useMemo(() => {
    if (scope !== 'ops') return null
    const designer = (designersQ.data ?? []).find((d) => d.id === designerId)
    if (!designer) return null
    const peers = (designersQ.data ?? []).filter(
      (d) => d.team === designer.team && d.status === 'active',
    )
    if (peers.length < 2) return null
    const tasks = taskRows ?? []
    const metrics = metricRows ?? []
    const rows: DesignerPeriodSummary[] = peers.map((p) =>
      summarizeDesigner(p.id, { start: period.start, end: period.end, tasks, metrics, quota }),
    )
    return {
      attainment: median(rows.map((r) => r.attainmentPct).filter((v): v is number => v != null)),
      fpq: median(rows.map((r) => r.firstPassQualityPct).filter((v): v is number => v != null)),
      production: median(rows.map((r) => r.productionMedianMin).filter((v): v is number => v != null)),
      revision: median(
        rows.map((r) => r.revisionTurnaroundMedianMin).filter((v): v is number => v != null),
      ),
    }
  }, [scope, designerId, designersQ.data, taskRows, metricRows, quota, period])

  const warmup = useMemo(() => {
    const mine = (attendanceRows ?? []).filter((a) => a.designer_id === designerId)
    const inRange = (a: AttendanceDaily, s: string, e: string) => a.work_date >= s && a.work_date <= e
    const gap = (s: string, e: string) =>
      median(
        mine
          .filter((a) => inRange(a, s, e))
          .map((a) => a.warmup_gap_min)
          .filter((v): v is number => v != null),
      )
    return { cur: gap(period.start, period.end), prev: gap(period.priorStart, period.priorEnd) }
  }, [attendanceRows, designerId, period])

  const s = summaries.cur
  const p = summaries.prev
  const vs = period.vs
  const pts = (abs: number) => `${abs} points`
  const metricsLoading =
    (!tasksProp && tasksQ.isLoading) || (!metricsProp && metricsQ.isLoading)

  const defectTotal = s.csrCaughtRounds + s.clientCaughtRounds
  const defectDiagnosis =
    defectTotal === 0
      ? 'No changes were asked for in this period, so there is nothing to look into here.'
      : s.csrCaughtRounds >= s.clientCaughtRounds
        ? scope === 'ops'
          ? 'Most of the changes were caught by our own checkers before the client ever saw the work. A little coaching could help lift this even further.'
          : 'Most of the changes were spotted and put right by our checkers before the client ever saw the work.'
        : scope === 'ops'
          ? 'Most of the changes came from clients rather than our own checkers, which suggests the checking step or the brief could use a closer look.'
          : 'Most of the changes came from clients, so it is worth taking one more look before sending next time.'

  const lastGood = Math.max(tasksQ.dataUpdatedAt, metricsQ.dataUpdatedAt)

  return (
    <div className="space-y-6">
      {((!tasksProp && tasksQ.error) || (!metricsProp && metricsQ.error)) && (
        <ErrorBanner
          message="We could not load the latest numbers, so you are looking at the last saved view for now."
          asOf={lastGood > 0 ? fmtTime(new Date(lastGood).toISOString()) : null}
          onRetry={() => {
            void tasksQ.refetch()
            void metricsQ.refetch()
          }}
        />
      )}

      {/* ── Metric grid (§20.2: delta + cause on every number) ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatTile
          eyebrow="Target met"
          tip="Of the projects this designer was expected to take on, how many they finished."
          icon={Gauge}
          value={fmtPct(s.attainmentPct)}
          delta={metricDelta(s.attainmentPct, p.attainmentPct, 'up', pts, vs)}
          cause={`finished ${s.completed} of the ${s.expectedQuota} expected`}
          reference={teamRef?.attainment != null ? `usual for the team: ${teamRef.attainment}%` : null}
          state={
            s.attainmentPct == null
              ? null
              : s.attainmentPct >= 85
                ? 'ok'
                : s.attainmentPct >= 60
                  ? 'watch'
                  : 'flag'
          }
          loading={metricsLoading}
        />
        <StatTile
          eyebrow="Right first time"
          tip="How many designs the client accepted without asking for a single change. The higher, the better."
          icon={ShieldCheck}
          value={fmtPct(s.firstPassQualityPct)}
          delta={metricDelta(s.firstPassQualityPct, p.firstPassQualityPct, 'up', pts, vs)}
          cause={
            s.delivered > 0
              ? `${s.firstPassClean} of ${s.delivered} designs needed no changes at all`
              : 'Nothing has gone to a client in this period yet'
          }
          reference={teamRef?.fpq != null ? `usual for the team: ${teamRef.fpq}%` : null}
          state={
            s.firstPassQualityPct == null
              ? null
              : s.firstPassQualityPct >= 80
                ? 'ok'
                : s.firstPassQualityPct >= 60
                  ? 'watch'
                  : 'flag'
          }
          loading={metricsLoading}
        />
        <StatTile
          eyebrow="Work time"
          tip="The usual time from picking up a project to sending the first design. Time spent waiting for the client is never counted."
          icon={Timer}
          value={fmtDuration(s.productionMedianMin)}
          delta={metricDelta(s.productionMedianMin, p.productionMedianMin, 'down', fmtDuration, vs)}
          cause={
            scope === 'ops'
              ? `the usual time across ${s.delivered} first designs, with any client waiting time left out`
              : 'your usual time to the first design, and waiting for the client never counts against you'
          }
          reference={teamRef?.production != null ? `usual for the team: ${fmtDuration(teamRef.production)}` : null}
          loading={metricsLoading}
        />
        <StatTile
          eyebrow="Fix time"
          tip="The usual time to finish a set of changes once someone has asked for them."
          icon={RotateCcw}
          value={fmtDuration(s.revisionTurnaroundMedianMin)}
          delta={metricDelta(
            s.revisionTurnaroundMedianMin,
            p.revisionTurnaroundMedianMin,
            'down',
            fmtDuration,
            vs,
          )}
          cause={`${s.revisionRounds} round${s.revisionRounds === 1 ? '' : 's'} of changes in this period`}
          reference={teamRef?.revision != null ? `usual for the team: ${fmtDuration(teamRef.revision)}` : null}
          loading={metricsLoading}
        />
        <StatTile
          eyebrow="Cancelled orders"
          tip="Orders that did not go ahead. Please read the project history before forming a view, as the reason is not always what it first seems."
          icon={XCircle}
          value={String(s.cancelled)}
          delta={metricDelta(s.cancelled, p.cancelled, 'down', String, vs)}
          cause={
            s.cancelled > 0
              ? scope === 'ops'
                ? `${fmtPct(s.cancellationRatePct)} of ${s.assigned} projects, so do read the history before forming a view`
                : `${fmtPct(s.cancellationRatePct)} of ${s.assigned} projects in this period`
              : `none of the ${s.assigned} projects were lost`
          }
          state={s.cancelled > 0 ? 'flag' : 'ok'}
          loading={metricsLoading}
        />
        <StatTile
          eyebrow="Time to get going"
          tip="The gap between the start of the day and the first real piece of work in ClickUp."
          icon={LogIn}
          value={fmtDuration(warmup.cur)}
          delta={metricDelta(warmup.cur, warmup.prev, 'down', fmtDuration, vs)}
          cause="the usual gap between the start of the day and the first real piece of work"
          state={warmup.cur == null ? null : warmup.cur > 60 ? 'flag' : warmup.cur > 30 ? 'watch' : 'ok'}
          loading={!attendanceProp && attendanceQ.isLoading}
        />
      </div>

      {/* ── Defect source split (§4.2) ── */}
      <section className="card p-5">
        <h4 className="eyebrow inline-flex items-center gap-1">
          Who asked for the changes, {period.label}
          <InfoTip text="Who noticed the changes that were needed: our own checkers or the client. The ones a client sees matter most." />
        </h4>
        <div className="mt-3">
          <HBar
            rows={[
              {
                label: 'Caught by our checkers',
                value: s.csrCaughtRounds,
                tone: 'warning',
                secondary: 'fixed before the client ever saw it',
              },
              {
                label: 'Caught by the client',
                value: s.clientCaughtRounds,
                tone: 'danger',
                secondary: 'the client saw it and asked for changes',
              },
            ]}
            formatValue={(v) => `${v} round${v === 1 ? '' : 's'}`}
            ariaLabel="Rounds of changes by who spotted the problem"
          />
        </div>
        <p className="mt-3 max-w-prose text-caption text-muted">{defectDiagnosis}</p>
      </section>
    </div>
  )
}

/**
 * One shared, RLS-scoped designer drill-down (spec §22.3) used by the Ops
 * drawer and the Designer self-view. The metric grid + defect split render
 * via DesignerMetricsPanel; the self scope compares only to the designer's
 * own past (§22.10) — the reads themselves are already scoped server-side.
 */
export function DesignerDetail({ designerId, scope }: DesignerDetailProps) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [period, setPeriod] = useLocalStorage<Period>('pulse.designer-detail.period', 'week')
  const [trailTaskId, setTrailTaskId] = useState<string | null>(null)

  const today = pktToday()
  const range = useMemo(() => {
    const days = period === 'week' ? 7 : 30
    return { start: addDays(today, -(days - 1)), end: today }
  }, [period, today])
  const prior = useMemo(() => priorPeriod(range.start, range.end), [range])
  const periodLabel = period === 'week' ? 'last 7 days' : 'last 30 days'
  const metricsPeriod: MetricsPeriod = useMemo(
    () => ({
      start: range.start,
      end: range.end,
      priorStart: prior.start,
      priorEnd: prior.end,
      label: periodLabel,
      vs: 'compared with the period before',
    }),
    [range, prior, periodLabel],
  )

  const designersQ = useQuery({ queryKey: qk.designers, queryFn: fetchDesigners, staleTime: STALE_ANALYTICS })
  const schedulesQ = useQuery({ queryKey: qk.schedules, queryFn: fetchSchedules, staleTime: STALE_ANALYTICS })
  const openTasksQ = useQuery({ queryKey: qk.openTasks, queryFn: fetchOpenTasks, staleTime: STALE_LIVE })
  const stripStart = addDays(today, -6)
  const attendanceQ = useQuery({
    queryKey: qk.attendance(stripStart, today),
    queryFn: () => fetchAttendance(stripStart, today),
    staleTime: STALE_LIVE,
  })

  const designer = (designersQ.data ?? []).find((d) => d.id === designerId)
  const schedule = scheduleFor(schedulesQ.data ?? [], designerId, today)

  const myAttendance = useMemo(
    () => (attendanceQ.data ?? []).filter((a) => a.designer_id === designerId),
    [attendanceQ.data, designerId],
  )

  const myOpenTasks = useMemo(
    () =>
      (openTasksQ.data ?? [])
        .filter((t) => t.designer_id === designerId && !t.deleted)
        .sort((a, b) => ageMinutes(b) - ageMinutes(a)),
    [openTasksQ.data, designerId],
  )

  const markMutation = useMutation({
    mutationFn: (mark_type: 'check_in' | 'check_out') =>
      insertShiftMark({ designer_id: designerId, mark_type, source: 'manual' }),
    onSuccess: (_d, mark_type) => {
      void queryClient.invalidateQueries({ queryKey: ['attendance'] })
      void queryClient.invalidateQueries({ queryKey: ['shift-marks'] })
      toast({
        message:
          mark_type === 'check_in'
            ? `Saved the start of the day for ${designer?.name ?? 'this designer'}.`
            : `Saved the end of the day for ${designer?.name ?? 'this designer'}.`,
      })
    },
    onError: (e: Error) => toast({ message: `That did not save. ${e.message}` }),
  })

  if (designersQ.isLoading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading designer">
        <div className="skeleton h-7 w-48" />
        <div className="skeleton h-4 w-72" />
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton h-32" />
          ))}
        </div>
      </div>
    )
  }

  if (!designer) {
    return (
      <EmptyState
        icon={Inbox}
        title="We could not find this designer"
        hint="They may have been removed, or their page may not be one you are able to see."
      />
    )
  }

  const listUrl = clickupListUrl(designer.clickup_list_id)
  const trailTask = trailTaskId ? myOpenTasks.find((t) => t.task_id === trailTaskId) : undefined
  const stripDates = dateRange(stripStart, today)
  const attendanceByDate = new Map(myAttendance.map((a) => [a.work_date, a]))

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-card text-fg">{designer.name}</h3>
          <Badge tone="neutral">{designer.team}</Badge>
          {designer.status === 'archived' && <Badge tone="warning">Archived</Badge>}
        </div>
        {designer.specialty && (
          <p className="mt-0.5 text-caption text-muted">{designer.specialty}</p>
        )}
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {schedule ? (
            <span>
              {schedule.daily_quota} projects a day, from {fmtShiftTime(schedule.shift_start)} to{' '}
              {fmtShiftTime(schedule.shift_end)} Pakistan time
              {schedule.weekly_off != null && `, with ${DOW_LABELS[schedule.weekly_off]} off`}
            </span>
          ) : (
            <span>No working hours are set yet, so "Target met" cannot be worked out.</span>
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {listUrl && (
            <a href={listUrl} target="_blank" rel="noreferrer" className={buttonClasses('secondary')}>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open list in ClickUp
              <span className="sr-only">(opens in new tab)</span>
            </a>
          )}
          {scope === 'ops' && (
            <>
              <Button
                variant="secondary"
                onClick={() => markMutation.mutate('check_in')}
                disabled={markMutation.isPending}
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                Start their day for them
              </Button>
              <Button
                variant="secondary"
                onClick={() => markMutation.mutate('check_out')}
                disabled={markMutation.isPending}
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                End their day for them
              </Button>
              <Link
                to="/ops/roster"
                className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-caption font-medium text-brand underline-offset-2 hover:underline"
              >
                <ClipboardList className="h-4 w-4" aria-hidden="true" />
                View in roster
              </Link>
            </>
          )}
        </div>
      </header>

      {/* ── Period ── */}
      <div className="flex items-center justify-between gap-3">
        <h4 className="eyebrow inline-flex items-center gap-1">
          How they have been doing over the {periodLabel}
          <InfoTip text="Their numbers for the period you have chosen, each one compared with the period before it." />
        </h4>
        <SegmentedControl<Period>
          options={[
            { value: 'week', label: '7 days' },
            { value: 'month', label: '30 days' },
          ]}
          value={period}
          onChange={setPeriod}
          ariaLabel="Which period to show"
        />
      </div>

      {/* ── Shared metric grid + defect split (§22.3) ── */}
      <DesignerMetricsPanel designerId={designerId} scope={scope} period={metricsPeriod} />

      {/* ── Open tasks ── */}
      <section>
        <h4 className="eyebrow inline-flex items-center gap-1">
          Open projects ({myOpenTasks.length}), oldest first
          <InfoTip text="Everything on their plate right now, with the one that has waited longest at the top." />
        </h4>
        <div className="mt-3 space-y-2">
          {openTasksQ.isLoading ? (
            [0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)
          ) : myOpenTasks.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing open right now"
              hint={
                scope === 'ops'
                  ? 'They have room for more. Anything new in their ClickUp list will appear here right away.'
                  : 'Nothing right now. New projects will appear here the moment they land in ClickUp.'
              }
            />
          ) : (
            myOpenTasks.map((t) => (
              // setTrailTaskId is referentially stable — memoized TaskCards
              // skip re-rendering when the list itself hasn't changed.
              <TaskCard key={t.task_id} task={t} onOpen={setTrailTaskId} />
            ))
          )}
        </div>
      </section>

      {/* ── Recent attendance ── */}
      <section>
        <h4 className="eyebrow inline-flex items-center gap-1">
          Attendance over the last 7 days
          <InfoTip text="One small box for each day, showing whether they worked, took leave, had a day off, and so on." />
        </h4>
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Attendance, last 7 days">
          {stripDates.map((d) => {
            const row = attendanceByDate.get(d)
            const chip = row?.status ? ATTENDANCE_CHIP[row.status] : null
            return (
              <div key={d} className="flex flex-col items-center gap-1">
                <span
                  className={`tnum flex h-9 w-9 items-center justify-center rounded-lg text-label font-semibold ${
                    chip ? chip.className : 'bg-surface-2 text-muted/60'
                  }`}
                  title={`${fmtDate(d)}: ${row?.status ?? 'nothing recorded'}${
                    row?.warmup_gap_min != null ? `, taking ${fmtDuration(row.warmup_gap_min)} to get going` : ''
                  }`}
                >
                  {chip ? chip.letter : '·'}
                </span>
                <span className="tnum text-label normal-case tracking-normal text-muted">
                  {fmtDate(d).split(' ')[0]}
                </span>
              </div>
            )
          })}
        </div>
        <p className="mt-2 text-label normal-case tracking-normal text-muted">
          P means present, HW means they worked on a holiday, L means on leave, H means a company
          holiday, W means a day off, A means they were not marked in, and I means the day was not
          finished.
        </p>
      </section>

      {/* ── Task trail drawer ── */}
      <Drawer
        open={trailTaskId != null}
        onClose={() => setTrailTaskId(null)}
        title={trailTask?.name ?? 'Project history'}
      >
        {trailTaskId && (
          <div className="space-y-4">
            {clickupTaskUrl(trailTaskId) && (
              <a
                href={clickupTaskUrl(trailTaskId) ?? '#'}
                target="_blank"
                rel="noreferrer"
                className={buttonClasses('secondary')}
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                Open in ClickUp
                <span className="sr-only">(opens in new tab)</span>
              </a>
            )}
            <TaskTrail taskId={trailTaskId} />
          </div>
        )}
      </Drawer>
    </div>
  )
}

export default DesignerDetail
