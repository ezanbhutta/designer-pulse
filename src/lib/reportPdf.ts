/**
 * The weekly studio report, exported as a premium editorial PDF (spec §13.2,
 * §15, §22.9). Fraunces display serif over Inter, warm paper, hairline rules,
 * a cover page, a studio spread, designer standings, and a page-per-designer
 * with a project table, a dark total band, and any note from the week. The look
 * matches the approved mock one-to-one (mock pixels map to points at 0.75).
 *
 * `renderReport(doc, args, markPng)` is a pure drawing pass — no DOM — so it can
 * be exercised headlessly. `generateWeeklyReportPdf` rasterises the brand mark
 * (browser only) and downloads. All timestamps render PKT (§22.2); the report
 * never calculates pay (§22.10).
 */

import jsPDF from 'jspdf'
import { BRAND_MARK_PATH, BRAND_VIOLET } from '../components/ui/BrandLogo'
import { registerReportFonts, RF } from './reportFonts'
import { fmtClock } from './format'
import type { DesignerPeriodSummary, DesignerTimekeeping, ProjectLine } from '../../shared/aggregate'
import { isPerProject, type Designer, type DayNote, type Team } from '../../shared/types'
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

// ── Palette (from the approved premium mock) ──────────────────────────────────

type RGB = [number, number, number]
const PAPER: RGB = [247, 244, 239]
const INK: RGB = [28, 23, 38]
const SOFT: RGB = [65, 58, 79]
const MUTED: RGB = [106, 99, 119]
const FAINT: RGB = [168, 162, 180]
const HAIR: RGB = [228, 221, 209]
const LINE: RGB = [217, 208, 194]
const VIOLET: RGB = [106, 40, 230]
const VIOLETINK: RGB = [74, 28, 158]
const GOOD: RGB = [47, 122, 87]
const WARN: RGB = [176, 121, 28]
const BAD: RGB = [178, 58, 78]
const WHITE: RGB = [255, 255, 255]

const TEAM_ORDER: Team[] = ['Logo', 'Branding', 'Animation', 'PPT', 'Canva']
const TEAM_LABEL: Record<Team, string> = {
  Logo: 'Logo',
  Branding: 'Branding',
  Animation: 'Animation',
  PPT: 'Slides',
  Canva: 'Canva',
}

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

const fmtDay = (iso: string | null | undefined): string => (iso ? dayFmt.format(asDate(iso)) : 'not set')
const fmtDayYear = (iso: string | null | undefined): string =>
  iso ? dayYearFmt.format(asDate(iso)) : 'not set'
const fmtDayTime = (iso: string | null | undefined): string =>
  iso ? `${fmtDay(iso)}, ${fmtClock(iso)}` : 'not sent yet'

/** Durations in full words, no machine short forms and no "and" (keeps cells tight). */
function dur(min: number | null | undefined): string {
  if (min == null) return 'not yet'
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
const pct = (v: number | null): string => (v == null ? 'not set' : `${v}%`)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

const statusTone = (s: CanonicalStatus | null): RGB => {
  if (!s) return MUTED
  switch (STATUS_TONES[s]) {
    case 'success':
      return GOOD
    case 'waiting':
      return VIOLETINK
    case 'warning':
      return WARN
    case 'danger':
      return BAD
    default:
      return MUTED
  }
}

// ── Pure drawing pass ─────────────────────────────────────────────────────────

export function renderReport(doc: jsPDF, args: WeeklyReportArgs, markPng: string | null): void {
  registerReportFonts(doc)
  const { period, generatedAt, rows, designers, projectsByDesigner, timekeepingByDesigner, notes } = args
  const byId = new Map(designers.map((d) => [d.id, d]))

  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const PX = 66 // side margin (mock 88px)
  const CW = W - PX * 2

  // ── low-level helpers ──
  const fill = (c: RGB) => doc.setFillColor(c[0], c[1], c[2])
  const draw = (c: RGB) => doc.setDrawColor(c[0], c[1], c[2])
  const ink = (c: RGB) => doc.setTextColor(c[0], c[1], c[2])

  const rule = (x1: number, y: number, x2: number, c: RGB = HAIR, w = 0.6) => {
    draw(c)
    doc.setLineWidth(w)
    doc.line(x1, y, x2, y)
  }
  const vrule = (x: number, y1: number, y2: number, c: RGB = LINE, w = 0.5) => {
    draw(c)
    doc.setLineWidth(w)
    doc.line(x, y1, x, y2)
  }

  interface TextOpts {
    font?: string
    size?: number
    color?: RGB
    align?: 'left' | 'right' | 'center'
    spacing?: number
    upper?: boolean
    maxWidth?: number
  }
  const T = (str: string, x: number, y: number, o: TextOpts = {}) => {
    doc.setFont(o.font ?? RF.inter, 'normal')
    doc.setFontSize(o.size ?? 10)
    ink(o.color ?? INK)
    if (o.spacing) doc.setCharSpace(o.spacing)
    doc.text(o.upper ? str.toUpperCase() : str, x, y, {
      align: o.align ?? 'left',
      baseline: 'alphabetic',
      ...(o.maxWidth ? { maxWidth: o.maxWidth } : {}),
    })
    if (o.spacing) doc.setCharSpace(0)
  }

  /** Wrap text to a width, measuring in the SAME font/size it will be drawn in
   *  (splitTextToSize uses the doc's current font, so it must be set first). */
  const wrap = (str: string, width: number, font: string, size: number): string[] => {
    doc.setFont(font, 'normal')
    doc.setFontSize(size)
    return doc.splitTextToSize(str, width) as string[]
  }

  const paper = () => {
    fill(PAPER)
    doc.rect(0, 0, W, H, 'F')
  }
  const newPage = () => {
    doc.addPage()
    paper()
  }

  // ── the brand mark (violet, no box) — image if provided, else vector bars ──
  const mark = (x: number, y: number, h: number) => {
    if (markPng) {
      doc.addImage(markPng, 'PNG', x, y, h * (138 / 172), h)
      return
    }
    // Fallback pulse glyph: five rounded violet bars at varying heights.
    fill(VIOLET)
    const bw = h * 0.15
    const gap = h * 0.06
    const heights = [0.5, 0.78, 1, 0.62, 0.86]
    heights.forEach((hh, i) => {
      const bh = h * hh
      doc.roundedRect(x + i * (bw + gap), y + (h - bh) / 2, bw, bh, bw * 0.35, bw * 0.35, 'F')
    })
  }

  const period_ = period.start === period.end ? fmtDayYear(period.end) : `${fmtDay(period.start)} to ${fmtDayYear(period.end)}`
  const prepared = `Prepared ${fmtDayYear(generatedAt)}, ${fmtClock(generatedAt)} Pakistan time`

  // ── studio totals ──
  // The studio spread and team bars measure the SALARIED team against its
  // target; per project designers carry no target, so counting their delivered
  // work here (numerator) while their zero target sits out of the denominator
  // would over-read every percentage. They keep their standings line and their
  // own page — the studio rollups stay salaried-only. With no per project
  // designers present these totals are identical to before.
  const studioRows = rows.filter((r) => !isPerProject(byId.get(r.designerId)))
  const sum = (pick: (s: DesignerPeriodSummary) => number) =>
    studioRows.reduce((a, r) => a + pick(r), 0)
  const completed = sum((s) => s.completed)
  const expected = sum((s) => s.expectedQuota)
  const assigned = sum((s) => s.assigned)
  const delivered = sum((s) => s.delivered)
  const clean = sum((s) => s.firstPassClean)
  const revisions = sum((s) => s.revisionRounds)
  const clientCaught = sum((s) => s.clientCaughtRounds)
  const cancelled = sum((s) => s.cancelled)
  const studioAtt = expected > 0 ? Math.round((completed / expected) * 100) : null
  const studioFpq = delivered > 0 ? Math.round((clean / delivered) * 100) : null
  const teamCount = new Set(studioRows.map((r) => byId.get(r.designerId)?.team).filter(Boolean)).size

  const ranked = [...rows].sort((a, b) => (a.attainmentPct ?? Infinity) - (b.attainmentPct ?? Infinity))

  // ── shared: running head ──
  const runHead = (right: string) => {
    T('Studio Pulse, Weekly Review', PX, 44, { font: RF.interSemi, size: 7.5, color: MUTED, spacing: 1.1, upper: true })
    T(right, W - PX, 44, { font: RF.inter, size: 8.2, color: FAINT, align: 'right' })
  }

  // ── shared: section head "01  Title ............ meta" ──
  const sectionHead = (no: string, title: string, meta: string, y: number, titleSize = 23) => {
    T(no, PX, y, { font: RF.frauncesReg, size: 25, color: FAINT })
    T(title, PX + 40, y, { font: RF.frauncesSemi, size: titleSize, color: INK })
    if (meta) T(meta, W - PX, y - 5, { font: RF.inter, size: 8.6, color: MUTED, align: 'right' })
  }

  const groupLabel = (str: string, x: number, y: number, align: 'left' | 'right' = 'left') =>
    T(str, x, y, { font: RF.interSemi, size: 7.5, color: VIOLETINK, spacing: 1.3, upper: true, align })

  // ── shared: a stat line (top ink rule, equal cells, separators) ──
  interface Cell {
    label: string
    value: string
    small?: string | null
    valueColor?: RGB
    caption: string
  }
  const statLine = (y: number, cells: Cell[], opt: { valueSize?: number; cellH?: number } = {}) => {
    const cellH = opt.cellH ?? 62
    const vSize = opt.valueSize ?? 23
    const n = cells.length
    const cw = CW / n
    rule(PX, y, W - PX, INK, 1.1)
    const valueBaseY = y + 24 + vSize * 0.72 // clear the label above, scale with value size
    cells.forEach((c, i) => {
      const cx = PX + i * cw
      const tx = cx + (i === 0 ? 0 : 14)
      if (i > 0) vrule(cx, y + 6, y + cellH - 6, LINE, 0.5)
      T(c.label, tx, y + 18, { font: RF.interSemi, size: 7.2, color: MUTED, spacing: 0.7, upper: true })
      // value + small suffix
      doc.setFont(RF.frauncesSemi, 'normal')
      doc.setFontSize(vSize)
      ink(c.valueColor ?? INK)
      doc.text(c.value, tx, valueBaseY, { baseline: 'alphabetic' })
      if (c.small) {
        const vw = doc.getTextWidth(c.value)
        T(` ${c.small}`, tx + vw, valueBaseY, { font: RF.frauncesReg, size: vSize * 0.5, color: FAINT })
      }
      // caption pinned to the bottom of the cell
      const capLines = wrap(c.caption, cw - 16, RF.inter, 7.4).slice(0, 2)
      capLines.forEach((ln, li) =>
        T(ln, tx, y + cellH - 6 - (capLines.length - 1 - li) * 9, { font: RF.inter, size: 7.4, color: MUTED }),
      )
    })
  }

  // ── shared: note block (violet bar + serif quote) ──
  const noteBlock = (y: number, items: DayNote[]): number => {
    if (!items.length) return y
    const barX = PX
    const textX = PX + 16
    const wrapW = CW - 16
    let ny = y + 12
    T('A note from the week', textX, ny, { font: RF.interSemi, size: 7.4, color: VIOLETINK, spacing: 1.1, upper: true })
    ny += 8
    for (const nItem of items) {
      const lines = wrap(nItem.note, wrapW, RF.frauncesReg, 12.5)
      lines.forEach((ln) => {
        T(ln, textX, ny + 10, { font: RF.frauncesReg, size: 12.5, color: SOFT })
        ny += 18
      })
      ny += 6
    }
    fill(VIOLET)
    doc.rect(barX, y + 2, 2.2, ny - y - 8, 'F')
    return ny
  }

  // ── shared: footer on every page (drawn last for the page count) ──
  const drawFooters = () => {
    const pages = doc.getNumberOfPages()
    // Page 1 (the cover) carries its own bespoke foot; the rest get the running one.
    for (let p = 2; p <= pages; p++) {
      doc.setPage(p)
      rule(PX, H - 40, W - PX, HAIR, 0.6)
      T('Studio Pulse, HaseebMadeIt', PX, H - 28, { font: RF.inter, size: 7.4, color: FAINT })
      T('Private and confidential', W / 2, H - 28, { font: RF.inter, size: 7.4, color: FAINT, align: 'center' })
      T(`${p} of ${pages}`, W - PX, H - 28, { font: RF.inter, size: 7.4, color: FAINT, align: 'right' })
    }
  }

  // ════════════════════════ COVER ════════════════════════
  paper()
  {
    // top bar
    mark(PX, 58, 28)
    T('Studio Pulse', PX + 30, 78, { font: RF.interSemi, size: 8, color: INK, spacing: 1.6, upper: true })
    T('HaseebMadeIt', W - PX, 78, { font: RF.interSemi, size: 8, color: MUTED, spacing: 1.6, upper: true, align: 'right' })

    // title block
    T('Weekly performance review', PX, 322, { font: RF.interSemi, size: 8.6, color: VIOLETINK, spacing: 2.1, upper: true })
    T('The Week', PX - 3, 398, { font: RF.frauncesBlack, size: 78, color: INK })
    T('in Review', PX - 3, 470, { font: RF.frauncesReg, size: 78, color: INK })
    const subLines = wrap(
      `The design studio's week, measured with care. ${period_}, Pakistan time.`,
      CW * 0.66,
      RF.inter,
      12,
    )
    subLines.forEach((ln, i) => T(ln, PX, 512 + i * 18, { font: RF.inter, size: 12, color: SOFT }))

    // hero: big attainment + stat lines
    const heroY = 640
    doc.setFont(RF.frauncesBlack, 'normal')
    doc.setFontSize(99)
    ink(INK)
    const numStr = studioAtt == null ? 'not set' : String(studioAtt)
    doc.text(numStr, PX, heroY)
    const nw = doc.getTextWidth(numStr)
    if (studioAtt != null) T('%', PX + nw + 4, heroY, { font: RF.frauncesBlack, size: 39, color: INK })
    // Caption sits BELOW the number, so it can never run into the stat block on
    // the right whatever the number's width (a three digit 100 is much wider
    // than a two digit one).
    const capLines = wrap('of the studio target was met this week', 200, RF.inter, 9.5)
    capLines.forEach((ln, i) => T(ln, PX, heroY + 22 + i * 13, { font: RF.inter, size: 9.5, color: MUTED }))

    // right-side stat rows
    const stats: Array<[string, string, RGB]> = [
      ['Projects delivered', `${completed} of ${expected}`, INK],
      ['Right the first time', pct(studioFpq), INK],
      ['Orders cancelled', String(cancelled), cancelled > 0 ? BAD : INK],
    ]
    const sx = W - PX
    const sLeft = W - PX - 210
    let sy = heroY - 70
    rule(sLeft, sy, sx, HAIR, 0.6)
    stats.forEach(([l, v, c]) => {
      T(l, sLeft, sy + 17, { font: RF.inter, size: 9, color: MUTED })
      T(v, sx, sy + 17, { font: RF.frauncesSemi, size: 14, color: c, align: 'right' })
      sy += 26
      rule(sLeft, sy, sx, HAIR, 0.6)
    })

    // foot
    T(prepared, PX, H - 40, { font: RF.inter, size: 8, color: FAINT })
    T('Private and confidential', W - PX, H - 40, { font: RF.inter, size: 8, color: FAINT, align: 'right' })
  }

  // ════════════════════════ 01 — THE STUDIO ════════════════════════
  newPage()
  runHead(period_)
  {
    sectionHead('01', 'The studio this week', `${plural(studioRows.length, 'designer')}, ${plural(teamCount, 'team')}`, 108)

    // KPI row (bigger values)
    statLine(
      150,
      [
        { label: 'Delivered', value: String(completed), caption: `of the ${assigned} projects that were due` },
        { label: 'Right first time', value: pct(studioFpq), caption: `${clean} of ${delivered} accepted with no changes` },
        { label: 'Changes asked', value: String(revisions), caption: `${Math.max(0, revisions - clientCaught)} by our team, ${clientCaught} by clients` },
        {
          label: 'Cancelled',
          value: String(cancelled),
          valueColor: cancelled > 0 ? BAD : INK,
          caption: cancelled > 0 ? 'lost to a design problem' : 'nothing lost this week',
        },
      ],
      { valueSize: 38, cellH: 78 },
    )

    // team bars
    let y = 300
    groupLabel('Where the work went', PX, y)
    y += 22
    const teamStats = TEAM_ORDER.map((team) => {
      const teamRows = studioRows.filter((r) => byId.get(r.designerId)?.team === team)
      return {
        team,
        designers: teamRows.length,
        delivered: teamRows.reduce((a, r) => a + r.completed, 0),
        due: teamRows.reduce((a, r) => a + r.expectedQuota, 0),
      }
    }).filter((t) => t.designers > 0)
    const maxDel = Math.max(1, ...teamStats.map((t) => t.delivered))
    const barX = PX + 128
    const barRight = W - PX - 168
    const numX = barRight + 26
    rule(PX, y - 4, W - PX, HAIR, 0.6)
    teamStats.forEach((t) => {
      T(TEAM_LABEL[t.team], PX, y + 14, { font: RF.interSemi, size: 11, color: INK })
      T(plural(t.designers, 'designer'), PX, y + 26, { font: RF.inter, size: 8, color: FAINT })
      // track + fill
      fill(HAIR)
      doc.rect(barX, y + 13, barRight - barX, 1.5, 'F')
      fill(INK)
      doc.rect(barX, y + 12.5, (barRight - barX) * (t.delivered / maxDel), 2.5, 'F')
      // number + caption (fixed columns so every row lines up)
      T(String(t.delivered), numX, y + 18, { font: RF.frauncesSemi, size: 16, color: INK, align: 'right' })
      const met = t.due > 0 ? Math.round((t.delivered / t.due) * 100) : null
      T(`delivered of ${t.due}${met != null ? `, ${met}% met` : ''}`, numX + 12, y + 18, {
        font: RF.inter,
        size: 8,
        color: MUTED,
      })
      y += 36
      rule(PX, y - 4, W - PX, HAIR, 0.6)
    })
  }

  // ════════════════════════ 02 — EVERYONE (standings) ════════════════════════
  // Only worth its own page when there is more than one designer to rank —
  // otherwise it just repeats the single designer's own page.
  if (rows.length > 1) {
    newPage()
    runHead(period_)
    sectionHead('02', 'Everyone', `${plural(rows.length, 'designer')}, hardest week first`, 108)
    let y = 150
    const cols = { name: PX, team: PX + 150, del: PX + 250, met: PX + 340, rft: W - PX }
    // header
    T('Designer', cols.name, y, { font: RF.interSemi, size: 7.2, color: MUTED, spacing: 0.7, upper: true })
    T('Team', cols.team, y, { font: RF.interSemi, size: 7.2, color: MUTED, spacing: 0.7, upper: true })
    T('Delivered', cols.del, y, { font: RF.interSemi, size: 7.2, color: MUTED, spacing: 0.7, upper: true, align: 'right' })
    T('Target met', cols.met, y, { font: RF.interSemi, size: 7.2, color: MUTED, spacing: 0.7, upper: true, align: 'right' })
    T('Right first', cols.rft, y, { font: RF.interSemi, size: 7.2, color: MUTED, spacing: 0.7, upper: true, align: 'right' })
    rule(PX, y + 6, W - PX, INK, 1.1)
    y += 24
    ranked.forEach((r) => {
      if (y > H - 90) {
        newPage()
        runHead(period_)
        y = 80
      }
      const d = byId.get(r.designerId)
      const rowPerProject = isPerProject(d)
      T(d?.name ?? 'Unknown', cols.name, y, { font: RF.interSemi, size: 11, color: INK })
      T(d ? TEAM_LABEL[d.team] : 'not set', cols.team, y, { font: RF.inter, size: 9.5, color: MUTED })
      // Per project designers have no target, so "X of 0" and a target percent
      // would be nonsense — show the finished count on its own and a plain tag.
      T(rowPerProject ? String(r.completed) : `${r.completed} of ${r.expectedQuota}`, cols.del, y, {
        font: RF.inter,
        size: 9.5,
        color: SOFT,
        align: 'right',
      })
      if (rowPerProject) {
        T('per project', cols.met, y, { font: RF.inter, size: 8.5, color: MUTED, align: 'right' })
      } else {
        const att = r.attainmentPct
        const attC = att == null ? FAINT : att < 60 ? BAD : att < 85 ? WARN : GOOD
        T(pct(att), cols.met, y, { font: RF.frauncesSemi, size: 12, color: attC, align: 'right' })
      }
      T(pct(r.firstPassQualityPct), cols.rft, y, { font: RF.inter, size: 9.5, color: SOFT, align: 'right' })
      y += 15
      rule(PX, y - 6, W - PX, HAIR, 0.5)
    })
  }

  // ════════════════════════ PER DESIGNER ════════════════════════
  for (const r of ranked) {
    const d = byId.get(r.designerId)
    if (!d) continue
    const perProject = isPerProject(d)
    const lines = projectsByDesigner[r.designerId] ?? []
    // Per project designers keep no schedule, so their attendance summary is
    // empty and meaningless — never draw it for them.
    const tk = perProject ? undefined : timekeepingByDesigner[r.designerId]
    const first = firstNameOf(d.name)
    const teamLabel = `${TEAM_LABEL[d.team]} team`

    const onTime = lines.filter((l) => l.timing === 'on time' || l.timing === 'early').length
    const early = lines.filter((l) => l.timing === 'early').length
    const late = lines.filter((l) => l.timing === 'late').length
    const openCount = lines.filter((l) => !l.delivered && l.status !== 'cancelled').length

    // ── summary page ──
    newPage()
    runHead(`${d.name}, ${teamLabel}`)
    T('03', PX, 104, { font: RF.frauncesReg, size: 25, color: FAINT })
    T('Designer in focus', PX + 40, 104, { font: RF.frauncesSemi, size: 15, color: MUTED })
    T(perProject ? 'Per project' : `Target met ${pct(r.attainmentPct)}`, W - PX, 100, {
      font: RF.inter,
      size: 8.6,
      color: MUTED,
      align: 'right',
    })
    T(d.name, PX - 2, 150, { font: RF.frauncesBlack, size: 44, color: INK })

    // deck
    const cleanClause =
      r.delivered > 0
        ? `, and ${r.firstPassClean} of those ${r.firstPassClean === 1 ? 'was' : 'were'} accepted with no changes at all`
        : ''
    const lateMornings =
      tk && tk.lateDays > 0 ? ` ${plural(tk.lateDays, 'late morning')}, otherwise a steady week.` : ' A steady week.'
    // Per project designers are paid for what they finish, with no set hours, so
    // their deck talks about finished work, never attendance.
    const deck = perProject
      ? `${first} finished ${r.completed} of the ${plural(r.assigned, 'project')} handed over this week${cleanClause}. Paid for each project finished, with no set hours.`
      : `${first} delivered ${r.completed} of the ${plural(r.assigned, 'project')} that were due this week${cleanClause}.${lateMornings}`
    const deckLines = wrap(deck, CW * 0.82, RF.frauncesReg, 15.5)
    deckLines.forEach((ln, i) => T(ln, PX, 186 + i * 22, { font: RF.frauncesReg, size: 15.5, color: SOFT }))
    let y = 186 + deckLines.length * 22 + 26

    // The work
    groupLabel('The work', PX, y)
    y += 12
    statLine(y, [
      { label: 'Delivered', value: String(r.completed), small: `of ${r.assigned}`, caption: 'projects that were due' },
      {
        label: 'On time',
        value: String(onTime),
        small: r.delivered > 0 ? `of ${r.delivered}` : null,
        valueColor: r.delivered > 0 && onTime === r.delivered ? GOOD : INK,
        caption: 'on or before the due date',
      },
      { label: 'Right first time', value: pct(r.firstPassQualityPct), caption: r.delivered > 0 ? `${r.firstPassClean} of ${r.delivered}, no changes asked` : 'nothing sent yet' },
      { label: 'Changes', value: String(r.revisionRounds), caption: `${Math.max(0, r.revisionRounds - r.clientCaughtRounds)} by us, ${r.clientCaughtRounds} by the client` },
    ])
    y += 62 + 34

    // Time at work — replaced by "How they are paid" for per project designers,
    // who keep no set hours and are paid for what they finish.
    let summaryEndY: number
    if (perProject) {
      groupLabel('How they are paid', PX, y)
      y += 12
      rule(PX, y, W - PX, INK, 1.1)
      T(`${plural(r.completed, 'project')} finished this week, each one payable.`, PX, y + 24, {
        font: RF.frauncesSemi,
        size: 15,
        color: INK,
      })
      const payNote = wrap(
        'Per project designers are paid for what they finish, not the hours they keep. There is no daily target and no fixed shift, so whatever is handed over for a day should be finished that day.',
        CW * 0.92,
        RF.inter,
        9.5,
      )
      payNote.forEach((ln, i) => T(ln, PX, y + 42 + i * 13, { font: RF.inter, size: 9.5, color: MUTED }))
      summaryEndY = y + 42 + payNote.length * 13
    } else {
      groupLabel('Time at work', PX, y)
      y += 12
      if (tk) {
        const workedHours = Math.round(tk.workedMinutes / 60)
        statLine(y, [
          { label: 'Days present', value: String(tk.presentDays), small: `of ${tk.scheduledDays}`, caption: 'the days she was scheduled' },
          {
            label: 'Arrived late',
            value: String(tk.lateDays),
            small: tk.lateDays === 1 ? 'day' : 'days',
            valueColor: tk.lateDays > 0 ? BAD : INK,
            caption: tk.lateMinutes > 0 ? `${dur(tk.lateMinutes)} in total` : 'always on time',
          },
          {
            label: 'Left early',
            value: String(tk.earlyDays),
            small: tk.earlyDays === 1 ? 'day' : 'days',
            caption: tk.earlyMinutes > 0 ? `${dur(tk.earlyMinutes)} in total` : 'stayed the full shift',
          },
          { label: 'Total worked', value: String(workedHours), small: 'hours', caption: 'across the whole week' },
        ])
        summaryEndY = y + 62
      } else {
        rule(PX, y, W - PX, INK, 1.1)
        T('Attendance was not recorded for this period.', PX, y + 22, { font: RF.frauncesReg, size: 12, color: MUTED })
        summaryEndY = y + 34
      }
    }

    // Projects flow straight after the summary (no blank page), paginating when
    // full so a light designer fits on one page and a busy one never spills into
    // the footer.
    const mine = notes.filter((n) => n.designer_id === d.id)
    drawProjectsSection(`${d.name}, ${teamLabel}`, summaryEndY + 34, r, lines, { onTime, early, late, openCount }, mine, perProject)
  }

  drawFooters()

  // ── the project table + total band + note for one designer, flowing from
  //    startY and paginating (re-drawing the header) so it never overflows ──
  function drawProjectsSection(
    heading: string,
    startY: number,
    r: DesignerPeriodSummary,
    lines: ProjectLine[],
    counts: { onTime: number; early: number; late: number; openCount: number },
    mine: DayNote[],
    perProject: boolean,
  ): void {
    const TX = 42 // wider table area (mock 56px)
    const TW = W - TX * 2
    const SAFE = H - 58 // content must stop above the footer
    // column boundaries by fraction: name, due, first sent, to first design,
    // changes, where. Date and duration columns get the room they need so their
    // values never spill into a neighbour.
    const fr = [0, 0.19, 0.275, 0.48, 0.685, 0.77, 1]
    const bx = fr.map((f) => TX + f * TW)
    const pad = 8
    const CELL = 8.4 // date + duration value size
    // cols: 0 name(L) 1 due(R) 2 sent(R) 3 ttf(R) 4 changes(R) 5 where(L)
    const rightOf = (i: number) => bx[i + 1] - pad
    const leftOf = (i: number) => bx[i] + (i === 0 ? 0 : pad)

    const drawHead = (yy: number): number => {
      T('Project', leftOf(0), yy, { font: RF.interSemi, size: 6.7, color: MUTED, spacing: 0.5, upper: true })
      T('Due', rightOf(1), yy, { font: RF.interSemi, size: 6.7, color: MUTED, spacing: 0.5, upper: true, align: 'right' })
      T('First sent', rightOf(2), yy, { font: RF.interSemi, size: 6.7, color: MUTED, spacing: 0.5, upper: true, align: 'right' })
      T('To first design', rightOf(3), yy, { font: RF.interSemi, size: 6.7, color: MUTED, spacing: 0.5, upper: true, align: 'right' })
      T('Changes', rightOf(4), yy, { font: RF.interSemi, size: 6.7, color: MUTED, spacing: 0.5, upper: true, align: 'right' })
      T('Where it is now', leftOf(5), yy, { font: RF.interSemi, size: 6.7, color: MUTED, spacing: 0.5, upper: true })
      rule(TX, yy + 6, W - TX, INK, 1.1)
      return yy + 6
    }
    const closeSeg = (segTop: number, yy: number) => {
      for (let i = 1; i <= 5; i++) vrule(bx[i], segTop, yy, LINE, 0.5)
    }

    // Start where the summary left off; if there isn't room for the label,
    // header and a first row, begin on a fresh page instead.
    let y = startY
    if (y + 96 > SAFE) {
      newPage()
      runHead(heading)
      y = 96
    }
    groupLabel(perProject ? 'Every project handed over' : 'Every project she was meant to deliver', TX, y)
    y += 22
    let segTop = drawHead(y)
    y = segTop

    if (lines.length === 0) {
      T(
        perProject
          ? 'No projects were handed over in this period.'
          : 'No projects were due for her in this period.',
        leftOf(0),
        y + 22,
        { font: RF.frauncesReg, size: 12, color: MUTED },
      )
      y += 40
    }

    for (const l of lines) {
      const nameLines = wrap(l.name, bx[1] - bx[0] - pad, RF.interSemi, 10).slice(0, 2)
      const rowH = 18 + nameLines.length * 13 + (l.priority ? 10 : 0)
      // Page break: close this page's column rules, start a new page, redraw head.
      if (y + rowH > SAFE) {
        closeSeg(segTop, y)
        newPage()
        runHead(heading)
        y = 96
        segTop = drawHead(y)
        y = segTop
      }
      const top = y
      const cy = top + 16 // first text baseline
      // name + priority
      nameLines.forEach((ln, i) => T(ln, leftOf(0), cy + i * 13, { font: RF.interSemi, size: 10, color: INK }))
      if (l.priority)
        T(l.priority, leftOf(0), cy + nameLines.length * 13 + 2, { font: RF.inter, size: 6.5, color: FAINT, spacing: 0.6, upper: true })
      // due
      T(fmtDay(l.dueDate), rightOf(1), cy, { font: RF.inter, size: CELL, color: SOFT, align: 'right' })
      // first sent + timing sub
      if (l.firstDeliveredAt) {
        T(fmtDayTime(l.firstDeliveredAt), rightOf(2), cy, { font: RF.inter, size: CELL, color: SOFT, align: 'right' })
        const tc = l.timing === 'late' ? BAD : l.timing === 'early' ? GOOD : FAINT
        T(
          l.timing === 'early' ? 'a day early' : l.timing ?? '',
          rightOf(2),
          cy + 11,
          { font: RF.inter, size: 7.2, color: tc, align: 'right' },
        )
      } else {
        T('not sent yet', rightOf(2), cy, { font: RF.inter, size: CELL, color: FAINT, align: 'right' })
      }
      // to first design
      T(dur(l.productionMin), rightOf(3), cy, {
        font: RF.interSemi,
        size: CELL,
        color: l.productionMin == null ? FAINT : INK,
        align: 'right',
      })
      // changes
      T(l.delivered ? String(l.revisionRounds) : 'none', rightOf(4), cy, {
        font: RF.interSemi,
        size: CELL,
        color: l.delivered ? INK : FAINT,
        align: 'right',
      })
      // where it is now (may wrap)
      const label = l.status ? STATUS_LABELS[l.status] : 'Unknown'
      const stLines = wrap(label, W - TX - leftOf(5), RF.interSemi, 9).slice(0, 2)
      stLines.forEach((ln, i) => T(ln, leftOf(5), cy + i * 11, { font: RF.interSemi, size: 9, color: statusTone(l.status) }))
      y = top + rowH
      rule(TX, y, W - TX, HAIR, 0.5)
    }

    // column separators for the last page segment
    closeSeg(segTop, y)

    // total band (dark) + note, kept together as one block so a small note never
    // lands alone on an otherwise blank page — new page only if the pair will
    // not fit whole below the table.
    const bandH = 82
    let noteH = 0
    if (mine.length) {
      noteH = 24
      for (const n of mine) noteH += wrap(n.note, CW - 16, RF.frauncesReg, 12.5).length * 18 + 6
    }
    if (y + 26 + bandH + noteH > SAFE) {
      newPage()
      runHead(heading)
      y = 96
    } else {
      y += 26
    }
    fill(INK)
    doc.roundedRect(TX, y, TW, bandH, 4, 4, 'F')
    const tb: Array<[string, string, string]> = [
      ['Delivered', `${r.completed} of ${r.assigned} due`, counts.openCount > 0 ? `${counts.openCount} still being worked on` : 'all cleared'],
      [
        'Sent on time',
        counts.early > 0 && counts.onTime - counts.early > 0
          ? `${counts.onTime - counts.early} on time, ${counts.early} early`
          : counts.early > 0
            ? `${counts.early} early`
            : `${counts.onTime} on time`,
        counts.late > 0 ? `${counts.late} delivered late` : 'none delivered late',
      ],
      ['Usual first design', dur(r.productionMedianMin), 'client waiting not counted'],
      ['Usual fix time', dur(r.revisionTurnaroundMedianMin), `${plural(r.revisionRounds, 'round')}, ${Math.max(0, r.revisionRounds - r.clientCaughtRounds)} ours, ${r.clientCaughtRounds} client`],
    ]
    const bcw = TW / 4
    tb.forEach(([l, v, c], i) => {
      const cx = TX + i * bcw + 18
      if (i > 0) vrule(TX + i * bcw, y + 14, y + bandH - 14, [70, 64, 84], 0.5)
      T(l, cx, y + 24, { font: RF.interSemi, size: 6.8, color: [150, 145, 160], spacing: 0.8, upper: true })
      const vLines = wrap(v, bcw - 26, RF.frauncesSemi, 14).slice(0, 2)
      vLines.forEach((ln, li) => T(ln, cx, y + 42 + li * 14, { font: RF.frauncesSemi, size: 14, color: WHITE }))
      const cLines = wrap(c, bcw - 26, RF.inter, 7).slice(0, 2)
      cLines.forEach((ln, li) => T(ln, cx, y + 66 + li * 10, { font: RF.inter, size: 7, color: [150, 145, 160] }))
    })
    y += bandH

    // note (per-designer) — guaranteed to fit here by the band+note block check.
    if (mine.length) noteBlock(y + 20, mine)
  }
}

// ── SVG → PNG for the brand mark (browser only) ───────────────────────────────

function renderBrandMarkPng(sizePx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Just the violet pulse mark, no box, cropped to the glyph bounds.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${Math.round(sizePx * (172 / 138))}" viewBox="138 110 138 172"><path fill="${BRAND_VIOLET}" d="${BRAND_MARK_PATH}"/></svg>`
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = sizePx
        canvas.height = Math.round(sizePx * (172 / 138))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/png'))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('mark render failed'))
    }
    img.src = url
  })
}

/** Builds and downloads the detailed weekly report. */
export async function generateWeeklyReportPdf(args: WeeklyReportArgs): Promise<void> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true })
  let markPng: string | null = null
  try {
    markPng = await renderBrandMarkPng(220)
  } catch {
    markPng = null
  }
  renderReport(doc, args, markPng)
  doc.save(`studio-pulse-report-${args.period.start}.pdf`)
}

export default generateWeeklyReportPdf
