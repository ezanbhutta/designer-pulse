/**
 * All shift / attendance / day-boundary math uses one timezone: Asia/Karachi
 * (spec §22.2 — the whole team works PKT regardless of location).
 * PKT is UTC+5 with no DST, so a fixed offset is exact.
 */

export const PKT_OFFSET_MIN = 5 * 60
const MS_PER_MIN = 60_000
const MS_PER_DAY = 86_400_000

/** ISO `YYYY-MM-DD` for the PKT calendar day containing the instant. */
export function pktDateOf(instant: Date | string | number): string {
  const t = new Date(instant).getTime() + PKT_OFFSET_MIN * MS_PER_MIN
  return new Date(t).toISOString().slice(0, 10)
}

/** 0=Sun .. 6=Sat for a `YYYY-MM-DD` date string (calendar dow, matches Postgres `dow`). */
export function dowOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay()
}

/** UTC instant for a PKT wall-clock time (`HH:MM` or `HH:MM:SS`) on a PKT date. */
export function pktInstant(dateStr: string, timeStr: string): Date {
  const [h = 0, m = 0, s = 0] = timeStr.split(':').map(Number)
  const wall = new Date(`${dateStr}T00:00:00Z`).getTime() + ((h * 60 + m) * 60 + s) * 1000
  return new Date(wall - PKT_OFFSET_MIN * MS_PER_MIN)
}

/** dateStr + n days (n may be negative). */
export function addDays(dateStr: string, n: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + n * MS_PER_DAY)
    .toISOString()
    .slice(0, 10)
}

/** Inclusive list of `YYYY-MM-DD` between two dates. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

/** Whole minutes between two instants (b − a). */
export function minutesBetween(a: Date | string, b: Date | string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / MS_PER_MIN)
}

/** Today's PKT calendar date. */
export function pktToday(now: Date = new Date()): string {
  return pktDateOf(now)
}

/**
 * Resolve the scheduled shift window for a work_date (the shift-START day).
 * Overnight shifts (shift_end <= shift_start) end on the next calendar day.
 */
export function shiftWindow(
  workDate: string,
  shiftStart: string,
  shiftEnd: string,
): { scheduledIn: Date; scheduledOut: Date; isOvernight: boolean } {
  const scheduledIn = pktInstant(workDate, shiftStart)
  const isOvernight = shiftEnd <= shiftStart
  const scheduledOut = pktInstant(isOvernight ? addDays(workDate, 1) : workDate, shiftEnd)
  return { scheduledIn, scheduledOut, isOvernight }
}

/**
 * Collection window for marks/activity (spec §9.2 step 2):
 * [scheduled_in − buffer, scheduled_out + buffer], default buffer 4h.
 */
export function collectionWindow(
  workDate: string,
  shiftStart: string,
  shiftEnd: string,
  bufferHours = 4,
): { from: Date; to: Date; scheduledIn: Date; scheduledOut: Date; isOvernight: boolean } {
  const w = shiftWindow(workDate, shiftStart, shiftEnd)
  return {
    ...w,
    from: new Date(w.scheduledIn.getTime() - bufferHours * 60 * MS_PER_MIN),
    to: new Date(w.scheduledOut.getTime() + bufferHours * 60 * MS_PER_MIN),
  }
}
