/**
 * Rolling deep-verify: the system must match ClickUp BY ITSELF — no manual
 * sweeps. Each slice (run from the 15-minute pulse cron with its leftover
 * budget) walks a few pages of the workspace, compares every task's live
 * ClickUp status against task_state, and heals any divergence via full
 * history rebuild (which includes the snapshot heal). A persistent cursor
 * (app_config 'deep_verify_cursor') carries progress across runs and wraps
 * around at the end, so the whole workspace is re-verified continuously,
 * forever. Divergences from any cause — missed webhooks, moved tasks, empty
 * time-in-status histories on copied tasks — converge without human action.
 */

import { canonicalizeStatus } from '../../shared/statuses'
import type { TaskState } from '../../shared/types'
import {
  ClickUpBudgetError,
  DESIGNERS_SPACE_ID,
  discoverSpaceLists,
  getListTasks,
  getTask,
  type ClickUpTask,
} from './clickup'
import {
  backfillTaskHistory,
  insertEvent,
  listDesignerMap,
  recomputeTaskMetrics,
} from './ingest'
import { expectOk, type SupabaseAdmin } from './supabaseAdmin'

const CURSOR_KEY = 'deep_verify_cursor'

interface VerifyCursor {
  list_id: string
  page: number
}

export interface DeepVerifyResult {
  pages: number
  tasksChecked: number
  healed: number
  wrapped: boolean
}

export async function runDeepVerifySlice(
  supa: SupabaseAdmin,
  endAtMs: number,
): Promise<DeepVerifyResult> {
  const result: DeepVerifyResult = { pages: 0, tasksChecked: 0, healed: 0, wrapped: false }
  const timeLeft = () => endAtMs - Date.now()

  const [lists, designers] = await Promise.all([
    discoverSpaceLists(DESIGNERS_SPACE_ID),
    listDesignerMap(supa),
  ])
  const mapped = lists.filter((l) => designers.has(l.id))
  if (!mapped.length) return result

  const cursor = await loadCursor(supa)
  let idx = cursor ? mapped.findIndex((l) => l.id === cursor.list_id) : 0
  let page = idx >= 0 && cursor ? cursor.page : 0
  if (idx < 0) {
    idx = 0
    page = 0
  }

  try {
    while (timeLeft() > 4_000 && !result.wrapped) {
      const list = mapped[idx]
      const designer = designers.get(list.id)!
      const { tasks: batch, lastPage } = await getListTasks(list.id, {
        includeClosed: true,
        page,
        orderBy: 'created',
      })
      result.pages++

      if (batch.length) {
        const ids = batch.map((t) => t.id)
        const { data, error } = await supa
          .from('task_state')
          .select('task_id,current_status,deleted')
          .in('task_id', ids)
        expectOk(error, 'deep-verify state read')
        const byId = new Map(
          ((data ?? []) as Array<{ task_id: string; current_status: string | null; deleted: boolean }>).map(
            (r) => [r.task_id, r],
          ),
        )

        for (const task of batch) {
          result.tasksChecked++
          const snapshot = canonicalizeStatus(task.status?.status ?? null)
          const row = byId.get(task.id)
          const diverged =
            !row || row.deleted || (snapshot !== null && row.current_status !== snapshot)
          if (!diverged) continue
          if (timeLeft() < 4_000) return result // page redone next slice — idempotent
          await backfillTaskHistory(supa, task, list.id, designer.id)
          await recomputeTaskMetrics(supa, task.id)
          result.healed++
        }
      }

      if (lastPage || batch.length === 0) {
        idx++
        page = 0
        if (idx >= mapped.length) {
          idx = 0
          result.wrapped = true // full workspace cycle completed — start over next slice
        }
      } else {
        page++
      }
      await saveCursor(supa, { list_id: mapped[idx].id, page })
    }
  } catch (err) {
    if (!(err instanceof ClickUpBudgetError)) throw err
    // Rate-limit wait would blow the budget — resume from the cursor next run.
  }
  return result
}

// ── Verify-before-flag for "stuck" tasks ────────────────────────────────────
// A task may only be called stuck if ClickUp itself agrees. Before the pulse
// cron raises (or keeps) a task_aging alert, the oldest candidates are checked
// against ClickUp live: rows frozen by ancient imports rebuild their history
// and converge on the spot; rows whose ClickUp task was deleted are
// soft-deleted; only confirmed-stuck tasks may alert. A small log in
// app_config remembers confirmations so the same task is re-checked at most
// once per AGED_RECHECK_MS — steady-state cost is near zero.

const AGED_LOG_KEY = 'aged_verify_log'
const AGED_RECHECK_MS = 6 * 3600_000
const AGED_PARALLEL = 4
const AGED_MAX_PER_RUN = 60

export interface AgedVerifyResult {
  checked: number
  healed: number
  ghosted: number
  /** Tasks ClickUp confirmed (now or within AGED_RECHECK_MS) as truly stuck. */
  confirmed: Set<string>
  /** Tasks healed or ghosted — not stuck; their alerts should auto-resolve. */
  removed: Set<string>
}

export async function verifyAgedOpenTasks(
  supa: SupabaseAdmin,
  candidates: TaskState[],
  endAtMs: number,
): Promise<AgedVerifyResult> {
  const out: AgedVerifyResult = {
    checked: 0,
    healed: 0,
    ghosted: 0,
    confirmed: new Set(),
    removed: new Set(),
  }
  if (!candidates.length) return out

  const log = await loadAgedLog(supa)
  const nowMs = Date.now()
  const eventMs = (t: TaskState) =>
    new Date(t.last_event_at ?? t.created_at ?? '1970-01-01T00:00:00Z').getTime()

  // Oldest first: the longer a row has sat still, the more likely it is a
  // frozen import rather than genuinely stuck work.
  const queue: TaskState[] = []
  for (const t of [...candidates].sort((a, b) => eventMs(a) - eventMs(b))) {
    const lastSeen = log[t.task_id] ? new Date(log[t.task_id]).getTime() : 0
    if (nowMs - lastSeen < AGED_RECHECK_MS) {
      out.confirmed.add(t.task_id) // recently confirmed still-stuck — trust it
      continue
    }
    if (queue.length < AGED_MAX_PER_RUN) queue.push(t)
  }
  if (!queue.length) return out

  const designers = await listDesignerMap(supa)
  try {
    for (let i = 0; i < queue.length; i += AGED_PARALLEL) {
      if (endAtMs - Date.now() < 3_000) break
      const batch = queue.slice(i, i + AGED_PARALLEL)
      await Promise.all(
        batch.map(async (row) => {
          try {
            let live: ClickUpTask
            try {
              live = await getTask(row.task_id)
            } catch (err) {
              if (err instanceof ClickUpBudgetError) throw err
              const msg = err instanceof Error ? err.message : String(err)
              if (msg.includes('404') || /not found/i.test(msg)) {
                // Ghost — the ClickUp task no longer exists.
                await supa
                  .from('task_state')
                  .update({ deleted: true, updated_at: new Date().toISOString() })
                  .eq('task_id', row.task_id)
                out.checked++
                out.ghosted++
                out.removed.add(row.task_id)
                delete log[row.task_id]
                return
              }
              throw err
            }
            out.checked++
            const snapshot = canonicalizeStatus(live.status?.status ?? null)
            if (!snapshot || snapshot === row.current_status) {
              out.confirmed.add(row.task_id)
              log[row.task_id] = new Date().toISOString()
              return
            }
            await healDivergedAgedTask(supa, live, row, designers)
            out.healed++
            out.removed.add(row.task_id)
            delete log[row.task_id]
          } catch (err) {
            if (err instanceof ClickUpBudgetError) throw err
            console.error(`[aged-verify] ${row.task_id}`, err)
          }
        }),
      )
    }
  } catch (err) {
    if (!(err instanceof ClickUpBudgetError)) throw err
    // Budget gone — unverified candidates simply wait for the next run.
  }

  await saveAgedLog(supa, log, candidates)
  return out
}

/**
 * Rebuild the diverged task from ClickUp history (includes the snapshot heal
 * for copied tasks with empty time-in-status), then belt-and-braces: if the
 * replayed state STILL disagrees with ClickUp — e.g. a poisoned later-timed
 * event from an old import — force one last transition ordered after
 * everything, exactly like reconcile's drift heal. Convergence is guaranteed.
 */
async function healDivergedAgedTask(
  supa: SupabaseAdmin,
  live: ClickUpTask,
  row: TaskState,
  designers: Awaited<ReturnType<typeof listDesignerMap>>,
): Promise<void> {
  const listId = live.list?.id ?? row.list_id
  if (!listId) return // no list to rebuild from — leave it to the deep sweep
  const designerId = designers.get(listId)?.id ?? row.designer_id
  if (!designerId) return // unmapped list and no prior owner — nothing to pin it to
  await backfillTaskHistory(supa, live, listId, designerId)
  await recomputeTaskMetrics(supa, row.task_id)

  const snapshot = canonicalizeStatus(live.status?.status ?? null)
  if (!snapshot) return
  const { data: afterRow, error: afterErr } = await supa
    .from('task_state')
    .select('current_status,last_event_at')
    .eq('task_id', row.task_id)
    .maybeSingle()
  expectOk(afterErr, `aged-verify re-read (${row.task_id})`)
  const after = afterRow as Pick<TaskState, 'current_status' | 'last_event_at'> | null
  if (!after || after.current_status === snapshot) return
  const base = after.last_event_at ? new Date(after.last_event_at).getTime() : Date.now()
  await insertEvent(supa, {
    task_id: row.task_id,
    list_id: listId,
    designer_id: designerId,
    event_type: 'status_change',
    from_status: after.current_status,
    to_status: snapshot,
    event_time: new Date(base + 1000).toISOString(),
    source: 'reconciliation',
    raw: { forcedHeal: true, via: 'aged-verify', clickup_status: live.status?.status ?? null },
  })
  await recomputeTaskMetrics(supa, row.task_id)
}

async function loadAgedLog(supa: SupabaseAdmin): Promise<Record<string, string>> {
  const { data, error } = await supa
    .from('app_config')
    .select('value')
    .eq('key', AGED_LOG_KEY)
    .maybeSingle()
  expectOk(error, 'aged-verify log read')
  const v = (data?.value ?? null) as Record<string, string> | null
  return v && typeof v === 'object' ? { ...v } : {}
}

async function saveAgedLog(
  supa: SupabaseAdmin,
  log: Record<string, string>,
  candidates: TaskState[],
): Promise<void> {
  // Prune to tasks that are still aged candidates so the log cannot grow
  // without bound as tasks complete and stop qualifying.
  const keep = new Set(candidates.map((t) => t.task_id))
  const pruned: Record<string, string> = {}
  for (const [id, iso] of Object.entries(log)) if (keep.has(id)) pruned[id] = iso
  const { error } = await supa
    .from('app_config')
    .upsert({ key: AGED_LOG_KEY, value: pruned }, { onConflict: 'key' })
  expectOk(error, 'aged-verify log save')
}

async function loadCursor(supa: SupabaseAdmin): Promise<VerifyCursor | null> {
  const { data, error } = await supa
    .from('app_config')
    .select('value')
    .eq('key', CURSOR_KEY)
    .maybeSingle()
  expectOk(error, 'deep-verify cursor read')
  const v = (data?.value ?? null) as VerifyCursor | null
  return v && typeof v.list_id === 'string' && typeof v.page === 'number' ? v : null
}

async function saveCursor(supa: SupabaseAdmin, cursor: VerifyCursor): Promise<void> {
  const { error } = await supa
    .from('app_config')
    .upsert({ key: CURSOR_KEY, value: cursor }, { onConflict: 'key' })
  expectOk(error, 'deep-verify cursor save')
}
