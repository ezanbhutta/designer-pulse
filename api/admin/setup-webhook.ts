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
    // Defense-in-depth: the override may only point at THIS deployment's
    // hosts — otherwise a leaked CRON_SECRET turns webhook registration into
    // a task-event exfiltration primitive.
    const allowedHosts = new Set(
      [host, process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL]
        .filter((h): h is string => !!h)
        .map((h) => h.replace(/^https?:\/\//, '')),
    )
    let endpoint: string | null = host ? `https://${host}/api/clickup/webhook` : null
    if (override) {
      let parsed: URL
      try {
        parsed = new URL(override)
      } catch {
        json(res, 400, { error: 'endpoint override is not a valid URL' })
        return
      }
      if (
        parsed.protocol !== 'https:' ||
        parsed.pathname !== '/api/clickup/webhook' ||
        !allowedHosts.has(parsed.host)
      ) {
        json(res, 400, {
          error: 'endpoint override must be https://<this deployment>/api/clickup/webhook',
          allowedHosts: [...allowedHosts],
        })
        return
      }
      endpoint = parsed.toString()
    }
    if (!endpoint) {
      json(res, 400, { error: 'No host header — pass ?endpoint=https://.../api/clickup/webhook' })
      return
    }

    const redact = <T extends { secret?: string | null }>(w: T): Omit<T, 'secret'> => {
      const { secret: _secret, ...rest } = w
      return rest
    }

    const existing = (await getWebhooks(teamId)).find((w) => w.endpoint === endpoint)
    if (existing) {
      json(res, 200, {
        ok: true,
        created: false,
        webhook: redact(existing),
        note: 'Webhook already registered for this endpoint — nothing to do. (Secret redacted; it is only shown once, at creation.)',
      })
      return
    }

    const created = await createWebhook(teamId, endpoint, DESIGNERS_SPACE_ID)
    // The secret is intentionally included HERE ONLY — the operator needs it
    // once to set CLICKUP_WEBHOOK_SECRET.
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
