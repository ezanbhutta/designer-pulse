/**
 * Reconciliation pull (spec §5.2/§6.2) — the mandatory second ingestion
 * channel that heals dropped webhooks. Every run:
 *   1. auto-discovers the lists in the Designers Team space (folders +
 *      folderless) and maps them to roster designers via clickup_list_id;
 *   2. pulls tasks updated since last_sync minus a 5-minute overlap;
 *   3. backfills tasks we never saw (missed taskCreated) via time-in-status
 *      reconstruction, and inserts synthetic transitions where ClickUp's
 *      current status disagrees with task_state with no matching event;
 *   4. persists the new last_sync cursor.
 * All inserts are idempotent (ON CONFLICT DO NOTHING), so the overlap is safe.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { canonicalizeStatus } from '../../shared/statuses'
import type { TaskState } from '../../shared/types'
import { json, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin, type SupabaseAdmin } from '../_lib/supabaseAdmin'
import {
  ClickUpBudgetError,
  DESIGNERS_SPACE_ID,
  discoverSpaceLists,
  getListTasks,
  setClickUpDeadline,
  type ClickUpTask,
} from '../_lib/clickup'
import { getLastSync, setLastSync } from '../_lib/config'
import {
  backfillTaskHistory,
  handleCancellation,
  insertEvent,
  listDesignerMap,
  msToIso,
  recomputeTaskMetrics,
  upsertTaskFromClickUp,
} from '../_lib/ingest'

export const config = { maxDuration: 60 }

const OVERLAP_MS = 5 * 60_000
const FIRST_RUN_LOOKBACK_MS = 24 * 3600_000

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = new Date()
  // Never let a ClickUp 429 wait push the invocation into the platform kill —
  // on budget exhaustion we return partial and do NOT advance last_sync, so
  // the next 15-minute run redoes the window.
  setClickUpDeadline(started.getTime() + 45_000)
  try {
    const supa = supabaseAdmin()
    const lastSync = await getLastSync(supa)
    const sinceMs = lastSync
      ? Math.max(0, new Date(lastSync).getTime() - OVERLAP_MS)
      : started.getTime() - FIRST_RUN_LOOKBACK_MS

    const [lists, designers] = await Promise.all([
      discoverSpaceLists(DESIGNERS_SPACE_ID),
      listDesignerMap(supa),
    ])

    let mappedLists = 0
    let tasksChecked = 0
    let backfilled = 0
    let healed = 0
    let recomputed = 0

    for (const list of lists) {
      const designer = designers.get(list.id)
      if (!designer) continue // list without a roster designer — skip
      mappedLists++

      const tasks: ClickUpTask[] = []
      for (let page = 0; ; page++) {
        const { tasks: batch, lastPage } = await getListTasks(list.id, {
          dateUpdatedGt: sinceMs,
          includeClosed: true,
          page,
        })
        tasks.push(...batch)
        if (lastPage || batch.length === 0) break
      }
      if (!tasks.length) continue

      const ids = tasks.map((t) => t.id)
      const { data: existingRows, error: existingErr } = await supa
        .from('task_state')
        .select('*')
        .in('task_id', ids)
      expectOk(existingErr, `task_state read (${list.name})`)
      const existingById = new Map(
        ((existingRows ?? []) as TaskState[]).map((r) => [r.task_id, r]),
      )

      for (const task of tasks) {
        tasksChecked++
        const existing = existingById.get(task.id)
        const cuStatus = canonicalizeStatus(task.status?.status ?? null)

        if (!existing) {
          // Missed taskCreated → full backfill via time-in-status (spec §6.2).
          // Events carry source='backfill' so metrics_confidence honestly
          // reports the lower-bound revision rounds (spec §6.3/§19).
          await backfillTaskHistory(supa, task, list.id, designer.id)
          await recomputeTaskMetrics(supa, task.id)
          if (cuStatus === 'cancelled') {
            await handleCancellation(supa, {
              task_id: task.id,
              designer_id: designer.id,
              name: task.name,
            })
          }
          backfilled++
          continue
        }

        // Refresh mutable fields (name / tags / due / priority / closed_at).
        await upsertTaskFromClickUp(supa, task, designer.id)

        if (cuStatus && cuStatus !== existing.current_status) {
          const sinceIso =
            existing.last_event_at ?? existing.created_at ?? '1970-01-01T00:00:00Z'
          const { data: match, error: matchErr } = await supa
            .from('clickup_events')
            .select('id')
            .eq('task_id', task.id)
            .eq('to_status', cuStatus)
            .gte('event_time', sinceIso)
            .limit(1)
          expectOk(matchErr, `clickup_events match read (${task.id})`)
          if (!match || match.length === 0) {
            // Dropped webhook → synthetic transition (spec §6.2).
            await insertEvent(supa, {
              task_id: task.id,
              list_id: list.id,
              designer_id: designer.id,
              event_type: 'status_change',
              from_status: existing.current_status,
              to_status: cuStatus,
              event_time: msToIso(task.date_updated) ?? new Date().toISOString(),
              source: 'reconciliation',
              raw: { healed: true, clickup_status: task.status?.status ?? null },
            })
            healed++
          }
          await recomputeTaskMetrics(supa, task.id)
          recomputed++

          // Same-millisecond transitions can replay inverted, in which case a
          // "matching" event exists but the replayed terminal status still
          // disagrees with ClickUp. Force a heal ordered after everything.
          const { data: afterRow, error: afterErr } = await supa
            .from('task_state')
            .select('current_status,last_event_at')
            .eq('task_id', task.id)
            .maybeSingle()
          expectOk(afterErr, `task_state drift re-read (${task.id})`)
          const after = afterRow as Pick<TaskState, 'current_status' | 'last_event_at'> | null
          if (after && after.current_status !== cuStatus) {
            const base = after.last_event_at ? new Date(after.last_event_at).getTime() : Date.now()
            await insertEvent(supa, {
              task_id: task.id,
              list_id: list.id,
              designer_id: designer.id,
              event_type: 'status_change',
              from_status: after.current_status,
              to_status: cuStatus,
              event_time: new Date(base + 1000).toISOString(),
              source: 'reconciliation',
              raw: { forcedHeal: true, clickup_status: task.status?.status ?? null },
            })
            await recomputeTaskMetrics(supa, task.id)
            healed++
          }
          if (cuStatus === 'cancelled' && existing.current_status !== 'cancelled') {
            await handleCancellation(supa, {
              task_id: task.id,
              designer_id: designer.id,
              name: task.name,
            })
          }
        }
      }
    }

    await setLastSync(supa, started.toISOString())
    json(res, 200, {
      ok: true,
      since: new Date(sinceMs).toISOString(),
      lists: lists.length,
      mappedLists,
      tasksChecked,
      backfilled,
      healed,
      recomputed,
      tookMs: Date.now() - started.getTime(),
    })
  } catch (err) {
    if (err instanceof ClickUpBudgetError) {
      // Partial run: last_sync was NOT advanced, so the next 15-minute run
      // covers the same window again. Not an error condition.
      json(res, 200, {
        ok: true,
        partial: true,
        reason: 'ClickUp rate-limit wait exceeded the invocation budget',
        tookMs: Date.now() - started.getTime(),
      })
      return
    }
    console.error('[cron/reconcile]', err)
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
