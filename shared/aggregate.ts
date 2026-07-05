/**
 * Metric aggregation (spec §11) — pure functions shared by the dashboards and
 * the server compute jobs. Durations use MEDIAN, never mean (one nightmare
 * client must not distort). Cross-designer comparison uses Attainment %,
 * never raw counts (spec §2).
 */

import { ACTIVE_LOAD_STATUSES, DELIVERED_STATUSES, type CanonicalStatus } from './statuses'
import { addDays, dateRange, dowOf, pktDateOf } from './pkt'
import { leaveCovers } from './attendance'
import type {
  AttendanceDaily,
  DesignerSchedule,
  Holiday,
  HolidayWorker,
  Leave,
  QuotaException,
  TaskMetrics,
  TaskState,
} from './types'

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2)
}

// ── Expected quota calendar (spec §2, §8) ─────────────────────────────────────

export interface QuotaContext {
  schedules: DesignerSchedule[] // all rows for the designer (effective-dated)
  exceptions: QuotaException[]
  leaves: Leave[]
  holidays: Holiday[]
  holidayWorkers: HolidayWorker[]
}

export function scheduleFor(
  schedules: DesignerSchedule[],
  designerId: string,
  date: string,
): DesignerSchedule | null {
  return (
    schedules
      .filter(
        (s) =>
          s.designer_id === designerId &&
          s.effective_from <= date &&
          (s.effective_to === null || date <= s.effective_to),
      )
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null
  )
}

/**
 * Expected intake for one designer on one date. Precedence:
 * leave (an explicit absence always zeroes) → per-date quota exception (an
 * explicit PM-set expectation overrides schedule-derived defaults, e.g. a
 * designer covering their weekly off) → holiday (0 for everyone — holiday
 * work is bonus-eligible, never quota-measured, §9.2) → weekly off (0) →
 * schedule quota.
 */
export function expectedQuotaOn(designerId: string, date: string, ctx: QuotaContext): number {
  const schedule = scheduleFor(ctx.schedules, designerId, date)
  if (!schedule) return 0
  if (ctx.leaves.some((l) => l.designer_id === designerId && leaveCovers(l, date))) return 0
  const exception = ctx.exceptions.find(
    (e) => e.designer_id === designerId && e.the_date === date,
  )
  if (exception) return exception.daily_quota
  if (ctx.holidays.some((h) => h.the_date === date)) return 0
  if (schedule.weekly_off != null && schedule.weekly_off === dowOf(date)) return 0
  return schedule.daily_quota
}

export function expectedQuotaRange(
  designerId: string,
  start: string,
  end: string,
  ctx: QuotaContext,
): number {
  return dateRange(start, end).reduce((sum, d) => sum + expectedQuotaOn(designerId, d, ctx), 0)
}

// ── Per-designer period summary (Tier 0–2) ────────────────────────────────────

export interface DesignerPeriodSummary {
  designerId: string
  assigned: number
  completed: number
  cancelled: number
  revisionRounds: number
  csrCaughtRounds: number
  clientCaughtRounds: number
  delivered: number // tasks first-delivered in period
  firstPassClean: number
  firstPassQualityPct: number | null // clean / delivered
  expectedQuota: number
  attainmentPct: number | null // completed / expected
  productionMedianMin: number | null
  revisionTurnaroundMedianMin: number | null
  cancellationRatePct: number | null // cancelled / assigned
  reworkLoad: number | null // mean revision rounds per assigned task
}

export interface PeriodInputs {
  start: string // PKT dates, inclusive
  end: string
  tasks: TaskState[] // all (period filters applied here)
  metrics: TaskMetrics[]
  quota: QuotaContext
}

const inPeriod = (iso: string | null, start: string, end: string) => {
  if (!iso) return false
  const day = pktDateOf(iso)
  return day >= start && day <= end
}

export function summarizeDesigner(designerId: string, p: PeriodInputs): DesignerPeriodSummary {
  // Dedupe by task id first, so a merged task set (open tasks + recent tasks,
  // as the reports now pass) can never count the same project twice.
  const tasks = [
    ...new Map(
      p.tasks.filter((t) => t.designer_id === designerId && !t.deleted).map((t) => [t.task_id, t]),
    ).values(),
  ]
  const byId = new Map(tasks.map((t) => [t.task_id, t]))
  const metrics = p.metrics.filter((m) => m.designer_id === designerId && byId.has(m.task_id))

  // The plate (owner's rule, §slot): the projects whose DUE DATE falls in the
  // period are the work the designer was meant to deliver in this window —
  // creation date and status do not decide the plate.
  const plate = tasks.filter((t) => inPeriod(t.due_date, p.start, p.end))
  // Done = the designer has DELIVERED the first design (it has reached "deliver
  // to client" or any later stage) — not only the projects whose whole order
  // is finally closed. A project sitting in "pickup" or "in progress" is still
  // an open slot; a delivered one counts, even while it waits with the client.
  const completedTasks = plate.filter(
    (t) => t.current_status != null && DELIVERED_STATUSES.includes(t.current_status),
  )
  const cancelledTasks = tasks.filter(
    (t) => t.current_status === 'cancelled' && inPeriod(t.closed_at ?? t.last_event_at, p.start, p.end),
  )
  const deliveredMetrics = metrics.filter((m) => inPeriod(m.first_delivered_at, p.start, p.end))
  const clean = deliveredMetrics.filter((m) => m.first_pass_clean).length

  const plateIds = new Set(plate.map((t) => t.task_id))
  const plateMetrics = metrics.filter((m) => plateIds.has(m.task_id))
  const revisionRounds = plateMetrics.reduce((s, m) => s + m.revision_rounds, 0)

  const expected = expectedQuotaRange(designerId, p.start, p.end, p.quota)
  const productionMedian = median(
    deliveredMetrics.map((m) => m.production_min!).filter((x) => x != null),
  )
  const revisionMedian = median(
    plateMetrics
      .map((m) => m.revision_turnaround_min!)
      .filter((x): x is number => x != null),
  )

  return {
    designerId,
    assigned: plate.length,
    completed: completedTasks.length,
    cancelled: cancelledTasks.length,
    revisionRounds,
    csrCaughtRounds: plateMetrics.reduce((s, m) => s + m.csr_caught_rounds, 0),
    clientCaughtRounds: plateMetrics.reduce((s, m) => s + m.client_caught_rounds, 0),
    delivered: deliveredMetrics.length,
    firstPassClean: clean,
    firstPassQualityPct: deliveredMetrics.length
      ? Math.round((clean / deliveredMetrics.length) * 100)
      : null,
    expectedQuota: expected,
    attainmentPct: expected > 0 ? Math.round((completedTasks.length / expected) * 100) : null,
    productionMedianMin: productionMedian,
    revisionTurnaroundMedianMin: revisionMedian,
    cancellationRatePct: plate.length
      ? Math.round((cancelledTasks.length / plate.length) * 100)
      : null,
    reworkLoad: plate.length
      ? Math.round((revisionRounds / plate.length) * 10) / 10
      : null,
  }
}

// ── Burnout composite (Tier 4) ────────────────────────────────────────────────

export interface BurnoutComposite {
  /** 0–100 composite. */
  score: number
  turnaroundRise: number
  attainmentFall: number
  warmupShrink: number
  presentCur: number
  presentPrev: number
  /** Mean warm-up gaps behind `warmupShrink` (minutes), for cause wording. */
  warmupCurMin: number | null
  warmupPrevMin: number | null
}

/**
 * Burnout risk, 0–100 (spec §11 Tier 4) — a leading indicator of "online but
 * producing less". THE canonical composite: the nightly cron alerts on it and
 * the CEO Trends board displays it, so both always show the same score.
 * Weighted, normalized components over two equal adjacent windows:
 *
 *   0.40 · rising revision turnaround — median turnaround grew; a 2× rise
 *          saturates the component ((cur/prev − 1), clamped 0..1).
 *   0.35 · falling quota attainment — a 50-point attainment drop saturates
 *          ((prev − cur) / 50, clamped 0..1).
 *   0.25 · shrinking warm-up gap WITH sustained presence — present at least
 *          as many days, starting activity sooner after check-in, while the
 *          other signals degrade ((prevWarm − curWarm) / max(prevWarm, 30),
 *          clamped 0..1; zero unless presence held steady).
 *
 * Components missing their baseline (no prior data) contribute 0 — the score
 * only rises on evidenced movement, never on absence of data. Attendance rows
 * must already be filtered to the designer + window.
 */
export function burnoutComposite(
  cur: DesignerPeriodSummary,
  prev: DesignerPeriodSummary,
  attCur: AttendanceDaily[],
  attPrev: AttendanceDaily[],
): BurnoutComposite {
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

  let turnaroundRise = 0
  if (
    prev.revisionTurnaroundMedianMin != null &&
    prev.revisionTurnaroundMedianMin > 0 &&
    cur.revisionTurnaroundMedianMin != null
  ) {
    turnaroundRise = clamp01(cur.revisionTurnaroundMedianMin / prev.revisionTurnaroundMedianMin - 1)
  }

  let attainmentFall = 0
  if (prev.attainmentPct != null && cur.attainmentPct != null) {
    attainmentFall = clamp01((prev.attainmentPct - cur.attainmentPct) / 50)
  }

  const isPresent = (a: AttendanceDaily) => a.status === 'Present' || a.status === 'HolidayWorked'
  const presentCur = attCur.filter(isPresent).length
  const presentPrev = attPrev.filter(isPresent).length
  const warmCur = meanWarmup(attCur)
  const warmPrev = meanWarmup(attPrev)
  let warmupShrink = 0
  if (
    presentCur >= presentPrev &&
    presentCur > 0 &&
    warmPrev != null &&
    warmCur != null &&
    warmCur < warmPrev
  ) {
    warmupShrink = clamp01((warmPrev - warmCur) / Math.max(warmPrev, 30))
  }

  const score = Math.round(100 * (0.4 * turnaroundRise + 0.35 * attainmentFall + 0.25 * warmupShrink))
  return {
    score,
    turnaroundRise,
    attainmentFall,
    warmupShrink,
    presentCur,
    presentPrev,
    warmupCurMin: warmCur,
    warmupPrevMin: warmPrev,
  }
}

function meanWarmup(rows: AttendanceDaily[]): number | null {
  const vals = rows
    .map((r) => r.warmup_gap_min)
    .filter((v): v is number => v != null && Number.isFinite(v))
  if (!vals.length) return null
  return vals.reduce((s, v) => s + v, 0) / vals.length
}

// ── Live capacity (Tier 3) ────────────────────────────────────────────────────

export function activeLoad(tasks: TaskState[], designerId: string): number {
  return tasks.filter(
    (t) =>
      t.designer_id === designerId &&
      !t.deleted &&
      t.current_status != null &&
      ACTIVE_LOAD_STATUSES.includes(t.current_status),
  ).length
}

/**
 * The plate for a day (owner's rule): ONLY tasks whose DUE DATE falls on that
 * PKT day are that day's work — status and creation date don't matter. A task
 * due tomorrow, even one being worked right now, belongs to tomorrow. Deduped
 * by task id so merged task sets can be passed safely.
 */
export function dueOnDay(tasks: TaskState[], designerId: string, day: string): number {
  const ids = new Set<string>()
  for (const t of tasks) {
    if (
      t.designer_id === designerId &&
      !t.deleted &&
      t.due_date != null &&
      pktDateOf(t.due_date) === day
    ) {
      ids.add(t.task_id)
    }
  }
  return ids.size
}

export function utilizationPct(
  tasks: TaskState[],
  designerId: string,
  todayQuota: number,
  day: string,
): number | null {
  if (todayQuota <= 0) return null
  return Math.round((dueOnDay(tasks, designerId, day) / todayQuota) * 100)
}

/** Minutes a task has sat in its current status. */
export function ageMinutes(task: TaskState, now: Date = new Date()): number {
  const since = task.last_event_at ?? task.created_at
  if (!since) return 0
  return Math.max(0, Math.round((now.getTime() - new Date(since).getTime()) / 60_000))
}

// ── Pipeline bottleneck (spec §22.5) ─────────────────────────────────────────

export function pipelineBottleneck(
  openTasks: TaskState[],
  now: Date = new Date(),
): Array<{ status: CanonicalStatus; count: number; medianAgeMin: number | null }> {
  const byStatus = new Map<CanonicalStatus, number[]>()
  for (const t of openTasks) {
    if (!t.current_status || t.deleted) continue
    if (t.current_status === 'complete' || t.current_status === 'cancelled') continue
    const list = byStatus.get(t.current_status) ?? []
    list.push(ageMinutes(t, now))
    byStatus.set(t.current_status, list)
  }
  return [...byStatus.entries()].map(([status, ages]) => ({
    status,
    count: ages.length,
    medianAgeMin: median(ages),
  }))
}

// ── Forecast (Tier 4) ────────────────────────────────────────────────────────

export interface ForecastResult {
  inflowPerDay: number
  completionPerDay: number
  openNow: number
  projectedBacklog: number
  horizonDays: number
}

export function workloadForecast(
  tasks: TaskState[],
  horizonDays: number,
  now: Date = new Date(),
): ForecastResult {
  const today = pktDateOf(now)
  // 7 PKT calendar dates inclusive: today−6 .. today.
  const weekAgo = addDays(today, -6)
  const createdLast7 = tasks.filter(
    (t) => !t.deleted && t.created_at && pktDateOf(t.created_at) >= weekAgo,
  ).length
  const completedLast7 = tasks.filter(
    (t) =>
      !t.deleted &&
      t.current_status === 'complete' &&
      (t.closed_at ?? t.last_event_at) &&
      pktDateOf((t.closed_at ?? t.last_event_at)!) >= weekAgo,
  ).length
  const openNow = tasks.filter(
    (t) =>
      !t.deleted && t.current_status && !['complete', 'cancelled'].includes(t.current_status),
  ).length
  const inflow = createdLast7 / 7
  const completion = completedLast7 / 7
  return {
    inflowPerDay: Math.round(inflow * 10) / 10,
    completionPerDay: Math.round(completion * 10) / 10,
    openNow,
    projectedBacklog: Math.round(openNow + (inflow - completion) * horizonDays),
    horizonDays,
  }
}

// ── Deltas ───────────────────────────────────────────────────────────────────

/** Previous period of equal length, immediately before [start, end]. */
export function priorPeriod(start: string, end: string): { start: string; end: string } {
  const days = dateRange(start, end).length
  return { start: addDays(start, -days), end: addDays(start, -1) }
}
