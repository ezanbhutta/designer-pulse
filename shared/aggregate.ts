/**
 * Metric aggregation (spec §11) — pure functions shared by the dashboards and
 * the server compute jobs. Durations use MEDIAN, never mean (one nightmare
 * client must not distort). Cross-designer comparison uses Attainment %,
 * never raw counts (spec §2).
 */

import { ACTIVE_LOAD_STATUSES, type CanonicalStatus } from './statuses'
import { addDays, dateRange, dowOf } from './pkt'
import { leaveCovers } from './attendance'
import type {
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
  const day = pktDay(iso)
  return day >= start && day <= end
}

// PKT day for an ISO timestamp (inline to avoid circular import weight)
function pktDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10)
}

export function summarizeDesigner(designerId: string, p: PeriodInputs): DesignerPeriodSummary {
  const tasks = p.tasks.filter((t) => t.designer_id === designerId && !t.deleted)
  const byId = new Map(tasks.map((t) => [t.task_id, t]))
  const metrics = p.metrics.filter((m) => m.designer_id === designerId && byId.has(m.task_id))

  const assignedTasks = tasks.filter((t) => inPeriod(t.created_at, p.start, p.end))
  const completedTasks = tasks.filter(
    (t) => t.current_status === 'complete' && inPeriod(t.closed_at ?? t.last_event_at, p.start, p.end),
  )
  const cancelledTasks = tasks.filter(
    (t) => t.current_status === 'cancelled' && inPeriod(t.closed_at ?? t.last_event_at, p.start, p.end),
  )
  const deliveredMetrics = metrics.filter((m) => inPeriod(m.first_delivered_at, p.start, p.end))
  const clean = deliveredMetrics.filter((m) => m.first_pass_clean).length

  const assignedIds = new Set(assignedTasks.map((t) => t.task_id))
  const assignedMetrics = metrics.filter((m) => assignedIds.has(m.task_id))
  const revisionRounds = assignedMetrics.reduce((s, m) => s + m.revision_rounds, 0)

  const expected = expectedQuotaRange(designerId, p.start, p.end, p.quota)
  const productionMedian = median(
    deliveredMetrics.map((m) => m.production_min!).filter((x) => x != null),
  )
  const revisionMedian = median(
    assignedMetrics
      .map((m) => m.revision_turnaround_min!)
      .filter((x): x is number => x != null),
  )

  return {
    designerId,
    assigned: assignedTasks.length,
    completed: completedTasks.length,
    cancelled: cancelledTasks.length,
    revisionRounds,
    csrCaughtRounds: assignedMetrics.reduce((s, m) => s + m.csr_caught_rounds, 0),
    clientCaughtRounds: assignedMetrics.reduce((s, m) => s + m.client_caught_rounds, 0),
    delivered: deliveredMetrics.length,
    firstPassClean: clean,
    firstPassQualityPct: deliveredMetrics.length
      ? Math.round((clean / deliveredMetrics.length) * 100)
      : null,
    expectedQuota: expected,
    attainmentPct: expected > 0 ? Math.round((completedTasks.length / expected) * 100) : null,
    productionMedianMin: productionMedian,
    revisionTurnaroundMedianMin: revisionMedian,
    cancellationRatePct: assignedTasks.length
      ? Math.round((cancelledTasks.length / assignedTasks.length) * 100)
      : null,
    reworkLoad: assignedTasks.length
      ? Math.round((revisionRounds / assignedTasks.length) * 10) / 10
      : null,
  }
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

export function utilizationPct(tasks: TaskState[], designerId: string, todayQuota: number): number | null {
  if (todayQuota <= 0) return null
  return Math.round((activeLoad(tasks, designerId) / todayQuota) * 100)
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
  const today = pktDay(now.toISOString())
  // 7 PKT calendar dates inclusive: today−6 .. today.
  const weekAgo = addDays(today, -6)
  const createdLast7 = tasks.filter(
    (t) => !t.deleted && t.created_at && pktDay(t.created_at) >= weekAgo,
  ).length
  const completedLast7 = tasks.filter(
    (t) =>
      !t.deleted &&
      t.current_status === 'complete' &&
      (t.closed_at ?? t.last_event_at) &&
      pktDay((t.closed_at ?? t.last_event_at)!) >= weekAgo,
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
