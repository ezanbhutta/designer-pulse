/**
 * CEO Overview (spec §13.2, §20.11) — LEADS with the Verdict block: at most
 * five plain-language, pre-interpreted calls for this week vs last, each with
 * an in-app next step. The dashboard interprets; the CEO decides. Read-only
 * on operations (§22.1). Individual keep/coach/cut interpretation lives here,
 * privately — never on any designer-visible surface (§22.10).
 */

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, GitBranch, Package, ShieldCheck, Sparkles } from 'lucide-react'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { StatTile } from '../../components/ui/StatTile'
import { HBar, type HBarRow } from '../../components/ui/HBar'
import { DeltaChip } from '../../components/ui/DeltaChip'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { Skeleton } from '../../components/ui/Skeleton'
import {
  ageMinutes,
  pipelineBottleneck,
  summarizeDesigner,
  workloadForecast,
  type DesignerPeriodSummary,
} from '../../../shared/aggregate'
import { STATUS_ORDER, STATUS_LABELS, STATUS_TONES } from '../../../shared/statuses'
import { pktToday } from '../../../shared/pkt'
import type { Designer } from '../../../shared/types'
import { fmtDate, fmtDuration, fmtPct, fmtTime } from '../../lib/format'
import {
  TEAMS,
  activeDesigners,
  agingThresholdMin,
  cancelledInPeriod,
  constraintRead,
  firstName,
  fpqInPeriod,
  completionsInPeriod,
  clientWaitMedianInPeriod,
  mergeTasks,
  metricDelta,
  sameWindowLastWeek,
  thisWeekRange,
  useConfigValues,
  useDesigners,
  useMetricsWindow,
  useOpenTasksLive,
  useQuotaCtx,
  useTasksWindow,
  weekBuckets,
} from './ceoData'

interface OutlierRow {
  designer: Designer
  value: number
  sample: string
  delta: ReturnType<typeof metricDelta>
}

export default function CeoOverview() {
  const navigate = useNavigate()
  const today = pktToday()
  const week = thisWeekRange(today)
  // Week-to-date vs the SAME window last week (Mon..same weekday) — §20.4.
  const prior = sameWindowLastWeek(week)
  const buckets = weekBuckets(8, today)
  const windowStart = buckets[0].start

  const designersQ = useDesigners()
  const cfg = useConfigValues()
  const { ctx: quota, isLoading: quotaLoading } = useQuotaCtx()
  const tasksQ = useTasksWindow(windowStart)
  const metricsQ = useMetricsWindow(windowStart, today)
  const openQ = useOpenTasksLive()

  const loading =
    designersQ.isLoading || tasksQ.isLoading || metricsQ.isLoading || openQ.isLoading || quotaLoading
  const failed = designersQ.error ?? tasksQ.error ?? metricsQ.error ?? openQ.error
  const lastGood = Math.max(
    designersQ.dataUpdatedAt,
    tasksQ.dataUpdatedAt,
    metricsQ.dataUpdatedAt,
    openQ.dataUpdatedAt,
  )

  const model = useMemo(() => {
    if (loading || !designersQ.data || !tasksQ.data || !metricsQ.data || !openQ.data) return null
    const active = activeDesigners(designersQ.data)
    const activeIds = new Set(active.map((d) => d.id))
    const allTasks = mergeTasks(tasksQ.data, openQ.data)
    const metrics = metricsQ.data
    const now = new Date()

    // Per-designer summaries, this week vs the same elapsed window last week.
    const cur = new Map<string, DesignerPeriodSummary>()
    const prev = new Map<string, DesignerPeriodSummary>()
    for (const d of active) {
      cur.set(d.id, summarizeDesigner(d.id, { ...week, tasks: allTasks, metrics, quota }))
      prev.set(d.id, summarizeDesigner(d.id, { ...prior, tasks: allTasks, metrics, quota }))
    }

    // Studio + team slices
    const fpqNow = fpqInPeriod(metrics, activeIds, week)
    const fpqPrev = fpqInPeriod(metrics, activeIds, prior)
    const completionsNow = completionsInPeriod(allTasks, activeIds, week)
    const completionsPrev = completionsInPeriod(allTasks, activeIds, prior)
    const clientWaitNow = clientWaitMedianInPeriod(metrics, activeIds, week)
    const clientWaitPrev = clientWaitMedianInPeriod(metrics, activeIds, prior)
    const clientWaitSample = metrics.filter(
      (m) =>
        m.designer_id != null &&
        activeIds.has(m.designer_id) &&
        m.client_wait_min != null &&
        m.first_delivered_at != null,
    ).length

    const teamOf = new Map(active.map((d) => [d.id, d.team]))
    const teamIds = new Map(TEAMS.map((t) => [t, new Set(active.filter((d) => d.team === t).map((d) => d.id))]))
    const teamFpqLine = TEAMS.map((t) => ({ team: t, fpq: fpqInPeriod(metrics, teamIds.get(t)!, week) }))
      .filter((x) => x.fpq.pct != null)
      .map((x) => `${x.team} ${x.fpq.pct}%`)
      .join(' · ')
    const teamCompletionsLine = TEAMS.map(
      (t) => ({ team: t, n: completionsInPeriod(allTasks, teamIds.get(t)!, week) }),
    )
      .filter((x) => x.n > 0)
      .map((x) => `${x.team} ${x.n}`)
      .join(' · ')

    const weeklyCompletions = buckets.map((b) => completionsInPeriod(allTasks, activeIds, b))
    const weeklyAvg = weeklyCompletions.length
      ? Math.round(weeklyCompletions.reduce((s, v) => s + v, 0) / weeklyCompletions.length)
      : 0

    // Pipeline + forecast
    const bottleneck = pipelineBottleneck(openQ.data, now)
    const constraint = constraintRead(bottleneck, fmtDuration)
    const forecast = workloadForecast(allTasks, cfg.forecast_horizon_days, now)

    // ── Verdicts (§13.2 — 3–5 calls, decisions not data) ────────────────────
    const verdicts: VerdictItem[] = []

    // (d) Cancellations this week — critical, with the review link.
    const cancelledNow = cancelledInPeriod(allTasks, activeIds, week)
    const cancelledPrev = cancelledInPeriod(allTasks, activeIds, prior)
    if (cancelledNow.length > 0) {
      const perDesigner = new Map<string, number>()
      for (const t of cancelledNow) {
        const name = active.find((d) => d.id === t.designer_id)?.name
        if (name) perDesigner.set(firstName(name), (perDesigner.get(firstName(name)) ?? 0) + 1)
      }
      const names = [...perDesigner.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([n, c]) => `${n} ${c}`)
        .join(' · ')
      verdicts.push({
        id: 'cancellations',
        severity: 'critical',
        text: `${cancelledNow.length} cancellation${cancelledNow.length === 1 ? '' : 's'} this week (${names}) — designer-fault terminal losses by definition.`,
        detail: `${cancelledPrev.length} at this point last week. Fault is CSR-judged at close — review each trail, act on the trend (§4.4).`,
        action: { label: 'Review trails', onClick: () => navigate('/ceo/cancellations') },
      })
    }

    // (a) First-pass-quality decay past the config threshold — coaching calls.
    const decays = active
      .map((d) => {
        const c = cur.get(d.id)!
        const p = prev.get(d.id)!
        if (c.firstPassQualityPct == null || p.firstPassQualityPct == null) return null
        if (c.delivered < 2) return null // one bad task is noise, not a verdict
        const drop = p.firstPassQualityPct - c.firstPassQualityPct
        if (drop <= cfg.quality_decay_pct) return null
        return { d, c, p, drop }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => b.drop - a.drop)
      .slice(0, 2)
    for (const { d, c, p, drop } of decays) {
      const revised = c.delivered - c.firstPassClean
      const sourceClause =
        c.clientCaughtRounds === 0 && c.csrCaughtRounds > 0
          ? ', all CSR-caught'
          : c.csrCaughtRounds === 0 && c.clientCaughtRounds > 0
            ? ', all client-caught'
            : c.csrCaughtRounds + c.clientCaughtRounds > 0
              ? `, ${c.csrCaughtRounds} CSR-caught / ${c.clientCaughtRounds} client-caught`
              : ''
      const call =
        c.clientCaughtRounds > c.csrCaughtRounds
          ? 'Check the CSR gate and the brief.' // §4.2 — client-caught heavy points at the gate, not only the designer
          : 'Coaching flag.'
      verdicts.push({
        id: `decay-${d.id}`,
        severity: 'warning',
        text: `${firstName(d.name)}'s first-pass quality fell ${drop}pp this week — ${revised} of ${c.delivered} delivered went to revision${sourceClause}. ${call}`,
        detail: `${p.firstPassQualityPct}% → ${c.firstPassQualityPct}%, past the ${cfg.quality_decay_pct}pp decay threshold (${d.team} team).`,
        action: { label: 'Open trends', onClick: () => navigate('/ceo/trends') },
      })
    }

    // (b) The pipeline constraint, read in one line from the aging picture.
    const aging = openQ.data.filter(
      (t) => !t.deleted && ageMinutes(t, now) > agingThresholdMin(t.current_status, cfg),
    )
    if (aging.length > 0) {
      const byTeam = new Map<string, typeof aging>()
      for (const t of aging) {
        const team = t.designer_id ? teamOf.get(t.designer_id) : undefined
        if (!team) continue
        byTeam.set(team, [...(byTeam.get(team) ?? []), t])
      }
      const topTeam = [...byTeam.entries()].sort((a, b) => b[1].length - a[1].length)[0]
      if (topTeam) {
        const [team, teamAging] = topTeam
        const byStatus = new Map<string, number>()
        for (const t of teamAging)
          if (t.current_status) byStatus.set(t.current_status, (byStatus.get(t.current_status) ?? 0) + 1)
        const topStatus = [...byStatus.entries()].sort((a, b) => b[1] - a[1])[0]
        if (topStatus) {
          const share = Math.round((topStatus[1] / teamAging.length) * 100)
          verdicts.push({
            id: 'constraint',
            severity: 'warning',
            text: `${team} team is the constraint — ${share}% of its ${teamAging.length} aging tasks sit in ${STATUS_LABELS[topStatus[0] as keyof typeof STATUS_LABELS].toLowerCase()}.`,
            detail: `${aging.length} tasks past the aging threshold studio-wide.${constraint ? ` ${constraint.line}` : ''}`,
            action: { label: 'Open teams', onClick: () => navigate('/ceo/teams') },
          })
        }
      }
    }

    // (c) Forecast breach — the hire/rebalance-ahead signal.
    if (forecast.projectedBacklog > cfg.forecast_threshold && forecast.inflowPerDay > forecast.completionPerDay) {
      verdicts.push({
        id: 'forecast',
        severity: 'warning',
        text: `Inflow ${forecast.inflowPerDay}/day vs completion ${forecast.completionPerDay}/day — projected backlog ${forecast.projectedBacklog} by next week. Consider capacity or a rebalance.`,
        detail: `${forecast.openNow} open now · ${forecast.horizonDays}-day horizon · alert threshold ${cfg.forecast_threshold}.`,
        action: { label: 'Open forecast', onClick: () => navigate('/ceo/trends') },
      })
    }

    // (e) A standout positive when nothing is wrong — calm verdicts are features.
    if (verdicts.length === 0 && (fpqNow.delivered > 0 || completionsNow > 0)) {
      if (fpqNow.pct != null && fpqPrev.pct != null && fpqNow.pct >= fpqPrev.pct) {
        verdicts.push({
          id: 'positive-fpq',
          severity: 'info',
          text: `First-pass quality ${fpqNow.pct > fpqPrev.pct ? `rose ${fpqNow.pct - fpqPrev.pct}pp to` : 'is holding at'} ${fpqNow.pct}% — ${fpqNow.clean} of ${fpqNow.delivered} delivered clean this week. Nothing needs a decision.`,
          detail: 'No quality decay, no forecast breach, no cancellations, no aging pile-up.',
          action: { label: 'See trends', onClick: () => navigate('/ceo/trends') },
        })
      } else {
        verdicts.push({
          id: 'positive-throughput',
          severity: 'info',
          text: `${completionsNow} completion${completionsNow === 1 ? '' : 's'} so far this week (${completionsPrev} at this point last week) with no cancellations or quality flags. Calm week.`,
          detail: 'No quality decay, no forecast breach, no aging pile-up.',
          action: { label: 'See teams', onClick: () => navigate('/ceo/teams') },
        })
      }
    }

    const severityRank = { critical: 0, warning: 1, info: 2 } as const
    const sortedVerdicts = verdicts
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
      .slice(0, 5)

    // ── Outliers (normalized only — Attainment / FPQ, never raw counts §2) ──
    const fpqRanked: OutlierRow[] = active
      .map((d) => ({ d, c: cur.get(d.id)!, p: prev.get(d.id)! }))
      .filter((x) => x.c.firstPassQualityPct != null && x.c.delivered >= 1)
      .map((x) => ({
        designer: x.d,
        value: x.c.firstPassQualityPct!,
        sample: `${x.c.firstPassClean}/${x.c.delivered} clean`,
        delta: metricDelta(x.c.firstPassQualityPct, x.p.firstPassQualityPct, {
          goodWhen: 'up',
          format: (v) => `${v}pp`,
          vs: '',
        }),
      }))
      .sort((a, b) => b.value - a.value)
    const attRanked: OutlierRow[] = active
      .map((d) => ({ d, c: cur.get(d.id)!, p: prev.get(d.id)! }))
      .filter((x) => x.c.attainmentPct != null && x.c.expectedQuota > 0)
      .map((x) => ({
        designer: x.d,
        value: x.c.attainmentPct!,
        sample: `${x.c.completed} of ${x.c.expectedQuota} expected`,
        delta: metricDelta(x.c.attainmentPct, x.p.attainmentPct, {
          goodWhen: 'up',
          format: (v) => `${v}pp`,
          vs: '',
        }),
      }))
      .sort((a, b) => b.value - a.value)

    const bottleneckRows: HBarRow[] = bottleneck
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
      .map((r) => ({
        label: STATUS_LABELS[r.status],
        value: r.medianAgeMin ?? 0,
        secondary: `${r.count} open`,
        tone: STATUS_TONES[r.status],
      }))

    return {
      verdicts: sortedVerdicts,
      fpqNow,
      fpqPrev,
      completionsNow,
      completionsPrev,
      clientWaitNow,
      clientWaitPrev,
      clientWaitSample,
      teamFpqLine,
      teamCompletionsLine,
      weeklyCompletions,
      weeklyAvg,
      bottleneckRows,
      constraint,
      fpqRanked,
      attRanked,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, designersQ.data, tasksQ.data, metricsQ.data, openQ.data, quota, cfg, navigate])

  const fpqDrop =
    model?.fpqNow.pct != null && model.fpqPrev.pct != null ? model.fpqPrev.pct - model.fpqNow.pct : 0

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold text-fg">Overview</h1>
        <p className="mt-1 text-sm text-muted">
          Week of {fmtDate(week.start)} vs the same point last week · all times PKT · read-only
          decision cockpit — assignment happens in ClickUp
        </p>
      </header>

      {failed != null && (
        <ErrorBanner
          message={`Couldn't load studio data — ${(failed as Error).message}`}
          asOf={lastGood > 0 ? fmtTime(new Date(lastGood).toISOString()) : null}
          onRetry={() => {
            void designersQ.refetch()
            void tasksQ.refetch()
            void metricsQ.refetch()
            void openQ.refetch()
          }}
        />
      )}

      <VerdictBlock
        title="This week's calls"
        items={model?.verdicts ?? []}
        emptyMessage="No calls this week — quality, capacity, and the pipeline are all steady."
        loading={loading}
      />

      {/* ── Team health (§13.2): every number with delta + cause + reference ── */}
      <section aria-label="Team health" className="grid gap-4 md:grid-cols-3">
        <StatTile
          eyebrow="Team throughput"
          icon={Package}
          value={String(model?.completionsNow ?? 0)}
          delta={model ? metricDelta(model.completionsNow, model.completionsPrev, { goodWhen: 'up' }) : null}
          cause={
            model
              ? model.teamCompletionsLine
                ? `Completions this week — ${model.teamCompletionsLine}`
                : 'No completions yet this week'
              : null
          }
          reference={model ? `8-week average ${model.weeklyAvg}/wk` : null}
          sparkline={model?.weeklyCompletions}
          loading={loading}
        />
        <StatTile
          eyebrow="Team first-pass quality"
          icon={ShieldCheck}
          value={fmtPct(model?.fpqNow.pct ?? null)}
          delta={
            model
              ? metricDelta(model.fpqNow.pct, model.fpqPrev.pct, { goodWhen: 'up', format: (v) => `${v}pp` })
              : null
          }
          cause={
            model && model.fpqNow.delivered > 0
              ? `${model.fpqNow.clean} of ${model.fpqNow.delivered} delivered clean — ${model.fpqNow.csrCaughtRounds} CSR-caught, ${model.fpqNow.clientCaughtRounds} client-caught rounds`
              : 'Nothing delivered yet this week'
          }
          reference={model?.teamFpqLine ? `By team: ${model.teamFpqLine}` : null}
          state={
            model?.fpqNow.pct == null
              ? null
              : fpqDrop > cfg.quality_decay_pct
                ? 'flag'
                : fpqDrop > cfg.quality_decay_pct / 2
                  ? 'watch'
                  : 'ok'
          }
          loading={loading}
        />
        <StatTile
          eyebrow="Client wait (median)"
          icon={Clock}
          value={fmtDuration(model?.clientWaitNow ?? null)}
          delta={
            model
              ? metricDelta(model.clientWaitNow, model.clientWaitPrev, {
                  goodWhen: 'down',
                  format: (v) => fmtDuration(v),
                })
              : null
          }
          cause="Client-owned clock — isolated so client drag never reads as team drag (§4.1)"
          reference={
            model
              ? `${model.clientWaitSample} delivered task${model.clientWaitSample === 1 ? '' : 's'} waited on a client in this window`
              : null
          }
          loading={loading}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {/* ── Pipeline Bottleneck (§22.5 — named exactly this) ─────────────── */}
        <div className="card p-6">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted" aria-hidden="true" />
            <h2 className="eyebrow">Pipeline Bottleneck</h2>
          </div>
          <p className="mt-2 text-sm font-medium text-fg">
            {model?.constraint?.line ?? (loading ? '' : 'No open tasks — the pipeline is clear.')}
          </p>
          <p className="mt-1 text-xs text-muted">
            Median time-in-status per open status; open count secondary. Answers whether the
            constraint is production, the CSR gate, or the client.
          </p>
          <div className="mt-4">
            {loading ? (
              <div className="space-y-2" role="status" aria-label="Loading pipeline">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              <HBar
                rows={model?.bottleneckRows ?? []}
                formatValue={(v) => fmtDuration(v)}
                ariaLabel="Median time in each pipeline status"
              />
            )}
          </div>
        </div>

        {/* ── Outliers — normalized, cross-team-fair, PRIVATE (§22.10) ─────── */}
        <div className="card p-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted" aria-hidden="true" />
            <h2 className="eyebrow">Outliers — this week</h2>
          </div>
          <p className="mt-1 text-xs text-muted">
            First-pass quality and attainment only — never raw counts; a logo and a 25-page brand
            guide are different units (§2).
          </p>
          {loading ? (
            <div className="mt-4 space-y-2" role="status" aria-label="Loading outliers">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : (
            <div className="mt-4 grid gap-6 sm:grid-cols-2">
              <OutlierList title="First-pass quality" rows={model?.fpqRanked ?? []} />
              <OutlierList title="Quota attainment" rows={model?.attRanked ?? []} />
            </div>
          )}
          <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
            Private to this surface — designers are never shown rankings; metrics aim coaching,
            not shaming (§22.10).
          </p>
        </div>
      </section>
    </div>
  )
}

/** Top-3 / bottom-3 compact list. Bottom half is worst-first — the eye lands on the problem. */
function OutlierList({ title, rows }: { title: string; rows: OutlierRow[] }) {
  if (rows.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <p className="mt-2 text-sm text-muted">No data yet this week.</p>
      </div>
    )
  }
  const top = rows.slice(0, 3)
  const bottom = rows.length > 3 ? rows.slice(-Math.min(3, rows.length - top.length)).reverse() : []
  return (
    <div>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-success">Top</p>
      <ul className="mt-1">
        {top.map((r) => (
          <OutlierItem key={r.designer.id} row={r} />
        ))}
      </ul>
      {bottom.length > 0 && (
        <>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-warning">
            Needs attention
          </p>
          <ul className="mt-1">
            {bottom.map((r) => (
              <OutlierItem key={r.designer.id} row={r} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function OutlierItem({ row }: { row: OutlierRow }) {
  return (
    <li className="flex items-center gap-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm text-fg">
        {row.designer.name} <span className="text-xs text-muted">{row.designer.team}</span>
      </span>
      <span className="tnum shrink-0 text-sm font-medium text-fg" title={row.sample}>
        {row.value}%
      </span>
      {row.delta && row.delta.direction !== 'flat' && (
        <DeltaChip direction={row.delta.direction} good={row.delta.good} label={row.delta.label.trim()} />
      )}
    </li>
  )
}
