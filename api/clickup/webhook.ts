/**
 * ClickUp webhook receiver (spec §6.1) — the instant ingestion channel.
 * Verifies X-Signature (HMAC-SHA256 hex of the raw body with
 * CLICKUP_WEBHOOK_SECRET, compared timing-safe), ingests the event, recomputes
 * the task's metrics, THEN answers 200 (serverless freezes after the
 * response). Unknown lists are a 200 no-op; unknown status names are logged
 * with their raw payload and the transition skipped (spec §6.4). The system
 * never writes to ClickUp (spec §22.1) — reconciliation heals anything missed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { canonicalizeStatus } from '../../shared/statuses'
import type { TaskState } from '../../shared/types'
import { json, readRawBody } from '../_lib/http'
import { expectOk, supabaseAdmin, type SupabaseAdmin } from '../_lib/supabaseAdmin'
import { getTask } from '../_lib/clickup'
import {
  backfillTaskHistory,
  handleCancellation,
  hasNearbySyntheticEvent,
  insertEvent,
  listDesignerMap,
  msToIso,
  recomputeTaskMetrics,
  upsertTaskFromClickUp,
} from '../_lib/ingest'

// Keep the raw body readable for HMAC verification.
export const config = { api: { bodyParser: false } }

interface HistoryStatusRef {
  status?: string | null
}

interface HistoryItem {
  field?: string
  date?: string | number
  before?: HistoryStatusRef | null
  after?: HistoryStatusRef | null
}

interface WebhookPayload {
  event?: string
  task_id?: string
  webhook_id?: string
  history_items?: HistoryItem[]
}

function signatureOk(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || raw.length === 0) return false
  const given = Buffer.from(header, 'utf8')
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'POST only' })
    return
  }
  const secret = process.env.CLICKUP_WEBHOOK_SECRET
  if (!secret) {
    json(res, 500, { error: 'CLICKUP_WEBHOOK_SECRET is not set' })
    return
  }

  const raw = await readRawBody(req)
  const sigHeader = req.headers['x-signature']
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
  if (!signatureOk(raw, sig, secret)) {
    json(res, 401, { error: 'bad signature' })
    return
  }

  let payload: WebhookPayload
  try {
    payload = JSON.parse(raw.toString('utf8')) as WebhookPayload
  } catch {
    json(res, 400, { error: 'invalid JSON' })
    return
  }

  // Do the work BEFORE responding — the function may freeze right after.
  try {
    await processEvent(supabaseAdmin(), payload)
  } catch (err) {
    // Still 200: retry storms get webhooks disabled by ClickUp, and the
    // reconciliation cron heals any gap (spec §5.2).
    console.error('[clickup/webhook] processing failed', err)
  }
  json(res, 200, { ok: true })
}

async function processEvent(supa: SupabaseAdmin, payload: WebhookPayload): Promise<void> {
  const taskId = payload.task_id
  if (!taskId || !payload.event) return
  switch (payload.event) {
    case 'taskCreated':
      await onTaskCreated(supa, taskId)
      return
    case 'taskStatusUpdated':
      await onStatusUpdated(supa, taskId, payload.history_items ?? [])
      return
    case 'taskDeleted':
      await onTaskDeleted(supa, taskId)
      return
    case 'taskUpdated':
      await onTaskUpdated(supa, taskId)
      return
    default:
      return // only subscribed events are handled
  }
}

async function loadTaskState(supa: SupabaseAdmin, taskId: string): Promise<TaskState | null> {
  const { data, error } = await supa
    .from('task_state')
    .select('*')
    .eq('task_id', taskId)
    .maybeSingle()
  expectOk(error, `task_state read (${taskId})`)
  return (data as TaskState | null) ?? null
}

/** taskCreated → assignment recorded: creation time IS the assignment time (spec §2). */
async function onTaskCreated(supa: SupabaseAdmin, taskId: string): Promise<void> {
  const task = await getTask(taskId)
  const listId = task.list?.id
  if (!listId) return
  const designers = await listDesignerMap(supa)
  const designer = designers.get(listId)
  if (!designer) return // unknown list → no-op; only designer lists are tracked
  await upsertTaskFromClickUp(supa, task, designer.id)
  const createdIso = msToIso(task.date_created) ?? new Date().toISOString()
  await insertEvent(supa, {
    task_id: taskId,
    list_id: listId,
    designer_id: designer.id,
    event_type: 'created',
    event_time: createdIso,
    source: 'webhook',
    raw: { event: 'taskCreated' },
  })
  await recomputeTaskMetrics(supa, taskId)
}

async function onStatusUpdated(
  supa: SupabaseAdmin,
  taskId: string,
  items: HistoryItem[],
): Promise<void> {
  let state = await loadTaskState(supa, taskId)
  if (!state) {
    // Missed taskCreated — the receiver may have been down through several
    // transitions, so heal the FULL history via time-in-status (a
    // created-event-only heal would permanently fake first_pass_clean).
    const task = await getTask(taskId)
    const listId = task.list?.id
    if (!listId) return
    const designers = await listDesignerMap(supa)
    const designer = designers.get(listId)
    if (!designer) return // unknown list
    await backfillTaskHistory(supa, task, listId, designer.id)
    await recomputeTaskMetrics(supa, taskId)
    state = await loadTaskState(supa, taskId)
    if (!state) return
  }

  const statusItems = items
    .filter((i) => i.field === 'status')
    .sort((a, b) => Number(a.date ?? 0) - Number(b.date ?? 0))

  let sawCancellation = false
  let changed = false
  for (const item of statusItems) {
    const from = canonicalizeStatus(item.before?.status ?? null)
    const to = canonicalizeStatus(item.after?.status ?? null)
    const eventTime = msToIso(item.date) ?? new Date().toISOString()
    if (!to) {
      // Unknown status name → log + store raw, skip the transition (spec §6.4).
      console.warn(
        `[clickup/webhook] unknown status "${item.after?.status ?? ''}" on task ${taskId} — transition skipped`,
      )
      await insertEvent(supa, {
        task_id: taskId,
        list_id: state.list_id,
        designer_id: state.designer_id,
        event_type: 'status_change',
        from_status: from,
        to_status: null,
        event_time: eventTime,
        source: 'webhook',
        raw: item,
      })
      continue
    }
    // A late redelivery of a transition reconciliation already healed (with a
    // slightly different timestamp) must not double-count the round.
    if (await hasNearbySyntheticEvent(supa, taskId, to, eventTime)) continue
    await insertEvent(supa, {
      task_id: taskId,
      list_id: state.list_id,
      designer_id: state.designer_id,
      event_type: 'status_change',
      from_status: from,
      to_status: to,
      event_time: eventTime,
      source: 'webhook',
      raw: item,
    })
    changed = true
    if (to === 'cancelled') sawCancellation = true
  }

  if (changed) {
    await recomputeTaskMetrics(supa, taskId)
    if (sawCancellation) {
      await handleCancellation(supa, {
        task_id: taskId,
        designer_id: state.designer_id,
        name: state.name,
      })
    }
  }
}

/** taskDeleted → soft delete; the raw event history is never purged (spec §6.1). */
async function onTaskDeleted(supa: SupabaseAdmin, taskId: string): Promise<void> {
  const state = await loadTaskState(supa, taskId)
  if (!state) return
  const nowIso = new Date().toISOString()
  const { error } = await supa
    .from('task_state')
    .update({ deleted: true, updated_at: nowIso })
    .eq('task_id', taskId)
  expectOk(error, `task_state soft delete (${taskId})`)
  await insertEvent(supa, {
    task_id: taskId,
    list_id: state.list_id,
    designer_id: state.designer_id,
    event_type: 'deleted',
    event_time: nowIso,
    source: 'webhook',
    raw: { event: 'taskDeleted' },
  })
}

/** taskUpdated → refresh tags / due date / priority / name from ClickUp. */
async function onTaskUpdated(supa: SupabaseAdmin, taskId: string): Promise<void> {
  let task
  try {
    task = await getTask(taskId)
  } catch {
    return // deleted or inaccessible — nothing to refresh
  }
  const listId = task.list?.id
  if (!listId) return
  const designers = await listDesignerMap(supa)
  const designer = designers.get(listId)
  if (!designer) return
  await upsertTaskFromClickUp(supa, task, designer.id)
}
