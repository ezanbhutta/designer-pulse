/**
 * Data access layer — every read is RLS-scoped server-side; the designer role
 * physically cannot read other designers' rows (spec §14). Pages consume these
 * via @tanstack/react-query with the query keys below.
 *
 * Cache tiers (spec §5.1): view-time reads use staleTime 0; analytic reads use
 * STALE_ANALYTICS (5 min). Realtime invalidation lives in hooks/useRealtime.
 */

import { supabase } from './supabase'
import { mergeConfig } from '../../shared/types'
import type {
  Alert,
  AppUser,
  AttendanceDaily,
  Config,
  Designer,
  DesignerSchedule,
  DayNote,
  HalfDay,
  Holiday,
  HolidayWorker,
  Leave,
  QuotaException,
  ShiftMark,
  TaskMetrics,
  TaskState,
  ClickupEvent,
} from '../../shared/types'

export const STALE_ANALYTICS = 5 * 60 * 1000 // §5.1 short-cache
export const STALE_LIVE = 0

export const qk = {
  profile: ['profile'] as const,
  designers: ['designers'] as const,
  schedules: ['schedules'] as const,
  quotaExceptions: ['quota-exceptions'] as const,
  openTasks: ['tasks', 'open'] as const,
  taskMetrics: (start: string, end: string) => ['task-metrics', start, end] as const,
  taskEvents: (taskId: string) => ['task-events', taskId] as const,
  alerts: (status: string) => ['alerts', status] as const,
  attendance: (start: string, end: string) => ['attendance', start, end] as const,
  leaves: ['leaves'] as const,
  halfDays: ['half-days'] as const,
  holidays: ['holidays'] as const,
  holidayWorkers: ['holiday-workers'] as const,
  shiftMarks: (date: string) => ['shift-marks', date] as const,
  config: ['config'] as const,
  cancelledTasks: ['tasks', 'cancelled'] as const,
  dayNotes: (start: string, end: string) => ['day-notes', start, end] as const,
}

function throwIf<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message)
  return (data ?? []) as T
}

// ── Profile / auth ────────────────────────────────────────────────────────────

export async function fetchMyProfile(): Promise<AppUser | null> {
  const { data, error } = await supabase.rpc('get_my_profile')
  if (error) throw new Error(error.message)
  const rows = Array.isArray(data) ? data : data ? [data] : []
  return (rows[0] as AppUser | undefined) ?? null
}

// ── Reference data ────────────────────────────────────────────────────────────

export async function fetchDesigners(): Promise<Designer[]> {
  const { data, error } = await supabase
    .from('designers')
    .select('*')
    .neq('status', 'deleted')
    .order('team')
    .order('order_index')
  return throwIf(data, error)
}

export async function fetchSchedules(): Promise<DesignerSchedule[]> {
  const { data, error } = await supabase.from('designer_schedule').select('*')
  return throwIf(data, error)
}

export async function fetchQuotaExceptions(): Promise<QuotaException[]> {
  const { data, error } = await supabase.from('quota_exceptions').select('*')
  return throwIf(data, error)
}

export async function fetchConfig(): Promise<Config> {
  const { data, error } = await supabase.from('app_config').select('*')
  if (error) throw new Error(error.message)
  return mergeConfig(data)
}

// ── Tasks & metrics ───────────────────────────────────────────────────────────

export async function fetchOpenTasks(): Promise<TaskState[]> {
  // current_status IS NULL must be included: a task in an unmapped ClickUp
  // status is still open work and must never be invisible to Ops (§6.4) —
  // `NOT (NULL IN (...))` would silently drop it.
  const { data, error } = await supabase
    .from('task_state')
    .select('*')
    .eq('deleted', false)
    .or('current_status.is.null,current_status.not.in.("complete","cancelled")')
  return throwIf(data, error)
}

/** All tasks touching the period (created, closed, or delivered inside it). */
export async function fetchTasksSince(startIso: string): Promise<TaskState[]> {
  const { data, error } = await supabase
    .from('task_state')
    .select('*')
    .eq('deleted', false)
    .or(`created_at.gte.${startIso},last_event_at.gte.${startIso}`)
  return throwIf(data, error)
}

export async function fetchTaskMetricsSince(startIso: string): Promise<TaskMetrics[]> {
  const { data, error } = await supabase
    .from('task_metrics')
    .select('*')
    .or(`computed_at.gte.${startIso},first_delivered_at.gte.${startIso}`)
  return throwIf(data, error)
}

/** The columns the task trail actually renders — deliberately NOT `*`: the
 *  `raw` jsonb column holds full webhook payloads (tens of KB per task) the
 *  trail never displays. */
export type TaskTrailEvent = Pick<
  ClickupEvent,
  'id' | 'task_id' | 'event_type' | 'from_status' | 'to_status' | 'event_time' | 'source'
>

export async function fetchTaskEvents(taskId: string): Promise<TaskTrailEvent[]> {
  const { data, error } = await supabase
    .from('clickup_events')
    .select('id,task_id,event_type,from_status,to_status,event_time,source')
    .eq('task_id', taskId)
    .order('event_time')
  return throwIf(data, error)
}

/**
 * NOTE: keep every caller on the default limit — the query key
 * (qk.cancelledTasks) does not encode it, so two different limits would fight
 * over one cache entry. Slice locally for previews.
 */
export async function fetchCancelledTasks(limit = 200): Promise<TaskState[]> {
  const { data, error } = await supabase
    .from('task_state')
    .select('*')
    .eq('current_status', 'cancelled')
    .eq('deleted', false)
    .order('closed_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  return throwIf(data, error)
}

// ── Alerts ────────────────────────────────────────────────────────────────────

export async function fetchAlerts(status: 'open' | 'all' = 'open'): Promise<Alert[]> {
  let q = supabase.from('alerts').select('*').order('fired_at', { ascending: false }).limit(200)
  if (status === 'open') q = q.in('status', ['open', 'acknowledged'])
  const { data, error } = await q
  return throwIf(data, error)
}

export async function setAlertStatus(
  id: number,
  status: 'open' | 'acknowledged' | 'resolved',
): Promise<void> {
  // Un-resolving (the undo path) must clear resolved_at, or the row keeps a
  // stale resolution timestamp with status back at open/acknowledged.
  const patch: Record<string, unknown> = {
    status,
    resolved_at: status === 'resolved' ? new Date().toISOString() : null,
  }
  const { error } = await supabase.from('alerts').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Attendance ────────────────────────────────────────────────────────────────

export async function fetchAttendance(start: string, end: string): Promise<AttendanceDaily[]> {
  const { data, error } = await supabase
    .from('attendance_daily')
    .select('*')
    .gte('work_date', start)
    .lte('work_date', end)
  return throwIf(data, error)
}

export async function fetchShiftMarksAround(dayIso: string): Promise<ShiftMark[]> {
  const { data, error } = await supabase
    .from('shift_marks')
    .select('*')
    .gte('marked_at', dayIso)
    .order('marked_at')
  return throwIf(data, error)
}

/** Designer self-mark; PM/HR pass source='manual' + explicit designerId. */
export async function insertShiftMark(mark: {
  designer_id: string
  mark_type: 'check_in' | 'check_out'
  source?: 'self' | 'manual'
  marked_at?: string
}): Promise<void> {
  const row: Record<string, unknown> = {
    designer_id: mark.designer_id,
    mark_type: mark.mark_type,
    source: mark.source ?? 'self',
  }
  // marked_at defaults to now() server-side (migration 005): self marks omit
  // the timestamp entirely so the SERVER clock is the only truth — a wrong
  // phone clock can never block or skew a check-in. Explicit timestamps
  // (manual PM/HR corrections) still pass through.
  if (mark.marked_at) row.marked_at = mark.marked_at
  const { error } = await supabase.from('shift_marks').insert(row)
  if (error) throw new Error(error.message)
}

// ── Leave / calendar ──────────────────────────────────────────────────────────

export async function fetchLeaves(): Promise<Leave[]> {
  const { data, error } = await supabase
    .from('leaves')
    .select('*')
    .order('start_date', { ascending: false })
    .limit(500)
  return throwIf(data, error)
}

export async function fetchHalfDays(): Promise<HalfDay[]> {
  const { data, error } = await supabase
    .from('half_days')
    .select('*')
    .order('the_date', { ascending: false })
    .limit(500)
  return throwIf(data, error)
}

export async function fetchHolidays(): Promise<Holiday[]> {
  const { data, error } = await supabase.from('holidays').select('*').order('the_date')
  return throwIf(data, error)
}

export async function fetchHolidayWorkers(): Promise<HolidayWorker[]> {
  const { data, error } = await supabase.from('holiday_workers').select('*')
  return throwIf(data, error)
}

export async function upsertLeave(leave: Partial<Leave> & { designer_id: string; start_date: string }) {
  const { error } = await supabase.from('leaves').upsert(leave)
  if (error) throw new Error(error.message)
}

/** Designer self-service (§22.7 "request own"): RLS pins own id + 'pending'. */
export async function requestLeave(req: {
  designer_id: string
  leave_type: string
  start_date: string
  end_date: string | null
  reason: string | null
}) {
  const { error } = await supabase.from('leaves').insert({ ...req, status: 'pending', paid: true })
  if (error) throw new Error(error.message)
}

// ── Day notes (dated context on the reports) ─────────────────────────────────

export async function fetchDayNotes(start: string, end: string): Promise<DayNote[]> {
  const { data, error } = await supabase
    .from('day_notes')
    .select('*')
    .gte('the_date', start)
    .lte('the_date', end)
    .order('the_date', { ascending: false })
    .order('created_at', { ascending: false })
  return throwIf(data, error)
}

export async function insertDayNote(note: {
  designer_id: string | null
  the_date: string
  note: string
}): Promise<void> {
  const { error } = await supabase.from('day_notes').insert(note)
  if (error) throw new Error(error.message)
}

export async function deleteDayNote(id: string): Promise<void> {
  const { error } = await supabase.from('day_notes').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteLeave(id: string) {
  const { error } = await supabase.from('leaves').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function upsertHalfDay(row: Partial<HalfDay> & { designer_id: string; the_date: string }) {
  const { error } = await supabase.from('half_days').upsert(row)
  if (error) throw new Error(error.message)
}

export async function deleteHalfDay(id: string) {
  const { error } = await supabase.from('half_days').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function upsertHoliday(row: Partial<Holiday> & { the_date: string }) {
  const { error } = await supabase.from('holidays').upsert(row, { onConflict: 'the_date' })
  if (error) throw new Error(error.message)
}

export async function deleteHoliday(id: string) {
  const { error } = await supabase.from('holidays').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function setHolidayWorker(the_date: string, designer_id: string, working: boolean) {
  if (working) {
    const { error } = await supabase.from('holiday_workers').upsert({ the_date, designer_id })
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase
      .from('holiday_workers')
      .delete()
      .eq('the_date', the_date)
      .eq('designer_id', designer_id)
    if (error) throw new Error(error.message)
  }
}

// ── Roster CRUD (Ops) ────────────────────────────────────────────────────────

export async function upsertDesigner(designer: Partial<Designer> & { name: string; team: string }) {
  const { data, error } = await supabase.from('designers').upsert(designer).select().single()
  if (error) throw new Error(error.message)
  return data as Designer
}

export async function setDesignerStatus(id: string, status: 'active' | 'archived' | 'deleted') {
  const { error } = await supabase.from('designers').update({ status }).eq('id', id)
  if (error) throw new Error(error.message)
}

/**
 * Effective-dated schedule change (spec §8.3): closes the current row at
 * effective_from − 1 day and opens a new one. Implemented server-side so the
 * two writes are atomic.
 */
export async function applyScheduleChange(change: {
  designer_id: string
  effective_from: string
  daily_quota: number
  shift_start: string
  shift_end: string
  weekly_off: number | null
  late_grace_min?: number
  early_leave_grace_min?: number
}) {
  const { error } = await supabase.rpc('apply_schedule_change', {
    p_designer_id: change.designer_id,
    p_effective_from: change.effective_from,
    p_daily_quota: change.daily_quota,
    p_shift_start: change.shift_start,
    p_shift_end: change.shift_end,
    p_weekly_off: change.weekly_off,
    p_late_grace_min: change.late_grace_min ?? 15,
    p_early_leave_grace_min: change.early_leave_grace_min ?? 15,
  })
  if (error) throw new Error(error.message)
}

export async function upsertQuotaException(row: {
  designer_id: string
  the_date: string
  daily_quota: number
  reason?: string
}) {
  const { error } = await supabase
    .from('quota_exceptions')
    .upsert(row, { onConflict: 'designer_id,the_date' })
  if (error) throw new Error(error.message)
}

export async function deleteQuotaException(id: string) {
  const { error } = await supabase.from('quota_exceptions').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── ClickUp deep links (§22.1 — the tool never writes to ClickUp) ────────────

/** ClickUp workspace (team) id — list URLs don't open without it in the path. */
const CLICKUP_TEAM_ID = '9018453434'

/**
 * Deep link to the LIST view specifically (`/v/l/6-{id}-1`) — the plain
 * `/v/li/{id}` form lets ClickUp pick the list's default tab, which can be
 * the Chat channel instead of the task list.
 */
export function clickupListUrl(listId: string | null | undefined): string | null {
  return listId ? `https://app.clickup.com/${CLICKUP_TEAM_ID}/v/l/6-${listId}-1` : null
}

export function clickupTaskUrl(taskId: string | null | undefined): string | null {
  return taskId ? `https://app.clickup.com/t/${taskId}` : null
}
