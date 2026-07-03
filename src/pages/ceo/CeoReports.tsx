/**
 * CEO Reports (spec §13.2, §22.9): the auto weekly per-designer review —
 * in-app cards first, PDF export second. Defaults to the last FULL Mon–Sun
 * week in PKT (the pre-built Monday review). Every card carries a trend
 * arrow vs the prior week and a one-line interpretation: verdicts, not data
 * (§20.1). Read-only; private manager-facing interpretation (§22.10).
 */

import { useMemo, useState } from 'react'
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Minus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InfoTip } from '../../components/ui/InfoTip'
import { Skeleton } from '../../components/ui/Skeleton'
import { useToast } from '../../components/ui/ToastProvider'
import {
  priorPeriod,
  summarizeDesigner,
  type DesignerPeriodSummary,
} from '../../../shared/aggregate'
import { addDays, pktToday } from '../../../shared/pkt'
import type { Config, Designer } from '../../../shared/types'
import { fmtDate, fmtDuration, fmtPct, fmtTime } from '../../lib/format'
import { generateWeeklyReportPdf } from '../../lib/reportPdf'
import {
  TEAMS,
  activeDesigners,
  firstName,
  lastFullWeekRange,
  mergeTasks,
  productionMedianInPeriod,
  useConfigValues,
  useDesigners,
  useMetricsWindow,
  useOpenTasksLive,
  useQuotaCtx,
  useTasksWindow,
  type PeriodRange,
} from './ceoData'

const MAX_WEEKS_BACK = 26

interface ReportRow {
  designer: Designer
  cur: DesignerPeriodSummary
  prev: DesignerPeriodSummary
  trend: 'up' | 'down' | 'flat'
  interpretation: string
}

export default function CeoReports() {
  const toast = useToast()
  const today = pktToday()
  // Period picker: 0 = the most recent complete Mon–Sun week (§13.2 default).
  const [weeksBack, setWeeksBack] = useState(0)
  const base = lastFullWeekRange(today)
  const period: PeriodRange = {
    start: addDays(base.start, -7 * weeksBack),
    end: addDays(base.end, -7 * weeksBack),
  }
  const prior = priorPeriod(period.start, period.end)

  const designersQ = useDesigners()
  const cfg = useConfigValues()
  const { ctx: quota, isLoading: quotaLoading } = useQuotaCtx()
  const tasksQ = useTasksWindow(prior.start)
  const metricsQ = useMetricsWindow(prior.start, period.end)
  const openQ = useOpenTasksLive()

  const loading = designersQ.isLoading || tasksQ.isLoading || metricsQ.isLoading || quotaLoading
  const failed = designersQ.error ?? tasksQ.error ?? metricsQ.error

  const model = useMemo(() => {
    if (loading || !designersQ.data || !tasksQ.data || !metricsQ.data) return null
    const active = activeDesigners(designersQ.data)
    const allTasks = mergeTasks(tasksQ.data, openQ.data ?? [])
    const metrics = metricsQ.data

    const rows: ReportRow[] = active
      .map((d) => {
        const cur = summarizeDesigner(d.id, { ...period, tasks: allTasks, metrics, quota })
        const prev = summarizeDesigner(d.id, { ...prior, tasks: allTasks, metrics, quota })
        return {
          designer: d,
          cur,
          prev,
          trend: trendDirection(cur, prev),
          interpretation: interpretWeek(cur, prev, cfg),
        }
      })
      // Skip designers with zero signal in the week — an all-dash card teaches nothing.
      .filter(
        (r) =>
          r.cur.assigned > 0 || r.cur.completed > 0 || r.cur.delivered > 0 || r.cur.expectedQuota > 0,
      )

    const activeIds = new Set(active.map((d) => d.id))
    const summary = buildWeeklySummary(
      rows,
      period,
      productionMedianInPeriod(metrics, activeIds, period),
      productionMedianInPeriod(metrics, activeIds, prior),
      active,
    )
    return { rows, summary, active }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, designersQ.data, tasksQ.data, metricsQ.data, openQ.data, quota, cfg, period.start])

  const download = () => {
    if (!model) return
    generateWeeklyReportPdf({
      period,
      rows: model.rows.map((r) => r.cur),
      designers: model.active,
    })
    toast({ message: `Weekly PDF for ${fmtDate(period.start)} – ${fmtDate(period.end)} downloaded.` })
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="inline-flex items-center gap-2 text-3xl font-semibold text-fg">
            Weekly reports{' '}
            <InfoTip text="Your Monday review, already prepared — one card per designer with their numbers and a one-line summary." />
          </h1>
          <p className="mt-1 text-sm text-muted">
            Each designer&apos;s week at a glance — target met, right first time, work time, and
            which way they are heading. Covers a full Monday–Sunday week (Pakistan time)
          </p>
        </div>
        <button
          type="button"
          onClick={download}
          disabled={loading || !model || model.rows.length === 0}
          className="inline-flex min-h-[2.75rem] items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Download PDF
        </button>
      </header>

      {/* ── Period picker — defaults to the last full week; never blank (§20.4) ── */}
      <div className="flex items-center gap-2" role="group" aria-label="Report week">
        <button
          type="button"
          onClick={() => setWeeksBack((w) => Math.min(MAX_WEEKS_BACK, w + 1))}
          disabled={weeksBack >= MAX_WEEKS_BACK}
          aria-label="Previous week"
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-border text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="inline-flex min-h-[2.75rem] items-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-medium text-fg">
          <Calendar className="h-4 w-4 text-muted" aria-hidden="true" />
          Mon {fmtDate(period.start)} – Sun {fmtDate(period.end)}
          {weeksBack === 0 && <span className="text-xs text-muted">· most recent full week</span>}
          <InfoTip text="The week this report covers. Use the arrows to look at earlier weeks." />
        </span>
        <button
          type="button"
          onClick={() => setWeeksBack((w) => Math.max(0, w - 1))}
          disabled={weeksBack === 0}
          aria-label="Next week"
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-border text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {failed != null && (
        <ErrorBanner
          message={`Could not load the report numbers — ${(failed as Error).message}`}
          asOf={tasksQ.dataUpdatedAt > 0 ? fmtTime(new Date(tasksQ.dataUpdatedAt).toISOString()) : null}
          onRetry={() => {
            void tasksQ.refetch()
            void metricsQ.refetch()
          }}
        />
      )}

      {/* Weekly summary paragraph — assembled deterministically from the computed
          metrics with template sentences. §22.11 permits an LLM-generated
          paragraph over these SAME computed numbers as a config-gated add-on
          (summarization only — a model never touches a metric or a decision). */}
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        model &&
        model.summary && (
          <div className="card animate-fade-in p-6">
            <h2 className="eyebrow inline-flex items-center gap-1">
              The week in one paragraph{' '}
              <InfoTip text="A short summary of the whole studio's week, written from the same numbers as the cards below." />
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-fg">{model.summary}</p>
          </div>
        )
      )}

      {loading && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading reports">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      )}

      {!loading && model && model.rows.length === 0 && (
        <EmptyState
          icon={FileText}
          title="No designer activity in this week"
          hint="Pick an earlier week, or wait for the current week to complete on Sunday (PKT)."
        />
      )}

      {!loading &&
        model &&
        TEAMS.map((team) => {
          const teamRows = model.rows
            .filter((r) => r.designer.team === team)
            // Worst-first (§20.4): the designer who needs the conversation leads.
            .sort((a, b) => (a.cur.attainmentPct ?? Infinity) - (b.cur.attainmentPct ?? Infinity))
          if (teamRows.length === 0) return null
          return (
            <section key={team} aria-label={`${team} team weekly reports`}>
              <h2 className="mb-3 text-lg font-semibold text-fg">{team}</h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {teamRows.map((r) => (
                  <ReportCard key={r.designer.id} row={r} />
                ))}
              </div>
            </section>
          )
        })}
    </div>
  )
}

// ── Report card ───────────────────────────────────────────────────────────────

const TREND_META = {
  up: { icon: TrendingUp, className: 'text-success', label: 'Improving vs prior week' },
  down: { icon: TrendingDown, className: 'text-danger', label: 'Declining vs prior week' },
  flat: { icon: Minus, className: 'text-muted', label: 'Steady vs prior week' },
} as const

function ReportCard({ row }: { row: ReportRow }) {
  const meta = TREND_META[row.trend]
  const TrendIcon = meta.icon
  return (
    <article className="card animate-fade-in p-5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-base font-semibold text-fg">{row.designer.name}</h3>
        <span className={`flex shrink-0 items-center gap-1 text-xs font-medium ${meta.className}`}>
          <TrendIcon className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">{meta.label}</span>
        </span>
      </div>
      <p className="mt-1.5 text-sm font-medium leading-snug text-fg">{row.interpretation}</p>
      <dl className="tnum mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border/60 pt-3 text-sm">
        <ReportStat
          label="Attainment"
          value={fmtPct(row.cur.attainmentPct)}
          sub={row.cur.expectedQuota > 0 ? `${row.cur.completed} of ${row.cur.expectedQuota}` : 'no quota set'}
        />
        <ReportStat
          label="First-pass quality"
          value={fmtPct(row.cur.firstPassQualityPct)}
          sub={row.cur.delivered > 0 ? `${row.cur.firstPassClean}/${row.cur.delivered} clean` : 'none delivered'}
        />
        <ReportStat label="Production median" value={fmtDuration(row.cur.productionMedianMin)} />
        <ReportStat label="Revision rounds" value={String(row.cur.revisionRounds)} />
        <ReportStat
          label="Cancelled"
          value={String(row.cur.cancelled)}
          tone={row.cur.cancelled > 0 ? 'danger' : undefined}
        />
        <ReportStat label="Assigned" value={String(row.cur.assigned)} />
      </dl>
    </article>
  )
}

function ReportStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'danger'
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`font-medium ${tone === 'danger' ? 'text-danger' : 'text-fg'}`}>
        {value}
        {sub && <span className="ml-1 text-xs font-normal text-muted">({sub})</span>}
      </dd>
    </div>
  )
}

// ── Deterministic interpretation (§20.1 — verdicts, not data) ─────────────────

function trendDirection(cur: DesignerPeriodSummary, prev: DesignerPeriodSummary): 'up' | 'down' | 'flat' {
  let score = 0
  if (cur.firstPassQualityPct != null && prev.firstPassQualityPct != null) {
    const d = cur.firstPassQualityPct - prev.firstPassQualityPct
    score += d >= 2 ? 1 : d <= -2 ? -1 : 0
  }
  if (cur.attainmentPct != null && prev.attainmentPct != null) {
    const d = cur.attainmentPct - prev.attainmentPct
    score += d >= 5 ? 1 : d <= -5 ? -1 : 0
  }
  if (cur.cancelled > prev.cancelled) score -= 1
  return score > 0 ? 'up' : score < 0 ? 'down' : 'flat'
}

/** Template sentences only — worst signal wins; every line says what to DO. */
function interpretWeek(cur: DesignerPeriodSummary, prev: DesignerPeriodSummary, cfg: Config): string {
  if (cur.expectedQuota === 0 && cur.assigned === 0 && cur.delivered === 0) {
    return 'No expected work this week — leave, off-days, or an intake gap.'
  }
  if (cur.cancelled > 0) {
    return `${cur.cancelled} designer-fault cancellation${cur.cancelled === 1 ? '' : 's'} — read the trail before judging; act on the trend (§4.4).`
  }
  if (
    cur.firstPassQualityPct != null &&
    prev.firstPassQualityPct != null &&
    prev.firstPassQualityPct - cur.firstPassQualityPct > cfg.quality_decay_pct &&
    cur.delivered >= 2
  ) {
    const revised = cur.delivered - cur.firstPassClean
    const src =
      cur.clientCaughtRounds === 0 && cur.csrCaughtRounds > 0
        ? ', all CSR-caught'
        : cur.csrCaughtRounds === 0 && cur.clientCaughtRounds > 0
          ? ', all client-caught'
          : ''
    return `Quality slipped ${prev.firstPassQualityPct - cur.firstPassQualityPct}pp — ${revised} of ${cur.delivered} needed revision${src}. Coaching check-in.`
  }
  if (cur.attainmentPct != null && cur.attainmentPct < 60) {
    return `At ${cur.attainmentPct}% of quota — if intake fell short, that's an assignment gap (PM-owned, §11 T3), not designer slack. Check before coaching.`
  }
  if ((cur.firstPassQualityPct ?? 0) >= 90 && (cur.attainmentPct ?? 0) >= 100) {
    return 'Strong week — quota met with first-pass quality intact. Keep.'
  }
  if (
    cur.firstPassQualityPct != null &&
    prev.firstPassQualityPct != null &&
    cur.firstPassQualityPct - prev.firstPassQualityPct >= 5
  ) {
    return `Quality up ${cur.firstPassQualityPct - prev.firstPassQualityPct}pp on the prior week — whatever changed, keep it.`
  }
  return 'Steady week — no flags.'
}

/** The whole-studio paragraph, from the same computed rows the cards use. */
function buildWeeklySummary(
  rows: ReportRow[],
  period: PeriodRange,
  productionMedian: number | null,
  priorProductionMedian: number | null,
  designers: Designer[],
): string | null {
  if (rows.length === 0) return null
  const total = (pick: (r: ReportRow) => number) => rows.reduce((s, r) => s + pick(r), 0)
  const completed = total((r) => r.cur.completed)
  const expected = total((r) => r.cur.expectedQuota)
  const delivered = total((r) => r.cur.delivered)
  const clean = total((r) => r.cur.firstPassClean)
  const prevDelivered = total((r) => r.prev.delivered)
  const prevClean = total((r) => r.prev.firstPassClean)
  const cancelled = total((r) => r.cur.cancelled)

  const att = expected > 0 ? Math.round((completed / expected) * 100) : null
  const fpq = delivered > 0 ? Math.round((clean / delivered) * 100) : null
  const prevFpq = prevDelivered > 0 ? Math.round((prevClean / prevDelivered) * 100) : null

  const sentences: string[] = []
  sentences.push(
    `In the week of ${fmtDate(period.start)}–${fmtDate(period.end)}, the studio completed ${completed}${expected > 0 ? ` of ${expected} expected` : ''} projects${att != null ? ` (${att}% attainment)` : ''}.`,
  )
  if (fpq != null) {
    const deltaClause =
      prevFpq != null && fpq !== prevFpq
        ? `, ${Math.abs(fpq - prevFpq)}pp ${fpq > prevFpq ? 'up' : 'down'} on the prior week`
        : ''
    sentences.push(`First-pass quality was ${fpq}% — ${clean} of ${delivered} delivered clean${deltaClause}.`)
  }
  const teamFpq = TEAMS.map((team) => {
    const teamRows = rows.filter((r) => r.designer.team === team)
    const d = teamRows.reduce((s, r) => s + r.cur.delivered, 0)
    const c = teamRows.reduce((s, r) => s + r.cur.firstPassClean, 0)
    return { team, pct: d > 0 ? Math.round((c / d) * 100) : null }
  }).filter((t): t is { team: (typeof TEAMS)[number]; pct: number } => t.pct != null)
  if (teamFpq.length >= 2) {
    const best = [...teamFpq].sort((a, b) => b.pct - a.pct)[0]
    const worst = [...teamFpq].sort((a, b) => a.pct - b.pct)[0]
    sentences.push(`${best.team} led on quality at ${best.pct}%; ${worst.team} trailed at ${worst.pct}%.`)
  }
  if (cancelled > 0) {
    const names = rows
      .filter((r) => r.cur.cancelled > 0)
      .map((r) => `${firstName(r.designer.name)} ${r.cur.cancelled}`)
      .join(', ')
    sentences.push(
      `${cancelled} designer-fault cancellation${cancelled === 1 ? '' : 's'} (${names}) — review each trail, judge the trend.`,
    )
  } else {
    sentences.push('No designer-fault cancellations.')
  }
  if (productionMedian != null) {
    const deltaClause =
      priorProductionMedian != null && productionMedian !== priorProductionMedian
        ? ` — ${fmtDuration(Math.abs(productionMedian - priorProductionMedian))} ${productionMedian < priorProductionMedian ? 'faster' : 'slower'} than the prior week`
        : ''
    sentences.push(`Median production time was ${fmtDuration(productionMedian)}${deltaClause}.`)
  }
  if (designers.length > rows.length) {
    sentences.push(
      `${designers.length - rows.length} designer${designers.length - rows.length === 1 ? ' was' : 's were'} inactive this week (leave, off-days, or no intake).`,
    )
  }
  return sentences.join(' ')
}
