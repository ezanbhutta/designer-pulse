/**
 * One-time historical backfill (spec §6.3), sliced + cursored to fit
 * serverless limits.
 *
 * Guarantees on every invocation, in order of defense:
 *   1. A 40s work budget checked around EVERY operation; when spent, the call
 *      returns done:false with progress. A PERSISTENT CURSOR (app_config key
 *      'backfill_cursor' = {list_id, page}) means the next call jumps straight
 *      to the first unfinished page — no re-paging of finished work.
 *   2. The ClickUp client refuses to wait out a 429 past the budget
 *      (ClickUpBudgetError -> clean partial response, not a timeout).
 *   3. A last-resort 50s safety flush answers done:false BEFORE the platform
 *      can kill the invocation.
 * Pages are fetched with order_by=created (immutable key -> stable cursor),
 * processed page-by-page, and Supabase work is batched (~5 round-trips per
 * 20 tasks). Tasks that already have a task_metrics row are skipped, so even
 * without the cursor re-runs are idempotent. Responses carry phase timings.
 *
 * Revision rounds reconstructed from time-in-status are a LOWER BOUND
 * (ClickUp aggregates re-entries) -> metrics_confidence='backfill'; webhook
 * tracking is exact going forward.
 *
 * Params: ?list_id=<clickup list id> — restrict to one list (ignores the
 *         global cursor); ?force=1 — reset the cursor and redo everything.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { canonicalizeStatus, parseConceptCount } from '../../shared/statuses'
import { computeTaskMetrics, reconstructBackfillEvents, type TransitionEvent } from '../../shared/metrics'
import { json, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin, type SupabaseAdmin } from '../_lib/supabaseAdmin'
import {
  ClickUpBudgetError,
  DESIGNERS_SPACE_ID,
  discoverSpaceLists,
  getBulkTimeInStatus,
  getListTasks,
  setClickUpDeadline,
  type ClickUpTask,
} from '../_lib/clickup'
import { insertEvents, listDesignerMap, msToIso, type IngestEvent } from '../_lib/ingest'

const CURSOR_KEY = 'backfill_cursor'

interface Cursor {
  list_id: string
  page: number
}

export const config = { maxDuration: 60 }

const BUDGET_MS = 40_000
const SAFETY_FLUSH_MS = 50_000
const CHUNK = 20

/** Thrown by ensureTime() when the slice budget is spent. */
class SliceOver extends Error {}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = Date.now()
  setClickUpDeadline(started + BUDGET_MS)
  const ensureTime = () => {
    if (Date.now() - started > BUDGET_MS) throw new SliceOver()
  }

  const results: Array<{
    list_id: string
    list_name: string
    designer: string
    tasks: number
    already_done: number
    backfilled: number
    events: number
    completed: boolean
  }> = []
  const skipped: Array<{ list_id: string; list_name: string; reason: string }> = []
  const timings: Record<string, number> = {}
  let responded = false

  const respond = (done: boolean, extra?: Record<string, unknown>) => {
    if (responded) return
    responded = true
    clearTimeout(safety)
    json(res, 200, {
      ok: true,
      done,
      lists: results,
      skipped,
      timings,
      tookMs: Date.now() - started,
      hint: done
        ? 'Backfill complete — every mapped list is imported.'
        : 'Slice finished — CALL AGAIN; it resumes exactly where it stopped (already-imported tasks are skipped).',
      ...extra,
    })
  }

  // Last resort: never let the platform kill us without a usable answer.
  const safety = setTimeout(() => respond(false, { note: 'safety flush at 50s' }), SAFETY_FLUSH_MS)

  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now()
    try {
      return await fn()
    } finally {
      timings[name] = (timings[name] ?? 0) + (Date.now() - t0)
    }
  }

  try {
    const supa = supabaseAdmin()
    const rawParam = req.query.list_id
    const onlyListId =
      typeof rawParam === 'string' ? rawParam : Array.isArray(rawParam) ? rawParam[0] : null
    const force = req.query.force === '1' || req.query.force === 'true'

    const [lists, designers] = await timed('discover', () =>
      Promise.all([discoverSpaceLists(DESIGNERS_SPACE_ID), listDesignerMap(supa)]),
    )

    // Cursor: jump straight to the first unfinished (list, page). Ignored when
    // the caller restricts to one list; reset by ?force=1.
    let cursor: Cursor | null = null
    if (!onlyListId) {
      if (force) await saveCursor(supa, null)
      else cursor = await loadCursor(supa)
    }
    let startIdx = 0
    let startPage = 0
    if (cursor) {
      const idx = lists.findIndex((l) => l.id === cursor!.list_id)
      if (idx >= 0) {
        startIdx = idx
        startPage = cursor.page
      } // list vanished → start over from the top (skip-done makes it cheap)
    }

    for (let li = startIdx; li < lists.length; li++) {
      const list = lists[li]
      if (onlyListId && list.id !== onlyListId) continue
      const designer = designers.get(list.id)
      if (!designer) {
        skipped.push({ list_id: list.id, list_name: list.name, reason: 'no roster designer mapped' })
        continue
      }

      const entry = {
        list_id: list.id,
        list_name: list.name,
        designer: designer.name,
        tasks: 0,
        already_done: 0,
        backfilled: 0,
        events: 0,
        completed: false,
      }
      results.push(entry)

      // Page-by-page: fetch one page (≤100 tasks, order_by=created → stable),
      // import it, persist the cursor, move on. A slice always makes progress.
      for (let page = li === startIdx ? startPage : 0; ; page++) {
        ensureTime()
        const { tasks: batch, lastPage } = await timed('page_tasks', () =>
          getListTasks(list.id, { includeClosed: true, page, orderBy: 'created' }),
        )
        entry.tasks += batch.length

        if (batch.length > 0) {
          const doneIds = force
            ? new Set<string>()
            : await timed('scan_done', () =>
                existingMetricIds(supa, batch.map((t) => t.id), ensureTime),
              )
          entry.already_done += doneIds.size
          const pending = batch.filter((t) => !doneIds.has(t.id))

          for (let i = 0; i < pending.length; i += CHUNK) {
            ensureTime()
            const chunk = pending.slice(i, i + CHUNK)
            const n = await timed('import_chunk', () =>
              importChunk(supa, list.id, designer.id, chunk, ensureTime),
            )
            entry.backfilled += chunk.length
            entry.events += n
          }
        }

        if (lastPage || batch.length === 0) break
        if (!onlyListId) await saveCursor(supa, { list_id: list.id, page: page + 1 })
      }

      entry.completed = true
      // This list is done — cursor moves to the next one (or clears at the end).
      if (!onlyListId) {
        const next = lists[li + 1]
        await saveCursor(supa, next ? { list_id: next.id, page: 0 } : null)
      }
    }

    respond(true)
  } catch (err) {
    if (err instanceof SliceOver || err instanceof ClickUpBudgetError) {
      respond(false)
      return
    }
    console.error('[admin/backfill]', err)
    if (!responded) {
      responded = true
      clearTimeout(safety)
      json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err), timings })
    }
  }
}

/**
 * Import one chunk of tasks with BATCHED Supabase writes:
 * 1× task_state upsert, 1× created-events insert, 1× bulk TIS (per ≤100),
 * 1× status-events insert, 1× events read, 1× task_metrics upsert,
 * 1× task_state refresh. Returns the number of events inserted.
 */
async function importChunk(
  supa: SupabaseAdmin,
  listId: string,
  designerId: string,
  chunk: ClickUpTask[],
  ensureTime: () => void,
): Promise<number> {
  const nowIso = new Date().toISOString()

  // 1. Snapshot rows (same mapping as upsertTaskFromClickUp, batched).
  const stateRows = chunk.map((task) => {
    const tags = (task.tags ?? []).map((t) => t.name)
    const canonical = canonicalizeStatus(task.status?.status ?? null)
    if (!canonical && task.status?.status) {
      console.warn(`[admin/backfill] unknown status "${task.status.status}" on task ${task.id} (spec §6.4)`)
    }
    return {
      task_id: task.id,
      list_id: listId,
      designer_id: designerId,
      name: task.name ?? null,
      ...(canonical ? { current_status: canonical } : {}),
      priority: task.priority?.priority ?? null,
      concept_count: parseConceptCount(tags),
      scope_tags: tags,
      created_at: msToIso(task.date_created),
      due_date: msToIso(task.due_date),
      closed_at: msToIso(task.date_closed),
      deleted: false,
      updated_at: nowIso,
    }
  })
  ensureTime()
  const upErr = await supa.from('task_state').upsert(stateRows, { onConflict: 'task_id' })
  expectOk(upErr.error, 'task_state batch upsert')

  // 2. Created events (assignment time = date_created, spec §2).
  const createdEvents: IngestEvent[] = []
  for (const task of chunk) {
    const createdIso = msToIso(task.date_created)
    if (createdIso) {
      createdEvents.push({
        task_id: task.id,
        list_id: listId,
        designer_id: designerId,
        event_type: 'created',
        event_time: createdIso,
        source: 'backfill',
      })
    }
  }
  ensureTime()
  await insertEvents(supa, createdEvents)

  // 3. Time-in-status (1 ClickUp request per ≤100 ids; deadline-guarded).
  const tisById = await getBulkTimeInStatus(chunk.map((t) => t.id))

  // 4. Reconstructed transitions, one batched insert.
  const statusEvents: IngestEvent[] = []
  for (const task of chunk) {
    const tis = tisById[task.id]
    if (!tis) continue
    const history = [...(tis.status_history ?? []), ...(tis.current_status ? [tis.current_status] : [])]
    for (const e of reconstructBackfillEvents(task.id, listId, history, task.status?.status ?? null)) {
      statusEvents.push({
        task_id: task.id,
        list_id: listId,
        designer_id: designerId,
        event_type: 'status_change',
        from_status: e.from_status,
        to_status: e.to_status,
        event_time: e.event_time,
        source: 'backfill',
      })
    }
  }
  ensureTime()
  await insertEvents(supa, statusEvents)

  // 5. Batched metrics recompute: ONE events read for the whole chunk, compute
  //    in-process, ONE metrics upsert, ONE snapshot refresh.
  ensureTime()
  const ids = chunk.map((t) => t.id)
  const { data: evRows, error: evErr } = await supa
    .from('clickup_events')
    .select('task_id,event_type,from_status,to_status,event_time,source,id')
    .in('task_id', ids)
    .order('task_id')
    .order('event_time', { ascending: true })
    .order('id', { ascending: true })
    .limit(20000)
  expectOk(evErr, 'clickup_events chunk read')

  const byTask = new Map<string, Array<TransitionEvent & { source: string }>>()
  for (const row of (evRows ?? []) as Array<TransitionEvent & { task_id: string; source: string }>) {
    const list = byTask.get(row.task_id) ?? []
    list.push(row)
    byTask.set(row.task_id, list)
  }

  const now = new Date()
  const metricsRows: Record<string, unknown>[] = []
  const stateRefresh: Record<string, unknown>[] = []
  for (const task of chunk) {
    const createdIso = msToIso(task.date_created)
    if (!createdIso) continue
    const events = byTask.get(task.id) ?? []
    const computed = computeTaskMetrics(createdIso, events, now)
    const anyBackfill = events.some((e) => e.source === 'backfill')
    const statusEventsOfTask = events.filter((e) => e.event_type === 'status_change' && e.to_status)
    const lastEventAt = statusEventsOfTask.length
      ? statusEventsOfTask[statusEventsOfTask.length - 1].event_time
      : createdIso
    metricsRows.push({
      task_id: task.id,
      designer_id: designerId,
      start_latency_min: computed.start_latency_min,
      production_min: computed.production_min,
      first_pass_clean: computed.first_pass_clean,
      revision_rounds: computed.revision_rounds,
      csr_caught_rounds: computed.csr_caught_rounds,
      client_caught_rounds: computed.client_caught_rounds,
      revision_turnaround_min: computed.revision_turnaround_min,
      client_wait_min: computed.client_wait_min,
      first_delivered_at: computed.first_delivered_at,
      outcome: computed.outcome,
      is_cancelled: computed.is_cancelled,
      metrics_confidence: anyBackfill ? 'backfill' : 'live',
      computed_at: now.toISOString(),
    })
    stateRefresh.push({
      task_id: task.id,
      list_id: listId,
      designer_id: designerId,
      current_status: computed.current_status,
      last_event_at: lastEventAt,
      closed_at: computed.outcome === 'in_flight' ? null : lastEventAt,
      updated_at: now.toISOString(),
    })
  }
  ensureTime()
  const mErr = await supa.from('task_metrics').upsert(metricsRows, { onConflict: 'task_id' })
  expectOk(mErr.error, 'task_metrics batch upsert')
  const sErr = await supa.from('task_state').upsert(stateRefresh, { onConflict: 'task_id' })
  expectOk(sErr.error, 'task_state batch refresh')

  return createdEvents.length + statusEvents.length
}

/** Read the persisted (list, page) cursor; null = start from the top. */
async function loadCursor(supa: SupabaseAdmin): Promise<Cursor | null> {
  const { data, error } = await supa
    .from('app_config')
    .select('value')
    .eq('key', CURSOR_KEY)
    .maybeSingle()
  expectOk(error, 'backfill cursor read')
  const v = (data?.value ?? null) as Cursor | null
  return v && typeof v.list_id === 'string' && typeof v.page === 'number' ? v : null
}

/** Persist the cursor; null clears it (backfill finished or ?force reset). */
async function saveCursor(supa: SupabaseAdmin, cursor: Cursor | null): Promise<void> {
  if (cursor === null) {
    const { error } = await supa.from('app_config').delete().eq('key', CURSOR_KEY)
    expectOk(error, 'backfill cursor clear')
    return
  }
  const { error } = await supa
    .from('app_config')
    .upsert({ key: CURSOR_KEY, value: cursor }, { onConflict: 'key' })
  expectOk(error, 'backfill cursor save')
}

/** Which of these task ids already have a task_metrics row? (chunked IN query) */
async function existingMetricIds(
  supa: SupabaseAdmin,
  ids: string[],
  ensureTime: () => void,
): Promise<Set<string>> {
  const found = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    ensureTime()
    const slice = ids.slice(i, i + 200)
    const { data, error } = await supa.from('task_metrics').select('task_id').in('task_id', slice)
    expectOk(error, 'task_metrics existence check')
    for (const row of (data ?? []) as Array<{ task_id: string }>) found.add(row.task_id)
  }
  return found
}
