/** Display formatting — all times rendered in PKT (spec §22.2). */

const PKT = 'Asia/Karachi'

// Module-level singletons — Intl.DateTimeFormat construction costs ~0.1–0.5ms
// and these run per table cell (the attendance week grid alone calls them
// hundreds of times per render).
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: PKT,
})
const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: PKT,
})

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return TIME_FMT.format(new Date(iso))
}

export function fmtDate(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return '—'
  const d = isoOrDate.length === 10 ? new Date(`${isoOrDate}T00:00:00+05:00`) : new Date(isoOrDate)
  return DATE_FMT.format(d)
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return `${fmtDate(iso)}, ${fmtTime(iso)}`
}

/** "3h 20m" / "45m" / "2d 4h" — durations for humans. */
export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  const m = Math.round(minutes)
  if (m < 60) return `${m}m`
  if (m < 60 * 24) {
    const h = Math.floor(m / 60)
    const rem = m % 60
    return rem ? `${h}h ${rem}m` : `${h}h`
  }
  const d = Math.floor(m / (60 * 24))
  const h = Math.round((m % (60 * 24)) / 60)
  return h ? `${d}d ${h}h` : `${d}d`
}

/**
 * The same duration spelled out in full words — for prose the designer reads,
 * where "6h 12m" feels like a machine and "6 hours and 12 minutes" feels like
 * a person. The compact `fmtDuration` stays for dense Ops tables.
 */
export function fmtDurationLong(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  const m = Math.round(minutes)
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (m < 60) return unit(m, 'minute')
  if (m < 60 * 24) {
    const h = Math.floor(m / 60)
    const rem = m % 60
    return rem ? `${unit(h, 'hour')} and ${unit(rem, 'minute')}` : unit(h, 'hour')
  }
  const d = Math.floor(m / (60 * 24))
  const h = Math.round((m % (60 * 24)) / 60)
  return h ? `${unit(d, 'day')} and ${unit(h, 'hour')}` : unit(d, 'day')
}

/** Friendly 12-hour clock — "9:04 am", "5:00 pm" — for the phone-facing view. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—'
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: PKT,
  }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()}`
}

export function fmtPct(pct: number | null | undefined): string {
  return pct == null ? '—' : `${pct}%`
}

/** 'HH:MM[:SS]' PKT wall time → "9:00 PM" style label. */
export function fmtShiftTime(time: string | null | undefined): string {
  if (!time) return '—'
  const [h, m] = time.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  const hh = h % 12 === 0 ? 12 : h % 12
  return m ? `${hh}:${String(m).padStart(2, '0')}${ampm}` : `${hh}${ampm}`
}

export const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
