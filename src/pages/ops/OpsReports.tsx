import { useMemo } from 'react'
import {
  CircleCheck,
  Download,
  Eye,
  Gauge,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { ActionButton } from '../../components/ui/ActionButton'
import { DeltaChip } from '../../components/ui/DeltaChip'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/layout/PageHeader'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InfoTip } from '../../components/ui/InfoTip'
import {
  DateRangePicker,
  resolveRange,
  type DateRangeValue,
  type RangeMode,
} from '../../components/ui/DateRangePicker'
import { DesignerFilter } from '../../components/ui/DesignerFilter'
import { StatTile } from '../../components/ui/StatTile'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useToast } from '../../components/ui/ToastProvider'
import { fmtClock, fmtDate, fmtDuration, fmtPct } from '../../lib/format'
import { pktToday } from '../../../shared/pkt'
import {
  priorPeriod,
  summarizeDesigner,
  type DesignerPeriodSummary,
} from '../../../shared/aggregate'
import type { Designer } from '../../../shared/types'
import {
  metricDelta,
  useActiveDesigners,
  useDesigners,
  useDesignerDrawer,
  useMetricsSince,
  useQuotaCtx,
  useTasksSince,
} from './opsData'

/** Human label per preset for the history line + PDF caption. */
const MODE_LABEL: Record<RangeMode, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  custom: 'Custom range',
}

interface ReportRow {
  designer: Designer
  cur: DesignerPeriodSummary
  prev: DesignerPeriodSummary
}

/**
 * Per-designer period summaries (spec §13.1 drill / §22.9 in-app-first
 * reports): grouped by team because cross-team raw counts are not comparable —
 * attainment % is the only fair cross-team number (§2). Worst attainment
 * sorts first; the PDF export is the pre-built Monday review.
 */
export default function OpsReports() {
  const today = pktToday()
  const toast = useToast()
  const openDesigner = useDesignerDrawer()
  // The CSR-style date filter: presets re-resolve to today on every load so a
  // stored '7d' never goes stale; a custom range keeps its exact dates.
  const [stored, setStored] = useLocalStorage<DateRangeValue>(
    'pulse.ops.reports.range',
    resolveRange('7d', '', '', today),
  )
  const value = stored.mode === 'custom' ? stored : resolveRange(stored.mode, stored.start, stored.end, today)
  const range = { start: value.start, end: value.end }
  const prior = priorPeriod(range.start, range.end)

  // Who to include (empty = everyone) and the free-text note printed on the PDF,
  // both remembered on this machine; the note is kept per period so last week's
  // context never bleeds into this week's report.
  const [selectedIds, setSelectedIds] = useLocalStorage<string[]>('pulse.ops.reports.designers', [])
  const [notesByPeriod, setNotesByPeriod] = useLocalStorage<Record<string, string>>(
    'pulse.ops.reports.notes',
    {},
  )
  const periodKey = `${range.start}_${range.end}`
  const notes = notesByPeriod[periodKey] ?? ''
  const setNotes = (v: string) => setNotesByPeriod({ ...notesByPeriod, [periodKey]: v })

  const designersQ = useDesigners()
  const { ctx } = useQuotaCtx()
  const tasksQ = useTasksSince(prior.start)
  const metricsQ = useMetricsSince(prior.start, range.end)

  const activeDesigners = useActiveDesigners()
  const designers = useMemo(
    () =>
      selectedIds.length
        ? activeDesigners.filter((d) => selectedIds.includes(d.id))
        : activeDesigners,
    [activeDesigners, selectedIds],
  )
  const loading = designersQ.isLoading || tasksQ.isLoading || metricsQ.isLoading

  const rows: ReportRow[] = useMemo(() => {
    const tasks = tasksQ.data ?? []
    const metrics = metricsQ.data ?? []
    return designers.map((designer) => ({
      designer,
      cur: summarizeDesigner(designer.id, { start: range.start, end: range.end, tasks, metrics, quota: ctx }),
      prev: summarizeDesigner(designer.id, { start: prior.start, end: prior.end, tasks, metrics, quota: ctx }),
    }))
  }, [designers, tasksQ.data, metricsQ.data, ctx, range.start, range.end, prior.start, prior.end])

  const byTeam = useMemo(() => {
    const grouped = new Map<string, ReportRow[]>()
    for (const row of rows) {
      const list = grouped.get(row.designer.team) ?? []
      list.push(row)
      grouped.set(row.designer.team, list)
    }
    // Worst attainment first inside each team (§20.4); unmeasurable last.
    for (const list of grouped.values()) {
      list.sort((a, b) => (a.cur.attainmentPct ?? Infinity) - (b.cur.attainmentPct ?? Infinity))
    }
    return grouped
  }, [rows])

  // ── Studio rollup ──
  const totals = useMemo(() => {
    const sum = (pick: (s: DesignerPeriodSummary) => number) => ({
      cur: rows.reduce((acc, r) => acc + pick(r.cur), 0),
      prev: rows.reduce((acc, r) => acc + pick(r.prev), 0),
    })
    const completed = sum((s) => s.completed)
    const expected = sum((s) => s.expectedQuota)
    const delivered = sum((s) => s.delivered)
    const clean = sum((s) => s.firstPassClean)
    const cancelled = sum((s) => s.cancelled)
    const assigned = sum((s) => s.assigned)
    const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null)
    return {
      completed,
      expected,
      cancelled,
      assigned,
      attainment: { cur: pct(completed.cur, expected.cur), prev: pct(completed.prev, expected.prev) },
      fpq: { cur: pct(clean.cur, delivered.cur), prev: pct(clean.prev, delivered.prev) },
      clean,
      delivered,
    }
  }, [rows])

  // ── Verdict: the worst calls this period (§20.1) ──
  const verdictItems = useMemo(() => {
    const items: VerdictItem[] = []
    const measured = rows.filter((r) => r.cur.attainmentPct != null)
    for (const r of [...measured].sort((a, b) => (a.cur.attainmentPct ?? 0) - (b.cur.attainmentPct ?? 0)).slice(0, 3)) {
      const pct = r.cur.attainmentPct ?? 0
      if (pct >= 70) break
      items.push({
        id: `att-${r.designer.id}`,
        severity: pct < 50 ? 'critical' : 'warning',
        text: `${r.designer.name} met ${pct}% of their target, finishing ${r.cur.completed} of ${r.cur.expectedQuota}`,
        detail:
          r.cur.assigned < r.cur.expectedQuota
            ? `They were only given ${r.cur.assigned} projects, so the shortfall may be in handing out the work, not the person`
            : 'They were given enough projects, so the shortfall is in getting them done',
        action: { label: 'Open details', onClick: () => openDesigner(r.designer.id) },
      })
    }
    for (const r of rows.filter((x) => x.cur.firstPassQualityPct != null && x.cur.delivered >= 3 && (x.cur.firstPassQualityPct ?? 100) < 60)) {
      items.push({
        id: `fpq-${r.designer.id}`,
        severity: 'warning',
        text: `${r.designer.name} had ${r.cur.firstPassQualityPct}% of their work accepted without changes, ${r.cur.firstPassClean} of ${r.cur.delivered}`,
        detail:
          r.cur.csrCaughtRounds >= r.cur.clientCaughtRounds
            ? `${r.cur.csrCaughtRounds} rounds of changes were caught by our own checkers, so some coaching may help`
            : `${r.cur.clientCaughtRounds} rounds of changes came from clients, so our checking step or the brief may need tightening`,
        action: { label: 'Open details', onClick: () => openDesigner(r.designer.id) },
      })
    }
    for (const r of rows.filter((x) => x.cur.cancelled > 0)) {
      items.push({
        id: `cancel-${r.designer.id}`,
        severity: 'critical',
        text: `${r.designer.name}: ${r.cur.cancelled} cancelled order${r.cur.cancelled === 1 ? '' : 's'}, lost because of a design problem`,
        detail: 'Please read the project history first, and look at the pattern, not just one project.',
        action: { label: 'Open details', onClick: () => openDesigner(r.designer.id) },
      })
    }
    return items
  }, [rows, openDesigner])

  const rangeLabel = `${fmtDate(range.start)} – ${fmtDate(range.end)}`

  // The PDF engine (jsPDF, ~120 kB gzip) is fetched only when the button is
  // pressed — visiting the Reports page never downloads it.
  const exportPdf = async () => {
    try {
      const { generateWeeklyReportPdf } = await import('../../lib/reportPdf')
      generateWeeklyReportPdf({
        period: { start: range.start, end: range.end },
        rows: rows.map((r) => r.cur),
        designers: designersQ.data ?? [],
        notes,
      })
      toast({ message: `PDF for ${rangeLabel} downloaded` })
    } catch (e) {
      toast({ message: 'We couldn’t build the PDF. Please check your connection and try again.' })
      throw e // the stateful button resets to idle — never a false success ✓
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-12">
      <PageHeader
        breadcrumbs={['Ops', 'Reports']}
        title="Reports"
        titleAccessory={
          <InfoTip text="How each person did over a period: targets met, quality and speed, with a PDF you can share." />
        }
        history={`${MODE_LABEL[value.mode]} · ${rangeLabel}, compared with ${fmtDate(prior.start)} – ${fmtDate(prior.end)}.`}
        actions={
          <>
            <span className="flex items-center gap-1">
              <DateRangePicker value={value} onChange={setStored} />
              <InfoTip text="Pick the time period. Every number is compared with the same length of time just before it." />
            </span>
            <span className="flex items-center gap-1">
              <DesignerFilter
                designers={activeDesigners}
                selected={selectedIds}
                onChange={setSelectedIds}
              />
              <InfoTip text="Narrow the report to one or more people. Leave it on everyone to see the whole studio." />
            </span>
            {/* The one brand action on the page — stateful: dots while the PDF
                builds, a crisp ✓ when it lands (manifesto pillar 8). */}
            <ActionButton
              onAction={exportPdf}
              disabled={loading || rows.length === 0}
              aria-label="Download the PDF report for this period"
              className="min-h-11 rounded-xl"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download PDF
            </ActionButton>
          </>
        }
      />

      {(tasksQ.error || metricsQ.error) && (
        <ErrorBanner
          message="We couldn't load the latest numbers, so you're seeing the last saved view."
          asOf={(() => {
            const lastGood = Math.max(tasksQ.dataUpdatedAt, metricsQ.dataUpdatedAt)
            return lastGood > 0 ? fmtClock(new Date(lastGood).toISOString()) : null
          })()}
          onRetry={() => {
            void tasksQ.refetch()
            void metricsQ.refetch()
          }}
        />
      )}

      <section aria-label="Notes for this report" className="card p-5">
        <label htmlFor="report-notes" className="eyebrow inline-flex items-center gap-1">
          Notes for this report
          <InfoTip text="Add any context you want to sit alongside the numbers — for example, if you agreed with a designer to take on fewer or more projects this period because of workload. Whatever you write here is printed on the downloaded PDF." />
        </label>
        <textarea
          id="report-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="For example: Nimeazad took on fewer projects this week by agreement, to focus on the Aldercrest brand."
          className="mt-3 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-caption text-fg transition-colors placeholder:text-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        />
        <p className="mt-2 text-label text-muted">
          Saved for this period on this computer, and printed at the top of the PDF.
        </p>
      </section>

      <VerdictBlock
        title={`What stands out · ${MODE_LABEL[value.mode].toLowerCase()}`}
        items={verdictItems}
        emptyMessage="Everyone is on track this period, nothing stands out."
        loading={loading}
      />

      {/* ── Studio rollup (§20.2) ── */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="Studio rollup">
        <StatTile
          eyebrow="Target met across the studio"
          tip="Out of all the projects the team was supposed to take, how many they finished."
          icon={Gauge}
          value={fmtPct(totals.attainment.cur)}
          delta={metricDelta(totals.attainment.cur, totals.attainment.prev, {
            goodWhen: 'up',
            format: (v) => `${v} points`,
          })}
          cause={`finished ${totals.completed.cur} of ${totals.expected.cur} expected, the fairest way to compare teams`}
          loading={loading}
        />
        <StatTile
          eyebrow="Right first time across the studio"
          tip="How many designs were accepted without anyone asking for changes. Higher is better."
          icon={ShieldCheck}
          value={fmtPct(totals.fpq.cur)}
          delta={metricDelta(totals.fpq.cur, totals.fpq.prev, {
            goodWhen: 'up',
            format: (v) => `${v} points`,
          })}
          cause={`${totals.clean.cur} of ${totals.delivered.cur} designs needed no changes`}
          loading={loading}
        />
        <StatTile
          eyebrow="Cancelled orders"
          tip="Orders lost because of a design problem. Please read the project history before judging anyone."
          icon={TriangleAlert}
          value={String(totals.cancelled.cur)}
          delta={metricDelta(totals.cancelled.cur, totals.cancelled.prev, { goodWhen: 'down' })}
          cause={
            totals.assigned.cur > 0
              ? `${Math.round((totals.cancelled.cur / totals.assigned.cur) * 100)}% of ${totals.assigned.cur} projects given, lost to design problems`
              : 'no projects given in this period'
          }
          state={totals.cancelled.cur > 0 ? 'flag' : 'ok'}
          loading={loading}
        />
      </section>

      <p className="max-w-prose rounded-xl bg-surface-2 px-4 py-3 text-caption text-muted">
        A logo, a brand guide of 25 pages and an animation take very different amounts of work, so
        never compare raw counts between teams. Compare{' '}
        <strong className="text-fg">Target met</strong> only.
      </p>

      {loading ? (
        <div className="card overflow-hidden" role="status" aria-label="Loading report">
          <div className="border-b border-border/60 px-4 py-3">
            <div className="skeleton h-3.5 w-64" />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-6 border-b border-border/40 px-4 py-4 last:border-0">
              <div className="skeleton h-4 w-4 rounded-full" />
              <div className="skeleton h-4 w-40" />
              <div className="skeleton ml-auto h-4 w-56" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No designers yet"
          hint="Add people on the Roster page to see their reports here."
        />
      ) : (
        [...byTeam.entries()].map(([team, teamRows]) => (
          <section key={team} aria-label={`${team} team report`}>
            <h2 className="eyebrow">{team}</h2>
            <div className="card mt-3 overflow-x-auto">
              <table className="w-full text-left text-caption">
                <thead>
                  <tr className="border-b border-border/60 text-label text-muted">
                    <th scope="col" className="w-10 px-4 py-3"><span className="sr-only">State</span></th>
                    <th scope="col" className="px-4 py-3 font-medium">Designer</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      <span className="inline-flex items-center gap-1">
                        Target met
                        <InfoTip text="Out of the projects this person was supposed to take, how many they finished." />
                      </span>
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      <span className="inline-flex items-center gap-1">
                        Right first time
                        <InfoTip text="How many designs were accepted without anyone asking for changes. Higher is better." />
                      </span>
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      <span className="inline-flex items-center gap-1">
                        Work time
                        <InfoTip text="The usual time from getting a project to sending the first design. Waiting for the client is not counted." />
                      </span>
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      <span className="inline-flex items-center gap-1">
                        Fix time
                        <InfoTip text="The usual time to finish changes after someone asks for them." />
                      </span>
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      <span className="inline-flex items-center gap-1">
                        Cancelled
                        <InfoTip text="Orders lost because of a design problem." />
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {teamRows.map(({ designer, cur, prev }) => {
                    const flagged =
                      (cur.attainmentPct != null && cur.attainmentPct < 60) ||
                      (cur.firstPassQualityPct != null && cur.delivered >= 3 && cur.firstPassQualityPct < 60) ||
                      cur.cancelled > 0
                    const watch = !flagged && cur.attainmentPct != null && cur.attainmentPct < 85
                    return (
                      // Row stays a real table row for AT — the row-wide click
                      // is a mouse convenience; keyboard/SR drill-down lives on
                      // the name button below (same pattern as Attendance).
                      <tr
                        key={designer.id}
                        onClick={() => openDesigner(designer.id)}
                        className="cursor-pointer border-b border-border/40 last:border-0 transition-colors duration-150 ease-out hover:bg-surface-2/60"
                      >
                        <td className="px-4 py-3">
                          {flagged ? (
                            <TriangleAlert className="h-4 w-4 text-danger" aria-label="Needs attention" />
                          ) : watch ? (
                            <Eye className="h-4 w-4 text-warning" aria-label="Keep an eye" />
                          ) : (
                            <CircleCheck className="h-4 w-4 text-success" aria-label="On track" />
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              openDesigner(designer.id)
                            }}
                            className="min-h-11 text-left font-medium text-fg transition-colors duration-150 ease-out hover:text-brand"
                          >
                            {designer.name}
                          </button>
                          {designer.specialty && (
                            <span className="ml-2 text-label font-normal tracking-normal text-muted">{designer.specialty}</span>
                          )}
                        </td>
                        <td className="tnum px-4 py-3 text-right">
                          <span className="font-medium text-fg">{fmtPct(cur.attainmentPct)}</span>
                          <span className="ml-1.5 inline-block align-middle">
                            {(() => {
                              const d = metricDelta(cur.attainmentPct, prev.attainmentPct, {
                                goodWhen: 'up',
                                format: (v) => `${v}`,
                              })
                              return d ? <DeltaChip direction={d.direction} good={d.good} label={d.label} /> : null
                            })()}
                          </span>
                          <p className="text-label font-normal tracking-normal text-muted">
                            finished {cur.completed} of {cur.expectedQuota}
                          </p>
                        </td>
                        <td className="tnum px-4 py-3 text-right">
                          <span className="font-medium text-fg">{fmtPct(cur.firstPassQualityPct)}</span>
                          <p className="text-label font-normal tracking-normal text-muted">
                            {cur.delivered > 0
                              ? `${cur.firstPassClean} of ${cur.delivered} with no changes`
                              : 'nothing sent yet'}
                          </p>
                        </td>
                        <td className="tnum px-4 py-3 text-right text-fg">
                          {fmtDuration(cur.productionMedianMin)}
                        </td>
                        <td className="tnum px-4 py-3 text-right text-fg">
                          {fmtDuration(cur.revisionTurnaroundMedianMin)}
                        </td>
                        <td className="tnum px-4 py-3 text-right">
                          <span className={cur.cancelled > 0 ? 'font-medium text-danger' : 'text-muted'}>
                            {cur.cancelled}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  )
}
