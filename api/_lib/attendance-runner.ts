/**
 * Attendance runner (spec §9): resolves the effective-dated schedule, gathers
 * the dual signal (self-marks + ClickUp activity) over the overnight-aware
 * window, runs the shared computeAttendance engine and persists
 * attendance_daily. Forgotten checkouts are auto-closed exactly once — an
 * audit `shift_mark` (source auto_clickup / auto_shift_end) plus an info
 * alert. All day-boundary math is PKT (spec §22.2).
 */

import { addDays, pktInstant } from '../../shared/pkt'
import { computeAttendance, leaveCovers, type AttendanceResult } from '../../shared/attendance'
import { scheduleFor } from '../../shared/aggregate'
import type {
  AttendanceDaily,
  Config,
  Designer,
  DesignerSchedule,
  HalfDay,
  Holiday,
  HolidayWorker,
  Leave,
  ShiftMark,
} from '../../shared/types'
import { expectOk, type SupabaseAdmin } from './supabaseAdmin'
import { fireAlert } from './alerts'

/** 'HH:MM' PKT wall-clock for an ISO instant (for alert copy). */
function pktClock(iso: string): string {
  return new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(11, 16)
}

/**
 * Loop-invariant reference data a sweep caller (pulse / nightly /
 * recompute-attendance) already holds. Each field is optional: when supplied,
 * the corresponding per-designer-day query is skipped and the array is
 * filtered in memory — a fleet sweep drops from ~8 round trips per
 * designer-day to the 3 signal reads (marks / activity / prior row).
 * Preloaded arrays must cover EVERY designer and EVERY work date the sweep
 * touches (full-table loads, or range loads spanning the sweep window).
 */
export interface AttendancePreload {
  schedules?: DesignerSchedule[]
  leaves?: Leave[]
  holidays?: Holiday[]
  holidayWorkers?: HolidayWorker[]
  halfDays?: HalfDay[]
}

/**
 * Compute + persist attendance for one designer on one work_date (the
 * shift-START day, spec §9.2). Returns the computed result.
 */
export async function computeAttendanceFor(
  supa: SupabaseAdmin,
  designer: Designer,
  workDate: string,
  config: Config,
  preloaded: AttendancePreload = {},
): Promise<AttendanceResult> {
  const now = new Date()
  // Collection span [workDate−1d, workDate+2d] comfortably covers the engine's
  // overnight window (scheduled_in − buffer → scheduled_out + buffer); the
  // engine itself filters to the exact window.
  const fromIso = pktInstant(addDays(workDate, -1), '00:00').toISOString()
  const toIso = pktInstant(addDays(workDate, 2), '23:59:59').toISOString()

  const loadSchedules = async (): Promise<DesignerSchedule[]> => {
    if (preloaded.schedules) return preloaded.schedules
    const r = await supa.from('designer_schedule').select('*').eq('designer_id', designer.id)
    expectOk(r.error, `designer_schedule read (${designer.name})`)
    return (r.data ?? []) as DesignerSchedule[]
  }
  const loadIsHoliday = async (): Promise<boolean> => {
    if (preloaded.holidays) return preloaded.holidays.some((h) => h.the_date === workDate)
    const r = await supa.from('holidays').select('the_date').eq('the_date', workDate).limit(1)
    expectOk(r.error, 'holidays read')
    return (r.data ?? []).length > 0
  }
  const loadIsVolunteer = async (): Promise<boolean> => {
    if (preloaded.holidayWorkers) {
      return preloaded.holidayWorkers.some(
        (w) => w.the_date === workDate && w.designer_id === designer.id,
      )
    }
    const r = await supa
      .from('holiday_workers')
      .select('designer_id')
      .eq('the_date', workDate)
      .eq('designer_id', designer.id)
      .limit(1)
    expectOk(r.error, 'holiday_workers read')
    return (r.data ?? []).length > 0
  }
  const loadLeaves = async (): Promise<Leave[]> => {
    if (preloaded.leaves) return preloaded.leaves.filter((l) => l.designer_id === designer.id)
    const r = await supa
      .from('leaves')
      .select('*')
      .eq('designer_id', designer.id)
      .lte('start_date', workDate)
      .limit(500)
    expectOk(r.error, `leaves read (${designer.name})`)
    return (r.data ?? []) as Leave[]
  }
  const loadHalfDay = async (): Promise<HalfDay | null> => {
    if (preloaded.halfDays) {
      return (
        preloaded.halfDays.find(
          (h) => h.designer_id === designer.id && h.the_date === workDate,
        ) ?? null
      )
    }
    const r = await supa
      .from('half_days')
      .select('*')
      .eq('designer_id', designer.id)
      .eq('the_date', workDate)
      .limit(1)
    expectOk(r.error, `half_days read (${designer.name})`)
    return ((r.data ?? []) as HalfDay[])[0] ?? null
  }

  const [markRes, actRes, priorRes, schedules, isHoliday, isHolidayVolunteer, leaves, halfRow] =
    await Promise.all([
      supa
        .from('shift_marks')
        .select('mark_type,marked_at,source')
        .eq('designer_id', designer.id)
        .gte('marked_at', fromIso)
        .lte('marked_at', toIso)
        .order('marked_at')
        .limit(2000),
      // The 'activity' half of the §9 dual signal: only real designer-driven
      // status changes count. 'created' events are the PM assigning work, and
      // snapshotHeal / forcedHeal rows carry fabricated event times — any of
      // them would mark an absent designer Present.
      supa
        .from('clickup_events')
        .select('event_time')
        .eq('designer_id', designer.id)
        .eq('event_type', 'status_change')
        .is('raw->snapshotHeal', null)
        .is('raw->forcedHeal', null)
        .gte('event_time', fromIso)
        .lte('event_time', toIso)
        .order('event_time')
        .limit(5000),
      supa
        .from('attendance_daily')
        .select('*')
        .eq('designer_id', designer.id)
        .eq('work_date', workDate)
        .maybeSingle(),
      loadSchedules(),
      loadIsHoliday(),
      loadIsVolunteer(),
      loadLeaves(),
      loadHalfDay(),
    ])
  expectOk(markRes.error, `shift_marks read (${designer.name})`)
  expectOk(actRes.error, `clickup_events read (${designer.name})`)
  expectOk(priorRes.error, `attendance_daily read (${designer.name})`)

  const schedule = scheduleFor(schedules, designer.id, workDate)

  // Auto check-out marks are audit records of a previous auto-close — never
  // feed them back as declared marks or the checkout would read as 'self'.
  const allMarks = (markRes.data ?? []) as Array<
    Pick<ShiftMark, 'mark_type' | 'marked_at' | 'source'>
  >
  const marks = allMarks.filter(
    (m) => m.mark_type === 'check_in' || (m.source !== 'auto_clickup' && m.source !== 'auto_shift_end'),
  )
  const activityTimes = ((actRes.data ?? []) as Array<{ event_time: string }>).map(
    (e) => e.event_time,
  )
  const prior = (priorRes.data as AttendanceDaily | null) ?? null

  const result = computeAttendance({
    workDate,
    schedule: schedule
      ? {
          shift_start: schedule.shift_start,
          shift_end: schedule.shift_end,
          weekly_off: schedule.weekly_off,
          late_grace_min: schedule.late_grace_min,
          early_leave_grace_min: schedule.early_leave_grace_min,
        }
      : null,
    marks,
    activityTimes,
    isHoliday,
    isHolidayVolunteer,
    onLeave: leaves.some((l) => leaveCovers(l, workDate)),
    halfDay: halfRow ? { from_time: halfRow.from_time, to_time: halfRow.to_time } : null,
    forgottenCheckoutMode: config.forgotten_checkout_mode,
    overnightBufferHours: config.overnight_window_buffer_hours,
    now,
  })

  const { error: upErr } = await supa.from('attendance_daily').upsert(
    {
      designer_id: designer.id,
      work_date: result.work_date,
      declared_in: result.declared_in,
      declared_out: result.declared_out,
      first_activity: result.first_activity,
      last_activity: result.last_activity,
      scheduled_in: result.scheduled_in,
      scheduled_out: result.scheduled_out,
      worked_minutes: result.worked_minutes,
      warmup_gap_min: result.warmup_gap_min,
      late_minutes: result.late_minutes,
      early_leave_minutes: result.early_leave_minutes,
      is_half_day: result.is_half_day,
      needs_review: result.needs_review,
      checkout_source: result.checkout_source,
      status: result.status,
      computed_at: now.toISOString(),
    },
    { onConflict: 'designer_id,work_date' },
  )
  expectOk(upErr, `attendance_daily upsert (${designer.name} ${workDate})`)

  // Forgotten-checkout auto-close (spec §9.2 step 4) — record the audit mark
  // and alert only on the FIRST run that applied it.
  const isAuto = result.checkout_source === 'auto_clickup' || result.checkout_source === 'auto_shift_end'
  const priorWasAuto =
    prior?.checkout_source === 'auto_clickup' || prior?.checkout_source === 'auto_shift_end'
  if (isAuto && !priorWasAuto && result.declared_out && result.checkout_source) {
    const { error: markErr } = await supa.from('shift_marks').insert({
      designer_id: designer.id,
      mark_type: 'check_out',
      marked_at: result.declared_out,
      source: result.checkout_source,
    })
    expectOk(markErr, `auto check-out mark (${designer.name} ${workDate})`)
    const how =
      result.checkout_source === 'auto_clickup'
        ? `last ClickUp activity, ${pktClock(result.declared_out)} PKT`
        : `scheduled shift end, ${pktClock(result.declared_out)} PKT — no activity corroborates work, flagged for review`
    await fireAlert(supa, {
      alert_type: 'forgotten_checkout',
      designer_id: designer.id,
      severity: 'info',
      message: `${designer.name} forgot to check out on ${workDate} — auto-closed at ${how}`,
      context: {
        work_date: workDate,
        checkout_source: result.checkout_source,
        declared_out: result.declared_out,
        needs_review: result.needs_review,
      },
    })
  }

  return result
}

/**
 * Post-midnight events belong to the shift that STARTED the day before
 * (spec §9.2): recompute BOTH workDate−1 and workDate so every event lands on
 * the correct shift-start day.
 */
export async function recomputeWithPriorDay(
  supa: SupabaseAdmin,
  designer: Designer,
  workDate: string,
  config: Config,
  preloaded: AttendancePreload = {},
): Promise<AttendanceResult> {
  await computeAttendanceFor(supa, designer, addDays(workDate, -1), config, preloaded)
  return computeAttendanceFor(supa, designer, workDate, config, preloaded)
}
