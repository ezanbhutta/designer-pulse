/**
 * Detailed per-designer PDF report (spec §13.2, §15, §22.9). Styled to match
 * the CSR Pulse house look: deep-ink display numbers, restrained violet accent,
 * tiny spaced eyebrows over bold titles, borderless KPI cards, coloured bars,
 * and tight detail rows. Hand-drawn with jsPDF primitives (no autotable). All
 * timestamps render PKT (§22.2); the report never calculates pay (§22.10).
 *
 * `renderReport(doc, args, logoPng)` is a pure drawing pass — no DOM — so it can
 * be exercised headlessly. `generateWeeklyReportPdf` rasterises the brand mark
 * (browser only) and downloads.
 */

import jsPDF from 'jspdf'
import { BRAND_MARK_PATH, BRAND_VIOLET } from '../components/ui/BrandLogo'
import { fmtClock } from './format'
import type { DesignerPeriodSummary, DesignerTimekeeping, ProjectLine } from '../../shared/aggregate'
import type { Designer, DayNote, Team } from '../../shared/types'
import { STATUS_LABELS, STATUS_TONES, type CanonicalStatus } from '../../shared/statuses'

// ── Args ──────────────────────────────────────────────────────────────────────

export interface WeeklyReportArgs {
  period: { start: string; end: string } // PKT dates, inclusive
  generatedAt: string // ISO instant the report was built
  rows: DesignerPeriodSummary[]
  designers: Designer[]
  projectsByDesigner: Record<string, ProjectLine[]>
  timekeepingByDesigner: Record<string, DesignerTimekeeping | undefined>
  notes: DayNote[]
}

// ── Palette (CSR Pulse constants) ─────────────────────────────────────────────

type RGB = [number, number, number]
const VIOLET: RGB = [114, 41, 255]
const INK: RGB = [22, 10, 51]
const BODY: RGB = [60, 50, 100]
const MUTED: RGB = [120, 110, 155]
const DIM: RGB = [170, 162, 200]
const HAIRLINE: RGB = [231, 227, 241]
const CARD_BRD: RGB = [231, 227, 241]
const TOTAL_BRD: RGB = [218, 211, 236]
const WASH: RGB = [251, 250, 254]
const WHITE: RGB = [255, 255, 255]
const MINT: RGB = [16, 185, 129]
const AMBER: RGB = [245, 158, 11]
const CYAN: RGB = [14, 165, 233]
const ROSE: RGB = [244, 63, 94]

const TEAM_ORDER: Team[] = ['Logo', 'Branding', 'Animation', 'PPT', 'Canva']
const TEAM_COLOR: Record<Team, RGB> = {
  Logo: VIOLET,
  Branding: AMBER,
  Animation: CYAN,
  PPT: MINT,
  Canva: ROSE,
}
const TEAM_LABEL: Record<Team, string> = {
  Logo: 'Logo',
  Branding: 'Branding',
  Animation: 'Animation',
  PPT: 'Slides',
  Canva: 'Canva',
}

// ── Geometry (A4 portrait, mm) ────────────────────────────────────────────────

const W = 210
const H = 297
const M = 16
const CW = W - M * 2
const PAGE_BOTTOM = 272

// ── Text formatting (all PKT) ─────────────────────────────────────────────────

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Karachi' })
const dayYearFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Karachi',
})

const asDate = (iso: string): Date =>
  iso.length === 10 ? new Date(`${iso}T00:00:00+05:00`) : new Date(iso)

const fmtDay = (iso: string | null | undefined): string => (iso ? dayFmt.format(asDate(iso)) : '—')
const fmtDayYear = (iso: string | null | undefined): string =>
  iso ? dayYearFmt.format(asDate(iso)) : '—'
const fmtDayTime = (iso: string | null | undefined): string =>
  iso ? `${fmtDay(iso)}, ${fmtClock(iso)}` : 'not sent yet'

/** Durations in full words, no machine short forms and no "and" (keeps table cells tight). */
function dur(min: number | null | undefined): string {
  if (min == null) return '—'
  const m = Math.max(0, Math.round(min))
  const u = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (m < 60) return u(m, 'minute')
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (m < 1440) return rem ? `${u(h, 'hour')} ${u(rem, 'minute')}` : u(h, 'hour')
  const d = Math.floor(m / 1440)
  const hh = Math.round((m % 1440) / 60)
  return hh ? `${u(d, 'day')} ${u(hh, 'hour')}` : u(d, 'day')
}

const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] ?? name
const pct = (v: number | null): string => (v == null ? '—' : `${v}%`)

const statusColor = (s: CanonicalStatus | null): RGB => {
  if (!s) return DIM
  switch (STATUS_TONES[s]) {
    case 'success':
      return MINT
    case 'waiting':
      return CYAN
    case 'warning':
      return AMBER
    case 'danger':
      return ROSE
    default:
      return BODY
  }
}

// ── Pure drawing pass ─────────────────────────────────────────────────────────

export function renderReport(doc: jsPDF, args: WeeklyReportArgs, logoPng: string | null): void {
  const { period, generatedAt, rows, designers, projectsByDesigner, timekeepingByDesigner, notes } = args
  const byId = new Map(designers.map((d) => [d.id, d]))

  const setFill = (c: RGB) => doc.setFillColor(c[0], c[1], c[2])
  const setText = (c: RGB) => doc.setTextColor(c[0], c[1], c[2])
  const setDraw = (c: RGB) => doc.setDrawColor(c[0], c[1], c[2])

  const hairline = (y: number, x1 = M, x2 = W - M) => {
    setDraw(HAIRLINE)
    doc.setLineWidth(0.3)
    doc.line(x1, y, x2, y)
  }

  const eyebrow = (text: string, x: number, y: number, align: 'left' | 'right' = 'left') => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    setText(MUTED)
    doc.setCharSpace(0.5)
    const up = text.toUpperCase()
    if (align === 'right') {
      const wdt = doc.getTextWidth(up) + (up.length - 1) * 0.5
      doc.text(up, x - wdt, y)
    } else {
      doc.text(up, x, y)
    }
    doc.setCharSpace(0)
  }

  const period_ = `${fmtDay(period.start)} to ${fmtDayYear(period.end)}`
  const prepared = `Prepared ${fmtDayYear(generatedAt)}, ${fmtClock(generatedAt)} Pakistan time`

  // ── Value with a small grey suffix ("4" + " of 5") ──
  const valueSmall = (
    x: number,
    y: number,
    value: string,
    small: string | null,
    color: RGB,
    size = 13.5,
  ) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(size)
    setText(color)
    doc.text(value, x, y)
    if (small) {
      const wv = doc.getTextWidth(value)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      setText(DIM)
      doc.text(` ${small}`, x + wv, y)
    }
  }

  // ── One borderless-ish KPI card ──
  const CARD_H = 27
  const GAP = 4
  const cardW = (CW - GAP * 3) / 4

  const drawCard = (
    x: number,
    y: number,
    o: {
      label: string
      value: string
      small?: string | null
      caption: string
      valueColor?: RGB
      accent?: boolean
      total?: boolean
    },
  ) => {
    const h = o.total ? 30 : CARD_H
    setFill(o.total ? WHITE : WASH)
    setDraw(o.total ? TOTAL_BRD : CARD_BRD)
    doc.setLineWidth(o.total ? 0.4 : 0.3)
    doc.roundedRect(x, y, cardW, h, 2.5, 2.5, 'FD')
    if (o.accent) {
      setDraw(VIOLET)
      doc.setLineWidth(1)
      doc.line(x + 3, y + 1.1, x + cardW - 3, y + 1.1)
    }
    // label (up to two lines)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6.1)
    setText(MUTED)
    doc.setCharSpace(0.25)
    const labelLines = (doc.splitTextToSize(o.label.toUpperCase(), cardW - 7) as string[]).slice(0, 2)
    labelLines.forEach((ln, i) => doc.text(ln, x + 4, y + 6 + i * 2.9))
    doc.setCharSpace(0)
    // value
    if (o.total) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10.5)
      setText(o.valueColor ?? INK)
      const vlines = (doc.splitTextToSize(o.value, cardW - 8) as string[]).slice(0, 2)
      vlines.forEach((ln, i) => doc.text(ln, x + 4, y + 15 + i * 4.4))
    } else {
      valueSmall(x + 4, y + 15.5, o.value, o.small ?? null, o.valueColor ?? INK)
    }
    // caption pinned near the bottom
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.3)
    setText(MUTED)
    const cap = (doc.splitTextToSize(o.caption, cardW - 7) as string[]).slice(0, 2)
    let cy = y + h - 3.5 - (cap.length - 1) * 3
    cap.forEach((ln) => {
      doc.text(ln, x + 4, cy)
      cy += 3
    })
  }

  // ── Footers drawn last (need the final page count) ──
  const drawFooters = () => {
    const pages = doc.getNumberOfPages()
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p)
      hairline(H - 16)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(6.5)
      setText(DIM)
      doc.text('Studio Pulse, HaseebMadeIt, Confidential', M, H - 12)
      doc.text(prepared, W / 2, H - 12, { align: 'center' })
      doc.text(`Page ${p} of ${pages}`, W - M, H - 12, { align: 'right' })
    }
  }

  const runningHeader = (rightText: string) => {
    if (logoPng) doc.addImage(logoPng, 'PNG', M, 13, 6, 6)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    setText(INK)
    doc.setCharSpace(0.7)
    doc.text('STUDIO PULSE', M + 8.5, 17.4)
    doc.setCharSpace(0)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    setText(MUTED)
    doc.text(rightText, W - M, 17.4, { align: 'right' })
    hairline(21)
  }

  // ═══════════════════════ PAGE 1 — STUDIO OVERVIEW ═══════════════════════

  // Identity strip
  if (logoPng) doc.addImage(logoPng, 'PNG', M, 14, 10, 10)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  setText(INK)
  doc.text('Studio Pulse', M + 13, 19.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  setText(MUTED)
  doc.text('HaseebMadeIt, weekly team report', M + 13, 24)
  eyebrow(period.start === period.end ? 'One day' : 'Report period', W - M, 16.5, 'right')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  setText(INK)
  doc.text(period_, W - M, 21.5, { align: 'right' })
  hairline(30)

  // Studio totals
  const sum = (pick: (s: DesignerPeriodSummary) => number) => rows.reduce((a, r) => a + pick(r), 0)
  const completed = sum((s) => s.completed)
  const expected = sum((s) => s.expectedQuota)
  const assigned = sum((s) => s.assigned)
  const delivered = sum((s) => s.delivered)
  const clean = sum((s) => s.firstPassClean)
  const revisions = sum((s) => s.revisionRounds)
  const csrCaught = sum((s) => s.csrCaughtRounds)
  const clientCaught = sum((s) => s.clientCaughtRounds)
  const cancelled = sum((s) => s.cancelled)
  const studioAtt = expected > 0 ? Math.round((completed / expected) * 100) : null
  const studioFpq = delivered > 0 ? Math.round((clean / delivered) * 100) : null

  // Hero
  let y = 43
  eyebrow('Target met this week', M, y)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(46)
  setText(INK)
  doc.text(pct(studioAtt), M, y + 17)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  setText(BODY)
  doc.text(
    `The team delivered ${completed} of the ${expected} projects that were due this week, and ${cancelled} order${cancelled === 1 ? ' was' : 's were'} cancelled.`,
    M,
    y + 26,
    { maxWidth: CW - 20 },
  )
  hairline(y + 34)

  // "This week in short" cards
  y += 44
  eyebrow('This week in short', M, y)
  y += 5
  drawCard(M + 0 * (cardW + GAP), y, {
    label: 'Delivered',
    value: String(completed),
    small: `of ${assigned}`,
    caption: 'projects that were due',
  })
  drawCard(M + 1 * (cardW + GAP), y, {
    label: 'Right first time',
    value: pct(studioFpq),
    caption: `${clean} of ${delivered} with no changes`,
  })
  drawCard(M + 2 * (cardW + GAP), y, {
    label: 'Changes asked',
    value: String(revisions),
    caption: `${csrCaught} by our team, ${clientCaught} by clients`,
  })
  drawCard(M + 3 * (cardW + GAP), y, {
    label: 'Cancelled',
    value: String(cancelled),
    caption: cancelled > 0 ? 'lost to a design problem' : 'nothing lost this week',
    valueColor: cancelled > 0 ? ROSE : INK,
  })

  // "Where the work went" — team bars
  y += CARD_H + 12
  eyebrow('Where the work went', M, y)
  eyebrow('by team', W - M, y, 'right')
  y += 8
  const teamStats = TEAM_ORDER.map((team) => {
    const teamRows = rows.filter((r) => byId.get(r.designerId)?.team === team)
    return {
      team,
      designers: teamRows.length,
      delivered: teamRows.reduce((a, r) => a + r.completed, 0),
      due: teamRows.reduce((a, r) => a + r.expectedQuota, 0),
    }
  }).filter((t) => t.designers > 0)
  const maxDelivered = Math.max(1, ...teamStats.map((t) => t.delivered))
  const barX = M + 44
  const barRight = W - M - 46
  const barMaxW = barRight - barX
  teamStats.forEach((t, i) => {
    const ry = y + i * 13
    setFill(TEAM_COLOR[t.team])
    doc.circle(M + 1.6, ry + 3.2, 1.5, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10.5)
    setText(INK)
    doc.text(TEAM_LABEL[t.team], M + 5, ry + 4)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    setText(MUTED)
    doc.text(`${t.designers} designer${t.designers === 1 ? '' : 's'}`, M + 5, ry + 8)
    // track + fill
    setFill(HAIRLINE)
    doc.roundedRect(barX, ry + 1.6, barMaxW, 2.6, 1.3, 1.3, 'F')
    if (t.delivered > 0) {
      setFill(TEAM_COLOR[t.team])
      doc.roundedRect(barX, ry + 1.6, barMaxW * (t.delivered / maxDelivered), 2.6, 1.3, 1.3, 'F')
    }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    setText(INK)
    doc.text(`${t.delivered} delivered`, W - M, ry + 3, { align: 'right' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    setText(MUTED)
    const metPct = t.due > 0 ? Math.round((t.delivered / t.due) * 100) : null
    doc.text(`${t.due} due${metPct != null ? `, ${metPct} percent met` : ''}`, W - M, ry + 7, {
      align: 'right',
    })
  })

  // ═══════════════════════ PAGE 2 — DESIGNER STANDINGS ═══════════════════════

  doc.addPage()
  runningHeader(`Last 7 days, ${period_}`)
  y = 30
  eyebrow('Everyone', M, y)
  eyebrow(`${rows.length} designer${rows.length === 1 ? '' : 's'}, the ones needing attention first`, W - M, y, 'right')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  setText(INK)
  doc.text('Designer standings', M, y + 8)
  y += 16

  // Column header
  const stand = { rank: M, name: M + 9, team: M + 62, delivered: M + 104, target: M + 128, rft: M + 152, late: M + 166, bar: M + 170 }
  const drawStandHead = () => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6.5)
    setText(MUTED)
    doc.setCharSpace(0.4)
    doc.text('#', stand.rank, y)
    doc.text('DESIGNER', stand.name, y)
    doc.text('TEAM', stand.team, y)
    doc.text('DELIVERED', stand.delivered, y, { align: 'right' })
    doc.text('TARGET MET', stand.target, y, { align: 'right' })
    doc.text('RIGHT FIRST', stand.rft, y, { align: 'right' })
    doc.text('LATE', stand.late, y, { align: 'right' })
    doc.setCharSpace(0)
    hairline(y + 2)
    y += 7
  }
  drawStandHead()

  const ranked = [...rows].sort((a, b) => (a.attainmentPct ?? Infinity) - (b.attainmentPct ?? Infinity))
  ranked.forEach((r, i) => {
    if (y + 9 > PAGE_BOTTOM) {
      doc.addPage()
      runningHeader(`Last 7 days, ${period_}`)
      y = 30
      drawStandHead()
    }
    const d = byId.get(r.designerId)
    const tk = timekeepingByDesigner[r.designerId]
    const lateDays = tk?.lateDays ?? 0
    // rank
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    setText(DIM)
    doc.text(String(i + 1).padStart(2, '0'), stand.rank, y + 3)
    // name
    setText(INK)
    doc.setFontSize(9.5)
    doc.text(d?.name ?? 'Unknown', stand.name, y + 3)
    // team
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    setText(MUTED)
    doc.text(d ? TEAM_LABEL[d.team] : '—', stand.team, y + 3)
    // delivered
    setText(BODY)
    doc.text(`${r.completed} of ${r.expectedQuota}`, stand.delivered, y + 3, { align: 'right' })
    // target met (coloured)
    const att = r.attainmentPct
    const attColor = att == null ? DIM : att < 60 ? ROSE : att < 85 ? AMBER : MINT
    doc.setFont('helvetica', 'bold')
    setText(attColor)
    doc.text(pct(att), stand.target, y + 3, { align: 'right' })
    // right first time
    doc.setFont('helvetica', 'normal')
    setText(BODY)
    doc.text(pct(r.firstPassQualityPct), stand.rft, y + 3, { align: 'right' })
    // late days
    setText(lateDays > 0 ? ROSE : BODY)
    if (lateDays > 0) doc.setFont('helvetica', 'bold')
    doc.text(String(lateDays), stand.late, y + 3, { align: 'right' })
    doc.setFont('helvetica', 'normal')
    // target-met mini bar
    const frac = att == null ? 0 : Math.max(0, Math.min(1, att / 100))
    setFill(HAIRLINE)
    doc.rect(stand.bar, y + 1.8, W - M - stand.bar, 1, 'F')
    if (frac > 0) {
      setFill(VIOLET)
      doc.rect(stand.bar, y + 1.8, (W - M - stand.bar) * frac, 1, 'F')
    }
    hairline(y + 6)
    y += 8.5
  })

  // Cross-team caveat
  y += 4
  const caveat =
    'A logo, a brand guide of twenty five pages and an animation all take very different amounts of work, so please never compare the raw delivered counts between teams. Target met is the one number that is fair to compare across teams.'
  const caveatLines = doc.splitTextToSize(caveat, CW - 12) as string[]
  const caveatH = caveatLines.length * 4.4 + 8
  setFill(WASH)
  setDraw(CARD_BRD)
  doc.setLineWidth(0.3)
  doc.roundedRect(M, y, CW, caveatH, 2.5, 2.5, 'FD')
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  setText(BODY)
  caveatLines.forEach((ln, i) => doc.text(ln, M + 6, y + 6.5 + i * 4.4))

  // Studio-wide notes (designer_id null)
  const studioNotes = notes.filter((n) => n.designer_id == null)
  if (studioNotes.length) {
    y += caveatH + 8
    drawNoteBox(studioNotes)
  }

  // ═══════════════════════ PER-DESIGNER PAGES ═══════════════════════

  for (const r of ranked) {
    const d = byId.get(r.designerId)
    if (!d) continue
    const lines = projectsByDesigner[r.designerId] ?? []
    const tk = timekeepingByDesigner[r.designerId]
    const first = firstNameOf(d.name)

    // ── Page A: the summary ──
    doc.addPage()
    runningHeader(`${d.name}, ${period_}`)
    y = 30
    // name + hero
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(24)
    setText(INK)
    doc.text(d.name, M, y + 6)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9.5)
    setText(MUTED)
    doc.text(`${TEAM_LABEL[d.team]} team`, M, y + 12)
    eyebrow('Target met', W - M, y, 'right')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(30)
    setText(INK)
    doc.text(pct(r.attainmentPct), W - M, y + 11, { align: 'right' })
    y += 18
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(11)
    setText(BODY)
    const cleanClause =
      r.delivered > 0
        ? `, and ${r.firstPassClean} of those ${r.firstPassClean === 1 ? 'was' : 'were'} accepted with no changes at all`
        : ''
    doc.text(
      `${first} delivered ${r.completed} of the ${r.assigned} project${r.assigned === 1 ? '' : 's'} that were due this week${cleanClause}.`,
      M,
      y + 6,
      { maxWidth: CW },
    )
    hairline(y + 14)

    const onTimeCount = lines.filter((l) => l.timing === 'on time' || l.timing === 'early').length
    const earlyCount = lines.filter((l) => l.timing === 'early').length
    const lateCount = lines.filter((l) => l.timing === 'late').length
    const openCount = lines.filter((l) => !l.delivered && l.status !== 'cancelled').length

    // What she delivered
    y += 22
    eyebrow('What she delivered', M, y)
    y += 5
    drawCard(M + 0 * (cardW + GAP), y, {
      label: 'Delivered',
      value: String(r.completed),
      small: `of ${r.assigned}`,
      caption: 'projects that were due',
    })
    drawCard(M + 1 * (cardW + GAP), y, {
      label: 'On time',
      value: String(onTimeCount),
      small: r.delivered > 0 ? `of ${r.delivered}` : null,
      caption: 'sent on or before the due date',
      valueColor: r.delivered > 0 && onTimeCount === r.delivered ? MINT : INK,
    })
    drawCard(M + 2 * (cardW + GAP), y, {
      label: 'Still open',
      value: String(openCount),
      caption: 'being worked on inside the shift',
    })
    drawCard(M + 3 * (cardW + GAP), y, {
      label: 'Cancelled',
      value: String(r.cancelled),
      caption: r.cancelled > 0 ? 'lost to a design problem' : 'nothing lost to a design problem',
      valueColor: r.cancelled > 0 ? ROSE : INK,
    })

    // Quality of the work
    y += CARD_H + 12
    eyebrow('Quality of the work', M, y)
    y += 5
    drawCard(M + 0 * (cardW + GAP), y, {
      label: 'Right first time',
      value: pct(r.firstPassQualityPct),
      caption: r.delivered > 0 ? `${r.firstPassClean} of ${r.delivered}, no changes` : 'nothing sent yet',
    })
    drawCard(M + 1 * (cardW + GAP), y, {
      label: 'Changes asked',
      value: String(r.revisionRounds),
      small: 'rounds',
      caption: 'across her delivered projects',
    })
    drawCard(M + 2 * (cardW + GAP), y, {
      label: 'Caught by our team',
      value: String(r.csrCaughtRounds),
      caption: 'before the client ever saw it',
    })
    drawCard(M + 3 * (cardW + GAP), y, {
      label: 'Asked by client',
      value: String(r.clientCaughtRounds),
      caption: 'changes the client requested',
    })

    // Time at work
    y += CARD_H + 12
    eyebrow('Time at work', M, y)
    y += 5
    if (tk) {
      drawCard(M + 0 * (cardW + GAP), y, {
        label: 'Days present',
        value: String(tk.presentDays),
        small: `of ${tk.scheduledDays}`,
        caption: 'the days she was scheduled',
      })
      drawCard(M + 1 * (cardW + GAP), y, {
        label: 'Arrived late',
        value: String(tk.lateDays),
        small: tk.lateDays === 1 ? 'day' : 'days',
        caption: tk.lateMinutes > 0 ? `${dur(tk.lateMinutes)} in total` : 'always on time',
        valueColor: tk.lateDays > 0 ? ROSE : INK,
      })
      drawCard(M + 2 * (cardW + GAP), y, {
        label: 'Left early',
        value: String(tk.earlyDays),
        small: tk.earlyDays === 1 ? 'day' : 'days',
        caption: tk.earlyMinutes > 0 ? `${dur(tk.earlyMinutes)} in total` : 'stayed the full shift',
      })
      const workedHours = Math.floor(tk.workedMinutes / 60)
      const workedRem = tk.workedMinutes % 60
      drawCard(M + 3 * (cardW + GAP), y, {
        label: 'Total worked',
        value: `${workedHours} hour${workedHours === 1 ? '' : 's'}`,
        small: workedRem > 0 ? `${workedRem} minutes` : null,
        caption: 'across the whole week',
      })
      y += CARD_H + 6
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      setText(MUTED)
      doc.text(
        `On leave ${tk.leaveDays} day${tk.leaveDays === 1 ? '' : 's'}. These hours are safe for HR to use for payroll. Studio Pulse only records the time, it does not calculate any pay.`,
        M,
        y,
        { maxWidth: CW },
      )
    } else {
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9)
      setText(MUTED)
      doc.text('Attendance was not recorded for this period.', M, y + 4)
    }

    // ── Page B: projects + total + note ──
    doc.addPage()
    runningHeader(`${d.name}, ${period_}`)
    y = 30
    eyebrow('Every project she was meant to deliver', M, y)
    eyebrow(`${lines.length} project${lines.length === 1 ? '' : 's'}`, W - M, y, 'right')
    y += 8

    // project table columns (right anchors for numeric, left for text)
    const col = { name: M, due: 62, sent: 92, ttf: 122, chg: 140, fix: 168, status: 171 }
    const drawProjHead = () => {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(5.6)
      setText(MUTED)
      doc.setCharSpace(0.3)
      doc.text('PROJECT', col.name, y)
      doc.text('DUE', col.due, y, { align: 'right' })
      doc.text('FIRST SENT', col.sent, y, { align: 'right' })
      doc.text('TIME TO FIRST', col.ttf, y, { align: 'right' })
      doc.text('CHANGES', col.chg, y, { align: 'right' })
      doc.text('FIX TIME', col.fix, y, { align: 'right' })
      doc.text('WHERE IT IS NOW', col.status, y)
      doc.setCharSpace(0)
      hairline(y + 2)
      y += 7
    }
    drawProjHead()

    if (lines.length === 0) {
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9)
      setText(MUTED)
      doc.text('No projects were due for her in this period.', col.name, y + 3)
      y += 8
    }
    for (const l of lines) {
      if (y + 11 > PAGE_BOTTOM) {
        doc.addPage()
        runningHeader(`${d.name}, ${period_}`)
        y = 30
        drawProjHead()
      }
      // name + priority
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8.5)
      setText(INK)
      doc.text((doc.splitTextToSize(l.name, col.due - col.name - 4) as string[])[0] ?? l.name, col.name, y + 3)
      if (l.priority) {
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(6.2)
        setText(DIM)
        doc.setCharSpace(0.3)
        doc.text(l.priority.toUpperCase(), col.name, y + 6.6)
        doc.setCharSpace(0)
      }
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      setText(BODY)
      doc.text(fmtDay(l.dueDate), col.due, y + 3, { align: 'right' })
      // first sent + timing
      if (l.firstDeliveredAt) {
        doc.text(fmtDayTime(l.firstDeliveredAt), col.sent, y + 3, { align: 'right' })
        const tColor = l.timing === 'late' ? ROSE : l.timing === 'early' ? MINT : MUTED
        setText(tColor)
        doc.setFontSize(6.4)
        doc.text(l.timing ?? '', col.sent, y + 6.6, { align: 'right' })
        doc.setFontSize(8)
      } else {
        setText(DIM)
        doc.text('not sent yet', col.sent, y + 3, { align: 'right' })
      }
      setText(l.productionMin == null ? DIM : BODY)
      doc.text(dur(l.productionMin), col.ttf, y + 3, { align: 'right' })
      setText(BODY)
      doc.text(l.delivered ? String(l.revisionRounds) : '—', col.chg, y + 3, { align: 'right' })
      setText(l.revisionTurnaroundMin == null ? DIM : BODY)
      doc.text(dur(l.revisionTurnaroundMin), col.fix, y + 3, { align: 'right' })
      // status
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
      setText(statusColor(l.status))
      const label = l.status ? STATUS_LABELS[l.status] : 'Unknown'
      doc.text(doc.splitTextToSize(label, W - M - col.status) as string[], col.status, y + 3)
      hairline(y + 8)
      y += 9.5
    }

    // The week added up — bold total blocks
    if (y + 52 > PAGE_BOTTOM) {
      doc.addPage()
      runningHeader(`${d.name}, ${period_}`)
      y = 30
    } else {
      y += 8
    }
    eyebrow('The week added up', M, y)
    y += 5
    const onTimeText =
      earlyCount > 0 && onTimeCount - earlyCount > 0
        ? `${onTimeCount - earlyCount} on time, ${earlyCount} early`
        : earlyCount > 0
          ? `${earlyCount} early`
          : `${onTimeCount} on time`
    drawCard(M + 0 * (cardW + GAP), y, {
      total: true,
      accent: true,
      label: 'Delivered',
      value: `${r.completed} of ${r.assigned} due`,
      caption: openCount > 0 ? `${openCount} still being worked on` : 'all cleared',
    })
    drawCard(M + 1 * (cardW + GAP), y, {
      total: true,
      accent: true,
      label: 'Sent on time',
      value: onTimeText,
      caption: lateCount > 0 ? `${lateCount} delivered late` : 'none delivered late',
    })
    drawCard(M + 2 * (cardW + GAP), y, {
      total: true,
      accent: true,
      label: 'Usual time to first design',
      value: dur(r.productionMedianMin),
      caption: 'waiting on the client is not counted',
    })
    drawCard(M + 3 * (cardW + GAP), y, {
      total: true,
      accent: true,
      label: 'Usual time to fix changes',
      value: dur(r.revisionTurnaroundMedianMin),
      caption: `${r.revisionRounds} rounds in all, ${r.csrCaughtRounds} ours and ${r.clientCaughtRounds} client`,
    })
    y += 30 + 8

    // Per-designer notes
    const mine = notes.filter((n) => n.designer_id === d.id)
    if (mine.length) drawNoteBox(mine)
  }

  drawFooters()

  // ── Note box (used for studio + per-designer notes) ──
  function drawNoteBox(items: DayNote[]): void {
    const lineWidth = CW - 14
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    const blocks = items.map((n) => ({
      when: `Note, ${fmtDay(n.the_date)}`,
      body: doc.splitTextToSize(n.note, lineWidth) as string[],
    }))
    const boxH = blocks.reduce((a, b) => a + 5 + b.body.length * 4.2 + 4, 8)
    if (y + boxH > PAGE_BOTTOM) {
      doc.addPage()
      runningHeader(`Notes, ${period_}`)
      y = 30
    }
    setFill(WASH)
    setDraw(CARD_BRD)
    doc.setLineWidth(0.3)
    doc.roundedRect(M, y, CW, boxH, 2.5, 2.5, 'FD')
    setFill(VIOLET)
    doc.rect(M, y + 1.5, 1.2, boxH - 3, 'F')
    let ny = y + 7
    for (const b of blocks) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(6.8)
      setText(VIOLET)
      doc.setCharSpace(0.4)
      doc.text(b.when.toUpperCase(), M + 6, ny)
      doc.setCharSpace(0)
      ny += 4.5
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      setText(BODY)
      b.body.forEach((ln) => {
        doc.text(ln, M + 6, ny)
        ny += 4.2
      })
      ny += 4
    }
    y += boxH + 6
  }
}

// ── SVG → PNG for the brand mark (browser only) ───────────────────────────────

function renderBrandLogoPng(sizePx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 392.35 392.35"><rect width="392.35" height="392.35" rx="70" fill="${BRAND_VIOLET}"/><path fill="#FFFFFF" d="${BRAND_MARK_PATH}"/></svg>`
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = sizePx
        canvas.height = sizePx
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        ctx.drawImage(img, 0, 0, sizePx, sizePx)
        resolve(canvas.toDataURL('image/png'))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('logo render failed'))
    }
    img.src = url
  })
}

/** Builds and downloads the detailed weekly report. */
export async function generateWeeklyReportPdf(args: WeeklyReportArgs): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  let logoPng: string | null = null
  try {
    logoPng = await renderBrandLogoPng(256)
  } catch {
    logoPng = null
  }
  renderReport(doc, args, logoPng)
  doc.save(`studio-pulse-report-${args.period.start}.pdf`)
}

export default generateWeeklyReportPdf
