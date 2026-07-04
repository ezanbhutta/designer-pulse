/**
 * Ingestion core (spec §5/§6): immutable clickup_events → derived task_state +
 * task_metrics. Invariants (CONTRACTS.md):
 *  - events insert with ON CONFLICT DO NOTHING on
 *    (task_id, event_type, event_time, to_status) — idempotent across
 *    webhook / reconciliation / backfill;
 *  - task_metrics is recomputed from the FULL ordered event log via the shared
 *    computeTaskMetrics after every change (corrections never mutate raw);
 *  - a task entering `cancelled` fires an instant critical alert (spec §12);
 *  - the system NEVER writes to ClickUp (spec §22.1).
 */

import { canonicalizeStatus, parseConceptCount } from '../../shared/statuses'
import {
  computeTaskMetrics,
  reconstructBackfillEvents,
  type TransitionEvent,
} from '../../shared/metrics'
import type { CanonicalStatus } from '../../shared/statuses'
import type { ClickupEvent, Designer, TaskState } from '../../shared/types'
import { getTaskTimeInStatus, type ClickUpTask } from './clickup'
import { expectOk, type SupabaseAdmin } from './supabaseAdmin'
import { fireAlert } from './alerts'

/** ClickUp ms-epoch (string or number) → ISO timestamp, null-safe. */
export function msToIso(ms: string | number | null | undefined): string | null {
  if (ms == null || ms === '') return null
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n).toISOString()
}

/**
 * clickup_list_id → designer row. Includes archived designers so their history
 * keeps ingesting correctly (archive is the default exit, spec §8.2); only
 * hard-deleted designers drop out.
 */
export async function listDesignerMap(supa: SupabaseAdmin): Promise<Map<string, Designer>> {
  const { data, error } = await supa
    .from('designers')
    .select('*')
    .not('clickup_list_id', 'is', null)
    .neq('status', 'deleted')
  expectOk(error, 'designers read')
  const map = new Map<string, Designer>()
  for (const row of (data ?? []) as Designer[]) {
    // Trim defensively — a pasted id with stray whitespace must still map.
    const listId = row.clickup_list_id?.trim()
    if (listId) map.set(listId, row)
  }
  return map
}

/**
 * Auto-link discovered lists to roster designers BY NAME: a list called
 * "Khubaib" belongs to the designer named "Khubaib". Runs on every
 * reconciliation, so nobody has to hand-type list ids — the system extends
 * its own mapping as lists appear. Only links when the match is unambiguous
 * (exactly one unlinked designer with that name, list not already claimed);
 * every link is a DB write and lands in the audit log via triggers.
 */
export async function autoLinkDesignerLists(
  supa: SupabaseAdmin,
  lists: Array<{ id: string; name: string }>,
  mapped: Map<string, Designer>,
): Promise<Array<{ list_id: string; list_name: string; designer: string }>> {
  const { data, error } = await supa
    .from('designers')
    .select('*')
    .is('clickup_list_id', null)
    .neq('status', 'deleted')
  expectOk(error, 'unlinked designers read')
  const unlinked = (data ?? []) as Designer[]
  if (!unlinked.length) return []

  // Whitespace-insensitive matching: ClickUp list names sometimes carry
  // doubled spaces (e.g. "M.  Tariq") that no one can see or type.
  const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  const byName = new Map<string, Designer[]>()
  for (const d of unlinked) {
    const key = nameKey(d.name)
    byName.set(key, [...(byName.get(key) ?? []), d])
  }

  const linked: Array<{ list_id: string; list_name: string; designer: string }> = []
  for (const list of lists) {
    if (mapped.has(list.id)) continue
    const candidates = byName.get(nameKey(list.name))
    if (!candidates || candidates.length !== 1) continue // ambiguous or no match
    const designer = candidates[0]
    const { error: linkErr } = await supa
      .from('designers')
      .update({ clickup_list_id: list.id, updated_at: new Date().toISOString() })
      .eq('id', designer.id)
      .is('clickup_list_id', null)
    if (linkErr) {
      console.error(`[ingest] auto-link failed for ${designer.name}`, linkErr)
      continue
    }
    byName.delete(nameKey(list.name))
    mapped.set(list.id, { ...designer, clickup_list_id: list.id })
    linked.push({ list_id: list.id, list_name: list.name, designer: designer.name })
    console.log(`[ingest] auto-linked list "${list.name}" (${list.id}) → designer ${designer.name}`)
  }
  return linked
}

/**
 * ClickUp is the source of truth for designer NAMES too: a designer linked to
 * a list always wears that list's exact name. Runs on every reconciliation,
 * so a rename in ClickUp propagates within 15 minutes and nobody maintains
 * two spellings of the same person.
 */
export async function syncDesignerNames(
  supa: SupabaseAdmin,
  lists: Array<{ id: string; name: string }>,
  mapped: Map<string, Designer>,
): Promise<Array<{ designer_id: string; from: string; to: string }>> {
  const renamed: Array<{ designer_id: string; from: string; to: string }> = []
  for (const list of lists) {
    const designer = mapped.get(list.id)
    if (!designer) continue
    const exact = list.name.trim()
    if (!exact || designer.name === exact) continue
    const { error } = await supa
      .from('designers')
      .update({ name: exact, updated_at: new Date().toISOString() })
      .eq('id', designer.id)
    if (error) {
      console.error(`[ingest] name sync failed for ${designer.name} → ${exact}`, error)
      continue
    }
    renamed.push({ designer_id: designer.id, from: designer.name, to: exact })
    mapped.set(list.id, { ...designer, name: exact })
    console.log(`[ingest] designer renamed to exact ClickUp list name: "${designer.name}" → "${exact}"`)
  }
  return renamed
}

/**
 * Upsert the task_state snapshot from a full ClickUp task payload:
 * name / status / priority / tags → scope_tags + concept_count /
 * date_created (assignment time, spec §2) / due_date / date_closed.
 *
 * writeStatus:false skips current_status: callers that are NOT immediately
 * followed by an event insert + recompute (webhook taskUpdated, reconcile's
 * mutable-field refresh) must not snap status to ClickUp's live value —
 * doing so hides the drift from reconcile/deep-verify and the missed
 * transition event is never healed. Status moves only through events.
 */
export async function upsertTaskFromClickUp(
  supa: SupabaseAdmin,
  task: ClickUpTask,
  designerId: string,
  opts: { writeStatus?: boolean } = {},
): Promise<void> {
  const listId = task.list?.id
  if (!listId) throw new Error(`ClickUp task ${task.id} carries no list id — cannot upsert`)
  const tags = (task.tags ?? []).map((t) => t.name)
  const canonical = canonicalizeStatus(task.status?.status ?? null)
  if (!canonical && task.status?.status) {
    // Spec §6.4: unknown status names are logged for review, never guessed.
    console.warn(
      `[ingest] unknown status "${task.status.status}" on task ${task.id} — logged, transition skipped (spec §6.4)`,
    )
  }
  const row: Record<string, unknown> = {
    task_id: task.id,
    list_id: listId,
    designer_id: designerId,
    name: task.name ?? null,
    priority: task.priority?.priority ?? null,
    concept_count: parseConceptCount(tags),
    scope_tags: tags,
    created_at: msToIso(task.date_created),
    due_date: msToIso(task.due_date),
    closed_at: msToIso(task.date_closed),
    deleted: false,
    updated_at: new Date().toISOString(),
  }
  if (canonical && opts.writeStatus !== false) row.current_status = canonical
  const { error } = await supa.from('task_state').upsert(row, { onConflict: 'task_id' })
  expectOk(error, `task_state upsert (${task.id})`)
}

export interface IngestEvent {
  task_id: string
  list_id: string
  designer_id: string | null
  event_type: 'created' | 'status_change' | 'deleted'
  from_status?: CanonicalStatus | null
  to_status?: CanonicalStatus | null
  event_time: string
  source: 'webhook' | 'reconciliation' | 'backfill'
  raw?: unknown
}

/** Idempotent event insert (ON CONFLICT DO NOTHING). */
export async function insertEvent(supa: SupabaseAdmin, evt: IngestEvent): Promise<void> {
  await insertEvents(supa, [evt])
}

/** Batched idempotent event insert. */
export async function insertEvents(supa: SupabaseAdmin, evts: IngestEvent[]): Promise<void> {
  if (!evts.length) return
  const rows = evts.map((e) => ({
    task_id: e.task_id,
    list_id: e.list_id,
    designer_id: e.designer_id,
    event_type: e.event_type,
    from_status: e.from_status ?? null,
    to_status: e.to_status ?? null,
    event_time: e.event_time,
    source: e.source,
    raw: e.raw ?? null,
  }))
  const { error } = await supa.from('clickup_events').upsert(rows, {
    onConflict: 'task_id,event_type,event_time,to_status',
    ignoreDuplicates: true,
  })
  expectOk(error, `clickup_events insert (${rows[0].task_id})`)
}

/**
 * Reconstruct a task's full history from ClickUp's time-in-status payload and
 * insert it (spec §6.3). ALWAYS source='backfill' regardless of which job
 * runs it — the source describes how the events were derived (aggregated
 * re-entries → revision rounds are a lower bound), not who inserted them, and
 * recomputeTaskMetrics keys metrics_confidence off it. Used by the one-time
 * backfill, by reconciliation for never-seen tasks, and by the webhook when a
 * status update arrives for a task whose taskCreated was missed — a
 * created-event-only heal would freeze first_pass_clean=true forever.
 */
export async function backfillTaskHistory(
  supa: SupabaseAdmin,
  task: ClickUpTask,
  listId: string,
  designerId: string,
): Promise<void> {
  await upsertTaskFromClickUp(supa, task, designerId)
  const createdIso = msToIso(task.date_created)
  if (createdIso) {
    await insertEvent(supa, {
      task_id: task.id,
      list_id: listId,
      designer_id: designerId,
      event_type: 'created',
      event_time: createdIso,
      source: 'backfill',
    })
  }
  const tis = await getTaskTimeInStatus(task.id)
  const history = [
    ...(tis.status_history ?? []),
    ...(tis.current_status ? [tis.current_status] : []),
  ]
  // reconstructBackfillEvents drops unknown status names (spec §6.4) and
  // keeps the canonical chain intact.
  const events = reconstructBackfillEvents(history)
  const rows: IngestEvent[] = events.map((e) => ({
    task_id: task.id,
    list_id: listId,
    designer_id: designerId,
    event_type: 'status_change' as const,
    from_status: e.from_status,
    to_status: e.to_status,
    event_time: e.event_time,
    source: 'backfill' as const,
  }))

  // Snapshot heal: ClickUp's LIVE status is ground truth. Copied tasks (and
  // some others) return an empty time-in-status history — without this, the
  // event replay regresses them to their birth status ('pickup') and they
  // read as stuck forever. If the reconstructed chain is empty or ends on a
  // different status than the snapshot, append a final transition.
  const last = rows.length ? rows[rows.length - 1] : null
  const snapshot = canonicalizeStatus(task.status?.status ?? null)
  if (snapshot && snapshot !== (last?.to_status ?? 'pickup your projects')) {
    const closedOrUpdated = msToIso(task.date_closed) ?? msToIso(task.date_updated)
    const healTime =
      closedOrUpdated && (!last || closedOrUpdated > last.event_time)
        ? closedOrUpdated
        : new Date(new Date(last?.event_time ?? Date.now()).getTime() + 1000).toISOString()
    rows.push({
      task_id: task.id,
      list_id: listId,
      designer_id: designerId,
      event_type: 'status_change',
      from_status: last?.to_status ?? 'pickup your projects',
      to_status: snapshot,
      event_time: healTime,
      source: 'backfill',
      raw: { snapshotHeal: true },
    })
  }
  await insertEvents(supa, rows)
}

/**
 * Has a synthetic (reconciliation/backfill) event already recorded this same
 * physical transition close to this time? Used by the webhook so a late
 * ClickUp redelivery of a dropped event doesn't double-count a revision round
 * the reconciliation cron already healed with a slightly different timestamp.
 * Matched on the SAME from→to pair within a tight window: a redelivered
 * duplicate replays the identical physical transition within minutes, while a
 * genuine re-entry (a second revision round soon after a healed first one)
 * almost always differs in from_status or time and MUST still count. A null
 * from (unknown raw before-status) skips the from filter — heals record their
 * own canonical prior state, so requiring null would break the dedupe.
 */
export async function hasNearbySyntheticEvent(
  supa: SupabaseAdmin,
  taskId: string,
  fromStatus: CanonicalStatus | null,
  toStatus: CanonicalStatus,
  eventTime: string,
  windowMinutes = 10,
): Promise<boolean> {
  const t = new Date(eventTime).getTime()
  const from = new Date(t - windowMinutes * 60_000).toISOString()
  const to = new Date(t + windowMinutes * 60_000).toISOString()
  let q = supa
    .from('clickup_events')
    .select('id')
    .eq('task_id', taskId)
    .eq('to_status', toStatus)
    .in('source', ['reconciliation', 'backfill'])
    .gte('event_time', from)
    .lte('event_time', to)
  if (fromStatus) q = q.eq('from_status', fromStatus)
  const { data, error } = await q.limit(1)
  expectOk(error, `clickup_events synthetic match (${taskId})`)
  return (data ?? []).length > 0
}

/**
 * Recompute task_metrics for one task from its FULL ordered event log
 * (spec §4 attribution model) and refresh the task_state derived columns
 * (current_status / last_event_at / closed_at).
 * metrics_confidence is 'backfill' when ANY event was reconstructed from the
 * aggregated time-in-status payload (revision rounds are a lower bound there,
 * spec §6.3) — a taint that live events after cutover cannot wash out.
 */
export async function recomputeTaskMetrics(supa: SupabaseAdmin, taskId: string): Promise<void> {
  const { data: taskRow, error: taskErr } = await supa
    .from('task_state')
    .select('*')
    .eq('task_id', taskId)
    .maybeSingle()
  expectOk(taskErr, `task_state read (${taskId})`)
  const task = taskRow as TaskState | null
  if (!task || !task.created_at) return

  // Never select raw — it holds full webhook payloads and this is the hottest
  // read path (every webhook / heal / drift refresh).
  const { data: evRows, error: evErr } = await supa
    .from('clickup_events')
    .select('id,event_type,from_status,to_status,event_time,source')
    .eq('task_id', taskId)
    .order('event_time', { ascending: true })
    .order('id', { ascending: true })
    .limit(2000)
  expectOk(evErr, `clickup_events read (${taskId})`)
  const events = (evRows ?? []) as Array<
    Pick<ClickupEvent, 'id' | 'event_type' | 'from_status' | 'to_status' | 'event_time' | 'source'>
  >

  const transitions: TransitionEvent[] = events.map((e) => ({
    event_type: e.event_type,
    from_status: e.from_status,
    to_status: e.to_status,
    event_time: e.event_time,
  }))
  const now = new Date()
  const computed = computeTaskMetrics(task.created_at, transitions, now)

  const anyBackfill = events.some((e) => e.source === 'backfill')
  const statusEvents = events.filter((e) => e.event_type === 'status_change' && e.to_status)
  const lastEventAt = statusEvents.length
    ? statusEvents[statusEvents.length - 1].event_time
    : task.created_at

  const { error: metricsErr } = await supa.from('task_metrics').upsert(
    {
      task_id: taskId,
      designer_id: task.designer_id,
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
    },
    { onConflict: 'task_id' },
  )
  expectOk(metricsErr, `task_metrics upsert (${taskId})`)

  const { error: stateErr } = await supa
    .from('task_state')
    .update({
      current_status: computed.current_status,
      last_event_at: lastEventAt,
      closed_at: computed.outcome === 'in_flight' ? null : lastEventAt,
      updated_at: now.toISOString(),
    })
    .eq('task_id', taskId)
  expectOk(stateErr, `task_state refresh (${taskId})`)
}

/**
 * Batched recomputeTaskMetrics for a chunk of KNOWN task_state rows (the
 * nightly open-span drift refresh): ONE clickup_events read for the whole
 * chunk, compute in-process, ONE task_metrics upsert, ONE task_state refresh —
 * ~4 round trips per chunk instead of per task. Same math and same derived
 * columns as recomputeTaskMetrics; callers keep chunks ≤ ~50 tasks so the
 * events read stays under its row limit.
 */
export async function recomputeTaskMetricsChunk(
  supa: SupabaseAdmin,
  tasks: Array<Pick<TaskState, 'task_id' | 'list_id' | 'designer_id' | 'created_at'>>,
): Promise<number> {
  const chunk = tasks.filter((t) => t.created_at)
  if (!chunk.length) return 0
  const ids = chunk.map((t) => t.task_id)
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
  for (const t of chunk) {
    const events = byTask.get(t.task_id) ?? []
    const computed = computeTaskMetrics(t.created_at!, events, now)
    const anyBackfill = events.some((e) => e.source === 'backfill')
    const statusEvents = events.filter((e) => e.event_type === 'status_change' && e.to_status)
    const lastEventAt = statusEvents.length
      ? statusEvents[statusEvents.length - 1].event_time
      : t.created_at!
    metricsRows.push({
      task_id: t.task_id,
      designer_id: t.designer_id,
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
      task_id: t.task_id,
      list_id: t.list_id,
      designer_id: t.designer_id,
      current_status: computed.current_status,
      last_event_at: lastEventAt,
      closed_at: computed.outcome === 'in_flight' ? null : lastEventAt,
      updated_at: now.toISOString(),
    })
  }
  const mErr = await supa.from('task_metrics').upsert(metricsRows, { onConflict: 'task_id' })
  expectOk(mErr.error, 'task_metrics chunk upsert')
  const sErr = await supa.from('task_state').upsert(stateRefresh, { onConflict: 'task_id' })
  expectOk(sErr.error, 'task_state chunk refresh')
  return chunk.length
}

/**
 * A task entered `cancelled` — designer-fault terminal loss by definition
 * (spec §2/§4.3). Instant critical alert, routed Ops + CEO (spec §12); the
 * dashboards read it as a flag to investigate, not a verdict (spec §4.4).
 */
export async function handleCancellation(
  supa: SupabaseAdmin,
  task: { task_id: string; designer_id: string | null; name: string | null },
): Promise<void> {
  await fireAlert(supa, {
    alert_type: 'cancellation',
    designer_id: task.designer_id,
    task_id: task.task_id,
    severity: 'critical',
    message: `"${task.name ?? task.task_id}" was cancelled — designer-fault terminal loss. Review its status trail before judging.`,
    context: { task_name: task.name },
  })
}
