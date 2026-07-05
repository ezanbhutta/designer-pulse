/**
 * On-demand sync trigger for signed-in staff (spec §5.2 companion). The
 * reconcile cron only runs once a day on the hosting plan, so the live board
 * drifts from ClickUp between runs. This lets the open dashboard poke the
 * SAME proven reconcile job (which also re-registers the instant webhook) as
 * often as it is being watched — without ever exposing CRON_SECRET to the
 * browser.
 *
 * Safe by construction:
 *   - requires a valid Supabase session (any signed-in user of this app);
 *   - debounced against the shared last_sync cursor, so any number of open
 *     tabs can trigger at most one real ClickUp pull per DEBOUNCE window;
 *   - forwards to /api/cron/reconcile server-to-server with CRON_SECRET.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { json } from '../_lib/http'
import { supabaseAdmin } from '../_lib/supabaseAdmin'
import { getLastSync } from '../_lib/config'

export const config = { maxDuration: 60 }

/** At most one real ClickUp pull per minute, however many tabs are open. */
const DEBOUNCE_MS = 60_000

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'POST only' })
    return
  }

  const header = req.headers.authorization
  const token =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) {
    json(res, 401, { error: 'sign in required' })
    return
  }

  const supa = supabaseAdmin()
  // Validate the caller's Supabase session against the project (service-role
  // client verifies the JWT regardless of RLS). Any signed-in app user is
  // allowed to refresh the shared data.
  const { data: userData, error: authErr } = await supa.auth.getUser(token)
  if (authErr || !userData?.user) {
    json(res, 401, { error: 'sign in required' })
    return
  }

  let lastSync: string | null = null
  try {
    lastSync = await getLastSync(supa)
  } catch {
    /* treat a read failure as "stale" and let the sync run */
  }
  const ageMs = lastSync ? Date.now() - new Date(lastSync).getTime() : Infinity
  if (ageMs < DEBOUNCE_MS) {
    json(res, 200, { ok: true, skipped: true, reason: 'recently synced', lastSync })
    return
  }

  const secret = process.env.CRON_SECRET
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.PUBLIC_BASE_URL ?? null)
  if (!secret || !base) {
    json(res, 200, { ok: true, skipped: true, reason: 'sync not configured on the server', lastSync })
    return
  }

  try {
    const r = await fetch(`${base}/api/cron/reconcile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    })
    const reconcile = (await r.json().catch(() => ({}))) as Record<string, unknown>
    const newLast = await getLastSync(supa).catch(() => lastSync)
    json(res, 200, { ok: true, triggered: true, lastSync: newLast, reconcile })
  } catch (e) {
    json(res, 200, {
      ok: true,
      triggered: false,
      error: e instanceof Error ? e.message : String(e),
      lastSync,
    })
  }
}
