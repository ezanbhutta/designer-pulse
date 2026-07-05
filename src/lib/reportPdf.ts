/**
 * Weekly per-designer PDF report (spec §13.2, §15, §22.9) — the pre-built
 * Monday review. Hand-drawn A4 table via jsPDF primitives (setFontSize /
 * text / line) — no autotable plugin. All timestamps rendered PKT (§22.2).
 *
 * Cross-team caveat (§2): capacity units differ by discipline, so the footer
 * states on every page that only Attainment % compares across teams.
 */

import jsPDF from 'jspdf'
import { BRAND_MARK_PATH, BRAND_VIOLET } from '../components/ui/BrandLogo'
import { fmtDuration } from './format'
import type { DesignerPeriodSummary } from '../../shared/aggregate'
import type { Designer, Team } from '../../shared/types'

export interface WeeklyReportArgs {
  period: { start: string; end: string } // PKT dates, inclusive
  teamName?: string
  rows: DesignerPeriodSummary[]
  designers: Designer[]
  /** Optional free-text context typed on the Reports page — printed as a Notes
   *  section so the reason behind the numbers (e.g. a workload agreement with a
   *  designer) travels with the report to whoever reads it. */
  notes?: string
}

// ── Layout constants (A4 portrait, mm) ────────────────────────────────────────

const PAGE_W = 210
const PAGE_H = 297
const MARGIN_X = 14
const CONTENT_RIGHT = PAGE_W - MARGIN_X
const BODY_BOTTOM = 272 // page-break line; footer lives below
const ROW_H = 7

/** Right-edge x for each numeric column; Designer name is left-aligned. */
const COL = {
  name: MARGIN_X,
  attainment: 96,
  quality: 138,
  production: 160,
  revisions: 176,
  cancelled: CONTENT_RIGHT,
} as const

// PDF drawing needs literal RGB — these mirror the app's light-theme ink
// tokens (deep ink #160A33, muted #534A78) so print matches product.
const INK: [number, number, number] = [22, 10, 51]
const MUTED: [number, number, number] = [83, 74, 120]
const HAIRLINE: [number, number, number] = [200, 195, 216]

const TEAM_ORDER: Team[] = ['Logo', 'Branding', 'Animation', 'PPT', 'Canva']

// ── Formatting ────────────────────────────────────────────────────────────────

const pdfDate = (dateStr: string, withYear = false): string =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'Asia/Karachi',
  }).format(new Date(`${dateStr}T00:00:00+05:00`))

const pdfGeneratedAt = (now: Date): string =>
  `${new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Karachi',
  }).format(now)} Pakistan time`

const pct = (v: number | null): string => (v == null ? '—' : `${v}%`)

// ── Report ────────────────────────────────────────────────────────────────────

/**
 * Builds and downloads the weekly report: header (title, period, generated-at
 * PKT), one section per team, one row per designer (attainment %, first-pass
 * quality % with clean/delivered, production median, revision rounds,
 * cancellations), and the cross-team caveat in the footer of every page.
 */
export async function generateWeeklyReportPdf(args: WeeklyReportArgs): Promise<void> {
  const { period, teamName, rows, designers, notes } = args
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })

  const byId = new Map(designers.map((d) => [d.id, d]))
  const teams = TEAM_ORDER.filter((t) => !teamName || t === teamName)

  // The HaseebMadeIt mark, rendered once to a high-res PNG (jsPDF can't
  // rasterize SVG itself). A failed render falls back to the text-only
  // header rather than blocking the download.
  let logoPng: string | null = null
  try {
    logoPng = await renderBrandLogoPng(256)
  } catch {
    logoPng = null
  }

  let y = drawHeader(doc, period, teamName, logoPng)

  if (notes && notes.trim()) y = drawNotes(doc, notes.trim(), y)

  for (const team of teams) {
    const teamRows = rows
      .filter((r) => byId.get(r.designerId)?.team === team)
      // Worst-first (§20.4): lowest attainment leads the review; no-quota rows last.
      .sort((a, b) => (a.attainmentPct ?? Infinity) - (b.attainmentPct ?? Infinity))
    if (teamRows.length === 0) continue

    y = ensureRoom(doc, y, ROW_H * 3 + 14)
    y = drawTeamHeader(doc, team, teamRows, y)
    y = drawColumnHeader(doc, y)

    for (const r of teamRows) {
      y = ensureRoom(doc, y, ROW_H, () => drawColumnHeader(doc, drawContinuedNote(doc, team)))
      y = drawDesignerRow(doc, r, byId.get(r.designerId)?.name ?? 'Unknown designer', y)
    }
    y += 4
  }

  if (rows.length === 0) {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(10)
    doc.setTextColor(...MUTED)
    doc.text('No designer work was recorded for this week.', MARGIN_X, y + 6)
  }

  drawFooters(doc)
  doc.save(`studio-pulse-week-${period.start}.pdf`)
}

// ── Sections ──────────────────────────────────────────────────────────────────

/** SVG → PNG data-url via canvas, so the brand mark prints in the PDF header. */
function renderBrandLogoPng(sizePx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 392.35 392.35"><rect width="392.35" height="392.35" rx="60" fill="${BRAND_VIOLET}"/><path fill="#FFFFFF" d="${BRAND_MARK_PATH}"/></svg>`
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

function drawHeader(
  doc: jsPDF,
  period: { start: string; end: string },
  teamName?: string,
  logoPng?: string | null,
): number {
  let titleX = MARGIN_X
  if (logoPng) {
    doc.addImage(logoPng, 'PNG', MARGIN_X, 13.5, 8, 8)
    titleX = MARGIN_X + 11
  }
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(...INK)
  doc.text('Studio Pulse Weekly Designer Report', titleX, 20)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...MUTED)
  const periodLabel = `Week of ${pdfDate(period.start)} to ${pdfDate(period.end, true)}, Pakistan time`
  doc.text(teamName ? `${periodLabel} · ${teamName} team` : periodLabel, MARGIN_X, 27)
  doc.text(`Generated ${pdfGeneratedAt(new Date())}`, CONTENT_RIGHT, 27, { align: 'right' })

  doc.setDrawColor(...HAIRLINE)
  doc.setLineWidth(0.3)
  doc.line(MARGIN_X, 31, CONTENT_RIGHT, 31)

  // Printed legend — the PDF has no hover tips, so the two key measures are
  // explained in one sentence each, right under the header.
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text(
    '"Target met" = out of the projects they were supposed to take, how many they finished.',
    MARGIN_X,
    36,
  )
  doc.text(
    '"Right first time" = designs accepted without anyone asking for changes; higher is better.',
    MARGIN_X,
    40,
  )
  return 47
}

/** A soft violet panel of free-text context, printed under the header. */
function drawNotes(doc: jsPDF, notes: string, y: number): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text('NOTES', MARGIN_X, y)
  y += 3

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  const innerW = CONTENT_RIGHT - MARGIN_X - 6
  const lines = doc.splitTextToSize(notes, innerW) as string[]
  const lineH = 4.8
  const boxH = lines.length * lineH + 5

  doc.setFillColor(245, 241, 253) // faint brand tint
  doc.setDrawColor(...HAIRLINE)
  doc.setLineWidth(0.2)
  doc.roundedRect(MARGIN_X, y, CONTENT_RIGHT - MARGIN_X, boxH, 1.5, 1.5, 'FD')

  doc.setTextColor(...INK)
  let ty = y + 5
  for (const line of lines) {
    doc.text(line, MARGIN_X + 3, ty)
    ty += lineH
  }
  return y + boxH + 7
}

function drawTeamHeader(doc: jsPDF, team: Team, teamRows: DesignerPeriodSummary[], y: number): number {
  const completed = teamRows.reduce((s, r) => s + r.completed, 0)
  const delivered = teamRows.reduce((s, r) => s + r.delivered, 0)
  const clean = teamRows.reduce((s, r) => s + r.firstPassClean, 0)
  const teamFpq = delivered > 0 ? Math.round((clean / delivered) * 100) : null

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(...INK)
  doc.text(`${team} team`, MARGIN_X, y)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text(
    `${teamRows.length} designer${teamRows.length === 1 ? '' : 's'} · ${completed} finished · right first time ${pct(teamFpq)}`,
    CONTENT_RIGHT,
    y,
    { align: 'right' },
  )
  return y + 5
}

function drawColumnHeader(doc: jsPDF, y: number): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text('DESIGNER', COL.name, y)
  doc.text('TARGET MET', COL.attainment, y, { align: 'right' })
  doc.text('RIGHT FIRST TIME', COL.quality, y, { align: 'right' })
  doc.text('WORK TIME', COL.production, y, { align: 'right' })
  doc.text('CHANGES', COL.revisions, y, { align: 'right' })
  doc.text('CANCELLED', COL.cancelled, y, { align: 'right' })
  doc.setDrawColor(...HAIRLINE)
  doc.setLineWidth(0.2)
  doc.line(MARGIN_X, y + 1.5, CONTENT_RIGHT, y + 1.5)
  return y + 6
}

function drawDesignerRow(doc: jsPDF, r: DesignerPeriodSummary, name: string, y: number): number {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(...INK)
  doc.text(doc.splitTextToSize(name, 68)[0] as string, COL.name, y)

  const attainment =
    r.attainmentPct == null ? '—' : `${r.attainmentPct}%  (${r.completed} of ${r.expectedQuota})`
  const quality =
    r.firstPassQualityPct == null
      ? '—'
      : `${r.firstPassQualityPct}%  (${r.firstPassClean} of ${r.delivered})`

  doc.text(attainment, COL.attainment, y, { align: 'right' })
  doc.text(quality, COL.quality, y, { align: 'right' })
  doc.text(fmtDuration(r.productionMedianMin), COL.production, y, { align: 'right' })
  doc.text(String(r.revisionRounds), COL.revisions, y, { align: 'right' })
  if (r.cancelled > 0) doc.setTextColor(190, 32, 32) // danger ink: cancellations must pop in print too
  doc.text(String(r.cancelled), COL.cancelled, y, { align: 'right' })
  doc.setTextColor(...INK)

  doc.setDrawColor(...HAIRLINE)
  doc.setLineWidth(0.1)
  doc.line(MARGIN_X, y + 2, CONTENT_RIGHT, y + 2)
  return y + ROW_H
}

function drawContinuedNote(doc: jsPDF, team: Team): number {
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text(`${team} team (continued)`, MARGIN_X, 20)
  return 26
}

/** Page-break guard: adds a page (and optional redraw, e.g. column header) when needed. */
function ensureRoom(doc: jsPDF, y: number, needed: number, onNewPage?: () => number): number {
  if (y + needed <= BODY_BOTTOM) return y
  doc.addPage()
  return onNewPage ? onNewPage() : 20
}

function drawFooters(doc: jsPDF): void {
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setDrawColor(...HAIRLINE)
    doc.setLineWidth(0.2)
    doc.line(MARGIN_X, PAGE_H - 16, CONTENT_RIGHT, PAGE_H - 16)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text('Only "Target met" is fair to compare across different teams', MARGIN_X, PAGE_H - 11)
    doc.text(`Page ${i} of ${pages}`, CONTENT_RIGHT, PAGE_H - 11, { align: 'right' })
  }
}

export default generateWeeklyReportPdf
