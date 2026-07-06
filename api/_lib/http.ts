/**
 * HTTP helpers for the Vercel serverless layer.
 * Cron + admin endpoints are protected by `Authorization: Bearer ${CRON_SECRET}`
 * (Vercel Cron sends this header automatically when CRON_SECRET is set).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

/** Bumped on API behavior changes — lets `curl -i` prove which build is live. */
export const APP_VERSION = 'sp-43'

/** JSON response helper. */
export function json(res: VercelResponse, status: number, body: unknown): void {
  res.setHeader('x-studio-pulse-version', APP_VERSION)
  res.status(status).json(body)
}

/**
 * Budget-guarded responder for endpoints driven by external schedulers
 * (cron-job.org free tier waits ≤30s and auto-disables jobs that keep
 * "timing out"). Arms a safety timer that flushes `safetyBody()` with a 200
 * at `safetyMs`, BEFORE the scheduler gives up; the returned respond()
 * answers exactly once and disarms the timer. Per-endpoint budgets and flush
 * bodies stay with the handlers — this only owns the answer-once mechanics.
 */
export function createSafetyResponder(
  res: VercelResponse,
  opts: { safetyMs: number; safetyBody: () => Record<string, unknown> },
): (status: number, body: Record<string, unknown>) => void {
  let responded = false
  const respond = (status: number, body: Record<string, unknown>) => {
    if (responded) return
    responded = true
    clearTimeout(safety)
    json(res, status, body)
  }
  const safety = setTimeout(() => respond(200, opts.safetyBody()), opts.safetyMs)
  return respond
}

/** Constant-time string comparison (hash first so lengths never leak). */
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Guard for cron/admin endpoints. Sends the 401 itself and returns false when
 * the caller is not authorized; handlers just `if (!requireCronAuth(...)) return`.
 */
export function requireCronAuth(req: VercelRequest, res: VercelResponse): boolean {
  const secret = process.env.CRON_SECRET
  const header = req.headers.authorization
  if (!secret || typeof header !== 'string' || !secretsMatch(header, `Bearer ${secret}`)) {
    json(res, 401, { error: 'Unauthorized — send Authorization: Bearer CRON_SECRET' })
    return false
  }
  return true
}

/**
 * Raw request body — needed to verify the ClickUp webhook HMAC over the exact
 * bytes as sent. Vercel's Node helpers (always on for our functions — a
 * `config.api.bodyParser` export is NOT honored by @vercel/node) consume the
 * stream and replay it byte-exact ONLY to 'data'/'end' listeners via a
 * PassThrough shim; `for await (const c of req)` bypasses that shim and yields
 * nothing. So collect via event listeners, and keep the parsed-body
 * re-serialization strictly as a last resort (it byte-matches only when the
 * original JSON carried no \/ or \uXXXX escapes).
 */
export async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      req.on('end', () => resolve())
      req.on('error', reject)
      // Un-shimmed stream that something already drained: it will never emit
      // 'end' again — bail to the fallback instead of hanging. The shim's
      // PassThrough replays on the nextTick queue, which runs BEFORE
      // setImmediate, so a replayed body is never cut short by this.
      setImmediate(() => {
        if (req.readableEnded && chunks.length === 0) resolve()
      })
    })
  } catch {
    /* stream error — fall through to the parsed-body fallback */
  }
  if (chunks.length) return Buffer.concat(chunks)
  const body: unknown = (req as VercelRequest & { body?: unknown }).body
  if (body == null) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body)
  return Buffer.from(JSON.stringify(body))
}
