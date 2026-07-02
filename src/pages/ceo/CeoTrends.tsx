/**
 * CEO Trends (spec §13.2, §11 Tier 4): Quality Trend and Speed Trend over 12
 * weekly buckets (per team and overall) with the subject's OWN baseline —
 * the 12-week period average — drawn dashed (§22.5). Burnout Risk board is a
 * PRIVATE watch-list (§22.10) with the contributing causes in plain language.
 * Workload Forecast warns of next week's overload before it lands.
 */

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Flame, TrendingUp } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { Skeleton } from '../../components/ui/Skeleton'
import { StatTile } from '../../components/ui/StatTile'
import { TrendLine, type TrendPoint } from '../../components/ui/TrendLine'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import {
  priorPeriod,
  summarizeDesigner,
  workloadForecast,
} from '../../../shared/aggregate'
import { addDays, pktDateOf, pktToday } from '../../../shared/pkt'
import type { Team } from '../../../shared/types'
import { fmtDate, fmtDuration, fmtTime } from '../../lib/format'
import {
  TEAMS,
  activeDesigners,
  burnoutRisk,
  fpqInPeriod,
  mergeTasks,
  metricDelta,
  productionMedianInPeriod,
  useAttendanceWindow,
  useConfigValues,
  useDesigners,
  useMetricsWindow,
  useOpenTasksLive,
  useQuotaCtx,
  useTasksWindow,
  weekBuckets,
  type BurnoutRisk,
} from './ceoData'

type Scope = 'All' | Team

const SCOPE_OPTIONS: Array<{ value: Scope; label: string }> = [
  { value: 'All', label: 'Overall' },
  ...TEAMS.map((t) => ({ value: t as Scope, label: t })),
]

const mean = (values: number[]): number | null =>
  values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null

export default function CeoTrends() {
  const navigate = useNavigate()
  const today = pktToday()
  const buckets = weekBuckets(12, today)
  const windowStart = buckets[0].start
  // Burnout compares two adjacent 14-day windows (leading indicator, §11 T4).
  const cur14 = { start: addDays(today, -13), end: today }
  const prior14 = priorPeriod(cur14.start, cur14.end)

  const [scope, setScope] = useLocalStorage<Scope>('ceo:trends-scope', 'All')

  const designersQ = useDesigners()
  const cfg = useConfigValues()
  const { ctx: quota, isLoading: quotaLoading } = useQuotaCtx()
  const tasksQ = useTasksWindow(windowStart)
  const metricsQ = useMetricsWindow(windowStart, today)
  const openQ = useOpenTasksLive()
  const attendanceQ = useAttendanceWindow(prior14.start, cur14.end)

  const loading =
    designersQ.isLoading ||
    tasksQ.isLoading ||
    metricsQ.isLoading ||
    openQ.isLoading ||
    attendanceQ.isLoading ||
    quotaLoading
  const failed =
    designersQ.error ?? tasksQ.error ?? metricsQ.error ?? openQ.error ?? attendanceQ.error

  const model = useMemo(() => {
    if (
      loading ||
      !designersQ.data ||
      !tasksQ.data ||
      !metricsQ.data ||
      !openQ.data ||
      !attendanceQ.data
    )
      return null
    const active = activeDesigners(designersQ.data)
    const allTasks = mergeTasks(tasksQ.data, openQ.data)
    const metrics = metricsQ.data

    const scopeIds = new Set(
      (scope === 'All' ? active : active.filter((d) => d.team === scope)).map((d) => d.id),
    )

    // Quality Trend — weekly FPQ %, baseline = the scope's own 12-week average (§22.5).
    const qualityPoints: TrendPoint[] = []
    for (const b of buckets) {
      const slice = fpqInPeriod(metrics, scopeIds, b)
      if (slice.pct != null) qualityPoints.push({ label: fmtDate(b.start), value: slice.pct })
    }
    const qualityBaseline = mean(qualityPoints.map((p) => p.value))

    // Speed Trend — weekly production median, baseline = own period average. Lower = faster.
    const speedPoints: TrendPoint[] = []
    for (const b of buckets) {
      const med = productionMedianInPeriod(metrics, scopeIds, b)
      if (med != null) speedPoints.push({ label: fmtDate(b.start), value: med })
    }
    const speedBaseline = mean(speedPoints.map((p) => p.value))

    // Burnout Risk board — weights documented in ceoData.burnoutRisk (§11 T4).
    const curAtt = attendanceQ.data.filter((a) => a.work_date >= cur14.start && a.work_date <= cur14.end)
    const priorAtt = attendanceQ.data.filter(
      (a) => a.work_date >= prior14.start && a.work_date <= prior14.end,
    )
    const risks: Array<BurnoutRisk & { name: string; team: Team }> = active
      .map((d) => {
        const cur = summarizeDesigner(d.id, { ...cur14, tasks: allTasks, metrics, quota })
        const prev = summarizeDesigner(d.id, { ...prior14, tasks: allTasks, metrics, quota })
        return {
          ...burnoutRisk(d.id, cur, prev, curAtt, priorAtt, cfg.burnout_score, fmtDuration),
          name: d.name,
          team: d.team,
        }
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)

    // Workload Forecast — 7-day inflow vs completion (§11 T4).
    const forecast = workloadForecast(allTasks, cfg.forecast_horizon_days)
    const last7 = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6))
    const inflowSeries: TrendPoint[] = last7.map((day) => ({
      label: fmtDate(day),
      value: allTasks.filter((t) => !t.deleted && t.created_at && pktDateOf(t.created_at) === day).length,
    }))
    const completionSeries: TrendPoint[] = last7.map((day) => ({
      label: fmtDate(day),
      value: allTasks.filter(
        (t) =>
          !t.deleted &&
          t.current_status === 'complete' &&
          (t.closed_at ?? t.last_event_at) &&
          pktDateOf((t.closed_at ?? t.last_event_at)!) === day,
      ).length,
    }))

    return { qualityPoints, qualityBaseline, speedPoints, speedBaseline, risks, forecast, inflowSeries, completionSeries }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, designersQ.data, tasksQ.data, metricsQ.data, openQ.data, attendanceQ.data, quota, cfg, scope])

  const qualityRead = readVsBaseline(model?.qualityPoints, model?.qualityBaseline, {
    goodWhen: 'up',
    format: (v) => `${Math.round(v)}pp`,
    noun: 'first-pass quality',
  })
  const speedRead = readVsBaseline(model?.speedPoints, model?.speedBaseline, {
    goodWhen: 'down',
    format: (v) => fmtDuration(v),
    noun: 'production median',
  })
  const flaggedRisks = model?.risks.filter((r) => r.flagged) ?? []
  const flaggedCount = flaggedRisks.length

  // ── Page verdict (§20.1): synthesize the per-card reads into 2–4 calls ────
  const scopeLabel = scope === 'All' ? 'Studio-wide' : `${scope} team`
  const scrollTo = (id: string) => () =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const verdictItems: VerdictItem[] = []
  if (!loading && model) {
    if (qualityRead) {
      verdictItems.push({
        id: 'quality-trend',
        severity: qualityRead.tone === 'worse' ? 'warning' : 'info',
        text: `${scopeLabel} quality: ${qualityRead.text}`,
        detail: 'Latest weekly first-pass quality vs its own 12-week average (§22.5).',
        action:
          qualityRead.tone === 'worse'
            ? { label: 'Open teams', onClick: () => navigate('/ceo/teams') }
            : { label: 'See the chart', onClick: scrollTo('quality-trend-card') },
      })
    }
    if (speedRead) {
      verdictItems.push({
        id: 'speed-trend',
        severity: speedRead.tone === 'worse' ? 'warning' : 'info',
        text: `${scopeLabel} speed: ${speedRead.text}`,
        detail:
          'Median assignment → first delivery, designer-owned spans only — a slow creep up is an early burnout signal.',
        action: { label: 'See the chart', onClick: scrollTo('speed-trend-card') },
      })
    }
    if ((model.risks.length ?? 0) > 0) {
      verdictItems.push({
        id: 'burnout-watch',
        severity: flaggedCount > 0 ? 'warning' : 'info',
        text:
          flaggedCount > 0
            ? `${flaggedCount} designer${flaggedCount === 1 ? '' : 's'} over the burnout threshold (${flaggedRisks
                .map((r) => r.name)
                .join(', ')}) — check in before it becomes attrition.`
            : `${model.risks.length} on the burnout watch-list, none over threshold ${cfg.burnout_score} — worth a glance, not an intervention.`,
        detail: 'A leading indicator, not a verdict — private to this surface (§22.10).',
        action: { label: 'See the board', onClick: scrollTo('burnout-board') },
      })
    }
    if (model.forecast.inflowPerDay > model.forecast.completionPerDay) {
      const breach = model.forecast.projectedBacklog > cfg.forecast_threshold
      verdictItems.push({
        id: 'forecast',
        severity: breach ? 'warning' : 'info',
        text: `Inflow ${model.forecast.inflowPerDay}/day vs completion ${model.forecast.completionPerDay}/day — projected backlog ${model.forecast.projectedBacklog} within ${model.forecast.horizonDays} days${breach ? '. Rebalance or add capacity before it lands.' : ' — under the alert threshold, keep watching.'}`,
        action: { label: 'See the forecast', onClick: scrollTo('workload-forecast') },
      })
    }
  }
  const severityRank = { critical: 0, warning: 1, info: 2 } as const
  const sortedVerdicts = verdictItems
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
    .slice(0, 4)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold text-fg">Trends</h1>
        <p className="mt-1 text-sm text-muted">
          12 weekly buckets, each series against its own period-average baseline — decay is caught
          here before it becomes a crisis (§11 T4)
        </p>
      </header>

      {failed != null && (
        <ErrorBanner
          message={`Couldn't load trend data — ${(failed as Error).message}`}
          asOf={tasksQ.dataUpdatedAt > 0 ? fmtTime(new Date(tasksQ.dataUpdatedAt).toISOString()) : null}
          onRetry={() => {
            void tasksQ.refetch()
            void metricsQ.refetch()
            void openQ.refetch()
            void attendanceQ.refetch()
          }}
        />
      )}

      <VerdictBlock
        title={`The trend read — ${scope === 'All' ? 'overall' : scope}`}
        items={sortedVerdicts}
        emptyMessage="Quality, speed, burnout and the forecast are all steady — nothing needs a decision."
        loading={loading}
      />

      <SegmentedControl<Scope>
        options={SCOPE_OPTIONS}
        value={scope}
        onChange={setScope}
        ariaLabel="Trend scope — overall or one team"
      />

      <section className="grid gap-4 xl:grid-cols-2">
        <div id="quality-trend-card" className="card p-6">
          <h2 className="eyebrow">Quality trend — {scope === 'All' ? 'overall' : scope}</h2>
          <p className="mt-2 text-sm font-medium text-fg">
            {loading
              ? ''
              : (qualityRead?.text ?? 'Not enough delivered work yet for a quality trend.')}
          </p>
          <div className="mt-4">
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <TrendLine
                points={model?.qualityPoints ?? []}
                baseline={model?.qualityBaseline ?? null}
                tone="brand"
                formatValue={(v) => `${Math.round(v)}%`}
                ariaLabel={`Weekly first-pass quality for ${scope === 'All' ? 'the whole studio' : `the ${scope} team`} over 12 weeks`}
              />
            )}
          </div>
          <p className="mt-2 text-xs text-muted">
            First-pass quality % per week of first delivery — every revision counts against it,
            CSR- or client-caught (§4.2).
          </p>
        </div>

        <div id="speed-trend-card" className="card p-6">
          <h2 className="eyebrow">Speed trend — {scope === 'All' ? 'overall' : scope}</h2>
          <p className="mt-2 text-sm font-medium text-fg">
            {loading ? '' : (speedRead?.text ?? 'Not enough delivered work yet for a speed trend.')}
          </p>
          <div className="mt-4">
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <TrendLine
                points={model?.speedPoints ?? []}
                baseline={model?.speedBaseline ?? null}
                tone="success"
                formatValue={(v) => fmtDuration(v)}
                ariaLabel={`Weekly production median for ${scope === 'All' ? 'the whole studio' : `the ${scope} team`} over 12 weeks`}
              />
            )}
          </div>
          <p className="mt-2 text-xs text-muted">
            Median assignment → first delivery, designer-owned spans only — time parked in client
            response never counts (§4.1). Lower is faster; a slow creep up is an early burnout
            signal.
          </p>
        </div>
      </section>

      {/* ── Burnout Risk board — private watch-list (§22.10) ────────────────── */}
      <section id="burnout-board" className="card p-6" aria-label="Burnout risk board">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-muted" aria-hidden="true" />
            <h2 className="eyebrow">Burnout risk — last 14 days vs prior 14</h2>
          </div>
          {!loading && flaggedCount > 0 && (
            <Badge tone="danger">{flaggedCount} over threshold {cfg.burnout_score}</Badge>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          Composite 0–100: rising revision turnaround 40% · falling attainment 40% · shrinking
          warm-up gap with sustained presence 20% (online as usual, producing less). A leading
          indicator, not a verdict — private to this surface (§22.10).
        </p>

        {loading ? (
          <div className="mt-4 space-y-2" role="status" aria-label="Loading burnout board">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (model?.risks.length ?? 0) === 0 ? (
          <p className="mt-4 rounded-xl bg-success-soft/60 p-4 text-sm font-medium text-fg">
            No burnout signals — nobody is trending toward the red. A calm board is a feature.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border/50">
            {model!.risks.map((r) => (
              <li key={r.designerId} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3">
                <span className="min-w-[10rem] text-sm font-medium text-fg">
                  {r.name} <span className="text-xs font-normal text-muted">{r.team}</span>
                </span>
                <Badge tone={r.flagged ? 'danger' : r.score > cfg.burnout_score / 2 ? 'warning' : 'neutral'}>
                  {r.flagged ? 'Flag' : 'Watch'} {r.score}
                </Badge>
                <p className="w-full text-sm leading-snug text-muted sm:w-auto sm:flex-1">
                  {r.causes.length > 0 ? capitalize(r.causes.join(' · ')) : 'Low-grade signal only.'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Workload Forecast — the rebalance-ahead signal (§11 T4) ─────────── */}
      <section
        id="workload-forecast"
        className="grid gap-4 xl:grid-cols-[minmax(18rem,24rem),1fr]"
        aria-label="Workload forecast"
      >
        <StatTile
          eyebrow="Projected backlog"
          icon={TrendingUp}
          value={String(model?.forecast.projectedBacklog ?? 0)}
          delta={
            model
              ? metricDelta(model.forecast.projectedBacklog, model.forecast.openNow, {
                  goodWhen: 'down',
                  vs: `vs ${model.forecast.openNow} open now`,
                })
              : null
          }
          cause={
            model
              ? `Inflow ${model.forecast.inflowPerDay}/day vs completion ${model.forecast.completionPerDay}/day over the last 7 days`
              : null
          }
          reference={model ? `${model.forecast.horizonDays}-day horizon · alert threshold ${cfg.forecast_threshold}` : null}
          state={
            model == null
              ? null
              : model.forecast.projectedBacklog > cfg.forecast_threshold
                ? 'flag'
                : 'ok'
          }
          loading={loading}
        />
        <div className="card p-6">
          <h2 className="eyebrow">7-day inflow vs completion</h2>
          {loading ? (
            <Skeleton className="mt-4 h-24 w-full" />
          ) : (
            <div className="mt-4 grid gap-6 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-muted">Tasks created / day</p>
                <TrendLine
                  points={model?.inflowSeries ?? []}
                  tone="brand"
                  height={72}
                  ariaLabel="Tasks created per day over the last 7 days"
                />
              </div>
              <div>
                <p className="text-xs font-medium text-muted">Tasks completed / day</p>
                <TrendLine
                  points={model?.completionSeries ?? []}
                  tone="success"
                  height={72}
                  ariaLabel="Tasks completed per day over the last 7 days"
                />
              </div>
            </div>
          )}
          {model && (
            <p className="mt-3 text-sm text-fg">
              {model.forecast.inflowPerDay > model.forecast.completionPerDay
                ? `Inflow exceeds completion by ${Math.round((model.forecast.inflowPerDay - model.forecast.completionPerDay) * 10) / 10}/day — backlog projected to reach ${model.forecast.projectedBacklog} within ${model.forecast.horizonDays} days${model.forecast.projectedBacklog > cfg.forecast_threshold ? '; rebalance or add capacity before it lands' : ''}.`
                : `Completion is keeping pace with inflow — projected backlog ${model.forecast.projectedBacklog} in ${model.forecast.horizonDays} days. No capacity move needed.`}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

/** One-line reading of the latest point against the series' own baseline. */
function readVsBaseline(
  points: TrendPoint[] | undefined,
  baseline: number | null | undefined,
  opts: { goodWhen: 'up' | 'down'; format: (v: number) => string; noun: string },
): { text: string; tone: 'better' | 'worse' | 'steady' } | null {
  if (!points || points.length === 0 || baseline == null) return null
  const latest = points[points.length - 1].value
  const diff = latest - baseline
  if (Math.abs(diff) < 0.5) {
    return { text: `Holding at its 12-week baseline — ${opts.noun} steady.`, tone: 'steady' }
  }
  const better = opts.goodWhen === 'up' ? diff > 0 : diff < 0
  return {
    text: `${opts.format(Math.abs(diff))} ${diff > 0 ? 'above' : 'below'} its own 12-week baseline — ${opts.noun} is ${better ? 'better than usual' : 'worse than usual; watch the next two weeks'}.`,
    tone: better ? 'better' : 'worse',
  }
}
