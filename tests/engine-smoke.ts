import { computeTaskMetrics } from '../shared/metrics'
import { computeAttendance } from '../shared/attendance'
import { expectedQuotaOn, median, priorPeriod } from '../shared/aggregate'
import { pktDateOf, shiftWindow, pktInstant } from '../shared/pkt'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  } else console.log(`ok   ${name}`)
}

const T = (h: number, m = 0, day = 1) =>
  new Date(Date.UTC(2026, 5, day, h, m)).toISOString()

// ── Metrics: clean task ──────────────────────────────────────────────────────
{
  const m = computeTaskMetrics(T(10), [
    { event_type: 'status_change', from_status: 'pickup your projects', to_status: 'in progress', event_time: T(10, 30) },
    { event_type: 'status_change', from_status: 'in progress', to_status: 'deliver to client', event_time: T(12) },
    { event_type: 'status_change', from_status: 'deliver to client', to_status: 'client response', event_time: T(12, 30) },
    { event_type: 'status_change', from_status: 'client response', to_status: 'final files', event_time: T(14) },
    { event_type: 'status_change', from_status: 'final files', to_status: 'complete', event_time: T(14, 30) },
  ])
  check('clean.start_latency', m.start_latency_min, 30)
  check('clean.production', m.production_min, 120)
  check('clean.fpq', m.first_pass_clean, true)
  check('clean.client_wait', m.client_wait_min, 90)
  check('clean.outcome', m.outcome, 'complete')
}

// ── Metrics: CSR-caught + client-caught revisions ────────────────────────────
{
  const m = computeTaskMetrics(T(9), [
    { event_type: 'status_change', from_status: 'pickup your projects', to_status: 'in progress', event_time: T(9, 15) },
    { event_type: 'status_change', from_status: 'in progress', to_status: 'deliver to client', event_time: T(11) },
    { event_type: 'status_change', from_status: 'deliver to client', to_status: 'revision', event_time: T(11, 30) }, // CSR-caught
    { event_type: 'status_change', from_status: 'revision', to_status: 'revision complete', event_time: T(12, 30) }, // 60m turnaround
    { event_type: 'status_change', from_status: 'revision complete', to_status: 'client response', event_time: T(13) },
    { event_type: 'status_change', from_status: 'client response', to_status: 'revision', event_time: T(15) }, // client-caught, wait 120
    { event_type: 'status_change', from_status: 'revision', to_status: 'revision complete', event_time: T(15, 45) }, // 45m
    { event_type: 'status_change', from_status: 'revision complete', to_status: 'client response', event_time: T(16) },
    { event_type: 'status_change', from_status: 'client response', to_status: 'final files', event_time: T(17) }, // wait 60
    { event_type: 'status_change', from_status: 'final files', to_status: 'complete', event_time: T(17, 30) },
  ])
  check('rev.rounds', m.revision_rounds, 2)
  check('rev.csr', m.csr_caught_rounds, 1)
  check('rev.client', m.client_caught_rounds, 1)
  check('rev.turnaround', m.revision_turnaround_min, 105)
  check('rev.client_wait', m.client_wait_min, 180)
  check('rev.fpq', m.first_pass_clean, false)
  check('rev.production', m.production_min, 120)
}

// ── Metrics: cancellation ────────────────────────────────────────────────────
{
  const m = computeTaskMetrics(T(9), [
    { event_type: 'status_change', from_status: 'pickup your projects', to_status: 'in progress', event_time: T(10) },
    { event_type: 'status_change', from_status: 'in progress', to_status: 'cancelled', event_time: T(12) },
  ])
  check('cancel.outcome', m.outcome, 'cancelled')
  check('cancel.is_cancelled', m.is_cancelled, true)
  check('cancel.production_null', m.production_min, null)
}

// ── PKT ──────────────────────────────────────────────────────────────────────
check('pkt.date', pktDateOf('2026-06-01T20:30:00Z'), '2026-06-02') // 01:30 PKT next day
{
  const w = shiftWindow('2026-06-01', '21:00', '05:00')
  check('pkt.overnight', w.isOvernight, true)
  check('pkt.out', w.scheduledOut.toISOString(), '2026-06-02T00:00:00.000Z') // 05:00 PKT = 00:00 UTC next day
}

// ── Attendance: normal day shift ─────────────────────────────────────────────
{
  // Shift 09:00–17:00 PKT on 2026-06-01 → 04:00–12:00 UTC
  const r = computeAttendance({
    workDate: '2026-06-01',
    schedule: { shift_start: '09:00', shift_end: '17:00', weekly_off: 0, late_grace_min: 15, early_leave_grace_min: 15 },
    marks: [
      { mark_type: 'check_in', marked_at: '2026-06-01T04:02:00Z' }, // 09:02 PKT
      { mark_type: 'check_out', marked_at: '2026-06-01T12:05:00Z' }, // 17:05 PKT
    ],
    activityTimes: ['2026-06-01T04:14:00Z', '2026-06-01T11:00:00Z'],
    isHoliday: false, isHolidayVolunteer: false, onLeave: false, halfDay: null,
    forgottenCheckoutMode: 'last_activity', overnightBufferHours: 4,
    now: new Date('2026-06-01T14:00:00Z'),
  })
  check('att.status', r.status, 'Present')
  check('att.warmup', r.warmup_gap_min, 12)
  check('att.worked', r.worked_minutes, 483)
  check('att.late', r.late_minutes, 0)
  check('att.checkout_source', r.checkout_source, 'self')
}

// ── Attendance: overnight, forgotten checkout, auto-close to last activity ───
{
  // Shift 21:00–05:00 PKT starting 2026-06-01 → 16:00 UTC Jun1 – 00:00 UTC Jun2
  const r = computeAttendance({
    workDate: '2026-06-01',
    schedule: { shift_start: '21:00', shift_end: '05:00', weekly_off: null, late_grace_min: 15, early_leave_grace_min: 15 },
    marks: [{ mark_type: 'check_in', marked_at: '2026-06-01T16:20:00Z' }], // 21:20 PKT — 5m past grace
    activityTimes: ['2026-06-01T17:00:00Z', '2026-06-01T23:30:00Z'], // post-midnight PKT activity
    isHoliday: false, isHolidayVolunteer: false, onLeave: false, halfDay: null,
    forgottenCheckoutMode: 'last_activity', overnightBufferHours: 4,
    now: new Date('2026-06-02T06:00:00Z'), // well after shift end
  })
  check('night.status', r.status, 'Present')
  check('night.late', r.late_minutes, 5)
  check('night.checkout_source', r.checkout_source, 'auto_clickup')
  check('night.declared_out', r.declared_out, '2026-06-01T23:30:00Z')
}

// ── Attendance: check-in, nothing else → Incomplete ─────────────────────────
{
  const r = computeAttendance({
    workDate: '2026-06-01',
    schedule: { shift_start: '09:00', shift_end: '17:00', weekly_off: null, late_grace_min: 15, early_leave_grace_min: 15 },
    marks: [{ mark_type: 'check_in', marked_at: '2026-06-01T04:00:00Z' }],
    activityTimes: [],
    isHoliday: false, isHolidayVolunteer: false, onLeave: false, halfDay: null,
    forgottenCheckoutMode: 'last_activity', overnightBufferHours: 4,
    now: new Date('2026-06-01T14:00:00Z'),
  })
  check('inc.status', r.status, 'Incomplete')
  check('inc.needs_review', r.needs_review, true)
  check('inc.checkout_source', r.checkout_source, 'auto_shift_end')
}

// ── Attendance: no signals — weekly off vs absent vs holiday ────────────────
{
  const base = {
    schedule: { shift_start: '09:00', shift_end: '17:00', weekly_off: 1, late_grace_min: 15, early_leave_grace_min: 15 },
    marks: [], activityTimes: [], isHolidayVolunteer: false, halfDay: null,
    forgottenCheckoutMode: 'last_activity' as const, overnightBufferHours: 4,
    now: new Date('2026-06-02T14:00:00Z'),
  }
  // 2026-06-01 is a Monday (dow 1) → WeeklyOff
  check('off.weekly', computeAttendance({ ...base, workDate: '2026-06-01', isHoliday: false, onLeave: false }).status, 'WeeklyOff')
  check('off.holiday-priority', computeAttendance({ ...base, workDate: '2026-06-01', isHoliday: true, onLeave: true }).status, 'Holiday')
  check('off.leave', computeAttendance({ ...base, workDate: '2026-06-02', isHoliday: false, onLeave: true }).status, 'Leave')
}

// ── Attendance: holiday volunteer with activity → HolidayWorked ──────────────
{
  const r = computeAttendance({
    workDate: '2026-06-01',
    schedule: { shift_start: '09:00', shift_end: '17:00', weekly_off: null, late_grace_min: 15, early_leave_grace_min: 15 },
    marks: [{ mark_type: 'check_in', marked_at: '2026-06-01T04:00:00Z' }, { mark_type: 'check_out', marked_at: '2026-06-01T10:00:00Z' }],
    activityTimes: ['2026-06-01T05:00:00Z'],
    isHoliday: true, isHolidayVolunteer: true, onLeave: false, halfDay: null,
    forgottenCheckoutMode: 'last_activity', overnightBufferHours: 4,
    now: new Date('2026-06-01T14:00:00Z'),
  })
  check('holworked.status', r.status, 'HolidayWorked')
}

// ── Quota calendar ───────────────────────────────────────────────────────────
{
  const ctx = {
    schedules: [{ id: 's1', designer_id: 'd1', effective_from: '2025-01-01', effective_to: null, daily_quota: 3, shift_start: '11:00', shift_end: '23:00', is_overnight: false, weekly_off: 5, late_grace_min: 15, early_leave_grace_min: 15 }],
    exceptions: [{ id: 'q1', designer_id: 'd1', the_date: '2026-06-05', daily_quota: 2, reason: 'reduced Friday' }],
    leaves: [], holidays: [], holidayWorkers: [],
  }
  check('quota.normal', expectedQuotaOn('d1', '2026-06-01', ctx as never), 3)
  // 2026-06-05 is a Friday (dow 5) = weekly off → 0 even with exception
  check('quota.weeklyoff', expectedQuotaOn('d1', '2026-06-05', ctx as never), 0)
  check('quota.exception-on-workday', expectedQuotaOn('d1', '2026-06-12', { ...ctx, exceptions: [{ id: 'q2', designer_id: 'd1', the_date: '2026-06-12', daily_quota: 2, reason: 'x' }], schedules: [{ ...ctx.schedules[0], weekly_off: 0 }] } as never), 2)
}

check('median.odd', median([5, 1, 9]), 5)
check('median.even', median([1, 2, 3, 100]), 3) // rounds (2+3)/2 → 3 (2.5 rounds to 3)
check('prior.week', priorPeriod('2026-06-08', '2026-06-14'), { start: '2026-06-01', end: '2026-06-07' })

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures ? 1 : 0)
