/**
 * Nightly compute (spec §5.1 "nightly tier", §11 Tier 4, §12) — runs at
 * 02:00 PKT (21:00 UTC, see vercel.json):
 *  1. Finalize attendance for yesterday + today for all active designers
 *     (overnight shifts still running keep updating via pulse).
 *  2. Refresh metrics for open tasks parked in `revision` / `client response`
 *     so their open-span minutes don't drift stale between events.
 *  3. Trend alerts, this-7-days vs the prior 7 (shared summarizeDesigner +
 *     priorPeriod): quality decay, burnout composite, workload forecast.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { addDays, dateRange, pktInstant, pktToday } from '../../shared/pkt'
import {
  burnoutComposite,
  priorPeriod,
  summarizeDesigner,
  workloadForecast,
  type QuotaContext,
} from '../../shared/aggregate'
import type {
  AttendanceDaily,
  Designer,
  DesignerSchedule,
  Holiday,
  HolidayWorker,
  Leave,
  QuotaException,
  TaskMetrics,
  TaskState,
} from '../../shared/types'
import { json, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin } from '../_lib/supabaseAdmin'
import { loadConfig } from '../_lib/config'
import { fireAlert } from '../_lib/alerts'
import { recomputeTaskMetrics } from '../_lib/ingest'
import { computeAttendanceFor } from '../_lib/attendance-runner'

export const config = { maxDuration: 60 }

/**
 * The nightly sweep recomputes this many trailing days per designer so
 * retroactive leave/holiday/half-day entries and schedule edits within the
 * window self-heal (spec §8.3/§9.2). Older corrections: POST
 * /api/admin/recompute-attendance?from=&to=[&designer_id=].
 */
const ATTENDANCE_SWEEP_DAYS = 7

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = Date.now()
  try {
    const supa = supabaseAdmin()
    const cfg = await loadConfig(supa)
    const now = new Date()
    const today = pktToday(now)

    const { data: designersRows, error: designersErr } = await supa
      .from('designers')
      .select('*')
      .eq('status', 'active')
    expectOk(designersErr, 'designers read')
    const designers = (designersRows ?? []) as Designer[]

    // ── (1) Attendance finalize: trailing sweep (retroactive edits self-heal) ─
    let attendanceRuns = 0
    const sweepDates = dateRange(addDays(today, -(ATTENDANCE_SWEEP_DAYS - 1)), today)
    for (const d of designers) {
      try {
        for (const date of sweepDates) {
          await computeAttendanceFor(supa, d, date, cfg)
          attendanceRuns++
        }
      } catch (err) {
        console.error(`[cron/nightly] attendance sweep failed for ${d.name}`, err)
      }
    }

    // ── (2) Open-span drift: refresh revision / client-response tasks ─────────
    const { data: driftRows, error: driftErr } = await supa
      .from('task_state')
      .select('task_id')
      .eq('deleted', false)
      .in('current_status', ['revision', 'client response'])
      .limit(2000)
    expectOk(driftErr, 'drift tasks read')
    const driftIds = ((driftRows ?? []) as Array<{ task_id: string }>).map((r) => r.task_id)
    for (const taskId of driftIds) {
      await recomputeTaskMetrics(supa, taskId)
    }

    // ── (3) Trends: the last 7 COMPLETE days vs the prior 7 ──────────────────
    // The run happens ~02:00 PKT when "today" is 2 hours old; including it
    // would deflate attainment ~14% every night and feed phantom points into
    // the burnout composite. Complete days only, both windows.
    const thisEnd = addDays(today, -1)
    const thisStart = addDays(thisEnd, -6)
    const prior = priorPeriod(thisStart, thisEnd)
    const sinceIso = pktInstant(addDays(today, -35), '00:00').toISOString()

    const [
      recentRes,
      openRes,
      metricsRes,
      schedulesRes,
      exceptionsRes,
      leavesRes,
      holidaysRes,
      workersRes,
      attRes,
    ] = await Promise.all([
      supa
        .from('task_state')
        .select('*')
        .eq('deleted', false)
        .or(`created_at.gte.${sinceIso},last_event_at.gte.${sinceIso}`)
        .limit(10000),
      supa
        .from('task_state')
        .select('*')
        .eq('deleted', false)
        .not('current_status', 'in', '("complete","cancelled")')
        .limit(10000),
      supa
        .from('task_metrics')
        .select('*')
        .or(`computed_at.gte.${sinceIso},first_delivered_at.gte.${sinceIso}`)
        .limit(10000),
      supa.from('designer_schedule').select('*').limit(5000),
      supa.from('quota_exceptions').select('*').limit(5000),
      supa.from('leaves').select('*').limit(5000),
      supa.from('holidays').select('*').limit(2000),
      supa.from('holiday_workers').select('*').limit(5000),
      supa
        .from('attendance_daily')
        .select('*')
        .gte('work_date', prior.start)
        .lte('work_date', thisEnd)
        .limit(10000),
    ])
    expectOk(recentRes.error, 'recent tasks read')
    expectOk(openRes.error, 'open tasks read')
    expectOk(metricsRes.error, 'task_metrics read')
    expectOk(schedulesRes.error, 'designer_schedule read')
    expectOk(exceptionsRes.error, 'quota_exceptions read')
    expectOk(leavesRes.error, 'leaves read')
    expectOk(holidaysRes.error, 'holidays read')
    expectOk(workersRes.error, 'holiday_workers read')
    expectOk(attRes.error, 'attendance_daily read')

    // Merge recent + open task sets (forecast needs every open task).
    const taskById = new Map<string, TaskState>()
    for (const t of [...(recentRes.data ?? []), ...(openRes.data ?? [])] as TaskState[]) {
      taskById.set(t.task_id, t)
    }
    const tasks = [...taskById.values()]
    const metrics = (metricsRes.data ?? []) as TaskMetrics[]
    const attendance = (attRes.data ?? []) as AttendanceDaily[]
    const quota: QuotaContext = {
      schedules: (schedulesRes.data ?? []) as DesignerSchedule[],
      exceptions: (exceptionsRes.data ?? []) as QuotaException[],
      leaves: (leavesRes.data ?? []) as Leave[],
      holidays: (holidaysRes.data ?? []) as Holiday[],
      holidayWorkers: (workersRes.data ?? []) as HolidayWorker[],
    }

    let qualityAlerts = 0
    let burnoutAlerts = 0
    for (const d of designers) {
      const cur = summarizeDesigner(d.id, {
        start: thisStart,
        end: thisEnd,
        tasks,
        metrics,
        quota,
      })
      const prev = summarizeDesigner(d.id, {
        start: prior.start,
        end: prior.end,
        tasks,
        metrics,
        quota,
      })

      // Quality decay (spec §12): FPQ drop > quality_decay_pct vs prior 7d.
      if (cur.firstPassQualityPct != null && prev.firstPassQualityPct != null) {
        const drop = prev.firstPassQualityPct - cur.firstPassQualityPct
        if (drop > cfg.quality_decay_pct) {
          const dirty = cur.delivered - cur.firstPassClean
          const result = await fireAlert(supa, {
            alert_type: 'quality_decay',
            designer_id: d.id,
            severity: 'warning',
            message: `${d.name}'s first-pass quality fell ${drop} pts week-over-week (${prev.firstPassQualityPct}% → ${cur.firstPassQualityPct}%) — ${dirty} of ${cur.delivered} delivered needed revision`,
            context: {
              window: { start: thisStart, end: thisEnd },
              current_pct: cur.firstPassQualityPct,
              prior_pct: prev.firstPassQualityPct,
              drop_pts: drop,
              delivered: cur.delivered,
              csr_caught: cur.csrCaughtRounds,
              client_caught: cur.clientCaughtRounds,
            },
          })
          if (result.fired) qualityAlerts++
        }
      }

      // Burnout composite (spec §11 Tier 4).
      const attCur = attendance.filter(
        (a) => a.designer_id === d.id && a.work_date >= thisStart && a.work_date <= thisEnd,
      )
      const attPrev = attendance.filter(
        (a) => a.designer_id === d.id && a.work_date >= prior.start && a.work_date <= prior.end,
      )
      const burnout = burnoutComposite(cur, prev, attCur, attPrev)
      if (burnout.score > cfg.burnout_score) {
        const result = await fireAlert(supa, {
          alert_type: 'burnout',
          designer_id: d.id,
          severity: 'warning',
          message: `${d.name} shows burnout risk (${burnout.score}/100) — revision turnaround ${fmtMin(cur.revisionTurnaroundMedianMin)} vs ${fmtMin(prev.revisionTurnaroundMedianMin)}, attainment ${fmtPct(cur.attainmentPct)} vs ${fmtPct(prev.attainmentPct)}, present ${burnout.presentCur}d with a shrinking warm-up gap`,
          context: {
            window: { start: thisStart, end: thisEnd },
            score: burnout.score,
            turnaround_rise: burnout.turnaroundRise,
            attainment_fall: burnout.attainmentFall,
            warmup_shrink: burnout.warmupShrink,
            present_days: burnout.presentCur,
            prior_present_days: burnout.presentPrev,
          },
        })
        if (result.fired) burnoutAlerts++
      }
    }

    // Workload forecast (spec §11 Tier 4): 7d inflow vs completion, projected.
    const forecast = workloadForecast(tasks, cfg.forecast_horizon_days, now)
    let forecastAlert = false
    if (forecast.projectedBacklog > cfg.forecast_threshold) {
      const result = await fireAlert(supa, {
        alert_type: 'workload_forecast',
        severity: 'warning',
        message: `Projected backlog ${forecast.projectedBacklog} tasks in ${forecast.horizonDays}d — inflow ${forecast.inflowPerDay}/day vs completion ${forecast.completionPerDay}/day. Rebalance or add capacity.`,
        context: { ...forecast, threshold: cfg.forecast_threshold },
      })
      forecastAlert = result.fired
    }

    json(res, 200, {
      ok: true,
      work_date: today,
      attendanceRuns,
      driftRefreshed: driftIds.length,
      designersScored: designers.length,
      qualityAlerts,
      burnoutAlerts,
      forecastAlert,
      projectedBacklog: forecast.projectedBacklog,
      tookMs: Date.now() - started,
    })
  } catch (err) {
    console.error('[cron/nightly]', err)
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

// Burnout composite lives in shared/aggregate.ts (spec §11 Tier 4) — ONE
// canonical scoring shared with the CEO Trends board, so the alert that fires
// here always matches the score the CEO reads for the same designer/window.

const fmtMin = (v: number | null) => (v == null ? '—' : `${v}m`)
const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`)
