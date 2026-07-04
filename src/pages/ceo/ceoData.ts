/**
 * Shared data hooks + aggregation for the CEO decision cockpit (spec §13.2).
 *
 * The CEO surface is READ-ONLY on operations (§13.2, §22.1): every hook here
 * is a fetch; there are no mutations in this module. Default decision window
 * is this week vs last (§20.4): week-to-date views compare against
 * `sameWindowLastWeek` (the same elapsed span shifted back 7 days) so deltas
 * are like-for-like; generic periods use `priorPeriod`. All day math is PKT
 * (§22.2).
 *
 * Cache tiers follow §5.1: open tasks read live (realtime invalidation via
 * hooks/useRealtime keeps them pushed); analytic aggregates use the 5-minute
 * short-cache — a 5-minute-old average is decision-identical to live.
 */

import { useQuery } from '@tanstack/react-query'
import {
  STALE_ANALYTICS,
  STALE_LIVE,
  fetchAttendance,
  fetchCancelledTasks,
  fetchConfig,
  fetchDesigners,
  fetchHolidayWorkers,
  fetchHolidays,
  fetchLeaves,
  fetchOpenTasks,
  fetchQuotaExceptions,
  fetchSchedules,
  fetchTaskMetricsSince,
  fetchTasksSince,
  qk,
} from '../../lib/queries'
import { addDays, dowOf, pktDateOf, pktInstant, pktToday } from '../../../shared/pkt'
import { median } from '../../../shared/aggregate'
import type { DesignerPeriodSummary, QuotaContext } from '../../../shared/aggregate'
import { STATUS_LABELS, type CanonicalStatus } from '../../../shared/statuses'
import { CONFIG_DEFAULTS } from '../../../shared/types'
import type {
  AttendanceDaily,
  Config,
  Designer,
  Team,
  TaskMetrics,
  TaskState,
} from '../../../shared/types'

export const TEAMS: Team[] = ['Logo', 'Branding', 'Animation', 'PPT', 'Canva']

// ── Reference data hooks ──────────────────────────────────────────────────────

export function useDesigners() {
  return useQuery({ queryKey: qk.designers, queryFn: fetchDesigners, staleTime: STALE_ANALYTICS })
}

export function activeDesigners(designers: Designer[] | undefined): Designer[] {
  return (designers ?? []).filter((d) => d.status === 'active')
}

/** Config with defaults applied while loading — thresholds never blank. */
export function useConfigValues(): Config {
  const { data } = useQuery({ queryKey: qk.config, queryFn: fetchConfig, staleTime: STALE_ANALYTICS })
  return data ?? CONFIG_DEFAULTS
}

/** Everything expectedQuotaOn/Range needs (schedules + exceptions + calendar). */
export function useQuotaCtx(): { ctx: QuotaContext; isLoading: boolean } {
  const schedules = useQuery({ queryKey: qk.schedules, queryFn: fetchSchedules, staleTime: STALE_ANALYTICS })
  const exceptions = useQuery({
    queryKey: qk.quotaExceptions,
    queryFn: fetchQuotaExceptions,
    staleTime: STALE_ANALYTICS,
  })
  const leaves = useQuery({ queryKey: qk.leaves, queryFn: fetchLeaves, staleTime: STALE_ANALYTICS })
  const holidays = useQuery({ queryKey: qk.holidays, queryFn: fetchHolidays, staleTime: STALE_ANALYTICS })
  const workers = useQuery({
    queryKey: qk.holidayWorkers,
    queryFn: fetchHolidayWorkers,
    staleTime: STALE_ANALYTICS,
  })
  return {
    ctx: {
      schedules: schedules.data ?? [],
      exceptions: exceptions.data ?? [],
      leaves: leaves.data ?? [],
      holidays: holidays.data ?? [],
      holidayWorkers: workers.data ?? [],
    },
    isLoading:
      schedules.isLoading ||
      exceptions.isLoading ||
      leaves.isLoading ||
      holidays.isLoading ||
      workers.isLoading,
  }
}

// ── Task / metric / attendance windows ────────────────────────────────────────

/** UTC instant at PKT midnight starting `date`. */
export function pktDayStartIso(date: string): string {
  return pktInstant(date, '00:00').toISOString()
}

export function useOpenTasksLive() {
  return useQuery({ queryKey: qk.openTasks, queryFn: fetchOpenTasks, staleTime: STALE_LIVE })
}

/** Tasks touching the window from PKT date `start` onward ('tasks' root keeps realtime invalidation). */
export function useTasksWindow(start: string) {
  return useQuery({
    queryKey: ['tasks', 'since', start] as const,
    queryFn: () => fetchTasksSince(pktDayStartIso(start)),
    staleTime: STALE_ANALYTICS,
  })
}

export function useMetricsWindow(start: string, end: string) {
  return useQuery({
    queryKey: qk.taskMetrics(start, end),
    queryFn: () => fetchTaskMetricsSince(pktDayStartIso(start)),
    staleTime: STALE_ANALYTICS,
  })
}

export function useAttendanceWindow(start: string, end: string) {
  return useQuery({
    queryKey: qk.attendance(start, end),
    queryFn: () => fetchAttendance(start, end),
    staleTime: STALE_ANALYTICS,
  })
}

export function useCancelledTasks() {
  return useQuery({
    queryKey: qk.cancelledTasks,
    queryFn: () => fetchCancelledTasks(200),
    staleTime: STALE_LIVE,
  })
}

/**
 * Union of a period window and the live open set, deduped by task_id. The
 * window fetch misses open tasks with no recent events; the open fetch misses
 * recently closed ones — the forecast and bottleneck need both.
 */
export function mergeTasks(windowTasks: TaskState[], openTasks: TaskState[]): TaskState[] {
  const byId = new Map<string, TaskState>()
  for (const t of windowTasks) byId.set(t.task_id, t)
  for (const t of openTasks) if (!byId.has(t.task_id)) byId.set(t.task_id, t)
  return [...byId.values()]
}

// ── Period math (PKT dates, inclusive; weeks start Monday) ────────────────────

export interface PeriodRange {
  start: string
  end: string
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, -((dowOf(date) + 6) % 7))
}

/** CEO decision window default: this week so far (Mon → today, §20.4). */
export function thisWeekRange(today: string = pktToday()): PeriodRange {
  return { start: startOfWeek(today), end: today }
}

/**
 * The prior week's SAME window — both bounds shifted back exactly 7 days.
 * Week-to-date deltas (Mon..today) must compare like-for-like elapsed spans:
 * a trailing equal-length window (`priorPeriod`) would mostly be last weekend
 * and skew every "vs last week" read. Use `priorPeriod` only for generic
 * (non-week-anchored) periods.
 */
export function sameWindowLastWeek(range: PeriodRange): PeriodRange {
  return { start: addDays(range.start, -7), end: addDays(range.end, -7) }
}

/** The most recent COMPLETE Mon–Sun week — the weekly report default (§13.2). */
export function lastFullWeekRange(today: string = pktToday()): PeriodRange {
  const start = addDays(startOfWeek(today), -7)
  return { start, end: addDays(start, 6) }
}

export interface WeekBucket extends PeriodRange {
  label: string
}

/** The last `n` Mon–Sun weeks ending with the current (partial) week. */
export function weekBuckets(n: number, today: string = pktToday()): WeekBucket[] {
  const thisMonday = startOfWeek(today)
  const buckets: WeekBucket[] = []
  for (let i = n - 1; i >= 0; i--) {
    const start = addDays(thisMonday, -7 * i)
    buckets.push({ start, end: addDays(start, 6), label: start.slice(5) })
  }
  return buckets
}

// ── Period aggregation helpers (team- or studio-level slices) ─────────────────

export function pktDayIn(iso: string | null | undefined, start: string, end: string): boolean {
  if (!iso) return false
  const day = pktDateOf(iso)
  return day >= start && day <= end
}

export interface FpqSlice {
  delivered: number
  clean: number
  pct: number | null
  csrCaughtRounds: number
  clientCaughtRounds: number
}

/** First-Pass Quality over tasks first-delivered in the period (§11 T1). */
export function fpqInPeriod(metrics: TaskMetrics[], ids: Set<string>, p: PeriodRange): FpqSlice {
  const delivered = metrics.filter(
    (m) => m.designer_id != null && ids.has(m.designer_id) && pktDayIn(m.first_delivered_at, p.start, p.end),
  )
  const clean = delivered.filter((m) => m.first_pass_clean).length
  return {
    delivered: delivered.length,
    clean,
    pct: delivered.length ? Math.round((clean / delivered.length) * 100) : null,
    csrCaughtRounds: delivered.reduce((s, m) => s + m.csr_caught_rounds, 0),
    clientCaughtRounds: delivered.reduce((s, m) => s + m.client_caught_rounds, 0),
  }
}

/** Completions in period (Tier 0 — Team Throughput numerator). */
export function completionsInPeriod(tasks: TaskState[], ids: Set<string>, p: PeriodRange): number {
  return tasks.filter(
    (t) =>
      !t.deleted &&
      t.designer_id != null &&
      ids.has(t.designer_id) &&
      t.current_status === 'complete' &&
      pktDayIn(t.closed_at ?? t.last_event_at, p.start, p.end),
  ).length
}

export function cancelledInPeriod(tasks: TaskState[], ids: Set<string>, p: PeriodRange): TaskState[] {
  return tasks.filter(
    (t) =>
      !t.deleted &&
      t.designer_id != null &&
      ids.has(t.designer_id) &&
      t.current_status === 'cancelled' &&
      pktDayIn(t.closed_at ?? t.last_event_at, p.start, p.end),
  )
}

/** Median production minutes over tasks first-delivered in the period (client wait excluded, §4.1). */
export function productionMedianInPeriod(
  metrics: TaskMetrics[],
  ids: Set<string>,
  p: PeriodRange,
): number | null {
  return median(
    metrics
      .filter(
        (m) =>
          m.designer_id != null && ids.has(m.designer_id) && pktDayIn(m.first_delivered_at, p.start, p.end),
      )
      .map((m) => m.production_min)
      .filter((v): v is number => v != null),
  )
}

/** Median client wait over tasks delivered in the period — client drag, never the designer's (§4.1). */
export function clientWaitMedianInPeriod(
  metrics: TaskMetrics[],
  ids: Set<string>,
  p: PeriodRange,
): number | null {
  return median(
    metrics
      .filter(
        (m) =>
          m.designer_id != null && ids.has(m.designer_id) && pktDayIn(m.first_delivered_at, p.start, p.end),
      )
      .map((m) => m.client_wait_min)
      .filter((v): v is number => v != null),
  )
}

/** Median revision turnaround over revised tasks delivered in the period. */
export function revisionTurnaroundMedianInPeriod(
  metrics: TaskMetrics[],
  ids: Set<string>,
  p: PeriodRange,
): number | null {
  return median(
    metrics
      .filter(
        (m) =>
          m.designer_id != null &&
          ids.has(m.designer_id) &&
          m.revision_rounds > 0 &&
          pktDayIn(m.first_delivered_at, p.start, p.end),
      )
      .map((m) => m.revision_turnaround_min)
      .filter((v): v is number => v != null),
  )
}

// ── Deltas (§20.2 — every metric ships with its delta) ────────────────────────

export interface TileDelta {
  label: string
  direction: 'up' | 'down' | 'flat'
  good: boolean
}

/**
 * Build a StatTile delta from current vs prior. `goodWhen` encodes the good
 * direction for THIS metric (faster speed = down = good, §20.2).
 */
export function metricDelta(
  current: number | null | undefined,
  prior: number | null | undefined,
  opts: { goodWhen: 'up' | 'down'; format?: (abs: number) => string; vs?: string },
): TileDelta | null {
  if (current == null || prior == null) return null
  const diff = current - prior
  const fmt = opts.format ?? ((abs: number) => String(abs))
  const vs = opts.vs ?? 'vs last week'
  if (diff === 0) return { label: `no change ${vs}`, direction: 'flat', good: true }
  return {
    label: `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))} ${vs}`,
    direction: diff > 0 ? 'up' : 'down',
    good: opts.goodWhen === 'up' ? diff > 0 : diff < 0,
  }
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

// ── Pipeline constraint read (§20.11 — the hidden insight in one line) ────────

export interface ConstraintRead {
  status: CanonicalStatus
  owner: 'the design work itself' | 'our checking step' | 'the client'
  line: string
}

const STATUS_OWNER: Record<string, ConstraintRead['owner']> = {
  'pickup your projects': 'the design work itself',
  'in progress': 'the design work itself',
  revision: 'the design work itself',
  'deliver to client': 'our checking step',
  'revision complete': 'our checking step',
  'final files': 'our checking step',
  'client response': 'the client',
}

/**
 * Reads the Pipeline Bottleneck (§22.5) in one plain sentence: whether the
 * slowest step is the design work, our checking step, or the client (§11 T5).
 */
export function constraintRead(
  rows: Array<{ status: CanonicalStatus; count: number; medianAgeMin: number | null }>,
  fmtDur: (min: number | null | undefined) => string,
): ConstraintRead | null {
  const ranked = rows
    .filter((r) => r.medianAgeMin != null && r.count > 0)
    .sort((a, b) => (b.medianAgeMin ?? 0) - (a.medianAgeMin ?? 0))
  const top = ranked[0]
  if (!top) return null
  const owner = STATUS_OWNER[top.status] ?? 'the design work itself'
  return {
    status: top.status,
    owner,
    line: `The slowest step right now is ${owner} — ${top.count} open project${top.count === 1 ? ' has' : 's have'} usually been sitting ${fmtDur(top.medianAgeMin)} at "${STATUS_LABELS[top.status].toLowerCase()}".`,
  }
}

// ── Burnout Risk composite (§11 Tier 4 — leading indicator, private §22.10) ───

export interface BurnoutRisk {
  designerId: string
  /** 0–100 composite. */
  score: number
  components: { turnaround: number; attainment: number; warmup: number }
  causes: string[]
  flagged: boolean
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const PRESENT: Array<AttendanceDaily['status']> = ['Present', 'HolidayWorked']

/**
 * Burnout composite per spec §11 Tier 4, computed client-side over two
 * equal adjacent windows (current vs prior). Weights are fixed by the spec's
 * definition and documented here:
 *
 *   40% rising revision turnaround — recovery speed decaying under load.
 *       raw = % increase of the current median over the prior median,
 *       saturating at a doubling (=100).
 *   40% falling attainment — output dropping against their own quota.
 *       raw = percentage-point drop × 2, saturating at a 50pp drop (=100).
 *   20% shrinking warm-up gap WITH sustained presence — online as usual and
 *       starting faster, yet producing less: the classic grind signal.
 *       Applied only when present-days hold at ≥80% of the prior window;
 *       raw = % shrink of the median warm-up gap.
 *
 * score = 0.4·turnaround + 0.4·attainment + 0.2·warmup, rounded; flag when
 * above `burnout_score` from app_config (§18).
 */
export function burnoutRisk(
  designerId: string,
  cur: DesignerPeriodSummary,
  prior: DesignerPeriodSummary,
  curAtt: AttendanceDaily[],
  priorAtt: AttendanceDaily[],
  threshold: number,
  fmtDur: (min: number | null | undefined) => string,
): BurnoutRisk {
  const causes: string[] = []

  // 40% — rising revision turnaround
  let turnaround = 0
  if (
    cur.revisionTurnaroundMedianMin != null &&
    prior.revisionTurnaroundMedianMin != null &&
    prior.revisionTurnaroundMedianMin > 0 &&
    cur.revisionTurnaroundMedianMin > prior.revisionTurnaroundMedianMin
  ) {
    const risePct =
      ((cur.revisionTurnaroundMedianMin - prior.revisionTurnaroundMedianMin) /
        prior.revisionTurnaroundMedianMin) *
      100
    turnaround = clamp(risePct, 0, 100)
    causes.push(
      `fixes are taking ${Math.round(risePct)}% longer (${fmtDur(prior.revisionTurnaroundMedianMin)} → ${fmtDur(cur.revisionTurnaroundMedianMin)})`,
    )
  }

  // 40% — falling attainment
  let attainment = 0
  if (cur.attainmentPct != null && prior.attainmentPct != null && cur.attainmentPct < prior.attainmentPct) {
    const dropPp = prior.attainmentPct - cur.attainmentPct
    attainment = clamp(dropPp * 2, 0, 100)
    causes.push(`"target met" fell from ${prior.attainmentPct}% to ${cur.attainmentPct}%`)
  }

  // 20% — shrinking warm-up gap with sustained presence
  let warmup = 0
  const presentDays = (rows: AttendanceDaily[]) =>
    rows.filter((a) => a.designer_id === designerId && a.status != null && PRESENT.includes(a.status))
  const curPresent = presentDays(curAtt)
  const priorPresent = presentDays(priorAtt)
  const gapMedian = (rows: AttendanceDaily[]) =>
    median(rows.map((a) => a.warmup_gap_min).filter((v): v is number => v != null))
  const curGap = gapMedian(curPresent)
  const priorGap = gapMedian(priorPresent)
  const sustained = priorPresent.length > 0 && curPresent.length >= priorPresent.length * 0.8
  if (sustained && curGap != null && priorGap != null && priorGap > 0 && curGap < priorGap) {
    const shrinkPct = ((priorGap - curGap) / priorGap) * 100
    warmup = clamp(shrinkPct, 0, 100)
    causes.push(
      `still showing up as usual (${curPresent.length} days vs ${priorPresent.length}) and starting work sooner (${fmtDur(priorGap)} → ${fmtDur(curGap)}), yet finishing less`,
    )
  }

  const score = Math.round(0.4 * turnaround + 0.4 * attainment + 0.2 * warmup)
  return {
    designerId,
    score,
    components: { turnaround: Math.round(turnaround), attainment: Math.round(attainment), warmup: Math.round(warmup) },
    causes,
    flagged: score > threshold,
  }
}

// ── Aging threshold (§11 T3) ──────────────────────────────────────────────────

// Waiting on the client is NEVER stuck (clients reply late — that's normal),
// so `client response` gets an infinite threshold everywhere.
export function agingThresholdMin(status: CanonicalStatus | null, cfg: Config): number {
  if (status === 'client response') return Infinity
  return cfg.aging_days_default * 24 * 60
}
