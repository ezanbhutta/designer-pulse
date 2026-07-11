import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import {
  CalendarDays,
  CircleCheck,
  Clock,
  ExternalLink,
  Inbox,
  LogIn,
  LogOut,
  Moon,
  Sun,
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
  requestLeave,
} from '../../lib/queries'
import { ToastProvider, useToast } from '../../components/ui/ToastProvider'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { Button } from '../../components/ui/Button'
import { ActionButton } from '../../components/ui/ActionButton'
import { InboxZeroReward } from '../../components/ui/InboxZeroReward'
import { SPRING_GENTLE, staggerContainer, staggerItem } from '../../components/ui/motion'
import { InfoTip } from '../../components/ui/InfoTip'
import {
  DesignerMetricsPanel,
  type MetricsPeriod,
} from '../../components/shared/DesignerDetail'
import { Badge, type BadgeProps } from '../../components/ui/Badge'
import { TrendLine, type TrendPoint } from '../../components/ui/TrendLine'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { BrandLogo } from '../../components/ui/BrandLogo'
import { Skeleton } from '../../components/ui/Skeleton'
import { Aurora } from '../../components/ui/Aurora'
import { ProgressRing } from '../../components/ui/ProgressRing'
import { fmtClock, fmtDate, fmtDurationLong, fmtShiftTime } from '../../lib/format'
import { syncThemeColorMeta } from '../../lib/themeColor'
import {
  addDays,
  collectionWindow,
  dateRange,
  dowOf,
  minutesBetween,
  pktDateOf,
  pktInstant,
  pktToday,
  shiftWindow,
  startOfWeek,
} from '../../../shared/pkt'
import {
  ageMinutes,
  agingDelay,
  expectedQuotaOn,
  scheduleFor,
  summarizeDesigner,
  type DesignerPeriodSummary,
  type QuotaContext,
} from '../../../shared/aggregate'
import { leaveCovers } from '../../../shared/attendance'
import { STATUS_EXPLAINERS, STATUS_LABELS } from '../../../shared/statuses'
import { CONFIG_DEFAULTS } from '../../../shared/types'
import type {
  AttendanceDaily,
  AttendanceStatus,
  DesignerSchedule,
  Holiday,
  Leave,
  TaskMetrics,
  TaskState,
} from '../../../shared/types'

// ── Small utilities ───────────────────────────────────────────────────────────

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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

/** Human words for each attendance state — never a bare code or an abbreviation. */
const ATT_LABEL: Record<AttendanceStatus, string> = {
  Present: 'Here today',
  HolidayWorked: 'Worked on a holiday',
  Leave: 'On leave',
  Holiday: 'Company holiday',
  WeeklyOff: 'Day off',
  Absent: 'Not marked in',
  Incomplete: 'Day not finished',
}

// ── Theme toggle (light-default self-view, §21.9 — override persists) ─────────

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    // Keep the phone browser chrome color in step with the app theme —
    // whether this toggle, the route default, or another surface set it.
    syncThemeColorMeta(document.documentElement.classList.contains('dark'))
    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.classList.contains('dark')
      setDark(isDark)
      syncThemeColorMeta(isDark)
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
      className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg motion-safe:active:scale-95"
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

  // Screen-reader navigation feedback + a recognisable tab/history entry.
  useEffect(() => {
    document.title = 'My day · Studio Pulse'
  }, [])

  // Ticking clock so "time since check-in" and the shift context stay honest.
  const [now, setNow] = useState<Date>(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const today = pktToday(now)
  const dates = useMemo(() => {
    const weekStart = startOfWeek(today) // Monday of this PKT week
    // Week-to-date (§20.4): Monday..today, compared against the SAME elapsed
    // window last week — never a partial week vs a complete prior one.
    const weekEnd = today
    const prior = { start: addDays(weekStart, -7), end: addDays(today, -7) }
    const trendStart = addDays(weekStart, -49) // 8 weeks including this one
    return {
      weekStart,
      weekEnd,
      prior,
      trendStart,
      sinceIso: pktInstant(trendStart, '00:00').toISOString(),
      markStart: addDays(today, -1), // covers overnight shifts started yesterday
      // From the start of the PRIOR week: covers yesterday's overnight carry
      // AND the metrics panel's comparison window, so one attendance fetch
      // serves the whole page.
      attStart: prior.start,
    }
  }, [today])

  const enabled = designerId != null

  // ── Queries — every read is RLS-scoped to this designer server-side (§14) ──
  // Reference data uses the same STALE_ANALYTICS tier as opsData/ceoData (the
  // keys are shared) so cache behavior is consistent per key, and remounts /
  // window focus on the phone don't refetch nine tables. Marks, open tasks and
  // attendance stay live — check-in mutations and realtime invalidate those.
  const designersQ = useQuery({
    queryKey: qk.designers,
    queryFn: fetchDesigners,
    enabled,
    staleTime: STALE_ANALYTICS,
  })
  const schedulesQ = useQuery({
    queryKey: qk.schedules,
    queryFn: fetchSchedules,
    enabled,
    staleTime: STALE_ANALYTICS,
  })
  const exceptionsQ = useQuery({
    queryKey: qk.quotaExceptions,
    queryFn: fetchQuotaExceptions,
    enabled,
    staleTime: STALE_ANALYTICS,
  })
  const leavesQ = useQuery({
    queryKey: qk.leaves,
    queryFn: fetchLeaves,
    enabled,
    staleTime: STALE_ANALYTICS,
  })
  const holidaysQ = useQuery({
    queryKey: qk.holidays,
    queryFn: fetchHolidays,
    enabled,
    staleTime: STALE_ANALYTICS,
  })
  const holidayWorkersQ = useQuery({
    queryKey: qk.holidayWorkers,
    queryFn: fetchHolidayWorkers,
    enabled,
    staleTime: STALE_ANALYTICS,
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
    // Mirror the attendance engine (shared/attendance.ts): a DAY shift counts
    // marks across the whole PKT calendar day; only OVERNIGHT shifts use the
    // buffered collection window. Using the buffer for day shifts would hide
    // an early check-in (>4h before shift) from this card while the engine
    // still counts it — inviting a duplicate mark.
    if (active.schedule && active.schedule.shift_end <= active.schedule.shift_start) {
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

  // ── Optimistic check-in/out — insert IMMEDIATELY (§20.6 optimistic UI) ─────
  // shift_marks is append-only, so there is no undo: the write fires the
  // moment the button is tapped (a deferred write would be silently lost if
  // the tab closes — this view lives on phones). The local mark reflects the
  // state instantly; a failed insert rolls back visibly with a retry hint.
  const [localMarks, setLocalMarks] = useState<LocalMark[]>([])
  // shift_marks is append-only with no designer-accessible undo: a double-tap
  // on a slow connection must not fire two inserts.
  const markInFlight = useRef(false)

  const mark = useCallback(
    (mark_type: 'check_in' | 'check_out') => {
      if (!designerId || markInFlight.current) return
      markInFlight.current = true
      const markedAt = new Date().toISOString()
      const local: LocalMark = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        mark_type,
        marked_at: markedAt,
      }
      setLocalMarks((prev) => [...prev, local])
      // No marked_at: the server clock stamps self marks (migration 005) —
      // the optimistic local row above still shows device time instantly,
      // and the realtime refresh snaps it to the server's truth.
      insertShiftMark({
        designer_id: designerId,
        mark_type,
        source: 'self',
      })
        .then(() => {
          markInFlight.current = false
          toast({
            message:
              mark_type === 'check_in'
                ? `Your day started at ${fmtClock(markedAt)}. Have a good one.`
                : 'That is your day wrapped up. See you tomorrow.',
          })
          // Once the refetch lands the server copy of this mark, drop the
          // local one — otherwise duplicates accumulate for the session.
          void queryClient
            .invalidateQueries({ queryKey: ['shift-marks'] })
            .then(() => {
              setLocalMarks((prev) => prev.filter((m) => m.id !== local.id))
            })
          void queryClient.invalidateQueries({ queryKey: ['attendance'] })
        })
        .catch(() => {
          markInFlight.current = false
          // Roll back visibly (§20.6) — the button returns to its prior state.
          setLocalMarks((prev) => prev.filter((m) => m.id !== local.id))
          toast({
            message: 'That did not save. Please check your connection and tap again.',
          })
        })
    },
    [designerId, queryClient, toast],
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
  // Today's / this week's plate counts projects by DUE date, so the summaries
  // need the live open tasks as well as the trend-window fetch. summarizeDesigner
  // dedupes by task id, so merging is safe.
  const summaryTasks = useMemo(() => [...myOpenTasks, ...myTasks], [myOpenTasks, myTasks])

  const weekSum: DesignerPeriodSummary | null = useMemo(
    () =>
      designerId
        ? summarizeDesigner(designerId, {
            start: dates.weekStart,
            end: dates.weekEnd,
            tasks: summaryTasks,
            metrics: myMetrics,
            quota,
          })
        : null,
    [designerId, dates.weekStart, dates.weekEnd, summaryTasks, myMetrics, quota],
  )
  const prevSum: DesignerPeriodSummary | null = useMemo(
    () =>
      designerId
        ? summarizeDesigner(designerId, {
            start: dates.prior.start,
            end: dates.prior.end,
            tasks: summaryTasks,
            metrics: myMetrics,
            quota,
          })
        : null,
    [designerId, dates.prior, summaryTasks, myMetrics, quota],
  )
  const daySum: DesignerPeriodSummary | null = useMemo(
    () =>
      designerId
        ? summarizeDesigner(designerId, {
            start: active.workDate,
            end: active.workDate,
            tasks: summaryTasks,
            metrics: myMetrics,
            quota,
          })
        : null,
    [designerId, active.workDate, summaryTasks, myMetrics, quota],
  )
  const expectedToday = designerId ? expectedQuotaOn(designerId, active.workDate, quota) : 0

  // ── Delight (manifesto pillar 11): finishing the LAST due-today project ────
  // Fires only on a live below-target → at-target transition observed in this
  // session — never on first load of a day that was already finished, and it
  // re-arms when the shift day rolls over (incl. overnight carry).
  const [celebrated, setCelebrated] = useState(false)
  const prevCompletedRef = useRef<number | null>(null)
  useEffect(() => {
    prevCompletedRef.current = null
    setCelebrated(false)
  }, [active.workDate])
  const dayDataReady =
    !tasksQ.isLoading && !metricsQ.isLoading && !schedulesQ.isLoading && !exceptionsQ.isLoading
  const dayCompleted = daySum?.completed ?? null
  useEffect(() => {
    // Seed only from settled data — a loading 0 must never count as "before".
    if (!dayDataReady || dayCompleted == null || expectedToday <= 0) return
    const prev = prevCompletedRef.current
    prevCompletedRef.current = dayCompleted
    if (prev != null && prev < expectedToday && dayCompleted >= expectedToday) {
      setCelebrated(true)
    }
  }, [dayDataReady, dayCompleted, expectedToday])

  // Week-to-date window for the shared metrics panel (§22.3) — deltas compare
  // Monday..today against the same elapsed window last week (§22.10: own past only).
  const metricsPeriod: MetricsPeriod = useMemo(
    () => ({
      start: dates.weekStart,
      end: dates.weekEnd,
      priorStart: dates.prior.start,
      priorEnd: dates.prior.end,
      label: 'this week',
      vs: 'compared with last week at this point',
    }),
    [dates],
  )

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
  const lastGood = Math.max(...allQueries.map((q) => q.dataUpdatedAt))
  const checkInLoading = marksQ.isLoading || schedulesQ.isLoading
  const analyticsLoading = tasksQ.isLoading || metricsQ.isLoading || schedulesQ.isLoading

  // ── Unlinked account: teach, don't dead-end (§20.7) ────────────────────────
  if (!designerId) {
    return (
      <>
        <Aurora />
        <main className="relative z-10 mx-auto min-h-screen w-full max-w-screen-sm px-5 py-8">
          <PageHeader
            greeting={greetingFor(now)}
            name={profile?.email?.split('@')[0] ?? 'there'}
            dateline={`${PKT_DATELINE.format(now)}. Everything you see here is on Pakistan time.`}
            onSignOut={() => void signOut()}
          />
          <div className="mt-10">
            <EmptyState
              icon={UserRound}
              title="Your account isn't linked to your name yet"
              hint="Ask your team lead to connect your account. The moment they do, the button to start your day and all of your numbers will appear right here."
              action={
                <Button variant="secondary" onClick={() => void signOut()}>
                  Sign out
                </Button>
              }
            />
          </div>
        </main>
      </>
    )
  }

  const firstName = designer?.name.split(' ')[0] ?? profile?.email?.split('@')[0] ?? 'there'

  return (
    <>
      <Aurora />
      <main className="relative z-10 mx-auto min-h-screen w-full max-w-screen-sm px-5 pb-24 pt-8">
      <PageHeader
        greeting={greetingFor(now)}
        name={firstName}
        dateline={`${PKT_DATELINE.format(now)}. Everything you see here is on Pakistan time.`}
        onSignOut={() => void signOut()}
      />

      {errored.length > 0 && (
        <div className="mt-6">
          <ErrorBanner
            message="Some of your information did not load. Please check your connection."
            asOf={lastGood > 0 ? fmtClock(new Date(lastGood).toISOString()) : null}
            onRetry={() => errored.forEach((q) => void q.refetch())}
          />
        </div>
      )}

      <div className="mt-8 flex flex-col gap-8">
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

        {/* ── 3. One honest line about the day (§13.3). When the LAST due-today
               project lands in this session, the line becomes the reward
               (manifesto pillar 11) — confetti, then a calm, definitive close. */}
        {celebrated ? (
          <InboxZeroReward
            title="That is your day, done."
            message={`Everything due today is finished, all ${expectedToday} of them. Really lovely work. Anything new will appear here the moment it is assigned to you in ClickUp.`}
          />
        ) : (
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
        )}

        {/* ── 4. Today: my open tasks ──────────────────────────────────────── */}
        <TodayTasks
          loading={openTasksQ.isLoading}
          tasks={myOpenTasks}
          now={now}
          agingDaysDefault={cfg.aging_days_default}
          agingDaysClientResponse={cfg.aging_days_client_response}
        />

        {/* ── 5. My week — deltas vs OWN past only (§22.10) ────────────────── */}
        <WeekSection
          designerId={designerId}
          period={metricsPeriod}
          tasks={summaryTasks}
          metrics={myMetrics}
          attendance={myAttendance}
          trendLoading={analyticsLoading}
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
          designerId={designerId}
        />
      </div>
      </main>
    </>
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
        <span className="flex items-center gap-1.5">
          <BrandLogo className="h-4 w-4" />
          <p className="eyebrow">Studio Pulse</p>
        </span>
        <h1 className="mt-2 text-section text-fg">
          {greeting}, {name.split(' ')[0]}
        </h1>
        <p className="mt-2 max-w-prose text-caption text-muted">{dateline}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ThemeToggle />
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg motion-safe:active:scale-95"
        >
          <LogOut className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}

// ── 2. Check-in / check-out ───────────────────────────────────────────────────

function shiftContextLine(active: ActiveShift, today: string): { text: string; overnight: boolean } {
  const s = active.schedule
  if (!s) {
    return {
      text: 'There is no schedule saved for you yet, but the moment you begin, your day still counts.',
      overnight: false,
    }
  }
  const span = `${fmtShiftTime(s.shift_start)} to ${fmtShiftTime(s.shift_end)}`
  if (active.carry) {
    // Overnight shift that started yesterday: name the SHIFT day, never the
    // calendar day (§22.11).
    return {
      text: `You are still on ${WEEKDAY[dowOf(active.workDate)]}’s shift, which carries on through the night.`,
      overnight: true,
    }
  }
  if (s.shift_end <= s.shift_start) {
    return {
      text: `Tonight you are working ${span}, finishing on ${WEEKDAY[dowOf(addDays(today, 1))]} morning.`,
      overnight: true,
    }
  }
  return { text: `Today you are working ${span}.`, overnight: false }
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
  const reduced = useReducedMotion()

  if (loading) {
    return (
      <section aria-label="Your day, loading" className="glass-card p-8">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-4 h-4 w-48" />
        <Skeleton className="mt-6 h-14 w-full" />
      </section>
    )
  }

  const context = shiftContextLine(active, today)
  const prominent = phase === 'unmarked' && !dayOff

  return (
    <section
      aria-label="Your day"
      className={`glass-card p-8 ${prominent ? 'ring-1 ring-brand/25' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow inline-flex items-center gap-1">
          Your day
          <InfoTip text="Tap the button when you begin work, and again when you finish for the day. If you forget to finish, we quietly close your day from your activity in ClickUp, so you are never marked absent for a day you worked." />
        </p>
        {phase === 'in' && (
          <span className="inline-flex items-center gap-2">
            <span className="pulse-dot" aria-hidden="true" />
            <Badge tone="success" icon={CircleCheck}>
              You’re here
            </Badge>
          </span>
        )}
        {phase === 'out' && (
          <Badge tone="neutral" icon={CircleCheck}>
            Day finished
          </Badge>
        )}
      </div>
      <p className="mt-3 inline-flex max-w-prose flex-wrap items-center gap-1 text-caption text-muted">
        {context.text}
        {context.overnight && (
          <InfoTip text="Your shift runs past midnight, so the whole night counts as one working day." />
        )}
        {dayOff && phase === 'unmarked'
          ? ' It is your day off, so starting is entirely up to you. If you do work, it still counts.'
          : ''}
      </p>

      {/* aria-live: the swap between "Check in", "Checked in at …" and
          "Checked out at …" announces itself to screen readers (pillar 12). */}
      <div aria-live="polite">
        {phase === 'unmarked' && (
          <ActionButton
            onAction={() => onMark('check_in')}
            className="mt-6 min-h-14 w-full rounded-2xl text-body font-semibold"
          >
            <LogIn className="h-5 w-5" aria-hidden="true" />
            Start my day
          </ActionButton>
        )}

        {phase === 'in' && lastCheckIn && (
          <>
            <motion.p
              initial={reduced ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={SPRING_GENTLE}
              className="mt-4 text-body font-medium text-fg"
            >
              You started at {fmtClock(lastCheckIn)}, about{' '}
              <span className="tnum">
                {fmtDurationLong(Math.max(0, minutesBetween(lastCheckIn, now)))}
              </span>{' '}
              ago.
            </motion.p>
            <ActionButton
              onAction={() => onMark('check_out')}
              variant="neutral"
              className="mt-6 min-h-12 w-full rounded-2xl text-body font-semibold"
            >
              <LogOut className="h-5 w-5" aria-hidden="true" />
              End my day
            </ActionButton>
          </>
        )}

        {phase === 'out' && lastMarkAt && (
          <>
            <motion.p
              initial={reduced ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={SPRING_GENTLE}
              className="mt-4 text-body font-medium text-fg"
            >
              You finished at {fmtClock(lastMarkAt)}
              {firstCheckIn && (
                <span className="text-muted">
                  , a day of{' '}
                  <span className="tnum">
                    {fmtDurationLong(Math.max(0, minutesBetween(firstCheckIn, lastMarkAt)))}
                  </span>
                  .
                </span>
              )}
            </motion.p>
            <ActionButton
              onAction={() => onMark('check_in')}
              variant="neutral"
              className="mt-4 min-h-11 rounded-2xl"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Start again
            </ActionButton>
          </>
        )}
      </div>
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
      <section aria-label="Today, loading" className="glass-card p-8">
        <Skeleton className="h-3 w-24" />
        <div className="mt-5 flex items-center gap-6">
          <Skeleton className="h-28 w-28 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="mt-3 h-4 w-3/5" />
          </div>
        </div>
      </section>
    )
  }

  // "Due today" honours the shift, not the calendar day, for overnight carries.
  const dueLabel = active.carry ? `on ${WEEKDAY[dowOf(active.workDate)]}’s shift` : 'today'

  // Day-off and no-target days deserve one calm, whole sentence — no ring, and
  // nothing to chase.
  let restMessage: string | null = null
  if (dayOffReason === 'holiday') {
    restMessage = 'It is a company holiday. Nothing is expected of you today, so enjoy it.'
  } else if (dayOffReason === 'leave') {
    restMessage = 'You are on leave today, so rest well. Nothing is expected of you.'
  } else if (dayOffReason === 'weekly_off') {
    restMessage = 'It is your day off. Nothing is expected of you today.'
  } else if (dayOffReason === 'none') {
    restMessage =
      'There is no target set for you today. If that does not look right, your team lead can put one in place.'
  }

  // The working-day read: a warm, specific summary beside the ring.
  const done = daySum.completed
  const remaining = Math.max(0, expectedToday - done)
  const allDone = done >= expectedToday
  const clientWaiting = openTasks.filter((t) => t.current_status === 'client response').length

  let heroTitle = ''
  let heroBody = ''
  if (allDone) {
    heroTitle = 'All done for today.'
    const everyoneHappy = daySum.delivered > 0 && daySum.firstPassClean === daySum.delivered
    heroBody = everyoneHappy
      ? `Every project due ${dueLabel} is finished, and each one was accepted the first time. A lovely day of work.`
      : `Every project due ${dueLabel} is finished. There is nothing left to pick up.`
  } else if (done === 0) {
    heroTitle = 'A fresh start.'
    heroBody = `None of the ${expectedToday} projects due ${dueLabel} are finished yet, and there is plenty of time ahead of you.`
  } else {
    heroTitle = 'Coming along nicely.'
    heroBody = `${done} of the ${expectedToday} projects due ${dueLabel} are finished, with ${remaining} still to go.`
  }
  if (!allDone && clientWaiting > 0) {
    heroBody +=
      clientWaiting === 1
        ? ' One of them is with the client, which is completely normal.'
        : ` ${clientWaiting} of them are with the client, which is completely normal.`
  }

  // Weekly quality line — only once there is enough finished work to speak to it honestly.
  let qualityLine: string | null = null
  if (weekSum && weekSum.delivered >= 3 && weekSum.firstPassQualityPct != null) {
    const base = `${weekSum.firstPassClean} of your ${weekSum.delivered} designs this week were accepted without a single change asked`
    const prev = prevSum?.firstPassQualityPct ?? null
    if (prev == null) qualityLine = `${base}.`
    else if (weekSum.firstPassQualityPct > prev) qualityLine = `${base}, up from ${prev}% the week before.`
    else if (weekSum.firstPassQualityPct < prev) {
      qualityLine = `${base}, a little below the ${prev}% you reached the week before.`
    } else qualityLine = `${base}, right in step with the week before.`
  }

  // A gentle next step: open the next project waiting to be picked up. This is a
  // deep link into ClickUp — the tool watches the work, it never assigns it (§22.1).
  const pickupTask = openTasks
    .filter((t) => t.current_status === 'pickup your projects')
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))[0]
  const slotsOpen = dayOffReason == null && daySum.completed < expectedToday
  const nextHref = pickupTask ? clickupTaskUrl(pickupTask.task_id) : listUrl
  const showPickup = slotsOpen && pickupTask != null && nextHref != null

  return (
    <section aria-label="Today at a glance" className="glass-card p-8">
      {restMessage ? (
        <p className="inline-flex max-w-prose items-start gap-1.5 text-card text-fg">
          {restMessage}
          <InfoTip text="Your day at a glance: of the projects due today, how many you have finished." />
        </p>
      ) : (
        <>
          <div className="flex items-center gap-5">
            <ProgressRing value={done} total={expectedToday} size={112} caption={`of ${expectedToday}`} />
            <div className="min-w-0">
              <p className="eyebrow inline-flex items-center gap-1">
                Today
                <InfoTip text="Your day at a glance: of the projects due today, how many you have finished. A project only counts toward today if it is due today." />
              </p>
              <h2 className="mt-2 text-section text-fg">{heroTitle}</h2>
            </div>
          </div>
          <p className="mt-5 max-w-prose text-body text-muted">{heroBody}</p>
        </>
      )}
      {qualityLine && (
        <p className="mt-5 max-w-prose text-caption leading-relaxed text-muted">
          {qualityLine}{' '}
          <InfoTip text="Accepted without a change asked means the client approved the design as it was, with nothing sent back." />
        </p>
      )}
      {showPickup && (
        <a
          href={nextHref}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex min-h-11 items-center gap-1.5 rounded-xl px-1 text-caption font-medium text-brand hover:underline"
        >
          Open your next project in ClickUp
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
  const delay = agingDelay(task.current_status, {
    aging_days_default: agingDaysDefault,
    aging_days_client_response: agingDaysClientResponse,
  })
  const threshold = Math.round(delay.thresholdMin / 1440)
  if (delay.owner === 'client') {
    if (days < threshold) return null
    return {
      text: `This has been with the client for ${days} day${days === 1 ? '' : 's'} now. That is completely normal, and it never counts against you.`,
      mine: false,
    }
  }
  if (days < threshold) return null
  if (delay.owner === 'team') {
    return {
      text: `You finished the changes on this ${days} day${days === 1 ? '' : 's'} ago; it is now with the team to send to the client — that part is on them, not on you.`,
      mine: false,
    }
  }
  if (delay.owner !== 'designer') return null
  const label = STATUS_LABELS[task.current_status]
  return {
    text: `This has been at the “${label}” stage for ${days} day${days === 1 ? '' : 's'} now, so it might be worth another look.`,
    mine: true,
  }
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
  const reduced = useReducedMotion()
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
      <h2 id="today-tasks-h" className="eyebrow inline-flex items-center gap-1 px-1">
        What you are working on
        <InfoTip text="Everything you have open right now, with anything that could use a look nearest the top. Tap a project to open it in ClickUp." />
      </h2>
      <div className="glass-card mt-3 px-6 py-2">
        {loading ? (
          <div className="flex flex-col gap-4 py-5">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-5">
            <EmptyState
              icon={Inbox}
              title="Nothing open right now"
              hint="A new project will appear here the moment it lands in your ClickUp list."
            />
          </div>
        ) : (
          /* Progressive reveal (pillar 9): rows cascade in with spring
             momentum, 50ms apart — instant under reduced motion. */
          <motion.ul
            variants={staggerContainer}
            initial={reduced ? false : 'hidden'}
            animate="show"
            className="divide-y divide-border/60"
          >
            {rows.slice(0, 20).map(({ task, age, note }) => {
              const href = clickupTaskUrl(task.task_id)
              return (
                <motion.li
                  key={task.task_id}
                  variants={staggerItem}
                  className="flex flex-col gap-2 py-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    {href ? (
                      // min-h + negative margin: a 44px tap target that
                      // borrows the row's padding instead of inflating it.
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${task.name ?? 'task'} in ClickUp`}
                        className="-my-2 inline-flex min-h-11 min-w-0 flex-1 items-center gap-1.5 truncate text-body font-medium text-fg hover:underline"
                      >
                        <span className="truncate">{task.name ?? 'Untitled task'}</span>
                        <ExternalLink className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="-my-2 inline-flex min-h-11 min-w-0 flex-1 items-center truncate text-body font-medium text-fg">
                        {task.name ?? 'Untitled task'}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {task.current_status && (
                      <span className="inline-flex items-center gap-1">
                        <StatusBadge status={task.current_status} />
                        <InfoTip
                          text={STATUS_EXPLAINERS[task.current_status]}
                          label={`What does ${STATUS_LABELS[task.current_status]} mean?`}
                        />
                      </span>
                    )}
                    <span className="tnum text-label text-muted">
                      {fmtDurationLong(age)} at this stage
                    </span>
                  </div>
                  {note && (
                    <p className={`max-w-prose text-caption ${note.mine ? 'text-warning' : 'text-muted'}`}>
                      {note.text}
                    </p>
                  )}
                </motion.li>
              )
            })}
            {rows.length > 20 && (
              <motion.li variants={staggerItem} className="py-4 text-caption text-muted">
                and {rows.length - 20} more in your ClickUp list
              </motion.li>
            )}
          </motion.ul>
        )}
      </div>
    </section>
  )
}

// ── 5. My week ────────────────────────────────────────────────────────────────

function WeekSection({
  designerId,
  period,
  tasks,
  metrics,
  attendance,
  trendLoading,
  trendPoints,
  trendBaseline,
}: {
  designerId: string
  period: MetricsPeriod
  tasks: TaskState[]
  metrics: TaskMetrics[]
  attendance: AttendanceDaily[]
  trendLoading: boolean
  trendPoints: TrendPoint[]
  trendBaseline: number | null
}) {
  return (
    <section aria-labelledby="my-week-h">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 id="my-week-h" className="eyebrow">
          Your week so far
        </h2>
        <p className="text-label text-muted">compared with last week at this point</p>
      </div>
      {/* Shared metrics panel (§22.3) — scope='self' omits every team-median
          reference and all peer data; deltas are vs the designer's own past
          only (§22.10). Single-column-friendly for mobile (§20.10). The page
          already fetched supersets of the panel's windows — hand them over so
          the panel doesn't re-fetch the same tables. */}
      <div className="mt-3">
        <DesignerMetricsPanel
          designerId={designerId}
          scope="self"
          period={period}
          tasks={tasks}
          metrics={metrics}
          attendance={attendance}
        />
      </div>

      <div className="glass-card mt-4 p-6">
        <p className="eyebrow">Accepted without changes, over the last eight weeks</p>
        {trendLoading ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : trendPoints.length >= 2 ? (
          <>
            <div className="mt-4">
              <TrendLine
                points={trendPoints}
                baseline={trendBaseline}
                tone="brand"
                formatValue={(v) => `${Math.round(v)}%`}
                ariaLabel={`The share of your designs accepted without changes over the last eight weeks, from ${trendPoints[0].value}% to ${trendPoints[trendPoints.length - 1].value}%, against your own average of ${trendBaseline ?? 0}%`}
              />
            </div>
            <p className="mt-3 max-w-prose text-caption text-muted">
              The dashed line is your own average across these eight weeks. The only person you are
              measured against here is your past self.
            </p>
          </>
        ) : (
          <p className="mt-4 max-w-prose text-caption text-muted">
            There is not enough history yet. Your trend will appear after a couple of weeks of
            finished work.
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
    const gap = activeAtt.warmup_gap_min ?? minutesBetween(activeAtt.declared_in, activeAtt.first_activity)
    warmupLine = `You started at ${fmtClock(activeAtt.declared_in)}, and your first move in ClickUp came through at ${fmtClock(activeAtt.first_activity)}, which took about ${fmtDurationLong(gap)} to get going.`
  } else if (activeAtt?.declared_in) {
    warmupLine = `You started at ${fmtClock(activeAtt.declared_in)}. Your first move in ClickUp has not come through yet.`
  } else if (phase !== 'unmarked' && liveCheckIn) {
    warmupLine = `You started at ${fmtClock(liveCheckIn)}. We will show how long you took to get going once your first action in ClickUp lands.`
  }

  const status: AttendanceStatus | null =
    activeAtt?.status ?? (phase !== 'unmarked' ? 'Present' : null)

  return (
    <section aria-labelledby="my-attendance-h">
      <h2 id="my-attendance-h" className="eyebrow px-1">
        Your attendance
      </h2>
      <div className="glass-card mt-3 p-6">
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
              <span className="text-caption font-semibold text-fg">Today</span>
              {status ? (
                <Badge tone={ATT_TONE[status]}>{ATT_LABEL[status]}</Badge>
              ) : (
                <Badge tone="neutral">Not started yet</Badge>
              )}
            </div>
            {warmupLine && (
              <p className="mt-3 max-w-prose text-caption leading-relaxed text-muted">
                {warmupLine}
              </p>
            )}

            <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-border/60 pt-5">
              <div>
                <dt className="text-label text-muted">Time worked this week</dt>
                <dd className="tnum mt-1.5 text-card text-fg">{fmtDurationLong(workedWeekMin)}</dd>
              </div>
              <div>
                <dt className="text-label text-muted">Time late this week</dt>
                <dd className="tnum mt-1.5 text-card text-fg">
                  {lateWeekMin > 0 ? fmtDurationLong(lateWeekMin) : 'None'}
                </dd>
                <dd className="mt-1 text-label text-muted">
                  {lateWeekMin > 0
                    ? 'beyond the few minutes of grace you are given'
                    : 'you have been on time all week'}
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
  designerId,
}: {
  loading: boolean
  leaves: Leave[]
  holidays: Holiday[]
  today: string
  designerId: string | null
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [requesting, setRequesting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [leaveType, setLeaveType] = useState('annual')
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  // The form opens near the bottom of the page on phones — bring it into
  // view and put the caret in the first field so it never starts half-hidden
  // below the fold.
  useEffect(() => {
    if (!requesting) return
    const raf = requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      formRef.current?.querySelector('select')?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [requesting])

  // §22.7 "request own": lands as status='pending' (RLS-pinned server-side);
  // only your PM/HR can approve it.
  const submitRequest = async () => {
    if (!designerId || !startDate) return
    setSubmitting(true)
    try {
      await requestLeave({
        designer_id: designerId,
        leave_type: leaveType,
        start_date: startDate,
        end_date: endDate && endDate !== startDate ? endDate : null,
        reason: reason.trim() || null,
      })
      await queryClient.invalidateQueries({ queryKey: qk.leaves })
      toast({ message: 'Your request has gone to your manager to approve.' })
      setRequesting(false)
      setEndDate('')
      setReason('')
    } catch (err) {
      toast({
        message: `That did not send. ${err instanceof Error ? err.message : 'Please try again.'}`,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const upcoming = holidays.filter((h) => h.the_date >= today).slice(0, 4)
  const history = [...leaves].sort((a, b) => b.start_date.localeCompare(a.start_date)).slice(0, 8)

  // Honest count only — the schema holds no leave allowance, so no "N of M
  // remaining" balance is ever invented here.
  const yearStart = `${today.slice(0, 4)}-01-01`
  const yearEnd = `${today.slice(0, 4)}-12-31`
  const leaveDaysThisYear = leaves
    .filter((l) => l.status === 'approved')
    .reduce((sum, l) => {
      const start = l.start_date > yearStart ? l.start_date : yearStart
      const rawEnd = l.end_date ?? l.start_date
      const end = rawEnd < yearEnd ? rawEnd : yearEnd
      return end < start ? sum : sum + dateRange(start, end).length
    }, 0)

  return (
    <section aria-labelledby="time-off-h">
      <h2 id="time-off-h" className="eyebrow px-1">
        Your time off
      </h2>
      <div className="glass-card mt-3 p-6">
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-52" />
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-caption font-semibold text-fg">Leave you have taken</h3>
                <p className="tnum mt-1 text-caption text-muted">
                  {leaveDaysThisYear === 0
                    ? 'None so far this year.'
                    : `${leaveDaysThisYear} day${leaveDaysThisYear === 1 ? '' : 's'} off so far this year.`}
                </p>
              </div>
              {designerId && !requesting && (
                <Button variant="secondary" onClick={() => setRequesting(true)}>
                  Ask for time off
                </Button>
              )}
            </div>
            {requesting && (
              <form
                ref={formRef}
                className="mt-4 flex flex-col gap-4 rounded-xl bg-surface-2 p-5"
                onSubmit={(e) => {
                  e.preventDefault()
                  void submitRequest()
                }}
              >
                <div className="grid grid-cols-2 gap-4">
                  <label className="flex flex-col gap-1.5 text-label font-medium text-muted">
                    What kind
                    <select
                      value={leaveType}
                      onChange={(e) => setLeaveType(e.target.value)}
                      className="min-h-11 rounded-xl border border-border bg-surface px-3 text-caption text-fg"
                    >
                      <option value="annual">Annual leave</option>
                      <option value="sick">Sick leave</option>
                      <option value="casual">Casual leave</option>
                      <option value="unpaid">Unpaid leave</option>
                      <option value="other">Something else</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-label font-medium text-muted">
                    First day
                    <input
                      type="date"
                      required
                      min={today}
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="tnum min-h-11 rounded-xl border border-border bg-surface px-3 text-caption text-fg"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-label font-medium text-muted">
                    Last day, if it is more than one
                    <input
                      type="date"
                      min={startDate}
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="tnum min-h-11 rounded-xl border border-border bg-surface px-3 text-caption text-fg"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-label font-medium text-muted">
                    A note for your manager, if you like
                    <input
                      type="text"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="for example, a family event"
                      className="min-h-11 rounded-xl border border-border bg-surface px-3 text-caption text-fg"
                    />
                  </label>
                </div>
                {/* Buttons never wrap mid-label; the caption drops to its own
                    line on narrow phones instead of squeezing the CTA. */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={submitting}
                    aria-busy={submitting}
                    className="whitespace-nowrap"
                  >
                    {submitting ? 'Sending…' : 'Send to my manager'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setRequesting(false)}
                    className="whitespace-nowrap"
                  >
                    Never mind
                  </Button>
                  <span className="min-w-0 flex-1 basis-full text-caption text-muted sm:basis-auto">
                    Your manager sees this and decides.
                  </span>
                </div>
              </form>
            )}
            {history.length === 0 ? (
              <p className="mt-3 max-w-prose text-caption text-muted">
                Nothing on record yet. Anything your manager logs for you will appear here.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border/60">
                {history.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-caption font-medium text-fg">
                        {l.leave_type ?? 'Leave'}
                      </p>
                      <p className="tnum mt-0.5 text-label text-muted">
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

            <h3 className="mt-6 flex items-center gap-1.5 border-t border-border/60 pt-5 text-caption font-semibold text-fg">
              <CalendarDays className="h-4 w-4 text-muted" aria-hidden="true" />
              Holidays coming up
            </h3>
            {upcoming.length === 0 ? (
              <p className="mt-3 text-caption text-muted">
                No company holidays are coming up just yet.
              </p>
            ) : (
              <ul className="mt-2">
                {upcoming.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center justify-between gap-3 py-2.5 text-caption"
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
