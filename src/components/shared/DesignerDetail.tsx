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
import { DOW_LABELS, fmtDate, fmtDuration, fmtPct, fmtShiftTime } from '../../lib/format'
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

const ATTENDANCE_CHIP: Record<AttendanceStatus, { letter: string; className: string }> = {
  Present: { letter: 'P', className: 'bg-success-soft text-success' },
  HolidayWorked: { letter: 'HW', className: 'bg-success-soft text-success' },
  Leave: { letter: 'L', className: 'bg-surface-2 text-muted' },
  Holiday: { letter: 'H', className: 'bg-surface-2 text-muted' },
  WeeklyOff: { letter: 'W', className: 'bg-surface-2 text-muted' },
  Absent: { letter: 'A', className: 'bg-danger-soft text-danger' },
  Incomplete: { letter: 'I', className: 'bg-warning-soft text-warning' },
}

/**
 * One shared, RLS-scoped designer drill-down (spec §22.3) used by the Ops
 * drawer and the Designer self-view. Every metric ships with delta + cause
 * (§20.2); the self scope compares only to the designer's own past (§22.10) —
 * the reads themselves are already scoped server-side.
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
  const sinceIso = pktInstant(prior.start, '00:00').toISOString()

  const designersQ = useQuery({ queryKey: qk.designers, queryFn: fetchDesigners, staleTime: STALE_ANALYTICS })
  const schedulesQ = useQuery({ queryKey: qk.schedules, queryFn: fetchSchedules, staleTime: STALE_ANALYTICS })
  const exceptionsQ = useQuery({ queryKey: qk.quotaExceptions, queryFn: fetchQuotaExceptions, staleTime: STALE_ANALYTICS })
  const leavesQ = useQuery({ queryKey: qk.leaves, queryFn: fetchLeaves, staleTime: STALE_ANALYTICS })
  const holidaysQ = useQuery({ queryKey: qk.holidays, queryFn: fetchHolidays, staleTime: STALE_ANALYTICS })
  const workersQ = useQuery({ queryKey: qk.holidayWorkers, queryFn: fetchHolidayWorkers, staleTime: STALE_ANALYTICS })
  const tasksQ = useQuery({
    queryKey: ['tasks', 'since', prior.start] as const,
    queryFn: () => fetchTasksSince(sinceIso),
    staleTime: STALE_LIVE,
  })
  const metricsQ = useQuery({
    queryKey: qk.taskMetrics(prior.start, range.end),
    queryFn: () => fetchTaskMetricsSince(sinceIso),
    staleTime: STALE_ANALYTICS,
  })
  const openTasksQ = useQuery({ queryKey: qk.openTasks, queryFn: fetchOpenTasks, staleTime: STALE_LIVE })
  const attendanceQ = useQuery({
    queryKey: qk.attendance(prior.start, range.end),
    queryFn: () => fetchAttendance(prior.start, range.end),
    staleTime: STALE_LIVE,
  })

  const designer = (designersQ.data ?? []).find((d) => d.id === designerId)
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
  const schedule = scheduleFor(quota.schedules, designerId, today)

  const summaries = useMemo(() => {
    const tasks = tasksQ.data ?? []
    const metrics = metricsQ.data ?? []
    const cur = summarizeDesigner(designerId, { start: range.start, end: range.end, tasks, metrics, quota })
    const prev = summarizeDesigner(designerId, { start: prior.start, end: prior.end, tasks, metrics, quota })
    return { cur, prev }
  }, [designerId, tasksQ.data, metricsQ.data, quota, range, prior])

  /** Team reference points (§22.5) — ops scope only; the self view never sees peers. */
  const teamRef = useMemo(() => {
    if (scope !== 'ops' || !designer) return null
    const peers = (designersQ.data ?? []).filter(
      (d) => d.team === designer.team && d.status === 'active',
    )
    if (peers.length < 2) return null
    const tasks = tasksQ.data ?? []
    const metrics = metricsQ.data ?? []
    const rows: DesignerPeriodSummary[] = peers.map((p) =>
      summarizeDesigner(p.id, { start: range.start, end: range.end, tasks, metrics, quota }),
    )
    return {
      attainment: median(rows.map((r) => r.attainmentPct).filter((v): v is number => v != null)),
      fpq: median(rows.map((r) => r.firstPassQualityPct).filter((v): v is number => v != null)),
    }
  }, [scope, designer, designersQ.data, tasksQ.data, metricsQ.data, quota, range])

  const myAttendance = useMemo(
    () => (attendanceQ.data ?? []).filter((a) => a.designer_id === designerId),
    [attendanceQ.data, designerId],
  )
  const warmup = useMemo(() => {
    const inRange = (a: AttendanceDaily, s: string, e: string) => a.work_date >= s && a.work_date <= e
    const cur = median(
      myAttendance
        .filter((a) => inRange(a, range.start, range.end))
        .map((a) => a.warmup_gap_min)
        .filter((v): v is number => v != null),
    )
    const prev = median(
      myAttendance
        .filter((a) => inRange(a, prior.start, prior.end))
        .map((a) => a.warmup_gap_min)
        .filter((v): v is number => v != null),
    )
    return { cur, prev }
  }, [myAttendance, range, prior])

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
        message: `Manual ${mark_type === 'check_in' ? 'check-in' : 'check-out'} recorded for ${
          designer?.name ?? 'designer'
        }`,
      })
    },
    onError: (e: Error) => toast({ message: `Couldn't record the mark — ${e.message}` }),
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
        hint="They may have been removed, or you may not have access to this profile."
      />
    )
  }

  const listUrl = clickupListUrl(designer.clickup_list_id)
  const s = summaries.cur
  const p = summaries.prev
  const periodLabel = period === 'week' ? 'last 7 days' : 'last 30 days'
  const vs = 'vs prior'
  const pts = (abs: number) => `${abs} pts`

  const defectTotal = s.csrCaughtRounds + s.clientCaughtRounds
  const defectDiagnosis =
    defectTotal === 0
      ? `No revision rounds in the ${periodLabel} — nothing to diagnose.`
      : s.csrCaughtRounds >= s.clientCaughtRounds
        ? 'Mostly CSR-caught — internal quality misses. Coach the designer (§4.2).'
        : 'Mostly client-caught with a quieter CSR gate — tighten the gate or the brief (§4.2).'

  const trailTask = trailTaskId ? myOpenTasks.find((t) => t.task_id === trailTaskId) : undefined
  const stripDates = dateRange(addDays(today, -6), today)
  const attendanceByDate = new Map(myAttendance.map((a) => [a.work_date, a]))

  return (
    <div className="space-y-6">
      {(tasksQ.error || metricsQ.error) && (
        <ErrorBanner
          message="Couldn't refresh production data — showing the last loaded numbers."
          onRetry={() => {
            void tasksQ.refetch()
            void metricsQ.refetch()
          }}
        />
      )}

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
              {schedule.daily_quota}/day · {fmtShiftTime(schedule.shift_start)}–
              {fmtShiftTime(schedule.shift_end)} PKT
              {schedule.weekly_off != null && ` · off ${DOW_LABELS[schedule.weekly_off]}`}
            </span>
          ) : (
            <span>No schedule set — quota attainment can't be computed</span>
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
                Manual check-in
              </button>
              <button
                type="button"
                onClick={() => markMutation.mutate('check_out')}
                disabled={markMutation.isPending}
                className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Manual check-out
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
        <h4 className="eyebrow">Performance — {periodLabel}</h4>
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

      {/* ── Metric grid (§20.2: delta + cause on every number) ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatTile
          eyebrow="Quota attainment"
          icon={Gauge}
          value={fmtPct(s.attainmentPct)}
          delta={metricDelta(s.attainmentPct, p.attainmentPct, 'up', pts, vs)}
          cause={`${s.completed} completed of ${s.expectedQuota} expected`}
          reference={
            teamRef?.attainment != null ? `team median ${teamRef.attainment}%` : null
          }
          state={
            s.attainmentPct == null
              ? null
              : s.attainmentPct >= 85
                ? 'ok'
                : s.attainmentPct >= 60
                  ? 'watch'
                  : 'flag'
          }
          loading={tasksQ.isLoading || metricsQ.isLoading}
        />
        <StatTile
          eyebrow="First-pass quality"
          icon={ShieldCheck}
          value={fmtPct(s.firstPassQualityPct)}
          delta={metricDelta(s.firstPassQualityPct, p.firstPassQualityPct, 'up', pts, vs)}
          cause={
            s.delivered > 0
              ? `${s.firstPassClean} of ${s.delivered} delivered clean`
              : 'Nothing delivered in this period yet'
          }
          reference={teamRef?.fpq != null ? `team median ${teamRef.fpq}%` : null}
          state={
            s.firstPassQualityPct == null
              ? null
              : s.firstPassQualityPct >= 80
                ? 'ok'
                : s.firstPassQualityPct >= 60
                  ? 'watch'
                  : 'flag'
          }
          loading={tasksQ.isLoading || metricsQ.isLoading}
        />
        <StatTile
          eyebrow="Production speed"
          icon={Timer}
          value={fmtDuration(s.productionMedianMin)}
          delta={metricDelta(s.productionMedianMin, p.productionMedianMin, 'down', fmtDuration, vs)}
          cause={`median over ${s.delivered} first deliveries — client wait excluded (§4.1)`}
          loading={tasksQ.isLoading || metricsQ.isLoading}
        />
        <StatTile
          eyebrow="Revision turnaround"
          icon={RotateCcw}
          value={fmtDuration(s.revisionTurnaroundMedianMin)}
          delta={metricDelta(
            s.revisionTurnaroundMedianMin,
            p.revisionTurnaroundMedianMin,
            'down',
            fmtDuration,
            vs,
          )}
          cause={`${s.revisionRounds} revision round${s.revisionRounds === 1 ? '' : 's'} on tasks assigned in period`}
          loading={tasksQ.isLoading || metricsQ.isLoading}
        />
        <StatTile
          eyebrow="Cancellations"
          icon={XCircle}
          value={String(s.cancelled)}
          delta={metricDelta(s.cancelled, p.cancelled, 'down', String, vs)}
          cause={
            s.cancelled > 0
              ? `${fmtPct(s.cancellationRatePct)} of ${s.assigned} assigned — investigate the trail, don't verdict (§4.4)`
              : `0 of ${s.assigned} assigned — no terminal losses`
          }
          state={s.cancelled > 0 ? 'flag' : 'ok'}
          loading={tasksQ.isLoading || metricsQ.isLoading}
        />
        <StatTile
          eyebrow="Warm-up gap"
          icon={LogIn}
          value={fmtDuration(warmup.cur)}
          delta={metricDelta(warmup.cur, warmup.prev, 'down', fmtDuration, vs)}
          cause="median check-in → first ClickUp activity (§9.3)"
          state={warmup.cur == null ? null : warmup.cur > 60 ? 'flag' : warmup.cur > 30 ? 'watch' : 'ok'}
          loading={attendanceQ.isLoading}
        />
      </div>

      {/* ── Defect source split (§4.2) ── */}
      <section className="card p-5">
        <h4 className="eyebrow">Defect source — {periodLabel}</h4>
        <div className="mt-3">
          <HBar
            rows={[
              {
                label: 'CSR-caught',
                value: s.csrCaughtRounds,
                tone: 'warning',
                secondary: 'internal reject — never reached the client',
              },
              {
                label: 'Client-caught',
                value: s.clientCaughtRounds,
                tone: 'danger',
                secondary: 'client saw it and wanted changes',
              },
            ]}
            formatValue={(v) => `${v} round${v === 1 ? '' : 's'}`}
            ariaLabel="Revision rounds by who caught the defect"
          />
        </div>
        <p className="mt-3 text-sm text-muted">{defectDiagnosis}</p>
      </section>

      {/* ── Open tasks ── */}
      <section>
        <h4 className="eyebrow">Open tasks ({myOpenTasks.length}) — oldest first</h4>
        <div className="mt-3 space-y-2">
          {openTasksQ.isLoading ? (
            [0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)
          ) : myOpenTasks.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No open tasks"
              hint={
                scope === 'ops'
                  ? 'Spare capacity — new work assigned in ClickUp appears here instantly.'
                  : 'Nothing in flight — new assignments appear here the moment they land.'
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
        <h4 className="eyebrow">Attendance — last 7 days</h4>
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
                    row?.warmup_gap_min != null ? ` · warm-up ${fmtDuration(row.warmup_gap_min)}` : ''
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
          P present · HW holiday worked · L leave · H holiday · W weekly off · A absent · I
          incomplete
        </p>
      </section>

      {/* ── Task trail drawer ── */}
      <Drawer
        open={trailTaskId != null}
        onClose={() => setTrailTaskId(null)}
        title={trailTask?.name ?? 'Task trail'}
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
