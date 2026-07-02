/**
 * Idempotent ClickUp webhook registration for the Designers Team space
 * (spec §6.1). Creating a webhook is receiver MANAGEMENT, not a task write —
 * the read-only guarantee of §22.1 is untouched.
 *
 * Endpoint defaults to https://{host}/api/clickup/webhook; override with
 * ?endpoint=... (e.g. when running behind a preview URL). If a webhook already
 * exists for the endpoint it is reported, not duplicated.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { json, requireCronAuth } from '../_lib/http'
import { createWebhook, DESIGNERS_SPACE_ID, getWebhooks } from '../_lib/clickup'

export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  try {
    const teamId = process.env.CLICKUP_TEAM_ID
    if (!teamId) {
      json(res, 500, { error: 'CLICKUP_TEAM_ID is not set' })
      return
    }

    const override = typeof req.query.endpoint === 'string' ? req.query.endpoint : null
    const host = req.headers.host
    const endpoint = override ?? (host ? `https://${host}/api/clickup/webhook` : null)
    if (!endpoint) {
      json(res, 400, { error: 'No host header — pass ?endpoint=https://.../api/clickup/webhook' })
      return
    }

    const existing = (await getWebhooks(teamId)).find((w) => w.endpoint === endpoint)
    if (existing) {
      json(res, 200, {
        ok: true,
        created: false,
        webhook: existing,
        note: 'Webhook already registered for this endpoint — nothing to do.',
      })
      return
    }

    const created = await createWebhook(teamId, endpoint, DESIGNERS_SPACE_ID)
    json(res, 200, {
      ok: true,
      created: true,
      webhook: created.webhook,
      note: 'Set CLICKUP_WEBHOOK_SECRET to this webhook\'s secret in Vercel env vars and redeploy.',
    })
  } catch (err) {
    console.error('[admin/setup-webhook]', err)
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
