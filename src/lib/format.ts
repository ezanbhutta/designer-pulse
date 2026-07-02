/** Display formatting — all times rendered in PKT (spec §22.2). */

const PKT = 'Asia/Karachi'

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: PKT,
  }).format(new Date(iso))
}

export function fmtDate(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return '—'
  const d = isoOrDate.length === 10 ? new Date(`${isoOrDate}T00:00:00+05:00`) : new Date(isoOrDate)
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: PKT,
  }).format(d)
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

export function fmtPct(pct: number | null | undefined): string {
  return pct == null ? '—' : `${pct}%`
}

export function fmtCount(n: number | null | undefined): string {
  return n == null ? '—' : String(n)
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
