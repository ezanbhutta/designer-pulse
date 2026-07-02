/**
 * Retroactive attendance recompute (spec §8.3/§9.2): re-derives
 * attendance_daily over an arbitrary date range after late leave/holiday
 * entries or effective-dated schedule edits older than the nightly sweep.
 *
 * POST /api/admin/recompute-attendance?from=YYYY-MM-DD&to=YYYY-MM-DD[&designer_id=uuid]
 * Auth: Authorization: Bearer $CRON_SECRET. Range capped at 92 days per call.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { dateRange } from '../../shared/pkt'
import type { Designer } from '../../shared/types'
import { json, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin } from '../_lib/supabaseAdmin'
import { loadConfig } from '../_lib/config'
import { computeAttendanceFor } from '../_lib/attendance-runner'

export const config = { maxDuration: 60 }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 92

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
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

  try {
    const supa = supabaseAdmin()
    const cfg = await loadConfig(supa)
    let q = supa.from('designers').select('*').neq('status', 'deleted')
    if (designerId) q = q.eq('id', designerId)
    const { data, error } = await q
    expectOk(error, 'designers read')
    const designers = (data ?? []) as Designer[]

    let runs = 0
    const failures: string[] = []
    for (const d of designers) {
      for (const date of dates) {
        try {
          await computeAttendanceFor(supa, d, date, cfg)
          runs++
        } catch (err) {
          failures.push(`${d.name} ${date}`)
          console.error(`[admin/recompute-attendance] ${d.name} ${date}`, err)
        }
      }
    }
    json(res, 200, { ok: true, designers: designers.length, dates: dates.length, runs, failures })
  } catch (err) {
    console.error('[admin/recompute-attendance]', err)
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
