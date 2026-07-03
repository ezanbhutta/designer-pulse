/**
 * One-time historical backfill (spec §6.3), sliced to fit serverless limits.
 *
 * Each invocation works for ~40s then returns cleanly with progress and
 * done:false — ClickUp's ~100 req/min rate limit makes a whole workspace
 * impossible in one 60s function call. Already-imported tasks (any
 * task_metrics row) are skipped, so REPEATED CALLS RESUME WHERE THE LAST ONE
 * STOPPED. Call until the response says done:true.
 *
 * For every pending task: task_state upsert → time-in-status →
 * reconstructBackfillEvents (source 'backfill') → idempotent event insert →
 * metrics recompute. Revision rounds reconstructed this way are a LOWER BOUND
 * (ClickUp aggregates re-entries) → metrics_confidence='backfill'; webhook
 * tracking is exact going forward.
 *
 * Params: ?list_id=<clickup list id> to restrict to one list;
 *         ?force=1 to redo tasks that already have metrics.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { canonicalizeStatus } from '../../shared/statuses'
import { reconstructBackfillEvents } from '../../shared/metrics'
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
import {
  insertEvent,
  insertEvents,
  listDesignerMap,
  msToIso,
  recomputeTaskMetrics,
  upsertTaskFromClickUp,
  type IngestEvent,
} from '../_lib/ingest'

export const config = { maxDuration: 60 }

/** Stop starting new work after this long; leaves headroom under maxDuration. */
const BUDGET_MS = 40_000
/** Tasks per work chunk (TIS fetch + recompute) between budget checks. */
const CHUNK = 25

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = Date.now()
  const outOfTime = () => Date.now() - started > BUDGET_MS
  // A ClickUp 429 Retry-After must never be awaited past the slice budget —
  // the client throws ClickUpBudgetError instead, handled below as done:false.
  setClickUpDeadline(started + BUDGET_MS)
  try {
    const supa = supabaseAdmin()
    const rawParam = req.query.list_id
    const onlyListId =
      typeof rawParam === 'string' ? rawParam : Array.isArray(rawParam) ? rawParam[0] : null
    const force = req.query.force === '1' || req.query.force === 'true'

    const [lists, designers] = await Promise.all([
      discoverSpaceLists(DESIGNERS_SPACE_ID),
      listDesignerMap(supa),
    ])

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
    let ranOutOfTime = false

    try {
    for (const list of lists) {
      if (onlyListId && list.id !== onlyListId) continue
      const designer = designers.get(list.id)
      if (!designer) {
        skipped.push({ list_id: list.id, list_name: list.name, reason: 'no roster designer mapped' })
        continue
      }
      if (outOfTime()) {
        ranOutOfTime = true
        break
      }

      // Page ALL tasks, closed included (spec §6.3) — cheap (~1 req / 100 tasks).
      const tasks: ClickUpTask[] = []
      for (let page = 0; ; page++) {
        const { tasks: batch, lastPage } = await getListTasks(list.id, {
          includeClosed: true,
          page,
        })
        tasks.push(...batch)
        if (lastPage || batch.length === 0) break
      }

      // Resume support: anything that already has a task_metrics row was
      // imported (by a previous slice, or tracked live by the webhook).
      const doneIds = force ? new Set<string>() : await existingMetricIds(supa, tasks.map((t) => t.id))
      const pending = tasks.filter((t) => !doneIds.has(t.id))

      let eventsInserted = 0
      let backfilled = 0
      let completed = true

      for (let i = 0; i < pending.length; i += CHUNK) {
        if (outOfTime()) {
          ranOutOfTime = true
          completed = false
          break
        }
        const chunk = pending.slice(i, i + CHUNK)

        for (const task of chunk) {
          await upsertTaskFromClickUp(supa, task, designer.id)
          const createdIso = msToIso(task.date_created)
          if (createdIso) {
            await insertEvent(supa, {
              task_id: task.id,
              list_id: list.id,
              designer_id: designer.id,
              event_type: 'created',
              event_time: createdIso,
              source: 'backfill',
            })
            eventsInserted++
          }
        }

        const tisById = await getBulkTimeInStatus(chunk.map((t) => t.id))
        for (const task of chunk) {
          const tis = tisById[task.id]
          if (tis) {
            const history = [
              ...(tis.status_history ?? []),
              ...(tis.current_status ? [tis.current_status] : []),
            ]
            const reconstructed = reconstructBackfillEvents(
              task.id,
              list.id,
              history,
              task.status?.status ?? null,
            )
            const rows: IngestEvent[] = []
            for (const e of reconstructed) {
              if (!canonicalizeStatus(e.to_status)) {
                console.warn(
                  `[admin/backfill] unknown status "${e.to_status ?? ''}" in history of task ${task.id} — skipped (spec §6.4)`,
                )
                continue
              }
              rows.push({
                task_id: task.id,
                list_id: list.id,
                designer_id: designer.id,
                event_type: 'status_change',
                from_status: e.from_status,
                to_status: e.to_status,
                event_time: e.event_time,
                source: 'backfill',
              })
            }
            await insertEvents(supa, rows)
            eventsInserted += rows.length
          }
          // Writing task_metrics is what marks this task done for resume.
          await recomputeTaskMetrics(supa, task.id)
          backfilled++
        }
      }

      results.push({
        list_id: list.id,
        list_name: list.name,
        designer: designer.name,
        tasks: tasks.length,
        already_done: doneIds.size,
        backfilled,
        events: eventsInserted,
        completed,
      })
      if (ranOutOfTime) break
    }
    } catch (err) {
      // Rate-limit wait would blow the slice — return partial progress; the
      // next call resumes (already-imported tasks are skipped).
      if (err instanceof ClickUpBudgetError) ranOutOfTime = true
      else throw err
    }

    const done = !ranOutOfTime
    json(res, 200, {
      ok: true,
      done,
      lists: results,
      skipped,
      hint: done
        ? 'Backfill complete — every mapped list is imported.'
        : 'Slice budget or ClickUp rate limit reached — CALL AGAIN (leave ~60s between calls if progress stalls); it resumes exactly where it stopped, already-imported tasks are skipped.',
      tookMs: Date.now() - started,
    })
  } catch (err) {
    console.error('[admin/backfill]', err)
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Which of these task ids already have a task_metrics row? (chunked IN query) */
async function existingMetricIds(supa: SupabaseAdmin, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200)
    const { data, error } = await supa.from('task_metrics').select('task_id').in('task_id', slice)
    expectOk(error, 'task_metrics existence check')
    for (const row of (data ?? []) as Array<{ task_id: string }>) found.add(row.task_id)
  }
  return found
}
