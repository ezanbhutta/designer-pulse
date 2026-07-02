import { useMemo } from 'react'
import {
  CircleCheck,
  Download,
  Eye,
  Gauge,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { DeltaChip } from '../../components/ui/DeltaChip'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { StatTile } from '../../components/ui/StatTile'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { generateWeeklyReportPdf } from '../../lib/reportPdf'
import { fmtDate, fmtDuration, fmtPct, fmtTime } from '../../lib/format'
import { pktToday } from '../../../shared/pkt'
import {
  priorPeriod,
  summarizeDesigner,
  type DesignerPeriodSummary,
} from '../../../shared/aggregate'
import type { Designer } from '../../../shared/types'
import {
  activeDesigners,
  lastWeekRange,
  metricDelta,
  thisMonthRange,
  thisWeekRange,
  useDesigners,
  useDesignerDrawer,
  useMetricsSince,
  useQuotaCtx,
  useTasksSince,
  type PeriodRange,
} from './opsData'

type PeriodKey = 'this-week' | 'last-week' | 'this-month'

const PERIODS: { value: PeriodKey; label: string; range: (today: string) => PeriodRange }[] = [
  { value: 'this-week', label: 'This week', range: thisWeekRange },
  { value: 'last-week', label: 'Last week', range: lastWeekRange },
  { value: 'this-month', label: 'This month', range: thisMonthRange },
]

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
  const openDesigner = useDesignerDrawer()
  const [periodKey, setPeriodKey] = useLocalStorage<PeriodKey>('pulse.ops.reports.period', 'this-week')

  const period = PERIODS.find((p) => p.value === periodKey) ?? PERIODS[0]
  const range = period.range(today)
  const prior = priorPeriod(range.start, range.end)

  const designersQ = useDesigners()
  const { ctx } = useQuotaCtx()
  const tasksQ = useTasksSince(prior.start)
  const metricsQ = useMetricsSince(prior.start, range.end)

  const designers = activeDesigners(designersQ.data)
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
        text: `${r.designer.name} at ${pct}% attainment — ${r.cur.completed} completed of ${r.cur.expectedQuota} expected`,
        detail:
          r.cur.assigned < r.cur.expectedQuota
            ? `Only ${r.cur.assigned} assigned in period — the gap may be assignment, not the designer (§11 T3)`
            : 'Assignment kept pace — the gap is production',
        action: { label: 'Open details', onClick: () => openDesigner(r.designer.id) },
      })
    }
    for (const r of rows.filter((x) => x.cur.firstPassQualityPct != null && x.cur.delivered >= 3 && (x.cur.firstPassQualityPct ?? 100) < 60)) {
      items.push({
        id: `fpq-${r.designer.id}`,
        severity: 'warning',
        text: `${r.designer.name} first-pass quality ${r.cur.firstPassQualityPct}% — ${r.cur.firstPassClean} of ${r.cur.delivered} clean`,
        detail:
          r.cur.csrCaughtRounds >= r.cur.clientCaughtRounds
            ? `${r.cur.csrCaughtRounds} CSR-caught rounds — coaching flag (§4.2)`
            : `${r.cur.clientCaughtRounds} client-caught rounds — tighten the CSR gate or the brief (§4.2)`,
        action: { label: 'Open details', onClick: () => openDesigner(r.designer.id) },
      })
    }
    for (const r of rows.filter((x) => x.cur.cancelled > 0)) {
      items.push({
        id: `cancel-${r.designer.id}`,
        severity: 'critical',
        text: `${r.designer.name}: ${r.cur.cancelled} cancellation${r.cur.cancelled === 1 ? '' : 's'} — designer-fault terminal loss`,
        detail: 'Human-judged at close — review the trail, act on the trend, not one row (§4.4)',
        action: { label: 'Open details', onClick: () => openDesigner(r.designer.id) },
      })
    }
    return items
  }, [rows, openDesigner])

  const exportPdf = () => {
    generateWeeklyReportPdf({
      period: { start: range.start, end: range.end },
      rows: rows.map((r) => r.cur),
      designers: designersQ.data ?? [],
    })
  }

  const rangeLabel = `${fmtDate(range.start)} – ${fmtDate(range.end)}`

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Reports · {rangeLabel} · vs {fmtDate(prior.start)} – {fmtDate(prior.end)}</p>
          <h1 className="mt-1 text-3xl font-semibold text-fg">Reports</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl<PeriodKey>
            options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
            value={periodKey}
            onChange={setPeriodKey}
            ariaLabel="Report period"
          />
          <button
            type="button"
            onClick={exportPdf}
            disabled={loading || rows.length === 0}
            className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Export PDF
          </button>
        </div>
      </header>

      {(tasksQ.error || metricsQ.error) && (
        <ErrorBanner
          message="Couldn't refresh period data — showing the last computed summaries."
          asOf={(() => {
            const lastGood = Math.max(tasksQ.dataUpdatedAt, metricsQ.dataUpdatedAt)
            return lastGood > 0 ? fmtTime(new Date(lastGood).toISOString()) : null
          })()}
          onRetry={() => {
            void tasksQ.refetch()
            void metricsQ.refetch()
          }}
        />
      )}

      <VerdictBlock
        title={`Calls for ${period.label.toLowerCase()}`}
        items={verdictItems}
        emptyMessage="Every designer on target this period — no attainment, quality or cancellation flags."
        loading={loading}
      />

      {/* ── Studio rollup (§20.2) ── */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Studio rollup">
        <StatTile
          eyebrow="Studio attainment"
          icon={Gauge}
          value={fmtPct(totals.attainment.cur)}
          delta={metricDelta(totals.attainment.cur, totals.attainment.prev, {
            goodWhen: 'up',
            format: (v) => `${v} pts`,
          })}
          cause={`${totals.completed.cur} completed of ${totals.expected.cur} expected — the only fair cross-team number (§2)`}
          loading={loading}
        />
        <StatTile
          eyebrow="Studio first-pass quality"
          icon={ShieldCheck}
          value={fmtPct(totals.fpq.cur)}
          delta={metricDelta(totals.fpq.cur, totals.fpq.prev, {
            goodWhen: 'up',
            format: (v) => `${v} pts`,
          })}
          cause={`${totals.clean.cur} of ${totals.delivered.cur} deliveries clean`}
          loading={loading}
        />
        <StatTile
          eyebrow="Cancellations"
          icon={TriangleAlert}
          value={String(totals.cancelled.cur)}
          delta={metricDelta(totals.cancelled.cur, totals.cancelled.prev, { goodWhen: 'down' })}
          cause={
            totals.assigned.cur > 0
              ? `${Math.round((totals.cancelled.cur / totals.assigned.cur) * 100)}% of ${totals.assigned.cur} assigned — designer-fault terminal losses`
              : 'nothing assigned in period'
          }
          state={totals.cancelled.cur > 0 ? 'flag' : 'ok'}
          loading={loading}
        />
      </section>

      <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">
        A logo, a 25-page brand guide and an animation are different units — raw counts are never
        comparable across teams. Compare <strong className="text-fg">Attainment %</strong> only
        (§2).
      </p>

      {loading ? (
        <div className="space-y-2" role="status" aria-label="Loading report">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-12" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No active designers"
          hint="Add designers on the Roster page to build the period report."
        />
      ) : (
        [...byTeam.entries()].map(([team, teamRows]) => (
          <section key={team} aria-label={`${team} team report`}>
            <h2 className="eyebrow">{team}</h2>
            <div className="card mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted">
                    <th scope="col" className="w-10 px-3 py-2.5"><span className="sr-only">State</span></th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Designer</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Attainment</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">First-pass quality</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Production median</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Revision turnaround</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Cancelled</th>
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
                      <tr
                        key={designer.id}
                        onClick={() => openDesigner(designer.id)}
                        // Keyboard-operable drill-down (§20.10).
                        tabIndex={0}
                        role="button"
                        aria-label={`Open ${designer.name}'s details`}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openDesigner(designer.id)
                          }
                        }}
                        className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-surface-2/60 focus-visible:bg-surface-2/60"
                      >
                        <td className="px-3 py-2.5">
                          {flagged ? (
                            <TriangleAlert className="h-4 w-4 text-danger" aria-label="Flagged" />
                          ) : watch ? (
                            <Eye className="h-4 w-4 text-warning" aria-label="Watch" />
                          ) : (
                            <CircleCheck className="h-4 w-4 text-success" aria-label="On track" />
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-medium text-fg">
                          {designer.name}
                          {designer.specialty && (
                            <span className="ml-2 text-xs font-normal text-muted">{designer.specialty}</span>
                          )}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right">
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
                          <p className="text-xs font-normal text-muted">
                            {cur.completed} of {cur.expectedQuota} expected
                          </p>
                        </td>
                        <td className="tnum px-3 py-2.5 text-right">
                          <span className="font-medium text-fg">{fmtPct(cur.firstPassQualityPct)}</span>
                          <p className="text-xs font-normal text-muted">
                            {cur.delivered > 0
                              ? `${cur.firstPassClean} of ${cur.delivered} delivered clean`
                              : 'nothing delivered'}
                          </p>
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-fg">
                          {fmtDuration(cur.productionMedianMin)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-fg">
                          {fmtDuration(cur.revisionTurnaroundMedianMin)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right">
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
