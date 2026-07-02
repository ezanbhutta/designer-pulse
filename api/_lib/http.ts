/**
 * HTTP helpers for the Vercel serverless layer.
 * Cron + admin endpoints are protected by `Authorization: Bearer ${CRON_SECRET}`
 * (Vercel Cron sends this header automatically when CRON_SECRET is set).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

/** JSON response helper. */
export function json(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).json(body)
}

/**
 * Guard for cron/admin endpoints. Sends the 401 itself and returns false when
 * the caller is not authorized; handlers just `if (!requireCronAuth(...)) return`.
 */
export function requireCronAuth(req: VercelRequest, res: VercelResponse): boolean {
  const secret = process.env.CRON_SECRET
  const header = req.headers.authorization
  if (!secret || header !== `Bearer ${secret}`) {
    json(res, 401, { error: 'Unauthorized — send Authorization: Bearer CRON_SECRET' })
    return false
  }
  return true
}

/**
 * Raw request body — needed to verify the ClickUp webhook HMAC over the exact
 * bytes as sent. Reads the stream; if a body parser already consumed it, falls
 * back to the parsed body (ClickUp sends compact JSON, so a compact
 * re-serialization byte-matches in practice).
 */
export async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
  } catch {
    /* stream already consumed — fall through to the parsed-body fallback */
  }
  if (chunks.length) return Buffer.concat(chunks)
  const body: unknown = (req as VercelRequest & { body?: unknown }).body
  if (body == null) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body)
  return Buffer.from(JSON.stringify(body))
}
