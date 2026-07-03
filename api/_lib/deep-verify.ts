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
import {
  ClickUpBudgetError,
  DESIGNERS_SPACE_ID,
  discoverSpaceLists,
  getListTasks,
} from './clickup'
import { backfillTaskHistory, listDesignerMap, recomputeTaskMetrics } from './ingest'
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
