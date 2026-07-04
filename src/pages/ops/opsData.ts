/**
 * Shared data hooks + period math for the Ops cockpit pages.
 *
 * Cache tiers follow spec §5.1: live board/alerts/attendance reads use
 * STALE_LIVE (realtime invalidation in hooks/useRealtime keeps them pushed);
 * analytic aggregates use STALE_ANALYTICS (a 5-minute-old average is
 * decision-identical to live). All day math is PKT (spec §22.2).
 */

import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  STALE_ANALYTICS,
  STALE_LIVE,
  fetchAlerts,
  fetchAttendance,
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
import { supabase } from '../../lib/supabase'
import {
  addDays,
  pktDateOf,
  pktInstant,
  pktToday,
  shiftWindow,
  startOfWeek,
} from '../../../shared/pkt'
import type { QuotaContext } from '../../../shared/aggregate'
import { CONFIG_DEFAULTS } from '../../../shared/types'
import type { Config, Designer, DesignerSchedule, TaskState } from '../../../shared/types'
import { dueOnDay } from '../../../shared/aggregate'
import type { CanonicalStatus } from '../../../shared/statuses'

// ── Reference data ────────────────────────────────────────────────────────────

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

// ── Tasks / metrics / attendance / alerts ─────────────────────────────────────

export function useOpenTasks() {
  return useQuery({ queryKey: qk.openTasks, queryFn: fetchOpenTasks, staleTime: STALE_LIVE })
}

/** UTC instant at PKT midnight starting `date`. */
export function pktDayStartIso(date: string): string {
  return pktInstant(date, '00:00').toISOString()
}

/** Tasks touching the window from PKT date `start` onward (key stays under the 'tasks' realtime root). */
export function useTasksSince(start: string) {
  return useQuery({
    queryKey: ['tasks', 'since', start] as const,
    queryFn: () => fetchTasksSince(pktDayStartIso(start)),
    staleTime: STALE_LIVE,
  })
}

export function useMetricsSince(start: string, end: string) {
  return useQuery({
    queryKey: qk.taskMetrics(start, end),
    queryFn: () => fetchTaskMetricsSince(pktDayStartIso(start)),
    staleTime: STALE_ANALYTICS,
  })
}

export function useAttendanceRange(start: string, end: string) {
  return useQuery({
    queryKey: qk.attendance(start, end),
    queryFn: () => fetchAttendance(start, end),
    staleTime: STALE_LIVE,
  })
}

export function useOpenAlerts() {
  return useQuery({
    queryKey: qk.alerts('open'),
    queryFn: () => fetchAlerts('open'),
    staleTime: STALE_LIVE,
  })
}

// ── Designer drawer (layout-level, driven by the `d` search param) ───────────

export function useDesignerDrawer(): (id: string) => void {
  const [searchParams, setSearchParams] = useSearchParams()
  return useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams)
      next.set('d', id)
      setSearchParams(next)
    },
    [searchParams, setSearchParams],
  )
}

// ── Period math (PKT dates, inclusive) ────────────────────────────────────────

export interface PeriodRange {
  start: string
  end: string
}

export function thisWeekRange(today: string = pktToday()): PeriodRange {
  return { start: startOfWeek(today), end: today }
}

export function lastWeekRange(today: string = pktToday()): PeriodRange {
  const start = addDays(startOfWeek(today), -7)
  return { start, end: addDays(start, 6) }
}

export function thisMonthRange(today: string = pktToday()): PeriodRange {
  return { start: `${today.slice(0, 8)}01`, end: today }
}

/** Rolling window of `days` ending today (used by the designer drill-down). */
export function rollingRange(days: number, today: string = pktToday()): PeriodRange {
  return { start: addDays(today, -(days - 1)), end: today }
}

// ── Small derivations shared across pages ─────────────────────────────────────

export function createdOn(task: TaskState, date: string): boolean {
  return task.created_at != null && pktDateOf(task.created_at) === date
}

export function closedOn(task: TaskState, date: string, status: CanonicalStatus): boolean {
  const at = task.closed_at ?? task.last_event_at
  return task.current_status === status && at != null && pktDateOf(at) === date
}

/**
 * Slots filled for a day (owner's rule): ONLY projects whose DUE DATE falls
 * on that PKT day are that day's work — status and creation date don't
 * matter. A task due tomorrow, even one being worked on right now, belongs to
 * tomorrow. Deduped by task id across the two task sets.
 */
export function slotsFilledToday(
  openTasks: TaskState[],
  recentTasks: TaskState[],
  designerId: string,
  today: string,
): number {
  return dueOnDay([...openTasks, ...recentTasks], designerId, today)
}

/**
 * Aging threshold in minutes for a task's current status (spec §11 T3).
 * Waiting on the client is NEVER stuck — clients reply late, that's the
 * business — so `client response` gets an infinite threshold and can never
 * appear in a stuck list or wear an aging badge.
 */
export function agingThresholdMin(status: CanonicalStatus | null, cfg: Config): number {
  if (status === 'client response') return Infinity
  return cfg.aging_days_default * 24 * 60
}

/**
 * Minutes since today's scheduled shift start (negative = shift not started).
 * null when the designer has no schedule for today.
 */
export function minutesSinceShiftStart(
  schedule: DesignerSchedule | null,
  today: string,
  now: Date,
): number | null {
  if (!schedule) return null
  const win = shiftWindow(today, schedule.shift_start, schedule.shift_end)
  return Math.round((now.getTime() - win.scheduledIn.getTime()) / 60_000)
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

// ── Delta helper (§20.2 — every metric ships with its delta) ─────────────────

export interface TileDelta {
  label: string
  direction: 'up' | 'down' | 'flat'
  good: boolean
}

/**
 * Build a StatTile delta from current vs prior. `goodWhen` encodes the good
 * direction for THIS metric (faster speed = down = good).
 */
export function metricDelta(
  current: number | null | undefined,
  prior: number | null | undefined,
  opts: { goodWhen: 'up' | 'down'; format?: (abs: number) => string; vs?: string },
): TileDelta | null {
  if (current == null || prior == null) return null
  const diff = current - prior
  const fmt = opts.format ?? ((abs: number) => String(abs))
  const vs = opts.vs ?? 'vs last period'
  if (diff === 0) return { label: `no change ${vs}`, direction: 'flat', good: true }
  return {
    label: `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))} ${vs}`,
    direction: diff > 0 ? 'up' : 'down',
    good: opts.goodWhen === 'up' ? diff > 0 : diff < 0,
  }
}

// ── Manual shift-mark undo path ───────────────────────────────────────────────

/**
 * shift_marks is append-only (SQL contract): the delete succeeds for admins
 * and errors visibly otherwise — the Undo toast surfaces the failure rather
 * than pretending. Marks are matched by exact fingerprint, never broadly.
 */
export async function deleteManualShiftMark(designerId: string, markedAtIso: string): Promise<void> {
  const { error } = await supabase
    .from('shift_marks')
    .delete()
    .eq('designer_id', designerId)
    .eq('marked_at', markedAtIso)
    .eq('source', 'manual')
  if (error) throw new Error(error.message)
}
