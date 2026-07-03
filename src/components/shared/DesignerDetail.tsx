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
import type { AttendanceDaily, AttendanceStatus } from '../../../shared/types'

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
}

/**
 * The metric StatTile grid + defect-source split for one designer, shared by
 * the Ops drill-down drawer and the Designer self-view (spec §22.3). Every
 * metric ships with delta + cause (§20.2). scope='ops' adds team-median
 * reference points (§22.5); scope='self' omits all peer data and compares the
 * designer only to their own past (§22.10). Single-column on small screens —
 * the self-view is mobile-first (§20.10).
 */
export function DesignerMetricsPanel({ designerId, scope, period }: DesignerMetricsPanelProps) {
  const sinceIso = pktInstant(period.priorStart, '00:00').toISOString()

  const designersQ = useQuery({ queryKey: qk.designers, queryFn: fetchDesigners, staleTime: STALE_ANALYTICS })
  const schedulesQ = useQuery({ queryKey: qk.schedules, queryFn: fetchSchedules, staleTime: STALE_ANALYTICS })
  const exceptionsQ = useQuery({ queryKey: qk.quotaExceptions, queryFn: fetchQuotaExceptions, staleTime: STALE_ANALYTICS })
  const leavesQ = useQuery({ queryKey: qk.leaves, queryFn: fetchLeaves, staleTime: STALE_ANALYTICS })
  const holidaysQ = useQuery({ queryKey: qk.holidays, queryFn: fetchHolidays, staleTime: STALE_ANALYTICS })
  const workersQ = useQuery({ queryKey: qk.holidayWorkers, queryFn: fetchHolidayWorkers, staleTime: STALE_ANALYTICS })
  const tasksQ = useQuery({
    queryKey: ['tasks', 'since', period.priorStart] as const,
    queryFn: () => fetchTasksSince(sinceIso),
    staleTime: STALE_LIVE,
  })
  const metricsQ = useQuery({
    queryKey: qk.taskMetrics(period.priorStart, period.end),
    queryFn: () => fetchTaskMetricsSince(sinceIso),
    staleTime: STALE_ANALYTICS,
  })
  const attendanceQ = useQuery({
    queryKey: qk.attendance(period.priorStart, period.end),
    queryFn: () => fetchAttendance(period.priorStart, period.end),
    staleTime: STALE_LIVE,
  })

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
    const tasks = tasksQ.data ?? []
    const metrics = metricsQ.data ?? []
    const cur = summarizeDesigner(designerId, { start: period.start, end: period.end, tasks, metrics, quota })
    const prev = summarizeDesigner(designerId, {
      start: period.priorStart,
      end: period.priorEnd,
      tasks,
      metrics,
      quota,
    })
    return { cur, prev }
  }, [designerId, tasksQ.data, metricsQ.data, quota, period])

  /** Team reference points (§22.5) — ops scope only; the self view never sees peers (§22.10). */
  const teamRef = useMemo(() => {
    if (scope !== 'ops') return null
    const designer = (designersQ.data ?? []).find((d) => d.id === designerId)
    if (!designer) return null
    const peers = (designersQ.data ?? []).filter(
      (d) => d.team === designer.team && d.status === 'active',
    )
    if (peers.length < 2) return null
    const tasks = tasksQ.data ?? []
    const metrics = metricsQ.data ?? []
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
  }, [scope, designerId, designersQ.data, tasksQ.data, metricsQ.data, quota, period])

  const warmup = useMemo(() => {
    const mine = (attendanceQ.data ?? []).filter((a) => a.designer_id === designerId)
    const inRange = (a: AttendanceDaily, s: string, e: string) => a.work_date >= s && a.work_date <= e
    const gap = (s: string, e: string) =>
      median(
        mine
          .filter((a) => inRange(a, s, e))
          .map((a) => a.warmup_gap_min)
          .filter((v): v is number => v != null),
      )
    return { cur: gap(period.start, period.end), prev: gap(period.priorStart, period.priorEnd) }
  }, [attendanceQ.data, designerId, period])

  const s = summaries.cur
  const p = summaries.prev
  const vs = period.vs
  const pts = (abs: number) => `${abs} pts`
  const metricsLoading = tasksQ.isLoading || metricsQ.isLoading

  const defectTotal = s.csrCaughtRounds + s.clientCaughtRounds
  const defectDiagnosis =
    defectTotal === 0
      ? `No change requests in the ${period.label} — nothing to look at.`
      : s.csrCaughtRounds >= s.clientCaughtRounds
        ? scope === 'ops'
          ? 'Most problems were caught by our own checkers before the client saw them. Some coaching may help.'
          : 'Most problems were caught and fixed by our checkers before the client ever saw them.'
        : scope === 'ops'
          ? 'Most problems were spotted by clients, not our checkers. The checking step or the brief may need tightening.'
          : 'Most problems were spotted by clients — worth an extra check before sending next time.'

  const lastGood = Math.max(tasksQ.dataUpdatedAt, metricsQ.dataUpdatedAt)

  return (
    <div className="space-y-6">
      {(tasksQ.error || metricsQ.error) && (
        <ErrorBanner
          message="Could not load the latest numbers — you are seeing the last saved view."
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
          eyebrow={labelTip(
            'Target met',
            'Out of the projects this person was supposed to take, how many they finished.',
          )}
          icon={Gauge}
          value={fmtPct(s.attainmentPct)}
          delta={metricDelta(s.attainmentPct, p.attainmentPct, 'up', pts, vs)}
          cause={`finished ${s.completed} of ${s.expectedQuota} expected`}
          reference={teamRef?.attainment != null ? `typical for the team: ${teamRef.attainment}%` : null}
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
          eyebrow={labelTip(
            'Right first time',
            'How many designs were accepted without anyone asking for changes. Higher is better.',
          )}
          icon={ShieldCheck}
          value={fmtPct(s.firstPassQualityPct)}
          delta={metricDelta(s.firstPassQualityPct, p.firstPassQualityPct, 'up', pts, vs)}
          cause={
            s.delivered > 0
              ? `${s.firstPassClean} of ${s.delivered} designs needed no changes`
              : 'Nothing sent to a client in this period yet'
          }
          reference={teamRef?.fpq != null ? `typical for the team: ${teamRef.fpq}%` : null}
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
          eyebrow={labelTip(
            'Work time',
            'The usual time from getting a project to sending the first design. Waiting for the client is not counted.',
          )}
          icon={Timer}
          value={fmtDuration(s.productionMedianMin)}
          delta={metricDelta(s.productionMedianMin, p.productionMedianMin, 'down', fmtDuration, vs)}
          cause={
            scope === 'ops'
              ? `usual time across ${s.delivered} first designs — client waiting time not counted`
              : 'your usual time to the first design — waiting for the client never counts against you'
          }
          reference={teamRef?.production != null ? `typical for the team: ${fmtDuration(teamRef.production)}` : null}
          loading={metricsLoading}
        />
        <StatTile
          eyebrow={labelTip(
            'Fix time',
            'The usual time to finish changes after someone asks for them.',
          )}
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
          reference={teamRef?.revision != null ? `typical for the team: ${fmtDuration(teamRef.revision)}` : null}
          loading={metricsLoading}
        />
        <StatTile
          eyebrow={labelTip(
            'Cancelled orders',
            'Orders lost because of a design problem. Check the project history before judging.',
          )}
          icon={XCircle}
          value={String(s.cancelled)}
          delta={metricDelta(s.cancelled, p.cancelled, 'down', String, vs)}
          cause={
            s.cancelled > 0
              ? scope === 'ops'
                ? `${fmtPct(s.cancellationRatePct)} of ${s.assigned} projects — check the history before judging`
                : `${fmtPct(s.cancellationRatePct)} of ${s.assigned} projects in this period`
              : `0 of ${s.assigned} projects — none lost`
          }
          state={s.cancelled > 0 ? 'flag' : 'ok'}
          loading={metricsLoading}
        />
        <StatTile
          eyebrow={labelTip(
            'Start delay',
            'The time between pressing Check in and doing the first real work in ClickUp.',
          )}
          icon={LogIn}
          value={fmtDuration(warmup.cur)}
          delta={metricDelta(warmup.cur, warmup.prev, 'down', fmtDuration, vs)}
          cause="usual gap between checking in and the first real work"
          state={warmup.cur == null ? null : warmup.cur > 60 ? 'flag' : warmup.cur > 30 ? 'watch' : 'ok'}
          loading={attendanceQ.isLoading}
        />
      </div>

      {/* ── Defect source split (§4.2) ── */}
      <section className="card p-5">
        <h4 className="eyebrow inline-flex items-center gap-1">
          Who asked for changes — {period.label}
          <InfoTip text="Who spotted the problems: our own checkers or the client. Problems the client sees matter more." />
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
        <p className="mt-3 text-sm text-muted">{defectDiagnosis}</p>
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
      vs: 'vs last period',
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
        message: `${mark_type === 'check_in' ? 'Check-in' : 'Check-out'} saved for ${
          designer?.name ?? 'this designer'
        }`,
      })
    },
    onError: (e: Error) => toast({ message: `Could not save it — ${e.message}` }),
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
        title="Designer not found"
        hint="They may have been removed, or you may not have access to their page."
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
          <h3 className="text-xl font-semibold text-fg">{designer.name}</h3>
          <Badge tone="neutral">{designer.team}</Badge>
          {designer.status === 'archived' && <Badge tone="warning">Archived</Badge>}
        </div>
        {designer.specialty && <p className="mt-0.5 text-sm text-muted">{designer.specialty}</p>}
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {schedule ? (
            <span>
              {schedule.daily_quota} projects a day · {fmtShiftTime(schedule.shift_start)}–
              {fmtShiftTime(schedule.shift_end)} PKT
              {schedule.weekly_off != null && ` · day off ${DOW_LABELS[schedule.weekly_off]}`}
            </span>
          ) : (
            <span>No work hours set — "Target met" cannot be worked out</span>
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {listUrl && (
            <a
              href={listUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open list in ClickUp
            </a>
          )}
          {scope === 'ops' && (
            <>
              <button
                type="button"
                onClick={() => markMutation.mutate('check_in')}
                disabled={markMutation.isPending}
                className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                Check in for them
              </button>
              <button
                type="button"
                onClick={() => markMutation.mutate('check_out')}
                disabled={markMutation.isPending}
                className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Check out for them
              </button>
              <Link
                to="/ops/roster"
                className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-brand hover:underline"
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
          How they did — {periodLabel}
          <InfoTip text="Their numbers for the chosen period, each compared with the period before it." />
        </h4>
        <SegmentedControl<Period>
          options={[
            { value: 'week', label: '7 days' },
            { value: 'month', label: '30 days' },
          ]}
          value={period}
          onChange={setPeriod}
          ariaLabel="Metric period"
        />
      </div>

      {/* ── Shared metric grid + defect split (§22.3) ── */}
      <DesignerMetricsPanel designerId={designerId} scope={scope} period={metricsPeriod} />

      {/* ── Open tasks ── */}
      <section>
        <h4 className="eyebrow inline-flex items-center gap-1">
          Open projects ({myOpenTasks.length}) — oldest first
          <InfoTip text="Everything on their plate right now. The oldest sits at the top." />
        </h4>
        <div className="mt-3 space-y-2">
          {openTasksQ.isLoading ? (
            [0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)
          ) : myOpenTasks.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No open projects"
              hint={
                scope === 'ops'
                  ? 'They have room for more — anything given in ClickUp shows up here right away.'
                  : 'Nothing right now — new projects show up here the moment they land.'
              }
            />
          ) : (
            myOpenTasks.map((t) => (
              <TaskCard key={t.task_id} task={t} onOpen={(id) => setTrailTaskId(id)} />
            ))
          )}
        </div>
      </section>

      {/* ── Recent attendance ── */}
      <section>
        <h4 className="eyebrow inline-flex items-center gap-1">
          Attendance — last 7 days
          <InfoTip text="One box per day: worked, on leave, day off, absent, and so on." />
        </h4>
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Attendance, last 7 days">
          {stripDates.map((d) => {
            const row = attendanceByDate.get(d)
            const chip = row?.status ? ATTENDANCE_CHIP[row.status] : null
            return (
              <div key={d} className="flex flex-col items-center gap-1">
                <span
                  className={`tnum flex h-9 w-9 items-center justify-center rounded-lg text-xs font-semibold ${
                    chip ? chip.className : 'bg-surface-2 text-muted/60'
                  }`}
                  title={`${fmtDate(d)}: ${row?.status ?? 'no record'}${
                    row?.warmup_gap_min != null ? ` · start delay ${fmtDuration(row.warmup_gap_min)}` : ''
                  }`}
                >
                  {chip ? chip.letter : '·'}
                </span>
                <span className="text-[10px] text-muted">{fmtDate(d).split(' ')[0]}</span>
              </div>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-muted">
          P present · HW worked on a holiday · L leave · H holiday · W weekly day off · A absent ·
          I incomplete
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
                className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                Open in ClickUp
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
