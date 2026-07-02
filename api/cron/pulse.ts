/**
 * Pulse cron (every 15 min) — the near-real-time watchers (spec §11 Tier 3 +
 * §12), all in PKT (spec §22.2):
 *  1. Assignment gaps: at shift_start + assignment_gap_check_offset_min for
 *     each active designer, expected quota (schedule + exceptions, zeroed on
 *     off/leave/holiday days) vs tasks created today in their list. A
 *     shortfall is idle paid capacity — attributed to the PM/assignment team,
 *     never the designer. The proposed action is a ClickUp deep link, never a
 *     write (spec §22.1).
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
import { json, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin } from '../_lib/supabaseAdmin'
import { loadConfig } from '../_lib/config'
import { fireAlert } from '../_lib/alerts'
import { recomputeWithPriorDay } from '../_lib/attendance-runner'

export const config = { maxDuration: 60 }

/**
 * The gap check fires when shift_start+offset fell within this lookback.
 * Generous (2h) on purpose: a skipped/failed cron run must not drop the day's
 * check, and fireAlert's per-work_date dedupe makes re-evaluation free.
 */
const GAP_WINDOW_MS = 120 * 60_000

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = Date.now()
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

          const { count, error: countErr } = await supa
            .from('task_state')
            .select('task_id', { count: 'exact', head: true })
            .eq('designer_id', d.id)
            .eq('deleted', false)
            .gte('created_at', pktInstant(workDate, '00:00').toISOString())
            .lt('created_at', pktInstant(addDays(workDate, 1), '00:00').toISOString())
          expectOk(countErr, `created-today count (${d.name})`)
          const created = count ?? 0
          const gap = expected - created
          if (gap <= 0) continue

          const result = await fireAlert(supa, {
            alert_type: 'assignment_gap',
            designer_id: d.id,
            severity: 'warning',
            // §20.3 wording — an observation + a deep-link action, never a write.
            message: `${gap} slot${gap === 1 ? '' : 's'} open — open ${d.name}'s list in ClickUp`,
            context: { work_date: workDate, expected, created, gap },
          })
          if (result.fired) gapAlerts++
        } catch (err) {
          console.error(`[cron/pulse] gap check failed for ${d.name} (${workDate})`, err)
        }
      }
    }

    // ── (2) Task aging (spec §11 T3, §12) ─────────────────────────────────────
    const { data: openRows, error: openErr } = await supa
      .from('task_state')
      .select('*')
      .eq('deleted', false)
      .not('current_status', 'in', '("complete","cancelled")')
      .limit(5000)
    expectOk(openErr, 'open tasks read')
    const openTasks = (openRows ?? []) as TaskState[]

    let agingAlerts = 0
    for (const t of openTasks) {
      if (!t.current_status) continue
      const thresholdDays =
        t.current_status === 'client response'
          ? cfg.aging_days_client_response
          : cfg.aging_days_default
      const age = ageMinutes(t, now)
      if (age < thresholdDays * 1440) continue
      const days = Math.floor(age / 1440)
      const severity = age >= thresholdDays * 2 * 1440 ? 'critical' : 'warning'
      const message =
        t.current_status === 'client response'
          ? `"${t.name ?? t.task_id}" parked ${days}d in client response — nudge the client`
          : `"${t.name ?? t.task_id}" has sat ${days}d in ${STATUS_LABELS[t.current_status]}`
      const result = await fireAlert(supa, {
        alert_type: 'task_aging',
        designer_id: t.designer_id,
        task_id: t.task_id,
        severity,
        message,
        context: { status: t.current_status, age_days: days, threshold_days: thresholdDays },
      })
      if (result.fired || result.escalated) agingAlerts++
    }

    // ── (3) Attendance recompute — today + yesterday (spec §9.2) ──────────────
    let attendanceRuns = 0
    for (const d of designers) {
      try {
        await recomputeWithPriorDay(supa, d, today, cfg)
        attendanceRuns += 2
      } catch (err) {
        console.error(`[cron/pulse] attendance recompute failed for ${d.name}`, err)
      }
    }

    json(res, 200, {
      ok: true,
      work_date: today,
      gapAlerts,
      agingAlerts,
      openTasks: openTasks.length,
      attendanceRuns,
      tookMs: Date.now() - started,
    })
  } catch (err) {
    console.error('[cron/pulse]', err)
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
