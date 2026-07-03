/**
 * CEO Overview (spec §13.2, §20.11) — LEADS with the Verdict block: at most
 * five plain-language, pre-interpreted calls for this week vs last, each with
 * an in-app next step. The dashboard interprets; the CEO decides. Read-only
 * on operations (§22.1). Individual keep/coach/cut interpretation lives here,
 * privately — never on any designer-visible surface (§22.10).
 */

import { useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, GitBranch, Package, ShieldCheck, Sparkles } from 'lucide-react'
import { InfoTip } from '../../components/ui/InfoTip'
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
        text: `${cancelledNow.length} order${cancelledNow.length === 1 ? '' : 's'} lost this week because of design problems (${names}).`,
        detail: `${cancelledPrev.length} at this point last week. Open each one and read its full story before judging anyone — look for a pattern, not one bad week.`,
        action: { label: 'Review them', onClick: () => navigate('/ceo/cancellations') },
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
          ? ' — all caught by our own checkers'
          : c.csrCaughtRounds === 0 && c.clientCaughtRounds > 0
            ? ' — all caught by clients'
            : c.csrCaughtRounds + c.clientCaughtRounds > 0
              ? ` — ${c.csrCaughtRounds} caught by our checkers, ${c.clientCaughtRounds} by clients`
              : ''
      const call =
        c.clientCaughtRounds > c.csrCaughtRounds
          ? 'Clients caught most of these, so also check our own checking step and the brief.' // §4.2 — client-caught heavy points at the gate, not only the designer
          : 'Worth a coaching chat.'
      verdicts.push({
        id: `decay-${d.id}`,
        severity: 'warning',
        text: `${firstName(d.name)}'s designs are getting sent back more often this week — ${revised} of ${c.delivered} needed changes${sourceClause}. ${call}`,
        detail: `"Right first time" fell from ${p.firstPassQualityPct}% to ${c.firstPassQualityPct}% — a bigger drop than we normally allow (${d.team} team).`,
        action: { label: 'See trends', onClick: () => navigate('/ceo/trends') },
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
            text: `Work is piling up in the ${team} team — ${share}% of its ${teamAging.length} slow-moving projects are stuck at "${STATUS_LABELS[topStatus[0] as keyof typeof STATUS_LABELS].toLowerCase()}".`,
            detail: `${aging.length} project${aging.length === 1 ? ' has' : 's have'} been sitting longer than they should across the studio.${constraint ? ` ${constraint.line}` : ''}`,
            action: { label: 'See teams', onClick: () => navigate('/ceo/teams') },
          })
        }
      }
    }

    // (c) Forecast breach — the hire/rebalance-ahead signal.
    if (forecast.projectedBacklog > cfg.forecast_threshold && forecast.inflowPerDay > forecast.completionPerDay) {
      verdicts.push({
        id: 'forecast',
        severity: 'warning',
        text: `New projects are coming in faster than they get finished — ${forecast.inflowPerDay} in vs ${forecast.completionPerDay} done per day. If this keeps up, about ${forecast.projectedBacklog} projects will be waiting by next week. Consider adding help or moving work around.`,
        detail: `${forecast.openNow} projects open right now · looking ${forecast.horizonDays} days ahead · we raise a flag above ${cfg.forecast_threshold}.`,
        action: { label: 'See forecast', onClick: () => navigate('/ceo/trends') },
      })
    }

    // (e) A standout positive when nothing is wrong — calm verdicts are features.
    if (verdicts.length === 0 && (fpqNow.delivered > 0 || completionsNow > 0)) {
      if (fpqNow.pct != null && fpqPrev.pct != null && fpqNow.pct >= fpqPrev.pct) {
        verdicts.push({
          id: 'positive-fpq',
          severity: 'info',
          text: `${fpqNow.pct > fpqPrev.pct ? `More designs are being accepted first time — ${fpqNow.pct}% this week, up from ${fpqPrev.pct}%` : `Designs accepted first time are holding steady at ${fpqNow.pct}%`} (${fpqNow.clean} of ${fpqNow.delivered}). Nothing needs your attention.`,
          detail: 'No quality dropping, no pile-up coming, no lost orders, no stuck projects.',
          action: { label: 'See trends', onClick: () => navigate('/ceo/trends') },
        })
      } else {
        verdicts.push({
          id: 'positive-throughput',
          severity: 'info',
          text: `${completionsNow} project${completionsNow === 1 ? '' : 's'} finished so far this week (${completionsPrev} at this point last week), with no lost orders and no quality worries. A calm week.`,
          detail: 'No quality dropping, no pile-up coming, no stuck projects.',
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
        sample: `${x.c.firstPassClean} of ${x.c.delivered} designs needed no changes`,
        delta: metricDelta(x.c.firstPassQualityPct, x.p.firstPassQualityPct, {
          goodWhen: 'up',
          format: (v) => `${v} pts`,
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
        sample: `${x.c.completed} of ${x.c.expectedQuota} planned projects finished`,
        delta: metricDelta(x.c.attainmentPct, x.p.attainmentPct, {
          goodWhen: 'up',
          format: (v) => `${v} pts`,
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
        <h1 className="inline-flex items-center gap-2 text-3xl font-semibold text-fg">
          Overview{' '}
          <InfoTip text="A quick look at the whole studio this week — what is going well and what needs your attention." />
        </h1>
        <p className="mt-1 text-sm text-muted">
          Week of {fmtDate(week.start)}, compared with the same days last week · all times are
          Pakistan time · this page is view-only — work is assigned in ClickUp
        </p>
      </header>

      {failed != null && (
        <ErrorBanner
          message={`Could not load the studio numbers — ${(failed as Error).message}`}
          asOf={lastGood > 0 ? fmtTime(new Date(lastGood).toISOString()) : null}
          onRetry={() => {
            void designersQ.refetch()
            void tasksQ.refetch()
            void metricsQ.refetch()
            void openQ.refetch()
          }}
        />
      )}

      <CornerTip tip="Up to five plain-language points about this week, worst first. Each one says what happened and what you can do next.">
        <VerdictBlock
          title="What to know this week"
          items={model?.verdicts ?? []}
          emptyMessage="Nothing needs your attention this week — quality, speed and workload all look steady."
          loading={loading}
        />
      </CornerTip>

      {/* ── Team health (§13.2): every number with delta + cause + reference ── */}
      <section aria-label="Studio health this week" className="grid gap-4 md:grid-cols-3">
        <CornerTip tip="How many projects the team closes each week.">
          <StatTile
            eyebrow="Finished per week"
            icon={Package}
            value={String(model?.completionsNow ?? 0)}
            delta={model ? metricDelta(model.completionsNow, model.completionsPrev, { goodWhen: 'up' }) : null}
            cause={
              model
                ? model.teamCompletionsLine
                  ? `Finished so far this week — ${model.teamCompletionsLine}`
                  : 'Nothing finished yet this week'
                : null
            }
            reference={model ? `8-week average ${model.weeklyAvg}/wk` : null}
            sparkline={model?.weeklyCompletions}
            loading={loading}
          />
        </CornerTip>
        <CornerTip
          tip="How many designs were accepted without anyone asking for changes. Higher is better."
          below
        >
          <StatTile
            eyebrow="Right first time"
            icon={ShieldCheck}
            value={fmtPct(model?.fpqNow.pct ?? null)}
            delta={
              model
                ? metricDelta(model.fpqNow.pct, model.fpqPrev.pct, { goodWhen: 'up', format: (v) => `${v} pts` })
                : null
            }
            cause={
              model && model.fpqNow.delivered > 0
                ? `${model.fpqNow.clean} of ${model.fpqNow.delivered} designs accepted with no changes — ${model.fpqNow.csrCaughtRounds} change requests from our checkers, ${model.fpqNow.clientCaughtRounds} from clients`
                : 'No designs sent yet this week'
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
        </CornerTip>
        <CornerTip tip="How long clients take to reply. This is the client's time, not the team's.">
          <StatTile
            eyebrow="Client waiting time"
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
            cause="Time spent waiting for clients to reply — it never counts against the team"
            reference={
              model
                ? `${model.clientWaitSample} project${model.clientWaitSample === 1 ? '' : 's'} waited on a client reply in this window`
                : null
            }
            loading={loading}
          />
        </CornerTip>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {/* ── Pipeline Bottleneck (§22.5) — shown as "Where work waits" ────── */}
        <div className="card p-6">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted" aria-hidden="true" />
            <h2 className="eyebrow inline-flex items-center gap-1">
              Where work waits{' '}
              <InfoTip text="Shows which step projects sit in the longest — making, checking, or waiting for clients." />
            </h2>
          </div>
          <p className="mt-2 text-sm font-medium text-fg">
            {model?.constraint?.line ?? (loading ? '' : 'No open projects right now — nothing is waiting.')}
          </p>
          <p className="mt-1 text-xs text-muted">
            For each step, the bar shows how long open projects have usually been sitting there.
          </p>
          <div className="mt-4">
            {loading ? (
              <div className="space-y-2" role="status" aria-label="Loading the waiting picture">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              <HBar
                rows={model?.bottleneckRows ?? []}
                formatValue={(v) => fmtDuration(v)}
                ariaLabel="How long projects usually sit in each step"
              />
            )}
          </div>
        </div>

        {/* ── Outliers — normalized, cross-team-fair, PRIVATE (§22.10) ─────── */}
        <div className="card p-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted" aria-hidden="true" />
            <h2 className="eyebrow inline-flex items-center gap-1">
              Stand-outs this week{' '}
              <InfoTip text="The strongest and weakest results this week, using fair measures only — never raw project counts." />
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted">
            Compared on &quot;Right first time&quot; and &quot;Target met&quot; only — never raw
            counts, because a small logo and a 25-page brand guide are not the same amount of work.
          </p>
          {loading ? (
            <div className="mt-4 space-y-2" role="status" aria-label="Loading stand-outs">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : (
            <div className="mt-4 grid gap-6 sm:grid-cols-2">
              <OutlierList
                title="Right first time"
                tip="How many designs were accepted without anyone asking for changes. Higher is better."
                rows={model?.fpqRanked ?? []}
              />
              <OutlierList
                title="Target met"
                tip="Out of the projects they were supposed to take, how many they finished. This is the only fair way to compare different teams."
                rows={model?.attRanked ?? []}
              />
            </div>
          )}
          <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
            Only you can see this list — designers are never shown rankings. Use it for coaching,
            not shaming.
          </p>
        </div>
      </section>
    </div>
  )
}

/**
 * Places a small ⓘ in the corner of a card whose component only accepts a
 * plain-string heading (StatTile, VerdictBlock). `below` drops the icon under
 * the tile's top-right state pill so the two never overlap.
 */
function CornerTip({ tip, below, children }: { tip: string; below?: boolean; children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className={`absolute right-4 ${below ? 'top-11' : 'top-4'}`}>
        <InfoTip text={tip} />
      </span>
    </div>
  )
}

/** Top-3 / bottom-3 compact list. Bottom half is worst-first — the eye lands on the problem. */
function OutlierList({ title, tip, rows }: { title: string; tip: string; rows: OutlierRow[] }) {
  const heading = (
    <h3 className="inline-flex items-center gap-1 text-sm font-semibold text-fg">
      {title} <InfoTip text={tip} />
    </h3>
  )
  if (rows.length === 0) {
    return (
      <div>
        {heading}
        <p className="mt-2 text-sm text-muted">Nothing to show yet this week.</p>
      </div>
    )
  }
  const top = rows.slice(0, 3)
  const bottom = rows.length > 3 ? rows.slice(-Math.min(3, rows.length - top.length)).reverse() : []
  return (
    <div>
      {heading}
      <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-success">Best</p>
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
