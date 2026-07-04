/**
 * The due-today sweep — the owner's highest-priority sync guarantee: the
 * day's plate must ALWAYS match ClickUp, in both directions, for every
 * designer, regardless of webhook luck, list linking age, or how much backlog
 * the heavier jobs are chewing through.
 *
 * Per mapped list (rotating start order, so a budget death can never starve
 * the same lists run after run):
 *   1. Pull every task DUE today (PKT) from ClickUp — import missing ones,
 *      rebuild drifted ones, refresh the rest.
 *   2. Diff OUR due-today rows against ClickUp's: rows ClickUp didn't confirm
 *      are phantoms (deleted task / due date moved / task moved) — verify
 *      each via getTask and correct it.
 *
 * Called from reconcile (every 15 min) AND the public self-rate-limited
 * /api/tick, which any open dashboard nudges — so the plate stays honest even
 * if the external scheduler is down.
 */

import { canonicalizeStatus } from '../../shared/statuses'
import type { Designer, TaskState } from '../../shared/types'
import { addDays, pktInstant, pktToday } from '../../shared/pkt'
import {
  ClickUpBudgetError,
  getListTasks,
  getTask,
  type ClickUpTask,
} from './clickup'
import {
  backfillTaskHistory,
  handleCancellation,
  recomputeTaskMetrics,
  upsertTaskFromClickUp,
} from './ingest'
import { expectOk, type SupabaseAdmin } from './supabaseAdmin'

export interface DueSweepResult {
  lists: number
  tasks: number
  backfilled: number
  healed: number
  phantoms: number
  partial: boolean
}

export async function sweepDueToday(
  supa: SupabaseAdmin,
  lists: Array<{ id: string; name: string }>,
  designers: Map<string, Designer>,
  endAtMs: number,
  phantomCapPerList = 10,
): Promise<DueSweepResult> {
  const res: DueSweepResult = {
    lists: 0,
    tasks: 0,
    backfilled: 0,
    healed: 0,
    phantoms: 0,
    partial: false,
  }
  const today = pktToday()
  const dueGt = pktInstant(today, '00:00').getTime()
  const dueLt = pktInstant(addDays(today, 1), '00:00').getTime()

  const mapped = lists.filter((l) => designers.has(l.id))
  if (!mapped.length) return res
  const rot = Math.floor(Date.now() / 900_000) % mapped.length
  const order = [...mapped.slice(rot), ...mapped.slice(0, rot)]

  try {
    for (const list of order) {
      if (endAtMs - Date.now() < 2_500) {
        res.partial = true
        break
      }
      const designer = designers.get(list.id)!
      res.lists++

      // ── Forward: ClickUp's due-today set → our rows ─────────────────────
      const seen = new Set<string>()
      for (let page = 0; ; page++) {
        const { tasks: batch, lastPage } = await getListTasks(list.id, {
          dueDateGt: dueGt,
          dueDateLt: dueLt,
          includeClosed: true,
          page,
        })
        if (!batch.length) break

        const existingById = new Map<string, TaskState>()
        const ids = batch.map((t) => t.id)
        for (let i = 0; i < ids.length; i += 200) {
          const { data, error } = await supa
            .from('task_state')
            .select('*')
            .in('task_id', ids.slice(i, i + 200))
          expectOk(error, `due-sweep state read (${list.name})`)
          for (const r of (data ?? []) as TaskState[]) existingById.set(r.task_id, r)
        }

        for (const task of batch) {
          seen.add(task.id)
          res.tasks++
          const existing = existingById.get(task.id)
          const cuStatus = canonicalizeStatus(task.status?.status ?? null)
          if (!existing) {
            await backfillTaskHistory(supa, task, list.id, designer.id)
            await recomputeTaskMetrics(supa, task.id)
            if (cuStatus === 'cancelled') {
              await handleCancellation(supa, {
                task_id: task.id,
                designer_id: designer.id,
                name: task.name,
              })
            }
            res.backfilled++
          } else if (cuStatus && cuStatus !== existing.current_status) {
            // Full rebuild (idempotent) heals status, due date and
            // attribution drift in one move.
            await backfillTaskHistory(supa, task, list.id, designer.id)
            await recomputeTaskMetrics(supa, task.id)
            if (cuStatus === 'cancelled' && existing.current_status !== 'cancelled') {
              await handleCancellation(supa, {
                task_id: task.id,
                designer_id: designer.id,
                name: task.name,
              })
            }
            res.healed++
          } else {
            // Status agrees — refresh mutable fields (due date, name, list,
            // designer) so quiet edits land too.
            await upsertTaskFromClickUp(supa, task, designer.id)
          }
        }
        if (lastPage) break
      }

      // ── Backward: our due-today rows ClickUp did NOT confirm ────────────
      const { data: ourRows, error: ourErr } = await supa
        .from('task_state')
        .select('task_id')
        .eq('designer_id', designer.id)
        .eq('deleted', false)
        .gte('due_date', new Date(dueGt).toISOString())
        .lt('due_date', new Date(dueLt).toISOString())
        .limit(500)
      expectOk(ourErr, `due-sweep phantom read (${list.name})`)
      let cap = phantomCapPerList
      for (const row of (ourRows ?? []) as Array<{ task_id: string }>) {
        if (seen.has(row.task_id)) continue
        if (cap <= 0 || endAtMs - Date.now() < 2_000) {
          res.partial = true
          break
        }
        cap--
        let live: ClickUpTask | null = null
        try {
          live = await getTask(row.task_id)
        } catch (err) {
          if (err instanceof ClickUpBudgetError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          if (!(msg.includes('404') || /not found/i.test(msg))) throw err
        }
        const homeListId = live?.list?.id ?? null
        const homeDesigner = homeListId ? designers.get(homeListId) : undefined
        if (!live || !homeDesigner) {
          // Deleted in ClickUp, or moved outside the roster — off the plate.
          const { error } = await supa
            .from('task_state')
            .update({ deleted: true, updated_at: new Date().toISOString() })
            .eq('task_id', row.task_id)
          expectOk(error, `due-phantom ghost (${row.task_id})`)
        } else {
          // Still real — rebuild so due date / list / designer / status all
          // snap back to ClickUp's truth.
          await backfillTaskHistory(supa, live, homeListId!, homeDesigner.id)
          await recomputeTaskMetrics(supa, row.task_id)
        }
        res.phantoms++
      }
    }
  } catch (err) {
    if (!(err instanceof ClickUpBudgetError)) throw err
    res.partial = true // budget gone — the rotation covers the rest next run
  }
  return res
}
