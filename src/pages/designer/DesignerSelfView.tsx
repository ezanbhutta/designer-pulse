import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  CircleCheck,
  Clock,
  ExternalLink,
  Gauge,
  Inbox,
  LogIn,
  LogOut,
  Moon,
  RotateCcw,
  Sparkles,
  Sun,
  Target,
  UserRound,
} from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import {
  STALE_ANALYTICS,
  clickupListUrl,
  clickupTaskUrl,
  fetchAttendance,
  fetchConfig,
  fetchDesigners,
  fetchHolidayWorkers,
  fetchHolidays,
  fetchLeaves,
  fetchOpenTasks,
  fetchQuotaExceptions,
  fetchSchedules,
  fetchShiftMarksAround,
  fetchTaskMetricsSince,
  fetchTasksSince,
  insertShiftMark,
  qk,
} from '../../lib/queries'
import { ToastProvider, useToast } from '../../components/ui/ToastProvider'
import { StatTile } from '../../components/ui/StatTile'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { Badge, type BadgeProps } from '../../components/ui/Badge'
import { TrendLine, type TrendPoint } from '../../components/ui/TrendLine'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { Skeleton } from '../../components/ui/Skeleton'
import { fmtDate, fmtDuration, fmtPct, fmtShiftTime, fmtTime } from '../../lib/format'
import {
  addDays,
  collectionWindow,
  dowOf,
  minutesBetween,
  pktDateOf,
  pktInstant,
  pktToday,
  shiftWindow,
} from '../../../shared/pkt'
import {
  ageMinutes,
  expectedQuotaOn,
  priorPeriod,
  scheduleFor,
  summarizeDesigner,
  type DesignerPeriodSummary,
  type QuotaContext,
} from '../../../shared/aggregate'
import { leaveCovers } from '../../../shared/attendance'
import { STATUS_LABELS } from '../../../shared/statuses'
import { CONFIG_DEFAULTS } from '../../../shared/types'
import type {
  AttendanceDaily,
  AttendanceStatus,
  DesignerSchedule,
  Holiday,
  Leave,
  TaskState,
} from '../../../shared/types'

// ── Small utilities ───────────────────────────────────────────────────────────

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Slightly beyond the 5s toast so Undo always wins the race. */
const UNDO_COMMIT_MS = 5200

const PKT_DATELINE = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'Asia/Karachi',
})

function pktHour(now: Date): number {
  return (now.getUTCHours() + 5) % 24
}

function greetingFor(now: Date): string {
  const h = pktHour(now)
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

type Delta = { label: string; direction: 'up' | 'down' | 'flat'; good: boolean } | null

/** Delta vs OWN prior week only (§22.10) — percentage-point metrics. */
function pctPointDelta(cur: number | null, prev: number | null, higherIsBetter: boolean): Delta {
  if (cur == null || prev == null) return null
  const diff = cur - prev
  if (diff === 0) return { label: 'level with last week', direction: 'flat', good: true }
  return {
    label: `${Math.abs(diff)} pts vs your last week`,
    direction: diff > 0 ? 'up' : 'down',
    good: diff > 0 === higherIsBetter,
  }
}

/** Duration metrics — down is good, and the label says so in plain language. */
function durationDelta(curMin: number | null, prevMin: number | null): Delta {
  if (curMin == null || prevMin == null) return null
  const diff = curMin - prevMin
  if (diff === 0) return { label: 'level with last week', direction: 'flat', good: true }
  return {
    label: `${fmtDuration(Math.abs(diff))} ${diff < 0 ? 'faster' : 'slower'} than last week`,
    direction: diff < 0 ? 'down' : 'up',
    good: diff < 0,
  }
}

/** Attendance tones per §21.2 — off states are calm, never alarming. */
const ATT_TONE: Record<AttendanceStatus, BadgeProps['tone']> = {
  Present: 'success',
  HolidayWorked: 'success',
  Leave: 'neutral',
  Holiday: 'neutral',
  WeeklyOff: 'neutral',
  Absent: 'warning',
  Incomplete: 'warning',
}

// ── Theme toggle (light-default self-view, §21.9 — override persists) ─────────

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {
      // Storage unavailable — the theme still applies for this session.
    }
    setDark(next)
  }

  const Icon = dark ? Sun : Moon
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
    </button>
  )
}

// ── Page shell: ToastProvider wraps everything (undo toasts, §20.6) ───────────

export default function DesignerSelfView() {
  return (
    <ToastProvider>
      <SelfViewBody />
    </ToastProvider>
  )
}

interface LocalMark {
  id: string
  mark_type: 'check_in' | 'check_out'
  marked_at: string
}

interface ActiveShift {
  workDate: string
  schedule: DesignerSchedule | null
  /** true = an overnight shift that STARTED yesterday is still running (§22.11). */
  carry: boolean
}

function SelfViewBody() {
  const { profile, signOut } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const designerId = profile?.designer_id ?? null

  // Ticking clock so "time since check-in" and the shift context stay honest.
  const [now, setNow] = useState<Date>(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const today = pktToday(now)
  const dates = useMemo(() => {
    const dow = dowOf(today)
    const weekStart = addDays(today, -((dow + 6) % 7)) // Monday of this PKT week
    const weekEnd = addDays(weekStart, 6)
    const prior = priorPeriod(weekStart, weekEnd)
    const trendStart = addDays(weekStart, -49) // 8 weeks including this one
    return {
      weekStart,
      weekEnd,
      prior,
      trendStart,
      sinceIso: pktInstant(trendStart, '00:00').toISOString(),
      markStart: addDays(today, -1), // covers overnight shifts started yesterday
      attStart: addDays(weekStart, -1),
    }
  }, [today])

  const enabled = designerId != null

  // ── Queries — every read is RLS-scoped to this designer server-side (§14) ──
  const designersQ = useQuery({ queryKey: qk.designers, queryFn: fetchDesigners, enabled })
  const schedulesQ = useQuery({ queryKey: qk.schedules, queryFn: fetchSchedules, enabled })
  const exceptionsQ = useQuery({
    queryKey: qk.quotaExceptions,
    queryFn: fetchQuotaExceptions,
    enabled,
  })
  const leavesQ = useQuery({ queryKey: qk.leaves, queryFn: fetchLeaves, enabled })
  const holidaysQ = useQuery({ queryKey: qk.holidays, queryFn: fetchHolidays, enabled })
  const holidayWorkersQ = useQuery({
    queryKey: qk.holidayWorkers,
    queryFn: fetchHolidayWorkers,
    enabled,
  })
  const configQ = useQuery({
    queryKey: qk.config,
    queryFn: fetchConfig,
    enabled,
    staleTime: STALE_ANALYTICS,
  })
  const openTasksQ = useQuery({ queryKey: qk.openTasks, queryFn: fetchOpenTasks, enabled })
  const tasksQ = useQuery({
    queryKey: ['tasks', 'since', dates.trendStart],
    queryFn: () => fetchTasksSince(dates.sinceIso),
    enabled,
    staleTime: STALE_ANALYTICS,
  })
  const metricsQ = useQuery({
    queryKey: qk.taskMetrics(dates.trendStart, today),
    queryFn: () => fetchTaskMetricsSince(dates.sinceIso),
    enabled,
    staleTime: STALE_ANALYTICS,
  })
  const attendanceQ = useQuery({
    queryKey: qk.attendance(dates.attStart, today),
    queryFn: () => fetchAttendance(dates.attStart, today),
    enabled,
  })
  const marksQ = useQuery({
    queryKey: qk.shiftMarks(dates.markStart),
    queryFn: () => fetchShiftMarksAround(dates.markStart),
    enabled,
  })

  const cfg = configQ.data ?? CONFIG_DEFAULTS
  const designer = useMemo(
    () => (designersQ.data ?? []).find((d) => d.id === designerId) ?? null,
    [designersQ.data, designerId],
  )
  const mySchedules = useMemo(
    () => (schedulesQ.data ?? []).filter((s) => s.designer_id === designerId),
    [schedulesQ.data, designerId],
  )
  const myLeaves = useMemo(
    () => (leavesQ.data ?? []).filter((l) => l.designer_id === designerId),
    [leavesQ.data, designerId],
  )
  const holidays = holidaysQ.data ?? []
  const quota: QuotaContext = useMemo(
    () => ({
      schedules: mySchedules,
      exceptions: (exceptionsQ.data ?? []).filter((e) => e.designer_id === designerId),
      leaves: myLeaves,
      holidays,
      holidayWorkers: (holidayWorkersQ.data ?? []).filter((w) => w.designer_id === designerId),
    }),
    [mySchedules, exceptionsQ.data, myLeaves, holidays, holidayWorkersQ.data, designerId],
  )

  // ── Active shift resolution (§22.11 — shift context, never calendar-naive) ─
  const active: ActiveShift = useMemo(() => {
    const fallback: ActiveShift = {
      workDate: today,
      schedule: designerId ? scheduleFor(mySchedules, designerId, today) : null,
      carry: false,
    }
    if (!designerId) return fallback
    const yesterday = addDays(today, -1)
    const ySched = scheduleFor(mySchedules, designerId, yesterday)
    if (ySched && ySched.shift_end <= ySched.shift_start) {
      const w = shiftWindow(yesterday, ySched.shift_start, ySched.shift_end)
      if (now < w.scheduledOut) return { workDate: yesterday, schedule: ySched, carry: true }
    }
    return fallback
  }, [designerId, mySchedules, today, now])

  const markWindow = useMemo(() => {
    if (active.schedule) {
      const w = collectionWindow(
        active.workDate,
        active.schedule.shift_start,
        active.schedule.shift_end,
        cfg.overnight_window_buffer_hours,
      )
      return { from: w.from, to: w.to }
    }
    return {
      from: pktInstant(active.workDate, '00:00'),
      to: pktInstant(active.workDate, '23:59:59'),
    }
  }, [active, cfg.overnight_window_buffer_hours])

  // ── Optimistic check-in/out with a real Undo window (§20.6) ────────────────
  // shift_marks is append-only (designers cannot delete a mark), so "undo" is
  // implemented by DEFERRING the insert until the 5s toast expires; undo simply
  // cancels the pending write. Pending marks flush immediately on unmount.
  const [localMarks, setLocalMarks] = useState<LocalMark[]>([])
  const localMarksRef = useRef<LocalMark[]>([])
  const pendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const designerIdRef = useRef(designerId)
  useEffect(() => {
    localMarksRef.current = localMarks
  }, [localMarks])
  useEffect(() => {
    designerIdRef.current = designerId
  }, [designerId])

  const commitMark = useCallback(
    async (local: LocalMark) => {
      pendingTimers.current.delete(local.id)
      const id = designerIdRef.current
      if (!id) return
      try {
        await insertShiftMark({
          designer_id: id,
          mark_type: local.mark_type,
          source: 'self',
          marked_at: local.marked_at,
        })
        void queryClient.invalidateQueries({ queryKey: ['shift-marks'] })
        void queryClient.invalidateQueries({ queryKey: ['attendance'] })
      } catch {
        // Roll back visibly (§20.6) — the button returns to its prior state.
        setLocalMarks((prev) => prev.filter((m) => m.id !== local.id))
        toast({
          message: `Couldn't save your ${local.mark_type === 'check_in' ? 'check-in' : 'check-out'} — check your connection and try again`,
        })
      }
    },
    [queryClient, toast],
  )

  // Flush any still-pending marks on unmount so nothing is silently lost.
  useEffect(() => {
    const timers = pendingTimers.current
    return () => {
      for (const [id, timer] of timers) {
        clearTimeout(timer)
        const m = localMarksRef.current.find((x) => x.id === id)
        const did = designerIdRef.current
        if (m && did) {
          void insertShiftMark({
            designer_id: did,
            mark_type: m.mark_type,
            source: 'self',
            marked_at: m.marked_at,
          }).catch(() => undefined)
        }
      }
      timers.clear()
    }
  }, [])

  const mark = useCallback(
    (mark_type: 'check_in' | 'check_out') => {
      if (!designerId) return
      const markedAt = new Date().toISOString()
      const local: LocalMark = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        mark_type,
        marked_at: markedAt,
      }
      setLocalMarks((prev) => [...prev, local])
      pendingTimers.current.set(
        local.id,
        setTimeout(() => void commitMark(local), UNDO_COMMIT_MS),
      )
      toast({
        message:
          mark_type === 'check_in'
            ? `Checked in at ${fmtTime(markedAt)} — have a good shift`
            : `Checked out at ${fmtTime(markedAt)} — see you next shift`,
        undo: () => {
          const timer = pendingTimers.current.get(local.id)
          if (timer) clearTimeout(timer)
          pendingTimers.current.delete(local.id)
          setLocalMarks((prev) => prev.filter((m) => m.id !== local.id))
        },
      })
    },
    [designerId, commitMark, toast],
  )

  // ── Check-in state machine from today's shift marks ────────────────────────
  const marksInWindow = useMemo(() => {
    const server = (marksQ.data ?? [])
      .filter((m) => m.designer_id === designerId)
      .map((m) => ({ mark_type: m.mark_type, marked_at: m.marked_at }))
    const all = [...server, ...localMarks.map((m) => ({ mark_type: m.mark_type, marked_at: m.marked_at }))]
    return all
      .filter((m) => {
        const t = new Date(m.marked_at)
        return t >= markWindow.from && t <= markWindow.to
      })
      .sort((a, b) => a.marked_at.localeCompare(b.marked_at))
  }, [marksQ.data, localMarks, designerId, markWindow])

  const lastMark = marksInWindow[marksInWindow.length - 1] ?? null
  const phase: 'unmarked' | 'in' | 'out' =
    lastMark == null ? 'unmarked' : lastMark.mark_type === 'check_in' ? 'in' : 'out'
  const lastCheckIn = useMemo(
    () => [...marksInWindow].reverse().find((m) => m.mark_type === 'check_in') ?? null,
    [marksInWindow],
  )
  const firstCheckIn = useMemo(
    () => marksInWindow.find((m) => m.mark_type === 'check_in') ?? null,
    [marksInWindow],
  )

  // ── Period summaries — own data, own past only (§22.10) ────────────────────
  const myTasks = useMemo(
    () => (tasksQ.data ?? []).filter((t) => t.designer_id === designerId),
    [tasksQ.data, designerId],
  )
  const myMetrics = useMemo(
    () => (metricsQ.data ?? []).filter((m) => m.designer_id === designerId),
    [metricsQ.data, designerId],
  )
  const myOpenTasks = useMemo(
    () => (openTasksQ.data ?? []).filter((t) => t.designer_id === designerId && !t.deleted),
    [openTasksQ.data, designerId],
  )

  const weekSum: DesignerPeriodSummary | null = useMemo(
    () =>
      designerId
        ? summarizeDesigner(designerId, {
            start: dates.weekStart,
            end: dates.weekEnd,
            tasks: myTasks,
            metrics: myMetrics,
            quota,
          })
        : null,
    [designerId, dates.weekStart, dates.weekEnd, myTasks, myMetrics, quota],
  )
  const prevSum: DesignerPeriodSummary | null = useMemo(
    () =>
      designerId
        ? summarizeDesigner(designerId, {
            start: dates.prior.start,
            end: dates.prior.end,
            tasks: myTasks,
            metrics: myMetrics,
            quota,
          })
        : null,
    [designerId, dates.prior, myTasks, myMetrics, quota],
  )
  const daySum: DesignerPeriodSummary | null = useMemo(
    () =>
      designerId
        ? summarizeDesigner(designerId, {
            start: active.workDate,
            end: active.workDate,
            tasks: myTasks,
            metrics: myMetrics,
            quota,
          })
        : null,
    [designerId, active.workDate, myTasks, myMetrics, quota],
  )
  const expectedToday = designerId ? expectedQuotaOn(designerId, active.workDate, quota) : 0

  const dayOffReason: 'holiday' | 'leave' | 'weekly_off' | 'none' | null = useMemo(() => {
    if (!designerId || expectedToday > 0) return null
    const isHoliday = holidays.some((h) => h.the_date === active.workDate)
    const volunteers = quota.holidayWorkers.some((w) => w.the_date === active.workDate)
    if (isHoliday && !volunteers) return 'holiday'
    if (myLeaves.some((l) => leaveCovers(l, active.workDate))) return 'leave'
    if (
      active.schedule?.weekly_off != null &&
      active.schedule.weekly_off === dowOf(active.workDate)
    ) {
      return 'weekly_off'
    }
    return 'none'
  }, [designerId, expectedToday, holidays, quota.holidayWorkers, myLeaves, active])

  // ── FPQ trend, 8 weeks, own average baseline (§22.5) ───────────────────────
  const trend = useMemo(() => {
    const points: TrendPoint[] = []
    for (let i = 7; i >= 0; i--) {
      const ws = addDays(dates.weekStart, -7 * i)
      const we = addDays(ws, 6)
      const delivered = myMetrics.filter((m) => {
        if (!m.first_delivered_at) return false
        const d = pktDateOf(m.first_delivered_at)
        return d >= ws && d <= we
      })
      if (delivered.length === 0) continue
      const clean = delivered.filter((m) => m.first_pass_clean).length
      points.push({ label: fmtDate(ws), value: Math.round((clean / delivered.length) * 100) })
    }
    const baseline = points.length
      ? Math.round(points.reduce((s, p) => s + p.value, 0) / points.length)
      : null
    return { points, baseline }
  }, [myMetrics, dates.weekStart])

  // ── Attendance rows ─────────────────────────────────────────────────────────
  const myAttendance = useMemo(
    () => (attendanceQ.data ?? []).filter((a) => a.designer_id === designerId),
    [attendanceQ.data, designerId],
  )
  const activeAtt = myAttendance.find((a) => a.work_date === active.workDate) ?? null
  const weekAtt = myAttendance.filter(
    (a) => a.work_date >= dates.weekStart && a.work_date <= today,
  )
  const workedWeekMin = weekAtt.reduce((s, a) => s + (a.worked_minutes ?? 0), 0)
  const lateWeekMin = weekAtt.reduce((s, a) => s + (a.late_minutes ?? 0), 0)

  // ── Loading / error rollup ─────────────────────────────────────────────────
  const allQueries = [
    designersQ,
    schedulesQ,
    exceptionsQ,
    leavesQ,
    holidaysQ,
    holidayWorkersQ,
    configQ,
    openTasksQ,
    tasksQ,
    metricsQ,
    attendanceQ,
    marksQ,
  ]
  const errored = allQueries.filter((q) => q.isError)
  const checkInLoading = marksQ.isLoading || schedulesQ.isLoading
  const analyticsLoading = tasksQ.isLoading || metricsQ.isLoading || schedulesQ.isLoading

  // ── Unlinked account: teach, don't dead-end (§20.7) ────────────────────────
  if (!designerId) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-screen-sm px-4 py-6">
        <PageHeader
          greeting={`${greetingFor(now)}`}
          name={profile?.email?.split('@')[0] ?? 'there'}
          dateline={`${PKT_DATELINE.format(now)} · all times PKT`}
          onSignOut={() => void signOut()}
        />
        <div className="mt-8">
          <EmptyState
            icon={UserRound}
            title="Your account isn't linked to a designer yet"
            hint="Ask your PM to link your login to your roster entry — your check-in button and numbers will appear here the moment that's done."
            action={
              <button
                type="button"
                onClick={() => void signOut()}
                className="min-h-[2.75rem] rounded-xl border border-border bg-surface px-4 text-sm font-medium text-fg transition-colors duration-150 hover:bg-surface-2"
              >
                Sign out
              </button>
            }
          />
        </div>
      </main>
    )
  }

  const firstName = designer?.name.split(' ')[0] ?? profile?.email?.split('@')[0] ?? 'there'

  return (
    <main className="mx-auto min-h-screen w-full max-w-screen-sm px-4 pb-16 pt-6">
      <PageHeader
        greeting={greetingFor(now)}
        name={firstName}
        dateline={`${PKT_DATELINE.format(now)} · all times PKT`}
        onSignOut={() => void signOut()}
      />

      {errored.length > 0 && (
        <div className="mt-4">
          <ErrorBanner
            message="Couldn't load some of your data — check your connection."
            onRetry={() => errored.forEach((q) => void q.refetch())}
          />
        </div>
      )}

      <div className="mt-5 flex flex-col gap-5">
        {/* ── 2. Check-in / check-out — most prominent when unmarked (§13.3) ── */}
        <CheckInCard
          loading={checkInLoading}
          phase={phase}
          active={active}
          today={today}
          now={now}
          dayOff={dayOffReason != null}
          lastCheckIn={lastCheckIn?.marked_at ?? null}
          firstCheckIn={firstCheckIn?.marked_at ?? null}
          lastMarkAt={lastMark?.marked_at ?? null}
          onMark={mark}
        />

        {/* ── 3. One honest line about the day (§13.3) ─────────────────────── */}
        <HonestLine
          loading={analyticsLoading}
          daySum={daySum}
          weekSum={weekSum}
          prevSum={prevSum}
          expectedToday={expectedToday}
          dayOffReason={dayOffReason}
          active={active}
          openTasks={myOpenTasks}
          listUrl={clickupListUrl(designer?.clickup_list_id)}
        />

        {/* ── 4. Today: my open tasks ──────────────────────────────────────── */}
        <TodayTasks
          loading={openTasksQ.isLoading}
          tasks={myOpenTasks}
          now={now}
          agingDaysDefault={cfg.aging_days_default}
          agingDaysClientResponse={cfg.aging_days_client_response}
        />

        {/* ── 5. My week — deltas vs OWN prior week only (§22.10) ─────────── */}
        <WeekSection
          loading={analyticsLoading}
          weekSum={weekSum}
          prevSum={prevSum}
          trendPoints={trend.points}
          trendBaseline={trend.baseline}
        />

        {/* ── 6. My attendance + time off ──────────────────────────────────── */}
        <AttendanceSection
          loading={attendanceQ.isLoading}
          activeAtt={activeAtt}
          phase={phase}
          liveCheckIn={firstCheckIn?.marked_at ?? null}
          workedWeekMin={workedWeekMin}
          lateWeekMin={lateWeekMin}
        />

        <TimeOffSection
          loading={leavesQ.isLoading || holidaysQ.isLoading}
          leaves={myLeaves}
          holidays={holidays}
          today={today}
        />
      </div>
    </main>
  )
}

// ── 1. Header ─────────────────────────────────────────────────────────────────

function PageHeader({
  greeting,
  name,
  dateline,
  onSignOut,
}: {
  greeting: string
  name: string
  dateline: string
  onSignOut: () => void
}) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="eyebrow">Studio Pulse</p>
        <h1 className="mt-1 truncate text-2xl font-semibold leading-tight text-fg">
          {greeting}, {name}
        </h1>
        <p className="mt-1 text-sm text-muted">{dateline}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ThemeToggle />
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
        >
          <LogOut className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}

// ── 2. Check-in / check-out ───────────────────────────────────────────────────

function shiftContextLine(active: ActiveShift, today: string): string {
  const s = active.schedule
  if (!s) return 'No schedule on file yet — your marks still count.'
  const span = `${fmtShiftTime(s.shift_start)}–${fmtShiftTime(s.shift_end)}`
  if (active.carry) {
    // Overnight shift that started yesterday: name the SHIFT day, never the
    // calendar day (§22.11).
    return `Marking for ${WEEKDAY[dowOf(active.workDate)]}'s shift (${span})`
  }
  if (s.shift_end <= s.shift_start) {
    return `Tonight's shift ${span} — wraps ${WEEKDAY[dowOf(addDays(today, 1))]} morning`
  }
  return `Today's shift ${span}`
}

function CheckInCard({
  loading,
  phase,
  active,
  today,
  now,
  dayOff,
  lastCheckIn,
  firstCheckIn,
  lastMarkAt,
  onMark,
}: {
  loading: boolean
  phase: 'unmarked' | 'in' | 'out'
  active: ActiveShift
  today: string
  now: Date
  dayOff: boolean
  lastCheckIn: string | null
  firstCheckIn: string | null
  lastMarkAt: string | null
  onMark: (t: 'check_in' | 'check_out') => void
}) {
  if (loading) {
    return (
      <section aria-label="Attendance — loading" className="card p-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-4 w-48" />
        <Skeleton className="mt-4 h-14 w-full" />
      </section>
    )
  }

  const context = shiftContextLine(active, today)
  const prominent = phase === 'unmarked' && !dayOff

  return (
    <section
      aria-label="Attendance"
      className={`card p-5 ${prominent ? 'shadow-raised ring-1 ring-brand/20' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">Attendance</p>
        {phase === 'in' && (
          <Badge tone="success" icon={CircleCheck}>
            On the clock
          </Badge>
        )}
        {phase === 'out' && (
          <Badge tone="neutral" icon={CircleCheck}>
            Shift wrapped
          </Badge>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        {context}
        {dayOff && phase === 'unmarked' ? ' · your day off — marks still count if you work' : ''}
      </p>

      {phase === 'unmarked' && (
        <button
          type="button"
          onClick={() => onMark('check_in')}
          className="mt-4 flex min-h-[3.5rem] w-full items-center justify-center gap-2.5 rounded-xl bg-brand text-lg font-semibold text-brand-fg transition-transform duration-150 ease-out hover:opacity-90 active:scale-[0.98]"
        >
          <LogIn className="h-5 w-5" aria-hidden="true" />
          Check in
        </button>
      )}

      {phase === 'in' && lastCheckIn && (
        <>
          <p className="mt-3 text-base font-medium text-fg">
            Checked in at {fmtTime(lastCheckIn)} —{' '}
            <span className="tnum">
              {fmtDuration(Math.max(0, minutesBetween(lastCheckIn, now)))}
            </span>{' '}
            so far
          </p>
          <button
            type="button"
            onClick={() => onMark('check_out')}
            className="mt-4 flex min-h-[3rem] w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface text-base font-semibold text-fg transition-colors duration-150 hover:bg-surface-2 active:scale-[0.98]"
          >
            <LogOut className="h-5 w-5" aria-hidden="true" />
            Check out
          </button>
        </>
      )}

      {phase === 'out' && lastMarkAt && (
        <>
          <p className="mt-3 text-base font-medium text-fg">
            Checked out at {fmtTime(lastMarkAt)}
            {firstCheckIn && (
              <span className="text-muted">
                {' '}
                · <span className="tnum">
                  {fmtDuration(Math.max(0, minutesBetween(firstCheckIn, lastMarkAt)))}
                </span>{' '}
                session
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => onMark('check_in')}
            className="mt-3 flex min-h-[2.75rem] items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-brand transition-colors duration-150 hover:bg-brand-soft"
          >
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Check back in
          </button>
        </>
      )}
    </section>
  )
}

// ── 3. The honest line ────────────────────────────────────────────────────────

function HonestLine({
  loading,
  daySum,
  weekSum,
  prevSum,
  expectedToday,
  dayOffReason,
  active,
  openTasks,
  listUrl,
}: {
  loading: boolean
  daySum: DesignerPeriodSummary | null
  weekSum: DesignerPeriodSummary | null
  prevSum: DesignerPeriodSummary | null
  expectedToday: number
  dayOffReason: 'holiday' | 'leave' | 'weekly_off' | 'none' | null
  active: ActiveShift
  openTasks: TaskState[]
  listUrl: string | null
}) {
  if (loading || !daySum) {
    return (
      <section aria-label="Today — loading" className="card p-5">
        <Skeleton className="h-6 w-4/5" />
        <Skeleton className="mt-2.5 h-4 w-3/5" />
      </section>
    )
  }

  const dayLabel = active.carry ? `for ${WEEKDAY[dowOf(active.workDate)]}'s shift` : 'today'

  let headline: string
  if (dayOffReason === 'holiday') headline = "It's a company holiday — nothing expected today."
  else if (dayOffReason === 'leave') headline = "You're on leave — nothing expected today."
  else if (dayOffReason === 'weekly_off') headline = "It's your day off — nothing expected."
  else if (dayOffReason === 'none') {
    headline = 'No quota is set for today — ask your PM if that looks wrong.'
  } else if (daySum.completed >= expectedToday) {
    const clean =
      daySum.delivered > 0 && daySum.firstPassClean === daySum.delivered
        ? ' Clean day so far.'
        : ''
    headline = `Quota met — ${daySum.completed} of ${expectedToday} ${dayLabel}.${clean}`
  } else {
    const slots = expectedToday - daySum.completed
    headline = `You're at ${daySum.completed} of ${expectedToday} ${dayLabel} — ${
      slots === 1 ? 'one slot open' : `${slots} slots open`
    }.`
  }

  // Weekly quality line — only once there's enough signal to be honest about.
  let qualityLine: string | null = null
  if (weekSum && weekSum.delivered >= 3 && weekSum.firstPassQualityPct != null) {
    const base = `${weekSum.firstPassClean} of ${weekSum.delivered} clean`
    const prev = prevSum?.firstPassQualityPct ?? null
    if (prev == null) qualityLine = `First-pass quality this week — ${base}.`
    else if (weekSum.firstPassQualityPct > prev) {
      qualityLine = `First-pass quality up this week — ${base} (was ${prev}% last week).`
    } else if (weekSum.firstPassQualityPct < prev) {
      qualityLine = `First-pass quality dipped this week — ${base} (was ${prev}% last week).`
    } else {
      qualityLine = `First-pass quality steady this week — ${base}.`
    }
  }

  // Proposed next action (§20.11): pick up the next task. A deep link into
  // ClickUp — the tool observes assignment, it never performs it (§22.1).
  const pickupTask = openTasks
    .filter((t) => t.current_status === 'pickup your projects')
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))[0]
  const slotsOpen = dayOffReason == null && daySum.completed < expectedToday
  const nextHref = pickupTask ? clickupTaskUrl(pickupTask.task_id) : listUrl
  const showPickup = slotsOpen && pickupTask != null && nextHref != null

  return (
    <section aria-label="Today at a glance" className="card p-5">
      <h2 className="text-xl font-semibold leading-snug text-fg">{headline}</h2>
      {qualityLine && <p className="mt-2 text-sm leading-relaxed text-muted">{qualityLine}</p>}
      {showPickup && (
        <a
          href={nextHref}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl px-1 text-sm font-medium text-brand hover:underline"
        >
          Pick up your next task in ClickUp
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      )}
    </section>
  )
}

// ── 4. Today's open tasks ─────────────────────────────────────────────────────

function agingNote(
  task: TaskState,
  now: Date,
  agingDaysDefault: number,
  agingDaysClientResponse: number,
): { text: string; mine: boolean } | null {
  if (!task.current_status) return null
  const days = Math.floor(ageMinutes(task, now) / (60 * 24))
  if (task.current_status === 'client response') {
    if (days < agingDaysClientResponse) return null
    return { text: `with the client ${days} days — not your clock`, mine: false }
  }
  const designerOwned = ['pickup your projects', 'in progress', 'revision', 'final files']
  if (!designerOwned.includes(task.current_status)) return null
  if (days < agingDaysDefault) return null
  const label = STATUS_LABELS[task.current_status].toLowerCase()
  return { text: `in ${label} ${days} day${days === 1 ? '' : 's'} — worth a look`, mine: true }
}

function TodayTasks({
  loading,
  tasks,
  now,
  agingDaysDefault,
  agingDaysClientResponse,
}: {
  loading: boolean
  tasks: TaskState[]
  now: Date
  agingDaysDefault: number
  agingDaysClientResponse: number
}) {
  const rows = useMemo(() => {
    const withMeta = tasks.map((t) => ({
      task: t,
      age: ageMinutes(t, now),
      note: agingNote(t, now, agingDaysDefault, agingDaysClientResponse),
    }))
    // Worst-first (§20.4): my own aging tasks lead, then oldest first.
    return withMeta.sort((a, b) => {
      const aFlag = a.note?.mine ? 1 : 0
      const bFlag = b.note?.mine ? 1 : 0
      if (aFlag !== bFlag) return bFlag - aFlag
      return b.age - a.age
    })
  }, [tasks, now, agingDaysDefault, agingDaysClientResponse])

  return (
    <section aria-labelledby="today-tasks-h">
      <h2 id="today-tasks-h" className="eyebrow px-1">
        On your plate
      </h2>
      <div className="card mt-2 px-5 py-1">
        {loading ? (
          <div className="flex flex-col gap-3 py-4">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-4">
            <EmptyState
              icon={Inbox}
              title="No open tasks right now"
              hint="New assignments land here the moment they're created in your ClickUp list."
            />
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.slice(0, 20).map(({ task, age, note }) => {
              const href = clickupTaskUrl(task.task_id)
              return (
                <li key={task.task_id} className="flex flex-col gap-1.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${task.name ?? 'task'} in ClickUp`}
                        className="inline-flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium text-fg hover:underline"
                      >
                        <span className="truncate">{task.name ?? 'Untitled task'}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                        {task.name ?? 'Untitled task'}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {task.current_status && <StatusBadge status={task.current_status} />}
                    <span className="tnum text-xs text-muted">
                      {fmtDuration(age)} in status
                    </span>
                  </div>
                  {note && (
                    <p className={`text-xs ${note.mine ? 'text-warning' : 'text-muted'}`}>
                      {note.text}
                    </p>
                  )}
                </li>
              )
            })}
            {rows.length > 20 && (
              <li className="py-3 text-xs text-muted">
                +{rows.length - 20} more in your ClickUp list
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  )
}

// ── 5. My week ────────────────────────────────────────────────────────────────

function WeekSection({
  loading,
  weekSum,
  prevSum,
  trendPoints,
  trendBaseline,
}: {
  loading: boolean
  weekSum: DesignerPeriodSummary | null
  prevSum: DesignerPeriodSummary | null
  trendPoints: TrendPoint[]
  trendBaseline: number | null
}) {
  const w = weekSum
  const p = prevSum
  return (
    <section aria-labelledby="my-week-h">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 id="my-week-h" className="eyebrow">
          My week
        </h2>
        <p className="text-xs text-muted">vs your own last week</p>
      </div>
      {/* No `reference` props here on purpose — the self-view compares a
          designer only to their own past, never to peers (§22.10). */}
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatTile
          eyebrow="Quota attainment"
          icon={Target}
          value={w ? fmtPct(w.attainmentPct) : '—'}
          delta={w && p ? pctPointDelta(w.attainmentPct, p.attainmentPct, true) : null}
          cause={
            w
              ? w.expectedQuota > 0
                ? `${w.completed} of ${w.expectedQuota} expected completed`
                : 'no quota scheduled this week'
              : null
          }
          loading={loading}
        />
        <StatTile
          eyebrow="First-pass quality"
          icon={Sparkles}
          value={w ? fmtPct(w.firstPassQualityPct) : '—'}
          delta={w && p ? pctPointDelta(w.firstPassQualityPct, p.firstPassQualityPct, true) : null}
          cause={
            w
              ? w.delivered > 0
                ? `${w.firstPassClean} of ${w.delivered} delivered clean`
                : 'no deliveries yet this week'
              : null
          }
          loading={loading}
        />
        <StatTile
          eyebrow="Production speed"
          icon={Gauge}
          value={w ? fmtDuration(w.productionMedianMin) : '—'}
          delta={w && p ? durationDelta(w.productionMedianMin, p.productionMedianMin) : null}
          cause="median first-pass time — client wait never counts against you"
          loading={loading}
        />
        <StatTile
          eyebrow="Revision turnaround"
          icon={RotateCcw}
          value={w ? fmtDuration(w.revisionTurnaroundMedianMin) : '—'}
          delta={
            w && p
              ? durationDelta(w.revisionTurnaroundMedianMin, p.revisionTurnaroundMedianMin)
              : null
          }
          cause={
            w
              ? w.revisionRounds > 0
                ? `${w.revisionRounds} revision round${w.revisionRounds === 1 ? '' : 's'} this week`
                : 'no revisions this week — nothing to fix'
              : null
          }
          loading={loading}
        />
      </div>

      <div className="card mt-3 p-5">
        <p className="eyebrow">First-pass quality — last 8 weeks</p>
        {loading ? (
          <Skeleton className="mt-3 h-24 w-full" />
        ) : trendPoints.length >= 2 ? (
          <>
            <div className="mt-3">
              <TrendLine
                points={trendPoints}
                baseline={trendBaseline}
                tone="brand"
                formatValue={(v) => `${Math.round(v)}%`}
                ariaLabel={`Your first-pass quality over the last 8 weeks, from ${trendPoints[0].value}% to ${trendPoints[trendPoints.length - 1].value}%, against your own average of ${trendBaseline ?? 0}%`}
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              Dashed line is your own 8-week average — your only benchmark here is your past self.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-muted">
            Not enough history yet — your trend appears after a couple of weeks of deliveries.
          </p>
        )}
      </div>
    </section>
  )
}

// ── 6a. My attendance ────────────────────────────────────────────────────────

function AttendanceSection({
  loading,
  activeAtt,
  phase,
  liveCheckIn,
  workedWeekMin,
  lateWeekMin,
}: {
  loading: boolean
  activeAtt: AttendanceDaily | null
  phase: 'unmarked' | 'in' | 'out'
  liveCheckIn: string | null
  workedWeekMin: number
  lateWeekMin: number
}) {
  let warmupLine: string | null = null
  if (activeAtt?.declared_in && activeAtt.first_activity) {
    warmupLine = `Checked in at ${fmtTime(activeAtt.declared_in)}, first ClickUp action ${fmtTime(
      activeAtt.first_activity,
    )} — ${fmtDuration(activeAtt.warmup_gap_min ?? minutesBetween(activeAtt.declared_in, activeAtt.first_activity))} warm-up`
  } else if (activeAtt?.declared_in) {
    warmupLine = `Checked in at ${fmtTime(activeAtt.declared_in)} — no ClickUp action yet`
  } else if (phase !== 'unmarked' && liveCheckIn) {
    warmupLine = `Checked in at ${fmtTime(liveCheckIn)} — warm-up shows once ClickUp activity lands`
  }

  const status: AttendanceStatus | null =
    activeAtt?.status ?? (phase !== 'unmarked' ? 'Present' : null)

  return (
    <section aria-labelledby="my-attendance-h">
      <h2 id="my-attendance-h" className="eyebrow px-1">
        My attendance
      </h2>
      <div className="card mt-2 p-5">
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5">
              <Clock className="h-4 w-4 text-muted" aria-hidden="true" />
              <span className="text-sm font-medium text-fg">Today</span>
              {status ? (
                <Badge tone={ATT_TONE[status]}>{status === 'HolidayWorked' ? 'Holiday · worked' : status === 'WeeklyOff' ? 'Weekly off' : status}</Badge>
              ) : (
                <Badge tone="neutral">Not marked yet</Badge>
              )}
            </div>
            {warmupLine && <p className="mt-2 text-sm leading-relaxed text-muted">{warmupLine}</p>}

            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-4">
              <div>
                <dt className="text-xs text-muted">Worked this week</dt>
                <dd className="tnum mt-0.5 text-lg font-medium text-fg">
                  {fmtDuration(workedWeekMin)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Late minutes this week</dt>
                <dd className="tnum mt-0.5 text-lg font-medium text-fg">
                  {lateWeekMin > 0 ? fmtDuration(lateWeekMin) : 'None'}
                </dd>
                <dd className="mt-0.5 text-xs text-muted">
                  {lateWeekMin > 0 ? 'after your grace window' : 'on time all week'}
                </dd>
              </div>
            </dl>
          </>
        )}
      </div>
    </section>
  )
}

// ── 6b. Time off: leave history + upcoming holidays ──────────────────────────

function TimeOffSection({
  loading,
  leaves,
  holidays,
  today,
}: {
  loading: boolean
  leaves: Leave[]
  holidays: Holiday[]
  today: string
}) {
  const upcoming = holidays.filter((h) => h.the_date >= today).slice(0, 4)
  const history = [...leaves].sort((a, b) => b.start_date.localeCompare(a.start_date)).slice(0, 8)

  return (
    <section aria-labelledby="time-off-h">
      <h2 id="time-off-h" className="eyebrow px-1">
        Time off
      </h2>
      <div className="card mt-2 px-5 py-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-52" />
          </div>
        ) : (
          <>
            <h3 className="text-sm font-semibold text-fg">My leave</h3>
            {history.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                No leave on record — anything your PM logs for you shows up here.
              </p>
            ) : (
              <ul className="mt-1 divide-y divide-border/60">
                {history.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">
                        {l.leave_type ?? 'Leave'}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {fmtDate(l.start_date)}
                        {l.end_date && l.end_date !== l.start_date
                          ? ` – ${fmtDate(l.end_date)}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* Paid/unpaid is recorded for reporting only — no pay math (§10). */}
                      <Badge tone="neutral">{l.paid ? 'Paid' : 'Unpaid'}</Badge>
                      {l.status !== 'approved' && (
                        <Badge tone={l.status === 'pending' ? 'warning' : 'danger'}>
                          {l.status}
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="mt-5 flex items-center gap-1.5 border-t border-border/60 pt-4 text-sm font-semibold text-fg">
              <CalendarDays className="h-4 w-4 text-muted" aria-hidden="true" />
              Upcoming holidays
            </h3>
            {upcoming.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No company holidays coming up.</p>
            ) : (
              <ul className="mt-1">
                {upcoming.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate text-fg">{h.name ?? 'Holiday'}</span>
                    <span className="tnum shrink-0 text-muted">{fmtDate(h.the_date)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  )
}
