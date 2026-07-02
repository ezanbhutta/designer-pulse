/**
 * One-time historical backfill (spec §6.3). For every existing task in every
 * mapped designer list (ALL tasks, closed included):
 *   task_state upsert → bulk time-in-status → reconstructBackfillEvents
 *   (source 'backfill') → idempotent event insert → metrics recompute.
 * Revision rounds reconstructed this way are a LOWER BOUND (ClickUp aggregates
 * re-entries), so these tasks carry metrics_confidence='backfill'; webhook
 * tracking is exact going forward.
 *
 * Batched + resumable: pass ?list_id=<clickup list id> to process one list per
 * call (re-runs are safe — every write is idempotent).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { canonicalizeStatus } from '../../shared/statuses'
import { reconstructBackfillEvents } from '../../shared/metrics'
import { json, requireCronAuth } from '../_lib/http'
import { supabaseAdmin } from '../_lib/supabaseAdmin'
import {
  DESIGNERS_SPACE_ID,
  discoverSpaceLists,
  getBulkTimeInStatus,
  getListTasks,
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

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = Date.now()
  try {
    const supa = supabaseAdmin()
    const rawParam = req.query.list_id
    const onlyListId = typeof rawParam === 'string' ? rawParam : Array.isArray(rawParam) ? rawParam[0] : null

    const [lists, designers] = await Promise.all([
      discoverSpaceLists(DESIGNERS_SPACE_ID),
      listDesignerMap(supa),
    ])

    const results: Array<{
      list_id: string
      list_name: string
      designer: string
      tasks: number
      events: number
    }> = []
    const skipped: Array<{ list_id: string; list_name: string; reason: string }> = []

    for (const list of lists) {
      if (onlyListId && list.id !== onlyListId) continue
      const designer = designers.get(list.id)
      if (!designer) {
        skipped.push({ list_id: list.id, list_name: list.name, reason: 'no roster designer mapped' })
        continue
      }

      // Page ALL tasks, closed included (spec §6.3).
      const tasks: ClickUpTask[] = []
      for (let page = 0; ; page++) {
        const { tasks: batch, lastPage } = await getListTasks(list.id, {
          includeClosed: true,
          page,
        })
        tasks.push(...batch)
        if (lastPage || batch.length === 0) break
      }

      let eventsInserted = 0
      for (const task of tasks) {
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

      // Bulk time-in-status (chunked ≤100 inside the client).
      const tisById = await getBulkTimeInStatus(tasks.map((t) => t.id))
      for (const task of tasks) {
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
        // All-backfill event logs keep metrics_confidence='backfill' here.
        await recomputeTaskMetrics(supa, task.id)
      }

      results.push({
        list_id: list.id,
        list_name: list.name,
        designer: designer.name,
        tasks: tasks.length,
        events: eventsInserted,
      })
    }

    json(res, 200, {
      ok: true,
      lists: results,
      skipped,
      hint: 'Resumable — pass ?list_id=<clickup list id> to backfill one list per call; re-runs are idempotent.',
      tookMs: Date.now() - started,
    })
  } catch (err) {
    console.error('[admin/backfill]', err)
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
