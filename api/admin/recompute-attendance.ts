/**
 * Retroactive attendance recompute (spec §8.3/§9.2): re-derives
 * attendance_daily over an arbitrary date range after late leave/holiday
 * entries or effective-dated schedule edits older than the nightly sweep.
 *
 * POST /api/admin/recompute-attendance?from=YYYY-MM-DD&to=YYYY-MM-DD[&designer_id=uuid]
 * Auth: Authorization: Bearer $CRON_SECRET. Range capped at 92 days per call.
 *
 * Big ranges × the whole roster can't finish in one invocation, so the work is
 * budgeted: reference data (schedules/leaves/holidays/half-days) loads ONCE,
 * dates run outer / designers inner, and when the ~50s budget is spent the
 * call answers `{ done:false, resume:{ date, designer_id } }` — re-call with
 * `from=resume.date` to finish (every recompute is idempotent, so overlap is
 * free). A 55s safety flush guarantees the caller always gets that answer
 * instead of a FUNCTION_INVOCATION_TIMEOUT that hides how far the run got.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { dateRange } from '../../shared/pkt'
import type {
  Designer,
  DesignerSchedule,
  HalfDay,
  Holiday,
  HolidayWorker,
  Leave,
} from '../../shared/types'
import { createSafetyResponder, json, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin } from '../_lib/supabaseAdmin'
import { loadConfig } from '../_lib/config'
import { computeAttendanceFor, type AttendancePreload } from '../_lib/attendance-runner'

export const config = { maxDuration: 60 }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 92
const BUDGET_MS = 50_000
const SAFETY_FLUSH_MS = 55_000

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = Date.now()
  const from = String(req.query.from ?? '')
  const to = String(req.query.to ?? '')
  const designerId = req.query.designer_id ? String(req.query.designer_id) : null
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    json(res, 400, { error: 'from/to must be YYYY-MM-DD with from <= to' })
    return
  }
  const dates = dateRange(from, to)
  if (dates.length > MAX_DAYS) {
    json(res, 400, { error: `range too wide (${dates.length}d) — max ${MAX_DAYS}d per call` })
    return
  }

  let runs = 0
  const failures: string[] = []
  // The (designer, date) about to be processed; null once the sweep finished.
  let resume: { date: string; designer_id: string; designer_name: string } | null = null
  const buildBody = (extra?: Record<string, unknown>): Record<string, unknown> => ({
    ok: true,
    done: resume === null,
    dates: dates.length,
    runs,
    failures,
    tookMs: Date.now() - started,
    ...(resume
      ? {
          resume,
          hint: `Budget spent — CALL AGAIN with from=${resume.date}&to=${to} to finish (recomputes are idempotent).`,
        }
      : {}),
    ...extra,
  })
  const respond = createSafetyResponder(res, {
    safetyMs: SAFETY_FLUSH_MS,
    safetyBody: () => buildBody({ note: 'safety flush at 55s' }),
  })

  try {
    const supa = supabaseAdmin()
    const cfg = await loadConfig(supa)
    let q = supa.from('designers').select('*').neq('status', 'deleted')
    if (designerId) q = q.eq('id', designerId)
    const { data, error } = await q.order('name')
    expectOk(error, 'designers read')
    const designers = (data ?? []) as Designer[]

    // Reference data once for the whole range — computeAttendanceFor then
    // only pays the 3 per-designer-day signal reads.
    let schedQ = supa.from('designer_schedule').select('*').limit(5000)
    let leaveQ = supa.from('leaves').select('*').lte('start_date', to).limit(5000)
    if (designerId) {
      schedQ = schedQ.eq('designer_id', designerId)
      leaveQ = leaveQ.eq('designer_id', designerId)
    }
    const [schedRes, leaveRes, holidayRes, workerRes, halfRes] = await Promise.all([
      schedQ,
      leaveQ,
      supa.from('holidays').select('*').gte('the_date', from).lte('the_date', to).limit(2000),
      supa.from('holiday_workers').select('*').gte('the_date', from).lte('the_date', to).limit(5000),
      supa.from('half_days').select('*').gte('the_date', from).lte('the_date', to).limit(5000),
    ])
    expectOk(schedRes.error, 'designer_schedule read')
    expectOk(leaveRes.error, 'leaves read')
    expectOk(holidayRes.error, 'holidays read')
    expectOk(workerRes.error, 'holiday_workers read')
    expectOk(halfRes.error, 'half_days read')
    const preloaded: AttendancePreload = {
      schedules: (schedRes.data ?? []) as DesignerSchedule[],
      leaves: (leaveRes.data ?? []) as Leave[],
      holidays: (holidayRes.data ?? []) as Holiday[],
      holidayWorkers: (workerRes.data ?? []) as HolidayWorker[],
      halfDays: (halfRes.data ?? []) as HalfDay[],
    }

    // Dates outer / designers inner: a budget cut leaves whole days finished,
    // so `resume.date` is an exact continuation point.
    let outOfBudget = false
    for (const date of dates) {
      for (const d of designers) {
        resume = { date, designer_id: d.id, designer_name: d.name }
        if (Date.now() - started > BUDGET_MS) {
          outOfBudget = true
          break
        }
        try {
          await computeAttendanceFor(supa, d, date, cfg, preloaded)
          runs++
        } catch (err) {
          failures.push(`${d.name} ${date}`)
          console.error(`[admin/recompute-attendance] ${d.name} ${date}`, err)
        }
      }
      if (outOfBudget) break
    }
    if (!outOfBudget) resume = null

    respond(200, buildBody({ designers: designers.length }))
  } catch (err) {
    console.error('[admin/recompute-attendance]', err)
    respond(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
