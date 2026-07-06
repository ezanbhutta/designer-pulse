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
import { canonicalizeStatus, parseConceptCount } from '../../shared/statuses'
import type { TaskState } from '../../shared/types'
import { createSafetyResponder, requireCronAuth } from '../_lib/http'
import { expectOk, supabaseAdmin } from '../_lib/supabaseAdmin'
import {
  ClickUpBudgetError,
  DESIGNERS_SPACE_ID,
  discoverSpaceLists,
  getListTasks,
  setClickUpDeadline,
  type ClickUpTask,
} from '../_lib/clickup'
import { getLastSync, setLastSync } from '../_lib/config'
import { sweepDueToday } from '../_lib/due-sweep'
import {
  autoLinkDesignerLists,
  backfillTaskHistory,
  ensureWebhookHealthy,
  handleCancellation,
  insertEvent,
  listDesignerMap,
  msToIso,
  recomputeTaskMetrics,
  syncDesignerNames,
} from '../_lib/ingest'

export const config = { maxDuration: 60 }

const OVERLAP_MS = 5 * 60_000
const FIRST_RUN_LOOKBACK_MS = 24 * 3600_000
/**
 * Longest slice of ClickUp updates one run will process. A long backlog (e.g.
 * after a webhook outage) is cleared one step at a time, advancing the cursor
 * each run, so no single run re-attempts a 40-hour window and times out. Caught
 * up, the window collapses to "now" and steady-state is unchanged.
 */
const STEP_MS = 3 * 3600_000
/**
 * A quiet window (nothing updated) lets the next window leap further, so a long
 * but idle backlog (e.g. a workspace untouched for days) is walked in a handful
 * of steps instead of one 3-hour hop per run. Any window that carries work snaps
 * the step back to STEP_MS so a busy stretch is never gathered into one oversized
 * (timeout-prone) window. Capped so a single leap can never span too much ground.
 */
const MAX_STEP_MS = 2 * 24 * 3600_000
/**
 * Stop draining new windows at this point in the invocation and leave the rest
 * of the budget for the due-today sweep and the response flush. Whatever the
 * cursor reached is already saved, so the next run continues from there.
 */
const DRAIN_SOFT_MS = 18_000

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return
  const started = new Date()
  // External schedulers (cron-job.org free tier) wait ≤30s and auto-disable
  // jobs that keep timing out, so reconcile must ALWAYS answer within ~25s.
  // On budget exhaustion we return partial and do NOT advance last_sync, so
  // the next 15-minute run redoes the window (5-min overlap covers gaps).
  setClickUpDeadline(started.getTime() + 22_000)
  const respond = createSafetyResponder(res, {
    safetyMs: 26_000,
    safetyBody: () => ({
      ok: true,
      partial: true,
      note: 'safety flush — last_sync not advanced, next run redoes the window',
      tookMs: Date.now() - started.getTime(),
    }),
  })
  try {
    const supa = supabaseAdmin()
    const lastSync = await getLastSync(supa)
    const cursorMs = lastSync ? new Date(lastSync).getTime() : started.getTime() - FIRST_RUN_LOOKBACK_MS
    // Any DB-heavy pass must abort before the invocation is force-killed at 60s
    // (which loses all progress). This wall clock is checked between tasks, so a
    // large heal batch always returns partial instead of dying.
    const wallDeadlineMs = started.getTime() + 23_000

    const [lists, designers] = await Promise.all([
      discoverSpaceLists(DESIGNERS_SPACE_ID),
      listDesignerMap(supa),
    ])

    // Self-extending mapping: link name-matching lists to unlinked designers
    // so their history starts flowing without anyone typing list ids.
    const autoLinked = await autoLinkDesignerLists(supa, lists, designers)
    // ClickUp owns the spelling: linked designers wear the exact list name.
    const renamed = await syncDesignerNames(supa, lists, designers)
    // The instant channel guarantees itself: verify/repair the ClickUp
    // webhook registration + signing secret every run.
    let webhook: Awaited<ReturnType<typeof ensureWebhookHealthy>> = null
    try {
      webhook = await ensureWebhookHealthy(supa)
    } catch (err) {
      if (err instanceof ClickUpBudgetError) throw err
      console.error('[cron/reconcile] webhook ensure failed', err)
    }

    let mappedLists = 0
    let tasksChecked = 0
    let backfilled = 0
    let healed = 0
    let recomputed = 0
    let dueTodaySwept = 0
    let duePhantomsHealed = 0

    // Shared per-batch pipeline: refresh known rows, backfill unknown ones,
    // heal status drift. Used by BOTH the updated-since window and the
    // due-today sweep below.
    const processBatch = async (
      list: { id: string; name: string },
      designer: { id: string },
      batch: ClickUpTask[],
    ): Promise<void> => {
        // task_state lookup, chunked ≤200 ids per `.in()` call.
        const existingById = new Map<string, TaskState>()
        const ids = batch.map((t) => t.id)
        for (let i = 0; i < ids.length; i += 200) {
          const { data: existingRows, error: existingErr } = await supa
            .from('task_state')
            .select('*')
            .in('task_id', ids.slice(i, i + 200))
          expectOk(existingErr, `task_state read (${list.name})`)
          for (const r of (existingRows ?? []) as TaskState[]) existingById.set(r.task_id, r)
        }

        // Refresh mutable fields (name / tags / due / priority / closed_at)
        // for every KNOWN task in ONE batched upsert — same mapping as
        // upsertTaskFromClickUp, minus current_status: snapping status here
        // without an event would hide the very drift this job exists to heal
        // (status only moves via events + recompute).
        const nowIso = new Date().toISOString()
        const refreshRows = batch
          .filter((t) => existingById.has(t.id))
          .map((task) => {
            const tags = (task.tags ?? []).map((t) => t.name)
            if (!canonicalizeStatus(task.status?.status ?? null) && task.status?.status) {
              console.warn(
                `[cron/reconcile] unknown status "${task.status.status}" on task ${task.id} — logged, transition skipped (spec §6.4)`,
              )
            }
            return {
              task_id: task.id,
              list_id: task.list?.id ?? list.id,
              designer_id: designer.id,
              name: task.name ?? null,
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
        if (refreshRows.length) {
          const { error: refreshErr } = await supa
            .from('task_state')
            .upsert(refreshRows, { onConflict: 'task_id' })
          expectOk(refreshErr, `task_state batch refresh (${list.name})`)
        }

        for (const task of batch) {
          if (Date.now() > wallDeadlineMs) throw new ClickUpBudgetError()
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

    // ── Phase B FIRST: the updated-since walk that advances the sync cursor.
    // The whole failure mode was a stuck clock, so the clock-advancing pass now
    // runs before anything else and always gets the budget. It DRAINS: it keeps
    // advancing windows within this invocation until it either catches up to now
    // or the soft time budget runs out, saving the cursor after every completed
    // window. Rotated so a heavy backlogged list cannot starve the tail; a busy
    // window stays STEP_MS-small (always fits), a quiet one leaps further so an
    // idle backlog closes in a few steps instead of one hop per run.
    const mapped = lists.filter((l) => designers.has(l.id))
    mappedLists = mapped.length
    const rotB = mapped.length ? Math.floor(started.getTime() / 900_000) % mapped.length : 0
    const orderB = [...mapped.slice(rotB), ...mapped.slice(0, rotB)]

    let cursor = cursorMs
    let step = STEP_MS
    let sinceMs = Math.max(0, cursor - OVERLAP_MS)
    let windowEndMs = cursor
    while (true) {
      sinceMs = Math.max(0, cursor - OVERLAP_MS)
      windowEndMs = Math.min(started.getTime(), cursor + step)
      let windowTasks = 0
      for (const list of orderB) {
        const designer = designers.get(list.id)!
        for (let page = 0; ; page++) {
          const { tasks: batch, lastPage } = await getListTasks(list.id, {
            dateUpdatedGt: sinceMs,
            dateUpdatedLt: windowEndMs,
            includeClosed: true,
            page,
          })
          if (!batch.length) break
          windowTasks += batch.length
          await processBatch(list, designer, batch)
          if (lastPage) break
        }
      }
      // Window finished — advance the cursor now, before anything else, so even
      // if the next window or the due-today sweep runs out of budget the clock
      // has already moved forward.
      await setLastSync(supa, new Date(windowEndMs).toISOString())
      cursor = windowEndMs
      if (windowEndMs >= started.getTime()) break // caught up to now
      if (Date.now() > started.getTime() + DRAIN_SOFT_MS) break // out of budget; next run continues
      // A quiet window means we can safely leap further; a busy one snaps back so
      // a busy stretch is never gathered into one oversized window.
      step = windowTasks === 0 ? Math.min(step * 4, MAX_STEP_MS) : STEP_MS
    }

    // ── Phase A (now second): the due-today sweep, with the budget that
    // remains. It runs every cycle and rotates, so a partial pass is safe and
    // the day's plate still converges.
    const sweep = await sweepDueToday(supa, lists, designers, started.getTime() + 20_000)
    dueTodaySwept = sweep.tasks
    duePhantomsHealed = sweep.phantoms
    respond(200, {
      ok: true,
      since: new Date(sinceMs).toISOString(),
      until: new Date(windowEndMs).toISOString(),
      caughtUp: windowEndMs >= started.getTime(),
      lists: lists.length,
      mappedLists,
      autoLinked,
      renamed,
      webhook,
      tasksChecked,
      backfilled,
      healed,
      recomputed,
      dueTodaySwept,
      duePhantomsHealed,
      tookMs: Date.now() - started.getTime(),
    })
  } catch (err) {
    if (err instanceof ClickUpBudgetError) {
      // Partial run: last_sync was NOT advanced, so the next 15-minute run
      // covers the same window again. Not an error condition.
      respond(200, {
        ok: true,
        partial: true,
        reason: 'ClickUp rate-limit wait exceeded the invocation budget',
        tookMs: Date.now() - started.getTime(),
      })
      return
    }
    console.error('[cron/reconcile]', err)
    respond(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
