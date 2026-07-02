/**
 * compute_attendance (spec §9.2) — pure, recomputable daily attendance.
 * Presence is a dual signal: the self-mark (declared) cross-validated against
 * ClickUp activity (verified). All math in PKT (spec §22.2).
 * `work_date` is always the shift-START day; overnight shifts attribute the
 * whole night to the day the shift started.
 */

import { addDays, collectionWindow, dowOf, minutesBetween, pktInstant } from './pkt'
import type { AttendanceStatus } from './types'

export interface AttendanceScheduleInput {
  shift_start: string // 'HH:MM[:SS]' PKT
  shift_end: string
  weekly_off: number | null
  late_grace_min: number
  early_leave_grace_min: number
}

export interface AttendanceInputs {
  workDate: string // 'YYYY-MM-DD' shift-start day
  schedule: AttendanceScheduleInput | null
  /** shift_marks whose marked_at falls anywhere near the day; the engine window-filters. */
  marks: Array<{ mark_type: 'check_in' | 'check_out'; marked_at: string }>
  /** clickup_events times for this designer (any near the day; window-filtered here). */
  activityTimes: string[]
  isHoliday: boolean
  isHolidayVolunteer: boolean
  onLeave: boolean
  halfDay: { from_time: string | null; to_time: string | null } | null
  forgottenCheckoutMode: 'last_activity' | 'scheduled_end'
  overnightBufferHours: number
  now: Date
}

export interface AttendanceResult {
  work_date: string
  declared_in: string | null
  declared_out: string | null
  first_activity: string | null
  last_activity: string | null
  scheduled_in: string | null
  scheduled_out: string | null
  worked_minutes: number
  warmup_gap_min: number | null
  late_minutes: number
  early_leave_minutes: number
  is_half_day: boolean
  needs_review: boolean
  checkout_source: 'self' | 'auto_clickup' | 'auto_shift_end' | null
  /** null = shift not resolvable yet (no signals and shift still in progress / not started). */
  status: AttendanceStatus | null
}

export function computeAttendance(inputs: AttendanceInputs): AttendanceResult {
  const {
    workDate,
    schedule,
    marks,
    activityTimes,
    isHoliday,
    isHolidayVolunteer,
    onLeave,
    halfDay,
    forgottenCheckoutMode,
    overnightBufferHours,
    now,
  } = inputs

  // 1–2. Resolve schedule + collection window (§9.2 step 2): day shift = the
  // local PKT calendar date; overnight shift = [sched_in − buffer,
  // sched_out + buffer]. Without a schedule row, degrade to the PKT day.
  const dayWindow = {
    from: pktInstant(workDate, '00:00'),
    to: pktInstant(workDate, '23:59:59'),
  }
  const shiftWin = schedule
    ? collectionWindow(workDate, schedule.shift_start, schedule.shift_end, overnightBufferHours)
    : null
  const win = shiftWin
    ? shiftWin.isOvernight
      ? shiftWin
      : { ...dayWindow, scheduledIn: shiftWin.scheduledIn, scheduledOut: shiftWin.scheduledOut, isOvernight: false }
    : {
        ...dayWindow,
        scheduledIn: null as Date | null,
        scheduledOut: null as Date | null,
        isOvernight: false,
      }

  const inWindow = (t: string) => {
    const d = new Date(t)
    return d >= win.from && d <= win.to
  }

  // 3. Gather signals.
  const windowMarks = marks
    .filter((m) => inWindow(m.marked_at))
    .sort((a, b) => a.marked_at.localeCompare(b.marked_at))
  const checkIns = windowMarks.filter((m) => m.mark_type === 'check_in')
  const checkOuts = windowMarks.filter((m) => m.mark_type === 'check_out')
  const activity = activityTimes.filter(inWindow).sort()

  const declaredIn = checkIns[0]?.marked_at ?? null
  let declaredOut = checkOuts.length ? checkOuts[checkOuts.length - 1].marked_at : null
  const firstActivity = activity[0] ?? null
  const lastActivity = activity.length ? activity[activity.length - 1] : null

  let checkoutSource: AttendanceResult['checkout_source'] = declaredOut ? 'self' : null
  let needsReview = false

  const scheduledInIso = win.scheduledIn ? win.scheduledIn.toISOString() : null
  const scheduledOutIso = win.scheduledOut ? win.scheduledOut.toISOString() : null

  // 4. Forgotten-checkout fallback — only once the shift is over (never
  // auto-close someone who is mid-shift).
  const shiftOver = win.scheduledOut ? now >= win.scheduledOut : false
  if (declaredIn && !declaredOut && shiftOver) {
    if (lastActivity && forgottenCheckoutMode === 'last_activity') {
      declaredOut = lastActivity
      checkoutSource = 'auto_clickup'
    } else if (scheduledOutIso) {
      declaredOut = scheduledOutIso
      checkoutSource = 'auto_shift_end'
      if (!lastActivity) needsReview = true // nothing corroborates work
    }
  }

  const hasSignals = windowMarks.length > 0 || activity.length > 0

  // 6. Status resolution.
  let status: AttendanceStatus | null = null
  if (hasSignals) {
    status = isHoliday && isHolidayVolunteer ? 'HolidayWorked' : 'Present'
    // Incomplete: a check-in with neither a check-out nor any ClickUp activity.
    if (declaredIn && checkOuts.length === 0 && activity.length === 0 && shiftOver) {
      status = 'Incomplete'
    }
  } else {
    if (isHoliday) status = 'Holiday'
    else if (onLeave) status = 'Leave'
    else if (schedule?.weekly_off != null && schedule.weekly_off === dowOf(workDate)) {
      status = 'WeeklyOff'
    } else if (shiftOver || !schedule) {
      status = 'Absent'
    } else {
      status = null // shift still ahead / in progress with no signal yet
    }
  }

  // 5. Compute spans.
  const effectiveIn = declaredIn ?? firstActivity
  const effectiveOut = declaredOut ?? lastActivity
  let workedMinutes =
    effectiveIn && effectiveOut ? Math.max(0, minutesBetween(effectiveIn, effectiveOut)) : 0

  const warmupGap =
    declaredIn && firstActivity ? Math.max(0, minutesBetween(declaredIn, firstActivity)) : null

  let lateMinutes = 0
  let earlyLeaveMinutes = 0
  if (schedule && win.scheduledIn && effectiveIn) {
    const graceIn = new Date(win.scheduledIn.getTime() + schedule.late_grace_min * 60_000)
    lateMinutes = Math.max(0, minutesBetween(graceIn, effectiveIn))
  }
  // Early leave applies to any corroborated close (self mark or last ClickUp
  // activity); auto_shift_end is exactly scheduled_out so it yields 0 anyway.
  if (
    schedule &&
    win.scheduledOut &&
    effectiveOut &&
    (checkoutSource === 'self' || checkoutSource === 'auto_clickup')
  ) {
    const graceOut = new Date(win.scheduledOut.getTime() - schedule.early_leave_grace_min * 60_000)
    earlyLeaveMinutes = Math.max(0, minutesBetween(effectiveOut, graceOut))
  }

  // Half-day: day stays Present, worked minutes reduced by the absent window.
  // On overnight shifts a wall time before shift_start belongs to the
  // post-midnight leg — anchor each bound to whichever calendar day places it
  // inside the shift window.
  const anchorToShift = (wallTime: string): Date => {
    const sameDay = pktInstant(workDate, wallTime)
    if (!win.isOvernight || !win.scheduledIn || !win.scheduledOut) return sameDay
    const nextDay = pktInstant(addDays(workDate, 1), wallTime)
    const pad = 60 * 60_000
    const inShift = (d: Date) =>
      d.getTime() >= win.scheduledIn!.getTime() - pad && d.getTime() <= win.scheduledOut!.getTime() + pad
    if (inShift(sameDay)) return sameDay
    if (inShift(nextDay)) return nextDay
    return sameDay
  }
  const isHalfDay = !!halfDay && status === 'Present'
  if (isHalfDay && halfDay?.from_time && halfDay?.to_time && effectiveIn && effectiveOut) {
    const absentFrom = anchorToShift(halfDay.from_time)
    const absentTo = anchorToShift(halfDay.to_time)
    const overlapStart = Math.max(absentFrom.getTime(), new Date(effectiveIn).getTime())
    const overlapEnd = Math.min(absentTo.getTime(), new Date(effectiveOut).getTime())
    if (overlapEnd > overlapStart) {
      workedMinutes = Math.max(0, workedMinutes - Math.round((overlapEnd - overlapStart) / 60_000))
    }
  }

  return {
    work_date: workDate,
    declared_in: declaredIn,
    declared_out: declaredOut,
    first_activity: firstActivity,
    last_activity: lastActivity,
    scheduled_in: scheduledInIso,
    scheduled_out: scheduledOutIso,
    worked_minutes: workedMinutes,
    warmup_gap_min: warmupGap,
    late_minutes: lateMinutes,
    early_leave_minutes: earlyLeaveMinutes,
    is_half_day: isHalfDay,
    needs_review: needsReview,
    checkout_source: checkoutSource,
    status,
  }
}

/** Does an approved leave row cover this date? */
export function leaveCovers(
  leave: { start_date: string; end_date: string | null; status: string },
  date: string,
): boolean {
  if (leave.status !== 'approved') return false
  const end = leave.end_date ?? leave.start_date
  return leave.start_date <= date && date <= end
}
