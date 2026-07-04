/**
 * Nightly compute (spec §5.1 "nightly tier", §11 Tier 4, §12) — runs at
 * 02:00 PKT (21:00 UTC, see vercel.json). Ordered by irreplaceability:
 *  1. Trend alerts FIRST (quality decay, burnout composite, workload
 *     forecast) — nothing else in the system computes these, so they get the
 *     budget before anything that other jobs also perform.
 *  2. Attendance finalize for the trailing week (retroactive leave/holiday/
 *     schedule edits self-heal) — parallel batches with a rotating start
 *     offset; pulse keeps today+yesterday fresh anyway.
 *  3. Open-span drift: refresh metrics for tasks parked in `revision` /
 *     `client response` — chunk-batched, with a persistent cursor so
 *     consecutive nights walk the whole set.
 *
 * Like pulse/reconcile, the run is budgeted (~22s) with a 26s safety flush:
 * external schedulers (cron-job.org free tier) wait ≤30s and auto-disable
 * jobs that keep timing out, so nightly must ALWAYS answer — partial work
 * rolls into the next night.
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
  HalfDay,
  Holiday,
  HolidayWorker,
  Leave,
  QuotaException,
  TaskMetrics,
  TaskState,
} from '../../shared/types'
import { createSafetyResponder, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin, type SupabaseAdmin } from '../_lib/supabaseAdmin'
import { loadConfig } from '../_lib/config'
import { fireAlert } from '../_lib/alerts'
import { recomputeTaskMetricsChunk } from '../_lib/ingest'
import { computeAttendanceFor, type AttendancePreload } from '../_lib/attendance-runner'

export const config = { maxDuration: 60 }

/**
 * The nightly sweep recomputes this many trailing days per designer so
 * retroactive leave/holiday/half-day entries and schedule edits within the
 * window self-heal (spec §8.3/§9.2). Older corrections: POST
 * /api/admin/recompute-attendance?from=&to=[&designer_id=].
 */
const ATTENDANCE_SWEEP_DAYS = 7

const BUDGET_MS = 22_000
const SAFETY_FLUSH_MS = 26_000
/** Designers recomputed concurrently per attendance batch. */
const ATT_PARALLEL = 6
/** Drift tasks per batched recompute (one events read / metrics upsert each). */
const DRIFT_CHUNK = 40
/** Cap on drift rows fetched per night; the cursor carries the remainder. */
const DRIFT_MAX_PER_RUN = 400
const DRIFT_CURSOR_KEY = 'nightly_drift_cursor'

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = Date.now()
  const outOfTime = () => Date.now() - started > BUDGET_MS
  const summary: Record<string, unknown> = { ok: true }
  const respond = createSafetyResponder(res, {
    safetyMs: SAFETY_FLUSH_MS,
    safetyBody: () => ({ ...summary, partial: true, note: 'safety flush — remainder next night' }),
  })
  try {
    const supa = supabaseAdmin()
    const cfg = await loadConfig(supa)
    const now = new Date()
    const today = pktToday(now)
    summary.work_date = today

    // ── Load everything loop-invariant in one parallel wave ──────────────────
    // Trend windows: the last 7 COMPLETE days vs the prior 7. The run happens
    // ~02:00 PKT when "today" is 2 hours old; including it would deflate
    // attainment ~14% every night and feed phantom points into the burnout
    // composite. Complete days only, both windows.
    const thisEnd = addDays(today, -1)
    const thisStart = addDays(thisEnd, -6)
    const prior = priorPeriod(thisStart, thisEnd)
    const sinceIso = pktInstant(addDays(today, -35), '00:00').toISOString()
    const sweepStart = addDays(today, -(ATTENDANCE_SWEEP_DAYS - 1))

    const [
      designersRes,
      recentRes,
      openRes,
      metricsRes,
      schedulesRes,
      exceptionsRes,
      leavesRes,
      holidaysRes,
      workersRes,
      halfRes,
      attRes,
    ] = await Promise.all([
      // Deterministic order — the attendance rotation offset below needs a
      // stable sequence across runs.
      supa
        .from('designers')
        .select('*')
        .eq('status', 'active')
        .order('order_index', { ascending: true })
        .order('id', { ascending: true }),
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
        .from('half_days')
        .select('*')
        .gte('the_date', sweepStart)
        .lte('the_date', today)
        .limit(5000),
      supa
        .from('attendance_daily')
        .select('*')
        .gte('work_date', prior.start)
        .lte('work_date', thisEnd)
        .limit(10000),
    ])
    expectOk(designersRes.error, 'designers read')
    expectOk(recentRes.error, 'recent tasks read')
    expectOk(openRes.error, 'open tasks read')
    expectOk(metricsRes.error, 'task_metrics read')
    expectOk(schedulesRes.error, 'designer_schedule read')
    expectOk(exceptionsRes.error, 'quota_exceptions read')
    expectOk(leavesRes.error, 'leaves read')
    expectOk(holidaysRes.error, 'holidays read')
    expectOk(workersRes.error, 'holiday_workers read')
    expectOk(halfRes.error, 'half_days read')
    expectOk(attRes.error, 'attendance_daily read')

    const designers = (designersRes.data ?? []) as Designer[]

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

    // ── (1) Trends FIRST: this-7-days vs the prior 7 (spec §11 T4, §12) ───────
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
    summary.designersScored = designers.length
    summary.qualityAlerts = qualityAlerts
    summary.burnoutAlerts = burnoutAlerts
    summary.forecastAlert = forecastAlert
    summary.projectedBacklog = forecast.projectedBacklog

    // ── (2) Attendance finalize: trailing sweep (retroactive edits self-heal) ─
    // Parallel batches with a rotating start offset (day-based — nightly runs
    // once a day) so budget-cut nights don't starve the same designers.
    const attPreload: AttendancePreload = {
      schedules: quota.schedules,
      leaves: quota.leaves,
      holidays: quota.holidays,
      holidayWorkers: quota.holidayWorkers,
      halfDays: (halfRes.data ?? []) as HalfDay[],
    }
    const sweepDates = dateRange(sweepStart, today)
    let attendanceRuns = 0
    let attendancePartial = false
    const offset = designers.length
      ? Math.floor(now.getTime() / 86_400_000) % designers.length
      : 0
    const rotated = [...designers.slice(offset), ...designers.slice(0, offset)]
    for (let i = 0; i < rotated.length; i += ATT_PARALLEL) {
      if (outOfTime()) {
        attendancePartial = true
        break
      }
      const batch = rotated.slice(i, i + ATT_PARALLEL)
      await Promise.all(
        batch.map(async (d) => {
          try {
            for (const date of sweepDates) {
              await computeAttendanceFor(supa, d, date, cfg, attPreload)
              attendanceRuns++
            }
          } catch (err) {
            console.error(`[cron/nightly] attendance sweep failed for ${d.name}`, err)
          }
        }),
      )
      summary.attendanceRuns = attendanceRuns
    }
    summary.attendanceRuns = attendanceRuns
    summary.attendancePartial = attendancePartial

    // ── (3) Open-span drift: refresh revision / client-response tasks ─────────
    // Chunk-batched (~4 round trips per DRIFT_CHUNK tasks instead of per task)
    // and cursored: a night that can't finish hands the remainder to the next
    // one instead of dying against maxDuration.
    let driftRefreshed = 0
    let driftPartial = false
    {
      const cursor = await loadDriftCursor(supa)
      let q = supa
        .from('task_state')
        .select('task_id,list_id,designer_id,created_at')
        .eq('deleted', false)
        .in('current_status', ['revision', 'client response'])
        .order('task_id', { ascending: true })
        .limit(DRIFT_MAX_PER_RUN)
      if (cursor) q = q.gt('task_id', cursor)
      const { data: driftRows, error: driftErr } = await q
      expectOk(driftErr, 'drift tasks read')
      const rows = (driftRows ?? []) as Array<
        Pick<TaskState, 'task_id' | 'list_id' | 'designer_id' | 'created_at'>
      >
      for (let i = 0; i < rows.length; i += DRIFT_CHUNK) {
        if (outOfTime()) {
          driftPartial = true
          break
        }
        const chunk = rows.slice(i, i + DRIFT_CHUNK)
        try {
          driftRefreshed += await recomputeTaskMetricsChunk(supa, chunk)
          await saveDriftCursor(supa, chunk[chunk.length - 1].task_id)
        } catch (err) {
          console.error('[cron/nightly] drift chunk failed', err)
        }
        summary.driftRefreshed = driftRefreshed
      }
      // Walked past the end of the set — next night starts from the top.
      if (!driftPartial && rows.length < DRIFT_MAX_PER_RUN) await saveDriftCursor(supa, null)
    }
    summary.driftRefreshed = driftRefreshed
    summary.driftPartial = driftPartial

    respond(200, { ...summary, tookMs: Date.now() - started })
  } catch (err) {
    console.error('[cron/nightly]', err)
    respond(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

// Burnout composite lives in shared/aggregate.ts (spec §11 Tier 4) — ONE
// canonical scoring shared with the CEO Trends board, so the alert that fires
// here always matches the score the CEO reads for the same designer/window.

const fmtMin = (v: number | null) => (v == null ? '—' : `${v}m`)
const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`)

/** Last drift task_id refreshed (app_config); null = start from the top. */
async function loadDriftCursor(supa: SupabaseAdmin): Promise<string | null> {
  const { data, error } = await supa
    .from('app_config')
    .select('value')
    .eq('key', DRIFT_CURSOR_KEY)
    .maybeSingle()
  expectOk(error, 'nightly drift cursor read')
  const v = (data as { value?: unknown } | null)?.value
  return typeof v === 'string' && v.length > 0 ? v : null
}

async function saveDriftCursor(supa: SupabaseAdmin, taskId: string | null): Promise<void> {
  if (taskId === null) {
    const { error } = await supa.from('app_config').delete().eq('key', DRIFT_CURSOR_KEY)
    expectOk(error, 'nightly drift cursor clear')
    return
  }
  const { error } = await supa
    .from('app_config')
    .upsert({ key: DRIFT_CURSOR_KEY, value: taskId }, { onConflict: 'key' })
  expectOk(error, 'nightly drift cursor save')
}
