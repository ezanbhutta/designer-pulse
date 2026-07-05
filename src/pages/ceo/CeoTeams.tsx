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
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge } from '../../components/ui/Badge'
import { DeltaChip } from '../../components/ui/DeltaChip'
import { InfoTip } from '../../components/ui/InfoTip'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { EmptyState } from '../../components/ui/EmptyState'
import { Skeleton } from '../../components/ui/Skeleton'
import { TrendLine, type TrendPoint } from '../../components/ui/TrendLine'
import { HeroMetric, Reveal, RevealItem } from './ceoKit'
import {
  dueOnDay,
  expectedQuotaOn,
  summarizeDesigner,
  type DesignerPeriodSummary,
} from '../../../shared/aggregate'
import { pktToday } from '../../../shared/pkt'
import type { Designer, Team } from '../../../shared/types'
import { fmtClock, fmtDate, fmtDuration, fmtDurationLong, fmtPct } from '../../lib/format'
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

      // Owner's rule: today's plate = projects DUE today, nothing else.
      const loadNow = members.reduce((s, d) => s + dueOnDay(openQ.data!, d.id, today), 0)
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
              label: `Quality dropping −${prev.firstPassQualityPct - cur.firstPassQualityPct} points`,
              tone: 'warning',
            })
          }
          if (cur.cancelled > 0)
            flags.push({
              label: `${cur.cancelled} lost order${cur.cancelled === 1 ? '' : 's'}`,
              tone: 'danger',
            })
          if (cur.clientCaughtRounds >= 2 && cur.clientCaughtRounds > cur.csrCaughtRounds) {
            flags.push({ label: `${cur.clientCaughtRounds} caught by clients`, tone: 'warning' })
          }
          if (cur.expectedQuota > 0 && cur.attainmentPct != null && cur.attainmentPct < 60) {
            flags.push({ label: 'Below target', tone: 'warning' })
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
        fpqDelta: metricDelta(fpqNow.pct, fpqPrev.pct, { goodWhen: 'up', format: (v) => `${v} points` }),
        fpqCause:
          fpqNow.delivered > 0
            ? `${fpqNow.clean} of ${fpqNow.delivered} accepted with no changes, with ${fpqNow.csrCaughtRounds} change requests from our checkers and ${fpqNow.clientCaughtRounds} from clients`
            : 'No designs sent yet this week',
        clientWait: clientWaitMedianInPeriod(metrics, ids, week),
        clientWaitDelta: metricDelta(
          clientWaitMedianInPeriod(metrics, ids, week),
          clientWaitMedianInPeriod(metrics, ids, prior),
          { goodWhen: 'down', format: (v) => fmtDurationLong(v) },
        ),
        revisionTurnaround: revisionTurnaroundMedianInPeriod(metrics, ids, week),
        revisionTurnaroundDelta: metricDelta(
          revisionTurnaroundMedianInPeriod(metrics, ids, week),
          revisionTurnaroundMedianInPeriod(metrics, ids, prior),
          { goodWhen: 'down', format: (v) => fmtDurationLong(v) },
        ),
        loadNow,
        quotaToday,
        rows,
      }
    }).filter((t): t is TeamModel => t != null)
    // `today` stands in for week/prior/buckets (all pure functions of it) so
    // the model recomputes at the PKT day/week rollover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, designersQ.data, tasksQ.data, metricsQ.data, openQ.data, quota, cfg, today])

  const lead = useMemo(() => {
    if (!teams || teams.length === 0) return null
    const withFpq = teams.filter((t) => t.fpqPct != null)
    if (withFpq.length === 0)
      return 'No designs sent yet this week, so team quality will show up here as work gets delivered.'
    const best = [...withFpq].sort((a, b) => (b.fpqPct ?? 0) - (a.fpqPct ?? 0))[0]
    const worst = [...withFpq].sort((a, b) => (a.fpqPct ?? 0) - (b.fpqPct ?? 0))[0]
    if (best.team === worst.team)
      return `${best.team} is the only team that sent designs this week, and ${best.fpqPct}% were right first time.`
    return `${best.team} has the best "right first time" score this week (${best.fpqPct}%), while ${worst.team} has the lowest (${worst.fpqPct}%). Coach within each team, and never compare raw output across teams.`
  }, [teams])

  const plate = teams
    ? {
        due: teams.reduce((s, t) => s + t.loadNow, 0),
        slots: teams.reduce((s, t) => s + t.quotaToday, 0),
        teamCount: teams.length,
      }
    : null

  return (
    <div className="mx-auto w-full max-w-6xl space-y-12">
      <PageHeader
        breadcrumbs={['CEO', 'Teams']}
        title="Teams"
        titleAccessory={
          <InfoTip text="How each team is doing this week, covering quality, waiting times, and every designer's numbers." />
        }
        history={`Week of ${fmtDate(week.start)} so far, compared with the same days last week and shown team by team. A logo, a brand guide, and an animation are different amounts of work, so only "Target met" is fair to compare across teams.`}
      />

      {failed != null && (
        <ErrorBanner
          message={`We could not load the team numbers just now, because ${(failed as Error).message}`}
          asOf={tasksQ.dataUpdatedAt > 0 ? fmtClock(new Date(tasksQ.dataUpdatedAt).toISOString()) : null}
          onRetry={() => {
            void designersQ.refetch()
            void tasksQ.refetch()
            void metricsQ.refetch()
            void openQ.refetch()
          }}
        />
      )}

      {/* ── The headline number: today's plate under the owner's slot rule ── */}
      <HeroMetric
        eyebrow="Due today"
        tip="How many projects are due today across every team, compared with the slots planned for today. Only projects due today count as today's plate."
        value={plate ? plate.due : null}
        caption={
          plate
            ? `for ${plate.slots} planned slot${plate.slots === 1 ? '' : 's'} across ${plate.teamCount} team${plate.teamCount === 1 ? '' : 's'}${
                plate.slots > 0 ? `, running at a busy level of ${Math.round((plate.due / plate.slots) * 100)}%` : ''
              }. Only projects due today count, so future work never inflates the picture.`
            : null
        }
        loading={loading}
      />

      {lead && (
        <div className="card animate-fade-in p-8">
          <h2 className="eyebrow inline-flex items-center gap-1">
            The call this week{' '}
            <InfoTip text="One line that sums up team quality this week. Coach within each team, and never compare raw output across teams." />
          </h2>
          <p className="mt-3 max-w-prose text-body text-fg">{lead}</p>
        </div>
      )}

      {loading && (
        <div className="space-y-8" role="status" aria-label="Loading teams">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      )}

      {!loading && teams && teams.length === 0 && (
        <EmptyState
          icon={Users}
          title="No designers on the roster yet"
          hint="As soon as designers are added, each team will show up here on its own."
        />
      )}

      {teams && teams.length > 0 && (
        <Reveal className="space-y-8">
          {teams.map((t) => (
            <RevealItem key={t.team}>
              <TeamCard model={t} />
            </RevealItem>
          ))}
        </Reveal>
      )}
    </div>
  )
}

function TeamCard({ model: t }: { model: TeamModel }) {
  const utilizationPctNow = t.quotaToday > 0 ? Math.round((t.loadNow / t.quotaToday) * 100) : null
  return (
    <section className="card p-8" aria-label={`${t.team} team`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-card text-fg">{t.team}</h2>
          <span className="text-caption text-muted">
            {t.members.length} designer{t.members.length === 1 ? '' : 's'}
          </span>
        </div>
        <span className="inline-flex items-center gap-1">
          <Badge
            tone={utilizationPctNow == null ? 'neutral' : utilizationPctNow > 120 ? 'danger' : utilizationPctNow >= 60 ? 'success' : 'neutral'}
          >
            {utilizationPctNow == null
              ? `${t.loadNow} project${t.loadNow === 1 ? '' : 's'} in hand, with no planned slots today`
              : `Busy at ${utilizationPctNow}%, with ${t.loadNow} projects due today against ${t.quotaToday} planned slots${utilizationPctNow > 120 ? ', which is too much on their plate' : utilizationPctNow < 60 ? ', which leaves room for more' : ''}`}
          </Badge>
          <InfoTip text="How full the team's plate is right now: projects being worked on, compared with the slots planned for today." />
        </span>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr,320px]">
        <div className="grid gap-4 sm:grid-cols-3">
          <MiniStat
            label="Right first time"
            tip="How many designs were accepted without anyone asking for changes. Higher is better."
            value={fmtPct(t.fpqPct)}
            delta={t.fpqDelta}
            cause={t.fpqCause}
          />
          <MiniStat
            label="Client waiting time"
            tip="How long clients take to reply. This is the client's time, not the team's."
            value={fmtDurationLong(t.clientWait)}
            delta={t.clientWaitDelta}
            cause="Waiting on clients, which is never counted against the team"
          />
          <MiniStat
            label="Fix time"
            tip="Once someone asks for changes, how long those changes usually take to turn around."
            value={fmtDurationLong(t.revisionTurnaround)}
            delta={t.revisionTurnaroundDelta}
            cause="Usual time spent on changes this week"
          />
        </div>
        <div>
          <p className="eyebrow inline-flex items-center gap-1">
            Finished per week over the last 8 weeks{' '}
            <InfoTip text="How many projects the team closes each week. The dotted line is the average over the last 8 weeks." />
          </p>
          <div className="mt-2">
            <TrendLine
              points={t.trend}
              baseline={t.trendBaseline}
              tone="brand"
              ariaLabel={`${t.team}: projects finished each week over the last 8 weeks`}
            />
          </div>
        </div>
      </div>

      {/* §19 — first delivery merges CSR send + client review; CSR speed is only measurable on revision cycles. */}
      <p className="mt-6 max-w-prose text-label text-muted">
        We cannot time our own checkers on first deliveries, so &quot;Client waiting time&quot; and
        &quot;Fix time&quot; stand in at team level, since no individual checker is tracked.
      </p>

      <div className="mt-6 border-t border-border pt-5">
        {/* Columned layout waits until lg — below that the auto-growing Notes
            column starves the Designer name. Notes is capped so badges wrap
            instead of squeezing the name. */}
        <div className="hidden gap-2 px-1 pb-2 lg:grid lg:grid-cols-[minmax(0,1fr),8.5rem,10.5rem,7rem,minmax(8rem,12rem)]">
          <span className="eyebrow">Designer</span>
          <span className="eyebrow inline-flex items-center justify-end gap-1 text-right">
            Target met{' '}
            <InfoTip text="Out of the projects they were supposed to take, how many they finished. This is the only fair way to compare different teams." />
          </span>
          <span className="eyebrow inline-flex items-center justify-end gap-1 text-right">
            Right first time{' '}
            <InfoTip text="How many designs were accepted without anyone asking for changes. Higher is better." />
          </span>
          <span className="eyebrow inline-flex items-center justify-end gap-1 text-right">
            Work time{' '}
            <InfoTip text="Usual time from getting a project to sending the first design. Client waiting time is not counted." />
          </span>
          <span className="eyebrow inline-flex items-center justify-end gap-1 text-right">
            Notes{' '}
            <InfoTip text="Quick signs from this week, good or worrying, with the person who most needs attention listed first." />
          </span>
        </div>
        <ul>
          {t.rows.map((r) => (
            <li
              key={r.designer.id}
              className="grid grid-cols-2 items-center gap-2 border-b border-border/50 px-1 py-3 last:border-b-0 lg:grid-cols-[minmax(0,1fr),8.5rem,10.5rem,7rem,minmax(8rem,12rem)]"
            >
              <span className="min-w-0 truncate text-caption font-medium text-fg">
                {r.designer.name}
                {r.designer.specialty && (
                  <span className="ml-1.5 text-label font-normal text-muted">{r.designer.specialty}</span>
                )}
              </span>
              <span className="tnum text-right text-caption text-fg">
                {fmtPct(r.cur.attainmentPct)}
                <span className="block text-label font-normal text-muted">
                  {r.cur.expectedQuota > 0 ? `${r.cur.completed} of ${r.cur.expectedQuota}` : 'no target set'}
                </span>
              </span>
              <span className="tnum text-right text-caption text-fg">
                {fmtPct(r.cur.firstPassQualityPct)}
                <span className="block text-label font-normal text-muted">
                  {r.cur.delivered > 0 ? `${r.cur.firstPassClean} of ${r.cur.delivered}` : 'none sent'}
                </span>
              </span>
              <span className="tnum text-right text-caption text-fg">
                {fmtDuration(r.cur.productionMedianMin)}
              </span>
              <span className="col-span-2 flex flex-wrap justify-start gap-1 lg:col-span-1 lg:justify-end">
                {r.flags.length === 0 ? (
                  <span className="text-label text-muted">No activity this week</span>
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
  tip,
  value,
  delta,
  cause,
}: {
  label: string
  tip: string
  value: string
  delta: TileDelta | null
  cause: string
}) {
  return (
    <div>
      <p className="eyebrow inline-flex items-center gap-1">
        {label} <InfoTip text={tip} />
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="tnum text-card font-medium text-fg">{value}</span>
        {delta && <DeltaChip direction={delta.direction} good={delta.good} label={delta.label} />}
      </div>
      <p className="mt-2 text-label font-normal leading-snug text-muted">{cause}</p>
    </div>
  )
}
