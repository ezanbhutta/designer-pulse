import { useEffect, useRef, useState } from 'react'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays, pktToday } from '../../../shared/pkt'

/**
 * The one date filter used everywhere (ported from CSR Pulse, exact same
 * behaviour): four preset chips — Today · Yesterday · 7d · 30d — plus a Custom
 * chip that opens a branded calendar popover for picking any range. Operates
 * purely on YYYY-MM-DD PKT business-day strings so it never drifts against the
 * rest of the app. Brand violet marks the active chip / selected days; the
 * substrate stays grayscale.
 */

export type RangeMode = 'today' | 'yesterday' | '7d' | '30d' | 'custom'

export interface DateRangeValue {
  mode: RangeMode
  /** YYYY-MM-DD PKT, inclusive. */
  start: string
  end: string
}

/** Resolve a preset mode to its {start, end} PKT window (custom passes through). */
export function resolveRange(mode: RangeMode, start: string, end: string, today = pktToday()): DateRangeValue {
  switch (mode) {
    case 'today':
      return { mode, start: today, end: today }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { mode, start: y, end: y }
    }
    case '7d':
      return { mode, start: addDays(today, -6), end: today }
    case '30d':
      return { mode, start: addDays(today, -29), end: today }
    case 'custom':
      return { mode, start, end }
  }
}

const CAL_WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const CAL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const pad2 = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`
const parseYmd = (s: string): { y: number; m: number; d: number } | null => {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ''))
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null
}
/** "May 27" for the trigger chip. */
const fmtChip = (s: string) => {
  const p = parseYmd(s)
  return p ? `${CAL_MONTHS[p.m].slice(0, 3)} ${p.d}` : '—'
}

const PRESETS: { v: RangeMode; l: string }[] = [
  { v: 'today', l: 'Today' },
  { v: 'yesterday', l: 'Yesterday' },
  { v: '7d', l: '7d' },
  { v: '30d', l: '30d' },
]

export function DateRangePicker({
  value,
  onChange,
  label,
}: {
  value: DateRangeValue
  onChange: (v: DateRangeValue) => void
  /** Optional eyebrow (e.g. "Period") shown before the chips. */
  label?: string
}) {
  const today = pktToday()
  const [open, setOpen] = useState(false)
  const [pendingStart, setPendingStart] = useState<string | null>(null)
  const [hoverDay, setHoverDay] = useState<number | null>(null)
  const seed = parseYmd(value.end) || parseYmd(today) || { y: 2026, m: 0, d: 1 }
  const [view, setView] = useState({ y: seed.y, m: seed.m })
  const rootRef = useRef<HTMLDivElement>(null)

  // Jump the visible month to the active range whenever the popover opens.
  useEffect(() => {
    if (!open) return
    const p = parseYmd(value.start) || parseYmd(today)
    if (p) setView({ y: p.y, m: p.m })
    setPendingStart(null)
    setHoverDay(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside-click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const isCustom = value.mode === 'custom'

  const chipCls = (active: boolean) =>
    `min-h-9 rounded-lg px-3 text-caption font-semibold transition-colors duration-150 ${
      active ? 'bg-brand text-brand-fg' : 'text-muted hover:bg-surface-2 hover:text-fg'
    }`

  const pickPreset = (v: RangeMode) => {
    onChange(resolveRange(v, value.start, value.end, today))
    setOpen(false)
  }

  const openCustom = () => {
    if (!isCustom) {
      // Seed the custom range from the currently-shown window.
      onChange({ mode: 'custom', start: value.start, end: value.end })
    }
    setOpen((o) => (isCustom ? !o : true))
  }

  const pickDay = (d: number) => {
    const cur = ymd(view.y, view.m, d)
    if (!pendingStart) {
      setPendingStart(cur)
      onChange({ mode: 'custom', start: cur, end: cur })
    } else {
      const [s, e] = pendingStart <= cur ? [pendingStart, cur] : [cur, pendingStart]
      onChange({ mode: 'custom', start: s, end: e })
      setPendingStart(null)
    }
  }

  const shiftMonth = (delta: number) =>
    setView((v) => {
      let m = v.m + delta
      let y = v.y
      if (m < 0) { m = 11; y -= 1 }
      if (m > 11) { m = 0; y += 1 }
      return { y, m }
    })

  // Monday-first grid (matches PKT week start used across the app).
  const firstDow = (new Date(view.y, view.m, 1).getDay() + 6) % 7
  const numDays = new Date(view.y, view.m + 1, 0).getDate()
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= numDays; d++) cells.push(d)

  return (
    <div ref={rootRef} className="relative flex flex-wrap items-center gap-1">
      {label && (
        <span className="mr-1 inline-flex items-center gap-1 text-label uppercase text-muted">
          <Calendar className="h-3 w-3" aria-hidden="true" />
          {label}
        </span>
      )}

      <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
        {PRESETS.map((p) => (
          <button key={p.v} type="button" onClick={() => pickPreset(p.v)} className={chipCls(value.mode === p.v)}>
            {p.l}
          </button>
        ))}
        <button
          type="button"
          onClick={openCustom}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`inline-flex items-center gap-1.5 ${chipCls(isCustom)}`}
        >
          <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
          {isCustom ? `${fmtChip(value.start)} – ${fmtChip(value.end)}` : 'Custom'}
          <ChevronDown className={`h-3.5 w-3.5 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="Pick a date range"
          className="absolute left-0 top-full z-palette mt-2 w-[272px] rounded-xl border border-border bg-surface p-3 shadow-raised"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <div className="text-caption font-semibold text-fg">
              {CAL_MONTHS[view.m]} {view.y}
            </div>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-0.5">
            {CAL_WEEKDAYS.map((w) => (
              <div key={w} className="text-center text-label font-semibold uppercase text-muted">
                {w}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5" onMouseLeave={() => setHoverDay(null)}>
            {cells.map((d, i) => {
              if (d === null) return <div key={i} />
              const cur = ymd(view.y, view.m, d)
              // Mid-selection: preview pendingStart → hovered day.
              let lo = value.start
              let hi = value.end
              if (pendingStart) {
                const h = hoverDay ? ymd(view.y, view.m, hoverDay) : pendingStart
                ;[lo, hi] = pendingStart <= h ? [pendingStart, h] : [h, pendingStart]
              }
              const inRange = isCustom && lo && hi && cur >= lo && cur <= hi
              const isEdge = isCustom && (cur === lo || cur === hi)
              const isToday = cur === today
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => pickDay(d)}
                  onMouseEnter={() => setHoverDay(d)}
                  className={`h-8 rounded-md text-caption tabular-nums transition-colors ${
                    isEdge
                      ? 'bg-brand font-semibold text-brand-fg'
                      : inRange
                        ? 'bg-brand-soft text-brand'
                        : isToday
                          ? 'text-fg ring-1 ring-inset ring-border hover:bg-surface-2'
                          : 'text-fg hover:bg-surface-2'
                  }`}
                >
                  {d}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default DateRangePicker
