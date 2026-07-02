/**
 * CEO Teams (spec §13.2, §20.4): per-team health cards — throughput trend,
 * team first-pass quality with delta + cause, client wait + revision
 * turnaround (the honest stand-ins for CSR send latency, §19), utilization
 * now, and per-designer rows worst-first INSIDE each team. Grouped by team
 * because raw cross-team comparison is invalid (§2) — only Attainment %
 * crosses team lines. Read-only; private interpretation (§22.10).
 */

import { useMemo } from 'react'
import { Users } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { DeltaChip } from '../../components/ui/DeltaChip'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { EmptyState } from '../../components/ui/EmptyState'
import { Skeleton } from '../../components/ui/Skeleton'
import { TrendLine, type TrendPoint } from '../../components/ui/TrendLine'
import {
  activeLoad,
  expectedQuotaOn,
  summarizeDesigner,
  type DesignerPeriodSummary,
} from '../../../shared/aggregate'
import { pktToday } from '../../../shared/pkt'
import type { Designer, Team } from '../../../shared/types'
import { fmtDate, fmtDuration, fmtPct, fmtTime } from '../../lib/format'
import {
  TEAMS,
  activeDesigners,
  clientWaitMedianInPeriod,
  completionsInPeriod,
  fpqInPeriod,
  mergeTasks,
  metricDelta,
  revisionTurnaroundMedianInPeriod,
  sameWindowLastWeek,
  thisWeekRange,
  useConfigValues,
  useDesigners,
  useMetricsWindow,
  useOpenTasksLive,
  useQuotaCtx,
  useTasksWindow,
  weekBuckets,
  type TileDelta,
} from './ceoData'

interface DesignerRow {
  designer: Designer
  cur: DesignerPeriodSummary
  flags: Array<{ label: string; tone: 'success' | 'warning' | 'danger' }>
  attentionScore: number
}

interface TeamModel {
  team: Team
  members: Designer[]
  trend: TrendPoint[]
  trendBaseline: number | null
  fpqPct: number | null
  fpqDelta: TileDelta | null
  fpqCause: string
  clientWait: number | null
  clientWaitDelta: TileDelta | null
  revisionTurnaround: number | null
  revisionTurnaroundDelta: TileDelta | null
  loadNow: number
  quotaToday: number
  rows: DesignerRow[]
}

export default function CeoTeams() {
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

  const teams = useMemo<TeamModel[] | null>(() => {
    if (loading || !designersQ.data || !tasksQ.data || !metricsQ.data || !openQ.data) return null
    const active = activeDesigners(designersQ.data)
    const allTasks = mergeTasks(tasksQ.data, openQ.data)
    const metrics = metricsQ.data

    return TEAMS.map((team) => {
      const members = active.filter((d) => d.team === team)
      if (members.length === 0) return null
      const ids = new Set(members.map((d) => d.id))

      const fpqNow = fpqInPeriod(metrics, ids, week)
      const fpqPrev = fpqInPeriod(metrics, ids, prior)
      const trendValues = buckets.map((b) => completionsInPeriod(allTasks, ids, b))
      const trend: TrendPoint[] = buckets.map((b, i) => ({
        label: fmtDate(b.start),
        value: trendValues[i],
      }))
      const trendBaseline = trendValues.length
        ? Math.round((trendValues.reduce((s, v) => s + v, 0) / trendValues.length) * 10) / 10
        : null

      const loadNow = members.reduce((s, d) => s + activeLoad(openQ.data!, d.id), 0)
      const quotaToday = members.reduce((s, d) => s + expectedQuotaOn(d.id, today, quota), 0)

      const rows: DesignerRow[] = members
        .map((d) => {
          const cur = summarizeDesigner(d.id, { ...week, tasks: allTasks, metrics, quota })
          const prev = summarizeDesigner(d.id, { ...prior, tasks: allTasks, metrics, quota })
          const flags: DesignerRow['flags'] = []
          if (
            cur.firstPassQualityPct != null &&
            prev.firstPassQualityPct != null &&
            prev.firstPassQualityPct - cur.firstPassQualityPct > cfg.quality_decay_pct &&
            cur.delivered >= 2
          ) {
            flags.push({
              label: `Quality −${prev.firstPassQualityPct - cur.firstPassQualityPct}pp`,
              tone: 'warning',
            })
          }
          if (cur.cancelled > 0) flags.push({ label: `${cur.cancelled} cancelled`, tone: 'danger' })
          if (cur.clientCaughtRounds >= 2 && cur.clientCaughtRounds > cur.csrCaughtRounds) {
            flags.push({ label: `Client-caught ×${cur.clientCaughtRounds}`, tone: 'warning' })
          }
          if (cur.expectedQuota > 0 && cur.attainmentPct != null && cur.attainmentPct < 60) {
            flags.push({ label: 'Under quota', tone: 'warning' })
          }
          if (flags.length === 0 && (cur.delivered > 0 || cur.completed > 0)) {
            flags.push({ label: 'Steady', tone: 'success' })
          }
          const attentionScore =
            flags.filter((f) => f.tone !== 'success').length * 1000 +
            (100 - (cur.attainmentPct ?? 100))
          return { designer: d, cur, flags, attentionScore }
        })
        // Worst-first (§20.4) — the problem row lands first.
        .sort((a, b) => b.attentionScore - a.attentionScore)

      return {
        team,
        members,
        trend,
        trendBaseline,
        fpqPct: fpqNow.pct,
        fpqDelta: metricDelta(fpqNow.pct, fpqPrev.pct, { goodWhen: 'up', format: (v) => `${v}pp` }),
        fpqCause:
          fpqNow.delivered > 0
            ? `${fpqNow.clean} of ${fpqNow.delivered} clean — ${fpqNow.csrCaughtRounds} CSR-caught, ${fpqNow.clientCaughtRounds} client-caught rounds`
            : 'Nothing delivered yet this week',
        clientWait: clientWaitMedianInPeriod(metrics, ids, week),
        clientWaitDelta: metricDelta(
          clientWaitMedianInPeriod(metrics, ids, week),
          clientWaitMedianInPeriod(metrics, ids, prior),
          { goodWhen: 'down', format: (v) => fmtDuration(v) },
        ),
        revisionTurnaround: revisionTurnaroundMedianInPeriod(metrics, ids, week),
        revisionTurnaroundDelta: metricDelta(
          revisionTurnaroundMedianInPeriod(metrics, ids, week),
          revisionTurnaroundMedianInPeriod(metrics, ids, prior),
          { goodWhen: 'down', format: (v) => fmtDuration(v) },
        ),
        loadNow,
        quotaToday,
        rows,
      }
    }).filter((t): t is TeamModel => t != null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, designersQ.data, tasksQ.data, metricsQ.data, openQ.data, quota, cfg])

  const lead = useMemo(() => {
    if (!teams || teams.length === 0) return null
    const withFpq = teams.filter((t) => t.fpqPct != null)
    if (withFpq.length === 0) return 'No deliveries yet this week — team quality reads will appear as work lands.'
    const best = [...withFpq].sort((a, b) => (b.fpqPct ?? 0) - (a.fpqPct ?? 0))[0]
    const worst = [...withFpq].sort((a, b) => (a.fpqPct ?? 0) - (b.fpqPct ?? 0))[0]
    if (best.team === worst.team)
      return `${best.team} is the only team with deliveries this week — first-pass quality ${best.fpqPct}%.`
    return `${best.team} leads on first-pass quality this week (${best.fpqPct}%); ${worst.team} trails (${worst.fpqPct}%) — coach inside the team, don't compare raw output across teams.`
  }, [teams])

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold text-fg">Teams</h1>
        <p className="mt-1 text-sm text-muted">
          Week of {fmtDate(week.start)} vs the same point last week · grouped by team — a logo, a
          brand guide, and an animation are different units, so only attainment crosses team lines
          (§2)
        </p>
      </header>

      {failed != null && (
        <ErrorBanner
          message={`Couldn't load team data — ${(failed as Error).message}`}
          asOf={tasksQ.dataUpdatedAt > 0 ? fmtTime(new Date(tasksQ.dataUpdatedAt).toISOString()) : null}
          onRetry={() => {
            void designersQ.refetch()
            void tasksQ.refetch()
            void metricsQ.refetch()
            void openQ.refetch()
          }}
        />
      )}

      {lead && (
        <div className="card animate-fade-in p-5">
          <p className="text-sm font-medium text-fg">{lead}</p>
        </div>
      )}

      {loading && (
        <div className="space-y-4" role="status" aria-label="Loading teams">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      )}

      {!loading && teams && teams.length === 0 && (
        <EmptyState
          icon={Users}
          title="No active designers on the roster"
          hint="Once Ops adds designers, per-team health appears here automatically."
        />
      )}

      {teams?.map((t) => <TeamCard key={t.team} model={t} />)}
    </div>
  )
}

function TeamCard({ model: t }: { model: TeamModel }) {
  const utilizationPctNow = t.quotaToday > 0 ? Math.round((t.loadNow / t.quotaToday) * 100) : null
  return (
    <section className="card animate-fade-in p-6" aria-label={`${t.team} team`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-fg">{t.team}</h2>
          <span className="text-sm text-muted">
            {t.members.length} designer{t.members.length === 1 ? '' : 's'}
          </span>
        </div>
        <Badge
          tone={utilizationPctNow == null ? 'neutral' : utilizationPctNow > 120 ? 'danger' : utilizationPctNow >= 60 ? 'success' : 'neutral'}
        >
          {utilizationPctNow == null
            ? `${t.loadNow} active now · no quota today`
            : `Utilization ${utilizationPctNow}% — ${t.loadNow} active / ${t.quotaToday} slots today${utilizationPctNow > 120 ? ' · overloaded' : utilizationPctNow < 60 ? ' · spare capacity' : ''}`}
        </Badge>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[1fr,320px]">
        <div className="grid gap-4 sm:grid-cols-3">
          <MiniStat
            label="First-pass quality"
            value={fmtPct(t.fpqPct)}
            delta={t.fpqDelta}
            cause={t.fpqCause}
          />
          <MiniStat
            label="Client wait (median)"
            value={fmtDuration(t.clientWait)}
            delta={t.clientWaitDelta}
            cause="Client-owned time — excluded from designer speed (§4.1)"
          />
          <MiniStat
            label="Revision turnaround"
            value={fmtDuration(t.revisionTurnaround)}
            delta={t.revisionTurnaroundDelta}
            cause="Median time revised tasks were held in revision this week"
          />
        </div>
        <div>
          <p className="eyebrow">Throughput — 8 weeks</p>
          <div className="mt-2">
            <TrendLine
              points={t.trend}
              baseline={t.trendBaseline}
              tone="brand"
              ariaLabel={`${t.team} weekly completions over the last 8 weeks`}
            />
          </div>
        </div>
      </div>

      {/* §19 — first delivery merges CSR send + client review; CSR speed is only measurable on revision cycles. */}
      <p className="mt-3 text-xs text-muted">
        CSR send latency is measurable on revision cycles only (§19) — client wait and revision
        turnaround stand in at team level; no individual CSR is tracked (§1.2).
      </p>

      <div className="mt-5 border-t border-border pt-4">
        <div
          className="hidden gap-2 px-1 pb-2 sm:grid sm:grid-cols-[minmax(0,1fr),6rem,6rem,6rem,minmax(8rem,auto)]"
          aria-hidden="true"
        >
          <span className="eyebrow">Designer</span>
          <span className="eyebrow text-right">Attainment</span>
          <span className="eyebrow text-right">First-pass</span>
          <span className="eyebrow text-right">Production</span>
          <span className="eyebrow text-right">Flags</span>
        </div>
        <ul>
          {t.rows.map((r) => (
            <li
              key={r.designer.id}
              className="grid grid-cols-2 items-center gap-2 border-b border-border/50 px-1 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr),6rem,6rem,6rem,minmax(8rem,auto)]"
            >
              <span className="min-w-0 truncate text-sm font-medium text-fg">
                {r.designer.name}
                {r.designer.specialty && (
                  <span className="ml-1.5 text-xs font-normal text-muted">{r.designer.specialty}</span>
                )}
              </span>
              <span className="tnum text-right text-sm text-fg">
                {fmtPct(r.cur.attainmentPct)}
                <span className="block text-xs text-muted">
                  {r.cur.expectedQuota > 0 ? `${r.cur.completed} of ${r.cur.expectedQuota}` : 'no quota'}
                </span>
              </span>
              <span className="tnum text-right text-sm text-fg">
                {fmtPct(r.cur.firstPassQualityPct)}
                <span className="block text-xs text-muted">
                  {r.cur.delivered > 0 ? `${r.cur.firstPassClean}/${r.cur.delivered} clean` : 'none delivered'}
                </span>
              </span>
              <span className="tnum text-right text-sm text-fg">
                {fmtDuration(r.cur.productionMedianMin)}
              </span>
              <span className="col-span-2 flex flex-wrap justify-start gap-1 sm:col-span-1 sm:justify-end">
                {r.flags.length === 0 ? (
                  <span className="text-xs text-muted">No activity this week</span>
                ) : (
                  r.flags.map((f) => (
                    <Badge key={f.label} tone={f.tone}>
                      {f.label}
                    </Badge>
                  ))
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function MiniStat({
  label,
  value,
  delta,
  cause,
}: {
  label: string
  value: string
  delta: TileDelta | null
  cause: string
}) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="tnum text-2xl font-medium text-fg">{value}</span>
        {delta && <DeltaChip direction={delta.direction} good={delta.good} label={delta.label} />}
      </div>
      <p className="mt-1 text-xs leading-snug text-muted">{cause}</p>
    </div>
  )
}
