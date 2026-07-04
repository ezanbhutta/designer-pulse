/**
 * CEO Trends (spec §13.2, §11 Tier 4): Quality Trend and Speed Trend over 12
 * weekly buckets (per team and overall) with the subject's OWN baseline —
 * the 12-week period average — drawn dashed (§22.5). Burnout Risk board is a
 * PRIVATE watch-list (§22.10) with the contributing causes in plain language.
 * Workload Forecast warns of next week's overload before it lands.
 */

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Flame, TrendingUp } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge } from '../../components/ui/Badge'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InfoTip } from '../../components/ui/InfoTip'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { Skeleton } from '../../components/ui/Skeleton'
import { StatTile } from '../../components/ui/StatTile'
import { TrendLine, type TrendPoint } from '../../components/ui/TrendLine'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { CornerTip, HeroMetric, Reveal, RevealItem } from './ceoKit'
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

    // Burnout Risk board — canonical scoring in shared/aggregate.burnoutComposite (§11 T4).
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
    // `today` stands in for buckets/cur14/prior14 (all pure functions of it)
    // so the model recomputes at the PKT day/week rollover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, designersQ.data, tasksQ.data, metricsQ.data, openQ.data, attendanceQ.data, quota, cfg, scope, today])

  const qualityRead = readVsBaseline(model?.qualityPoints, model?.qualityBaseline, {
    goodWhen: 'up',
    format: (v) => `${Math.round(v)} points`,
    noun: '"right first time"',
  })
  const speedRead = readVsBaseline(model?.speedPoints, model?.speedBaseline, {
    goodWhen: 'down',
    format: (v) => fmtDuration(v),
    noun: 'work time',
  })
  const flaggedRisks = model?.risks.filter((r) => r.flagged) ?? []
  const flaggedCount = flaggedRisks.length

  // ── Page verdict (§20.1): synthesize the per-card reads into 2–4 calls ────
  const scopeLabel = scope === 'All' ? 'Whole studio' : `${scope} team`
  const scrollTo = (id: string) => () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  }
  const verdictItems: VerdictItem[] = []
  if (!loading && model) {
    if (qualityRead) {
      verdictItems.push({
        id: 'quality-trend',
        severity: qualityRead.tone === 'worse' ? 'warning' : 'info',
        text: `${scopeLabel} quality: ${qualityRead.text}`,
        detail: 'This week\'s "right first time" score against its own 12-week average.',
        action:
          qualityRead.tone === 'worse'
            ? { label: 'See teams', onClick: () => navigate('/ceo/teams') }
            : { label: 'See the chart', onClick: scrollTo('quality-trend-card') },
      })
    }
    if (speedRead) {
      verdictItems.push({
        id: 'speed-trend',
        severity: speedRead.tone === 'worse' ? 'warning' : 'info',
        text: `${scopeLabel} speed: ${speedRead.text}`,
        detail:
          'Work time only — waiting for clients is not counted. A slow creep upward can be an early overload sign.',
        action: { label: 'See the chart', onClick: scrollTo('speed-trend-card') },
      })
    }
    if ((model.risks.length ?? 0) > 0) {
      verdictItems.push({
        id: 'burnout-watch',
        severity: flaggedCount > 0 ? 'warning' : 'info',
        text:
          flaggedCount > 0
            ? `${flaggedCount} designer${flaggedCount === 1 ? ' is' : 's are'} showing strong overload signs (${flaggedRisks
                .map((r) => r.name)
                .join(', ')}) — check in with them before they burn out.`
            : `${model.risks.length} on the overload watch-list, but nobody past the worry line (${cfg.burnout_score}) — worth a glance, nothing urgent.`,
        detail: 'An early warning only, not a judgement. Only you can see this.',
        action: { label: 'See the list', onClick: scrollTo('burnout-board') },
      })
    }
    if (model.forecast.inflowPerDay > model.forecast.completionPerDay) {
      const breach = model.forecast.projectedBacklog > cfg.forecast_threshold
      verdictItems.push({
        id: 'forecast',
        severity: breach ? 'warning' : 'info',
        text: `New projects are coming in faster than they get finished (${model.forecast.inflowPerDay} in vs ${model.forecast.completionPerDay} done per day) — about ${model.forecast.projectedBacklog} could be waiting within ${model.forecast.horizonDays} days${breach ? '. Move work around or add help before it lands.' : ' — still under the worry line, keep watching.'}`,
        action: { label: 'See the forecast', onClick: scrollTo('workload-forecast') },
      })
    }
  }
  const severityRank = { critical: 0, warning: 1, info: 2 } as const
  const sortedVerdicts = verdictItems
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
    .slice(0, 4)

  // Hero read: the latest week's quality score against its own 12-week average.
  const latestQuality =
    model && model.qualityPoints.length > 0
      ? model.qualityPoints[model.qualityPoints.length - 1].value
      : null
  const qualityDelta =
    latestQuality != null && model?.qualityBaseline != null
      ? metricDelta(latestQuality, Math.round(model.qualityBaseline), {
          goodWhen: 'up',
          format: (v) => `${v} pts`,
          vs: 'vs its 12-week average',
        })
      : null

  return (
    <div className="mx-auto w-full max-w-6xl space-y-12">
      <PageHeader
        breadcrumbs={['CEO', 'Trends']}
        title="Trends"
        titleAccessory={
          <InfoTip text="How quality, speed, overload and workload have been moving over the last 12 weeks." />
        }
        history="The last 12 weeks, week by week. Each line is compared with its own 12-week average, so problems show up early — before they become a crisis"
      />

      {failed != null && (
        <ErrorBanner
          message={`Could not load the trend numbers — ${(failed as Error).message}`}
          asOf={tasksQ.dataUpdatedAt > 0 ? fmtTime(new Date(tasksQ.dataUpdatedAt).toISOString()) : null}
          onRetry={() => {
            void tasksQ.refetch()
            void metricsQ.refetch()
            void openQ.refetch()
            void attendanceQ.refetch()
          }}
        />
      )}

      <CornerTip tip="Two to four short points that sum up what the trend charts below are saying.">
        <VerdictBlock
          title={`What the trends say — ${scope === 'All' ? 'whole studio' : scope}`}
          items={sortedVerdicts}
          emptyMessage="Quality, speed, overload and next week's load all look steady — nothing needs your attention."
          loading={loading}
        />
      </CornerTip>

      <SegmentedControl<Scope>
        options={SCOPE_OPTIONS}
        value={scope}
        onChange={setScope}
        ariaLabel="Show the whole studio or one team"
      />

      {/* ── The headline number: this week's quality vs its own past ───────── */}
      <HeroMetric
        eyebrow={`Right first time this week — ${scope === 'All' ? 'whole studio' : scope}`}
        tip="How many designs were accepted without anyone asking for changes in the latest week. Higher is better. The chip compares it with its own 12-week average."
        value={latestQuality}
        format={(n) => `${n}%`}
        delta={qualityDelta}
        caption={
          loading ? null : (qualityRead?.text ?? 'Not enough finished designs yet to show a trend.')
        }
        loading={loading}
      />

      <Reveal className="grid gap-6 xl:grid-cols-2">
        <RevealItem>
          <div id="quality-trend-card" className="card h-full p-8">
            <h2 className="eyebrow inline-flex items-center gap-1">
              Right first time — {scope === 'All' ? 'whole studio' : scope}{' '}
              <InfoTip text="Each week: how many designs were accepted without anyone asking for changes. Higher is better. The dotted line is the 12-week average." />
            </h2>
            <p className="mt-3 max-w-prose text-caption font-medium text-fg">
              {loading
                ? ''
                : (qualityRead?.text ?? 'Not enough finished designs yet to show a trend.')}
            </p>
            <div className="mt-6">
              {loading ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <TrendLine
                  points={model?.qualityPoints ?? []}
                  baseline={model?.qualityBaseline ?? null}
                  tone="brand"
                  formatValue={(v) => `${Math.round(v)}%`}
                  ariaLabel={`Designs right first time each week for ${scope === 'All' ? 'the whole studio' : `the ${scope} team`} over 12 weeks`}
                />
              )}
            </div>
            <p className="mt-3 text-label font-normal text-muted">
              Every change request counts against this score — whether a client or one of our own
              checkers asked for it.
            </p>
          </div>
        </RevealItem>

        <RevealItem>
          <div id="speed-trend-card" className="card h-full p-8">
            <h2 className="eyebrow inline-flex items-center gap-1">
              Work time — {scope === 'All' ? 'whole studio' : scope}{' '}
              <InfoTip text="Usual time from getting a project to sending the first design. Client waiting time is not counted. Lower is faster." />
            </h2>
            <p className="mt-3 max-w-prose text-caption font-medium text-fg">
              {loading ? '' : (speedRead?.text ?? 'Not enough finished designs yet to show a trend.')}
            </p>
            <div className="mt-6">
              {loading ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <TrendLine
                  points={model?.speedPoints ?? []}
                  baseline={model?.speedBaseline ?? null}
                  tone="success"
                  formatValue={(v) => fmtDuration(v)}
                  ariaLabel={`Work time each week for ${scope === 'All' ? 'the whole studio' : `the ${scope} team`} over 12 weeks`}
                />
              )}
            </div>
            <p className="mt-3 text-label font-normal text-muted">
              Lower is faster. Time spent waiting for clients is never counted. A slow creep upward
              can be an early overload sign.
            </p>
          </div>
        </RevealItem>
      </Reveal>

      {/* ── Burnout Risk board — private watch-list (§22.10) ────────────────── */}
      <section id="burnout-board" className="card p-8" aria-label="Overload warning list">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-muted" aria-hidden="true" />
            <h2 className="eyebrow inline-flex items-center gap-1">
              Overload warning — last 2 weeks vs the 2 before{' '}
              <InfoTip text="Early signs someone may be running out of steam: fixes taking longer, fewer projects finished, but still showing up as usual." />
            </h2>
          </div>
          {!loading && flaggedCount > 0 && (
            <Badge tone="danger">
              {flaggedCount} past the worry line ({cfg.burnout_score})
            </Badge>
          )}
        </div>
        <p className="mt-2 max-w-prose text-caption text-muted">
          A score from 0 to 100, built from three signs: fixes taking longer (40%), fewer projects
          finished (35%), and still showing up at least as often — starting work sooner, yet
          finishing less (25%). An early warning, not a judgement — only you can see this.
        </p>

        {loading ? (
          <div className="mt-6 space-y-2" role="status" aria-label="Loading the overload list">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (model?.risks.length ?? 0) === 0 ? (
          <div className="mt-6 flex items-center gap-3 rounded-xl bg-success-soft/60 p-4" aria-live="polite">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
            <p className="text-caption font-medium text-fg">
              No overload signs — nobody is trending the wrong way. Good news.
            </p>
          </div>
        ) : (
          <ul className="mt-6 divide-y divide-border/50">
            {model!.risks.map((r) => (
              <li key={r.designerId} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3.5">
                <span className="min-w-[10rem] text-caption font-medium text-fg">
                  {r.name} <span className="text-label font-normal text-muted">{r.team}</span>
                </span>
                <Badge tone={r.flagged ? 'danger' : r.score > cfg.burnout_score / 2 ? 'warning' : 'neutral'}>
                  {r.flagged ? 'Check in' : 'Watch'} {r.score}
                </Badge>
                <p className="w-full text-caption leading-snug text-muted sm:w-auto sm:flex-1">
                  {r.causes.length > 0 ? capitalize(r.causes.join(' · ')) : 'Only a faint signal.'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Workload Forecast — the rebalance-ahead signal (§11 T4) ─────────── */}
      <section
        id="workload-forecast"
        className="grid gap-6 xl:grid-cols-[minmax(18rem,24rem),1fr]"
        aria-label="Next week's load"
      >
        {/* No delta chip here — a red "+N" beside a green "On track" pill reads as
            two contradictory signals; the comparison lives in the cause line. */}
        <StatTile
          eyebrow="Next week's load"
          tip="If new projects keep coming in faster than they get finished, this shows the pile-up coming."
          icon={TrendingUp}
          value={String(model?.forecast.projectedBacklog ?? 0)}
          cause={
            model
              ? `vs ${model.forecast.openNow} open now — ${model.forecast.inflowPerDay} new per day vs ${model.forecast.completionPerDay} finished per day over the last 7 days`
              : null
          }
          reference={model ? `Looking ${model.forecast.horizonDays} days ahead · we flag above ${cfg.forecast_threshold}` : null}
          state={
            model == null
              ? null
              : model.forecast.projectedBacklog > cfg.forecast_threshold
                ? 'flag'
                : 'ok'
          }
          loading={loading}
        />
        <div className="card p-8">
          <h2 className="eyebrow inline-flex items-center gap-1">
            New vs finished — last 7 days{' '}
            <InfoTip text="Left: how many new projects arrived each day. Right: how many got finished. If new keeps beating finished, work piles up." />
          </h2>
          {loading ? (
            <Skeleton className="mt-6 h-24 w-full" />
          ) : (
            <div className="mt-6 grid gap-8 sm:grid-cols-2">
              <div>
                <p className="text-label font-medium text-muted">New projects per day</p>
                <TrendLine
                  points={model?.inflowSeries ?? []}
                  tone="brand"
                  height={72}
                  ariaLabel="New projects per day over the last 7 days"
                />
              </div>
              <div>
                <p className="text-label font-medium text-muted">Projects finished per day</p>
                <TrendLine
                  points={model?.completionSeries ?? []}
                  tone="success"
                  height={72}
                  ariaLabel="Projects finished per day over the last 7 days"
                />
              </div>
            </div>
          )}
          {model && (
            <p className="mt-4 max-w-prose text-caption text-fg">
              {model.forecast.inflowPerDay > model.forecast.completionPerDay
                ? `New projects are beating finished ones by ${Math.round((model.forecast.inflowPerDay - model.forecast.completionPerDay) * 10) / 10} a day — about ${model.forecast.projectedBacklog} could be waiting within ${model.forecast.horizonDays} days${model.forecast.projectedBacklog > cfg.forecast_threshold ? '. Move work around or add help before it lands' : ''}.`
                : `Finishing is keeping up with new work — about ${model.forecast.projectedBacklog} open in ${model.forecast.horizonDays} days. Nothing to change.`}
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
    return { text: `Right on its 12-week average — ${opts.noun} is steady.`, tone: 'steady' }
  }
  const better = opts.goodWhen === 'up' ? diff > 0 : diff < 0
  return {
    text: `${opts.format(Math.abs(diff))} ${diff > 0 ? 'above' : 'below'} its own 12-week average — ${opts.noun} is ${better ? 'better than usual' : 'worse than usual; watch the next two weeks'}.`,
    tone: better ? 'better' : 'worse',
  }
}
