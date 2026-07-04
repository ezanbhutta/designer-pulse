/**
 * Pulse cron (every 15 min) — the near-real-time watchers (spec §11 Tier 3 +
 * §12), all in PKT (spec §22.2):
 *  1. Assignment gaps: at shift_start + assignment_gap_check_offset_min for
 *     each active designer, expected quota (schedule + exceptions, zeroed on
 *     off/leave/holiday days) vs projects DUE that day (owner's rule — status
 *     and creation date don't matter). A shortfall is idle paid capacity —
 *     attributed to the PM/assignment team, never the designer. The proposed
 *     action is a ClickUp deep link, never a write (spec §22.1).
 *  2. Task aging: open tasks past aging_days_default in their current status
 *     (aging_days_client_response for `client response`) → warning; past 2×
 *     the threshold → escalated to critical.
 *  3. Attendance: recompute today + yesterday for all active designers so
 *     post-midnight shifts land on the right day and forgotten checkouts
 *     auto-close after shift end (spec §9.2).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { addDays, pktInstant, pktToday } from '../../shared/pkt'
import { STATUS_LABELS } from '../../shared/statuses'
import {
  ageMinutes,
  expectedQuotaOn,
  scheduleFor,
  type QuotaContext,
} from '../../shared/aggregate'
import type {
  Designer,
  DesignerSchedule,
  Holiday,
  HolidayWorker,
  Leave,
  QuotaException,
  TaskState,
} from '../../shared/types'
import { createSafetyResponder, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin, type SupabaseAdmin } from '../_lib/supabaseAdmin'
import { loadConfig } from '../_lib/config'
import { fireAlert } from '../_lib/alerts'
import { recomputeWithPriorDay } from '../_lib/attendance-runner'
import { getListTasks, setClickUpDeadline } from '../_lib/clickup'
import {
  runDeepVerifySlice,
  verifyAgedOpenTasks,
  type AgedVerifyResult,
} from '../_lib/deep-verify'

export const config = { maxDuration: 60 }

/**
 * The gap check fires when shift_start+offset fell within this lookback.
 * Generous (2h) on purpose: a skipped/failed cron run must not drop the day's
 * check, and fireAlert's per-work_date dedupe makes re-evaluation free.
 */
const GAP_WINDOW_MS = 120 * 60_000

/**
 * External schedulers (cron-job.org free tier) wait ≤30s for a reply and
 * auto-disable jobs that keep "timing out" — so pulse must ALWAYS answer
 * within ~25s. Work is budgeted; whatever attendance recompute doesn't fit
 * rolls into the next 15-minute run (a rotating start offset guarantees every
 * designer is covered across runs).
 */
const BUDGET_MS = 22_000
const SAFETY_FLUSH_MS = 26_000
/** Designers recomputed concurrently per batch. */
const ATT_PARALLEL = 6

/**
 * Slots filled for a work day (owner's rule): ONLY tasks whose DUE DATE falls
 * on that PKT day are that day's work — status and creation date don't
 * matter. A task due tomorrow, even one being worked right now, belongs to
 * tomorrow.
 */
async function slotsFilledDb(
  supa: SupabaseAdmin,
  designerId: string,
  workDate: string,
): Promise<number> {
  const startIso = pktInstant(workDate, '00:00').toISOString()
  const endIso = pktInstant(addDays(workDate, 1), '00:00').toISOString()
  const { count, error } = await supa
    .from('task_state')
    .select('task_id', { count: 'exact', head: true })
    .eq('designer_id', designerId)
    .eq('deleted', false)
    .gte('due_date', startIso)
    .lt('due_date', endIso)
  expectOk(error, `slots-filled read (${designerId})`)
  return count ?? 0
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = Date.now()
  const outOfTime = () => Date.now() - started > BUDGET_MS
  setClickUpDeadline(started + BUDGET_MS)
  const summary: Record<string, unknown> = { ok: true }
  const respond = createSafetyResponder(res, {
    safetyMs: SAFETY_FLUSH_MS,
    safetyBody: () => ({ ...summary, partial: true, note: 'safety flush — remainder next run' }),
  })
  try {
    const supa = supabaseAdmin()
    const cfg = await loadConfig(supa)
    const now = new Date()
    const today = pktToday(now)

    const [designersRes, schedulesRes, exceptionsRes, leavesRes, holidaysRes, workersRes] =
      await Promise.all([
        supa.from('designers').select('*').eq('status', 'active'),
        supa.from('designer_schedule').select('*').limit(5000),
        supa.from('quota_exceptions').select('*').limit(5000),
        supa.from('leaves').select('*').limit(5000),
        supa.from('holidays').select('*').limit(2000),
        supa.from('holiday_workers').select('*').limit(5000),
      ])
    expectOk(designersRes.error, 'designers read')
    expectOk(schedulesRes.error, 'designer_schedule read')
    expectOk(exceptionsRes.error, 'quota_exceptions read')
    expectOk(leavesRes.error, 'leaves read')
    expectOk(holidaysRes.error, 'holidays read')
    expectOk(workersRes.error, 'holiday_workers read')

    const designers = (designersRes.data ?? []) as Designer[]
    const schedules = (schedulesRes.data ?? []) as DesignerSchedule[]
    const quota: QuotaContext = {
      schedules,
      exceptions: (exceptionsRes.data ?? []) as QuotaException[],
      leaves: (leavesRes.data ?? []) as Leave[],
      holidays: (holidaysRes.data ?? []) as Holiday[],
      holidayWorkers: (workersRes.data ?? []) as HolidayWorker[],
    }

    // ── (1) Assignment gaps at shift-start + offset (spec §11 T3, §12) ────────
    // Both today's and yesterday's shift starts are evaluated so a shift whose
    // start+offset crosses PKT midnight (e.g. 23:30 start) is never skipped,
    // and one designer's failure never aborts the rest.
    let gapAlerts = 0
    for (const d of designers) {
      if (!d.clickup_list_id) continue
      for (const workDate of [today, addDays(today, -1)]) {
        try {
          const schedule = scheduleFor(schedules, d.id, workDate)
          if (!schedule) continue
          const checkAt =
            pktInstant(workDate, schedule.shift_start).getTime() +
            cfg.assignment_gap_check_offset_min * 60_000
          const sinceCheck = now.getTime() - checkAt
          if (sinceCheck < 0 || sinceCheck > GAP_WINDOW_MS) continue

          const expected = expectedQuotaOn(d.id, workDate, quota)
          if (expected <= 0) continue // off day / leave / holiday — no slots expected

          // Owner's rule: ONLY projects due this work day fill its slots —
          // status and creation date don't matter. A task due tomorrow, even
          // one being worked right now, belongs to tomorrow.
          let filled = await slotsFilledDb(supa, d.id, workDate)
          if (expected - filled > 0) {
            // Trust but verify against ClickUp live before accusing the
            // assignment team — a dropped webhook or reconcile lag must never
            // raise a false gap. (The higher count wins; missing tasks are
            // imported by the next reconcile run anyway.)
            let cuDue = 0
            for (let page = 0; page < 3; page++) {
              const { tasks: dueBatch, lastPage } = await getListTasks(d.clickup_list_id, {
                dueDateGt: pktInstant(workDate, '00:00').getTime(),
                dueDateLt: pktInstant(addDays(workDate, 1), '00:00').getTime(),
                includeClosed: true,
                page,
              })
              cuDue += dueBatch.length
              if (lastPage || dueBatch.length === 0) break
            }
            filled = Math.max(filled, cuDue)
          }
          const gap = expected - filled
          if (gap <= 0) continue

          const result = await fireAlert(supa, {
            alert_type: 'assignment_gap',
            designer_id: d.id,
            severity: 'warning',
            // §20.3 wording — an observation + a deep-link action, never a write.
            message: `${gap} slot${gap === 1 ? '' : 's'} open — open ${d.name}'s list in ClickUp`,
            context: { work_date: workDate, expected, filled, gap },
          })
          if (result.fired) gapAlerts++
        } catch (err) {
          console.error(`[cron/pulse] gap check failed for ${d.name} (${workDate})`, err)
        }
      }
    }

    // ── (2) Task aging — trust but verify (spec §11 T3, §12) ──────────────────
    // Collect every open task past its threshold, then check the oldest
    // candidates against ClickUp LIVE before flagging anything. Rows frozen by
    // old imports (copied tasks, empty histories) heal on the spot; deleted
    // ghosts are dropped; only tasks ClickUp confirms as stuck may alert.
    const { data: openRows, error: openErr } = await supa
      .from('task_state')
      .select('*')
      .eq('deleted', false)
      .not('current_status', 'in', '("complete","cancelled")')
      .limit(5000)
    expectOk(openErr, 'open tasks read')
    const openTasks = (openRows ?? []) as TaskState[]

    interface AgedCandidate {
      t: TaskState
      severity: 'warning' | 'critical'
      message: string
      days: number
      thresholdDays: number
    }
    const candidates: AgedCandidate[] = []
    // Waiting on the client is NEVER an error — clients reply late, that's
    // the business — so client-response tasks can't become alert candidates.
    // Long client waits are still silently verified against ClickUp so rows
    // frozen by old imports heal without ever flagging anyone.
    const silentVerify: TaskState[] = []
    for (const t of openTasks) {
      if (!t.current_status) continue
      const age = ageMinutes(t, now)
      if (t.current_status === 'client response') {
        if (age >= cfg.aging_days_client_response * 1440) silentVerify.push(t)
        continue
      }
      const thresholdDays = cfg.aging_days_default
      if (age < thresholdDays * 1440) continue
      const days = Math.floor(age / 1440)
      const severity = age >= thresholdDays * 2 * 1440 ? 'critical' : 'warning'
      const message = `"${t.name ?? t.task_id}" has sat ${days}d in ${STATUS_LABELS[t.current_status]}`
      candidates.push({ t, severity, message, days, thresholdDays })
    }

    // Verified set shrinks agedTaskIds only via CONFIRMED heals/ghosts, so a
    // budget-starved run can never mass-resolve alerts for unchecked tasks.
    const agedTaskIds = new Set(candidates.map((c) => c.t.task_id))
    let agedVerify: AgedVerifyResult | null = null
    try {
      agedVerify = await verifyAgedOpenTasks(
        supa,
        [...candidates.map((c) => c.t), ...silentVerify],
        started + BUDGET_MS - 8_000, // reserve room for attendance + response
      )
      for (const id of agedVerify.removed) agedTaskIds.delete(id)
    } catch (err) {
      console.error('[cron/pulse] aged verification failed', err)
    }

    let agingAlerts = 0
    for (const c of candidates) {
      if (outOfTime()) break
      // Not yet confirmed by ClickUp → no new alert; next runs will get to it.
      if (!agedVerify?.confirmed.has(c.t.task_id)) continue
      const result = await fireAlert(supa, {
        alert_type: 'task_aging',
        designer_id: c.t.designer_id,
        task_id: c.t.task_id,
        severity: c.severity,
        message: c.message,
        context: {
          status: c.t.current_status,
          age_days: c.days,
          threshold_days: c.thresholdDays,
        },
      })
      if (result.fired || result.escalated) agingAlerts++
    }

    // ── (2b) Alerts clean themselves up: when the flagged condition no longer
    // holds, the alert resolves itself — no manual inbox sweeping.
    let autoResolved = 0
    {
      const { data: openAging, error: oaErr } = await supa
        .from('alerts')
        .select('id,task_id')
        .eq('alert_type', 'task_aging')
        .in('status', ['open', 'acknowledged'])
        .limit(2000)
      expectOk(oaErr, 'open aging alerts read')
      const stale = ((openAging ?? []) as Array<{ id: number; task_id: string | null }>)
        .filter((a) => !a.task_id || !agedTaskIds.has(a.task_id))
        .map((a) => a.id)
      for (let i = 0; i < stale.length; i += 200) {
        const { error: resErr } = await supa
          .from('alerts')
          .update({ status: 'resolved', resolved_at: now.toISOString() })
          .in('id', stale.slice(i, i + 200))
        expectOk(resErr, 'aging alerts auto-resolve')
      }
      autoResolved += stale.length
    }
    // Assignment-gap alerts clean themselves up too: yesterday's are history
    // once the day is over, and TODAY's resolve the moment the created count
    // reaches the expected quota — late assignments and healed imports must
    // not leave a stale accusation on the board all day.
    const { data: gapAlertRows, error: sgErr } = await supa
      .from('alerts')
      .select('id,designer_id,context')
      .eq('alert_type', 'assignment_gap')
      .in('status', ['open', 'acknowledged'])
      .limit(2000)
    expectOk(sgErr, 'open gap alerts read')
    const gapResolveIds: number[] = []
    for (const a of (gapAlertRows ?? []) as Array<{
      id: number
      designer_id: string | null
      context: Record<string, unknown> | null
    }>) {
      const workDate =
        typeof a.context?.work_date === 'string' ? (a.context.work_date as string) : null
      if (!workDate || workDate < today) {
        gapResolveIds.push(a.id)
        continue
      }
      if (!a.designer_id) continue
      try {
        const expected = expectedQuotaOn(a.designer_id, workDate, quota)
        const nowFilled = await slotsFilledDb(supa, a.designer_id, workDate)
        if (expected - nowFilled <= 0) gapResolveIds.push(a.id)
      } catch (err) {
        console.error('[cron/pulse] gap re-check failed', err)
      }
    }
    if (gapResolveIds.length) {
      const { error: sgResErr } = await supa
        .from('alerts')
        .update({ status: 'resolved', resolved_at: now.toISOString() })
        .in('id', gapResolveIds)
      expectOk(sgResErr, 'gap alerts auto-resolve')
      autoResolved += gapResolveIds.length
    }

    summary.work_date = today
    summary.gapAlerts = gapAlerts
    summary.agingAlerts = agingAlerts
    summary.autoResolved = autoResolved
    summary.agedCandidates = candidates.length
    summary.agedChecked = agedVerify?.checked ?? 0
    summary.agedHealed = agedVerify?.healed ?? 0
    summary.agedGhosted = agedVerify?.ghosted ?? 0
    summary.agedUntracked = agedVerify?.untracked ?? 0

    // ── (3) Attendance recompute — today + yesterday (spec §9.2) ──────────────
    // Parallel batches within the time budget. The start offset rotates every
    // 15 minutes so if a run can't finish everyone, the next run starts where
    // this one's tail was — nobody is starved.
    let attendanceRuns = 0
    let attendancePartial = false
    const offset = designers.length ? Math.floor(now.getTime() / 900_000) % designers.length : 0
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
            await recomputeWithPriorDay(supa, d, today, cfg)
            attendanceRuns += 2
          } catch (err) {
            console.error(`[cron/pulse] attendance recompute failed for ${d.name}`, err)
          }
        }),
      )
      summary.attendanceRuns = attendanceRuns
    }
    // Always present in the body, even when no designer batch ran.
    summary.attendanceRuns = attendanceRuns

    // ── (4) Deep verify — the system matches ClickUp BY ITSELF ───────────────
    // Whatever budget is left goes to the rolling workspace verification: a
    // few pages per run, cursor carried across runs, wrap-around forever. Any
    // divergence (missed webhook, moved task, copied-task empty history) heals
    // automatically within hours, with zero human action.
    let deepVerify: Awaited<ReturnType<typeof runDeepVerifySlice>> | null = null
    if (started + BUDGET_MS - Date.now() > 6_000) {
      try {
        deepVerify = await runDeepVerifySlice(supa, started + BUDGET_MS)
      } catch (err) {
        console.error('[cron/pulse] deep verify slice failed', err)
      }
    }

    // `summary` is the single source for the success body — the safety flush
    // and the final response can never drift apart again.
    respond(200, {
      ...summary,
      openTasks: openTasks.length,
      deepVerify,
      partial: attendancePartial,
      tookMs: Date.now() - started,
    })
  } catch (err) {
    console.error('[cron/pulse]', err)
    respond(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
