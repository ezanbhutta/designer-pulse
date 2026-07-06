/**
 * Onsite team load (spec §22.6 companion — the CSR/PM side, tracked separately
 * from the remote designers). Each design project's CSR is the ClickUp member
 * who CREATED the task, so this reads how many live projects each of CSR 1..10
 * and the project managers are carrying, split by design team.
 *
 * Safe by construction:
 *   - requires a valid signed-in Supabase session (any app user);
 *   - read-only — it only counts what already exists in ClickUp, writing nothing
 *     back there;
 *   - cached in app_config for CACHE_MS so repeat views cost one config read,
 *     never a fresh full scan (bypass with ?force=1).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { json } from './_lib/http'
import { supabaseAdmin } from './_lib/supabaseAdmin'
import {
  ClickUpBudgetError,
  DESIGNERS_SPACE_ID,
  discoverSpaceLists,
  getListTasks,
  setClickUpDeadline,
} from './_lib/clickup'
import { listDesignerMap } from './_lib/ingest'
import { pktDateOf, pktToday, startOfWeek } from '../shared/pkt'

export const config = { maxDuration: 60 }

const CACHE_MS = 10 * 60_000
/** The onsite roster shown even at zero load, so a quiet CSR never vanishes. */
const ROSTER = [
  'CSR 1',
  'CSR 2',
  'CSR 3',
  'CSR 4',
  'CSR 5',
  'CSR 6',
  'CSR 7',
  'CSR 8',
  'CSR 9',
  'CSR 10',
  'Project Manager',
] as const

interface MemberLoad {
  name: string
  active: number
  newThisWeek: number
  byTeam: Record<string, number>
}

/** Map a task creator to its onsite label, or null if they are not onsite
 *  (a designer or anyone else who happened to create a task). */
function onsiteLabel(u?: { username?: string; email?: string } | null): string | null {
  if (!u) return null
  const name = (u.username ?? '').trim()
  const email = (u.email ?? '').toLowerCase()
  const m = name.match(/csr\s*0*(\d+)/i) ?? email.match(/madeitcsr0*(\d+)/i)
  if (m) {
    const n = Number(m[1])
    if (n >= 1 && n <= 10) return `CSR ${n}`
  }
  if (/project\s*manager/i.test(name) || email.includes('projectmanager')) return 'Project Manager'
  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const header = req.headers.authorization
  const token =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) {
    json(res, 401, { error: 'sign in required' })
    return
  }
  const supa = supabaseAdmin()
  const { data: userData, error: authErr } = await supa.auth.getUser(token)
  if (authErr || !userData?.user) {
    json(res, 401, { error: 'sign in required' })
    return
  }

  const force = req.query?.force === '1' || req.query?.force === 'true'

  // Serve the cached scan when it is still fresh — a full ClickUp walk is heavy.
  if (!force) {
    try {
      const { data } = await supa
        .from('app_config')
        .select('value')
        .eq('key', 'onsite_load')
        .maybeSingle()
      const cached = (data as { value?: Record<string, unknown> } | null)?.value
      const at = typeof cached?.computedAt === 'string' ? Date.parse(cached.computedAt) : NaN
      if (cached && Number.isFinite(at) && Date.now() - at < CACHE_MS) {
        json(res, 200, { ...cached, cached: true })
        return
      }
    } catch {
      /* no cache yet — compute below */
    }
  }

  const started = Date.now()
  setClickUpDeadline(started + 45_000)
  try {
    const [lists, designers] = await Promise.all([
      discoverSpaceLists(DESIGNERS_SPACE_ID),
      listDesignerMap(supa),
    ])
    const mapped = lists.filter((l) => designers.has(l.id))
    const weekStart = startOfWeek(pktToday())

    const load = new Map<string, MemberLoad>()
    const ensure = (name: string): MemberLoad => {
      let m = load.get(name)
      if (!m) {
        m = { name, active: 0, newThisWeek: 0, byTeam: {} }
        load.set(name, m)
      }
      return m
    }
    for (const n of ROSTER) ensure(n)

    // All lists in parallel; only OPEN tasks count as active load.
    await Promise.all(
      mapped.map(async (list) => {
        const team = designers.get(list.id)!.team
        for (let page = 0; ; page++) {
          const { tasks, lastPage } = await getListTasks(list.id, {
            includeClosed: false,
            page,
            orderBy: 'created',
          })
          for (const t of tasks) {
            const st = t.status?.status?.toLowerCase()
            if (st === 'complete' || st === 'cancelled') continue
            const label = onsiteLabel(t.creator)
            if (!label) continue
            const m = ensure(label)
            m.active++
            m.byTeam[team] = (m.byTeam[team] ?? 0) + 1
            if (t.date_created && pktDateOf(Number(t.date_created)) >= weekStart) m.newThisWeek++
          }
          if (lastPage) break
        }
      }),
    )

    const members = ROSTER.map((n) => load.get(n)!).sort((a, b) => b.active - a.active)
    const payload = {
      computedAt: new Date().toISOString(),
      members,
      totalActive: members.reduce((s, m) => s + m.active, 0),
      totalNewThisWeek: members.reduce((s, m) => s + m.newThisWeek, 0),
    }
    try {
      await supa.from('app_config').upsert({ key: 'onsite_load', value: payload }, { onConflict: 'key' })
    } catch {
      /* best-effort cache write */
    }
    json(res, 200, { ...payload, cached: false })
  } catch (e) {
    if (e instanceof ClickUpBudgetError) {
      json(res, 200, { error: 'The onsite scan ran out of time. Please try again in a moment.', partial: true })
      return
    }
    json(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}
