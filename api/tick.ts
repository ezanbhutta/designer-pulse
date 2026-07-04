/**
 * Self-serve micro-sync (no auth): any open dashboard nudges this endpoint on
 * load and every few minutes, so the due-today plate stays honest even if the
 * external scheduler is disabled or down.
 *
 * Safe to expose publicly by design:
 *  - it only pulls read-only truth FROM ClickUp into derived rows — nothing
 *    the caller sends is written anywhere;
 *  - it self-rate-limits via app_config ('last_tick', 4-minute floor), so
 *    hammering it costs one config read;
 *  - errors answer 200 with no detail (nothing to probe).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { json } from './_lib/http'
import { supabaseAdmin } from './_lib/supabaseAdmin'
import { DESIGNERS_SPACE_ID, discoverSpaceLists, setClickUpDeadline } from './_lib/clickup'
import { listDesignerMap } from './_lib/ingest'
import { sweepDueToday } from './_lib/due-sweep'

export const config = { maxDuration: 30 }

const MIN_INTERVAL_MS = 4 * 60_000
const KEY = 'last_tick'
const BUDGET_MS = 9_000

export default async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
  const started = Date.now()
  try {
    const supa = supabaseAdmin()
    const { data } = await supa.from('app_config').select('value').eq('key', KEY).maybeSingle()
    const last = typeof data?.value === 'string' ? new Date(data.value).getTime() : 0
    if (started - last < MIN_INTERVAL_MS) {
      json(res, 200, { ok: true, skipped: true })
      return
    }
    await supa
      .from('app_config')
      .upsert({ key: KEY, value: new Date(started).toISOString() }, { onConflict: 'key' })

    setClickUpDeadline(started + BUDGET_MS)
    const [lists, designers] = await Promise.all([
      discoverSpaceLists(DESIGNERS_SPACE_ID),
      listDesignerMap(supa),
    ])
    const sweep = await sweepDueToday(supa, lists, designers, started + BUDGET_MS, 5)
    json(res, 200, { ok: true, sweep, tookMs: Date.now() - started })
  } catch (err) {
    console.error('[tick]', err)
    json(res, 200, { ok: false })
  }
}
