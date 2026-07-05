/**
 * Typed ClickUp v2 REST client — READ-ONLY toward tasks (spec §22.1: the tool
 * observes assignment, it never performs it; there is no write-back path and
 * that is a permanent guarantee, not a v1 limitation). The single POST in this
 * file is webhook MANAGEMENT (registering our own receiver) — it touches no
 * task data.
 *
 * Rate limits: 429 responses are retried up to 3 times, honouring Retry-After
 * with exponential fallback.
 */

const BASE = 'https://api.clickup.com/api/v2'

/** The "Designers Team" space (spec §3.1). Never read any other space. */
export const DESIGNERS_SPACE_ID = '90187090116'

/** Events our webhook subscribes to (spec §6.1). */
export const WEBHOOK_EVENTS = [
  'taskCreated',
  'taskStatusUpdated',
  'taskDeleted',
  'taskUpdated',
] as const

// ── Response shapes ───────────────────────────────────────────────────────────

export interface ClickUpStatusRef {
  status: string
  type?: string
  color?: string
}

export interface ClickUpTask {
  id: string
  name: string
  status: ClickUpStatusRef | null
  /** ClickUp timestamps are ms-epoch strings. */
  date_created: string | null
  date_updated: string | null
  date_closed: string | null
  due_date: string | null
  priority: { priority: string } | null
  tags: Array<{ name: string }> | null
  assignees: Array<{ id: number; username?: string; email?: string }> | null
  list: { id: string; name?: string } | null
  parent?: string | null
}

export interface ClickUpList {
  id: string
  name: string
  archived?: boolean
}

export interface ClickUpFolder {
  id: string
  name: string
  lists?: ClickUpList[]
}

export interface TimeInStatusEntry {
  status: string
  orderindex?: number
  total_time?: { by_minute?: number; since?: string }
}

export interface TimeInStatusResponse {
  current_status?: TimeInStatusEntry
  status_history?: TimeInStatusEntry[]
}

export interface ClickUpWebhook {
  id: string
  endpoint: string
  events: string[]
  space_id?: number | null
  list_id?: number | null
  secret?: string
  health?: { status: string; fail_count: number }
}

// ── Core request with 429-aware retry + hard deadline ────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Serverless kill-guard: a 429 Retry-After can be 60s+, and awaiting it inside
 * one invocation sails straight past any caller-side budget check into the
 * platform's FUNCTION_INVOCATION_TIMEOUT. Callers set a wall-clock deadline;
 * the client throws ClickUpBudgetError instead of waiting past it, so sliced
 * jobs (backfill/reconcile) can return partial progress and resume next call.
 */
export class ClickUpBudgetError extends Error {
  constructor(msg = 'ClickUp rate-limit wait would exceed the invocation budget') {
    super(msg)
    this.name = 'ClickUpBudgetError'
  }
}

let deadlineAt = Number.POSITIVE_INFINITY

/** Set the absolute ms-epoch after which no ClickUp call may start or wait. */
export function setClickUpDeadline(msEpoch: number): void {
  deadlineAt = msEpoch
}

const remainingMs = () => deadlineAt - Date.now()

async function request<T>(
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown },
): Promise<T> {
  const token = process.env.CLICKUP_API_TOKEN
  if (!token) throw new Error('CLICKUP_API_TOKEN is not set')
  const method = init?.method ?? 'GET'
  for (let attempt = 0; ; attempt++) {
    if (remainingMs() < 2_000) throw new ClickUpBudgetError()
    let res: Response
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(Math.min(Math.max(remainingMs() - 1_000, 1_000), 25_000)),
      })
    } catch (err) {
      // A slow ClickUp response hitting the abort cap is a budget condition,
      // not a failure — sliced callers answer done:false and resume next call.
      const name = (err as { name?: string })?.name
      const causeName = (err as { cause?: { name?: string } })?.cause?.name
      if (name === 'TimeoutError' || name === 'AbortError' || causeName === 'TimeoutError') {
        throw new ClickUpBudgetError(`ClickUp ${method} ${path} exceeded the invocation budget`)
      }
      throw err
    }
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt
      if (waitMs > remainingMs() - 2_000) throw new ClickUpBudgetError()
      await sleep(waitMs)
      continue
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ClickUp ${method} ${path} → ${res.status} ${text.slice(0, 300)}`)
    }
    return (await res.json()) as T
  }
}

// ── Hierarchy (list auto-discovery, spec §3.1) ────────────────────────────────

export async function getSpaceFolders(
  spaceId: string,
  archived = false,
): Promise<ClickUpFolder[]> {
  const data = await request<{ folders?: ClickUpFolder[] }>(
    `/space/${spaceId}/folder?archived=${archived}`,
  )
  return data.folders ?? []
}

export async function getFolderlessLists(
  spaceId: string,
  archived = false,
): Promise<ClickUpList[]> {
  const data = await request<{ lists?: ClickUpList[] }>(
    `/space/${spaceId}/list?archived=${archived}`,
  )
  return data.lists ?? []
}

/**
 * All lists in the space — folders' lists plus folderless, ACTIVE AND
 * ARCHIVED, de-duplicated. Archived structures still hold task history (and
 * their tasks still surface in space-wide views), so skipping them silently
 * hides whole designers from the system.
 */
export async function discoverSpaceLists(
  spaceId: string = DESIGNERS_SPACE_ID,
): Promise<ClickUpList[]> {
  const [folders, archivedFolders, folderless, archivedFolderless] = await Promise.all([
    getSpaceFolders(spaceId, false),
    getSpaceFolders(spaceId, true).catch(() => [] as ClickUpFolder[]),
    getFolderlessLists(spaceId, false),
    getFolderlessLists(spaceId, true).catch(() => [] as ClickUpList[]),
  ])
  const out: ClickUpList[] = []
  const seen = new Set<string>()
  for (const list of [
    ...folders.flatMap((f) => f.lists ?? []),
    ...archivedFolders.flatMap((f) => f.lists ?? []),
    ...folderless,
    ...archivedFolderless,
  ]) {
    if (!seen.has(list.id)) {
      seen.add(list.id)
      out.push(list)
    }
  }
  return out
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export interface ListTasksOptions {
  /** ms epoch — only tasks updated after this instant. */
  dateUpdatedGt?: number
  /** ms epoch — only tasks created after this instant. */
  dateCreatedGt?: number
  /** ms epoch — only tasks created before this instant. */
  dateCreatedLt?: number
  /** ms epoch — only tasks due after this instant. */
  dueDateGt?: number
  /** ms epoch — only tasks due before this instant. */
  dueDateLt?: number
  includeClosed?: boolean
  page?: number
  /** 'created' = stable pagination for cursors; default 'updated'. */
  orderBy?: 'created' | 'updated'
}

export async function getListTasks(
  listId: string,
  opts: ListTasksOptions = {},
): Promise<{ tasks: ClickUpTask[]; lastPage: boolean }> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 0))
  params.set('subtasks', 'true')
  params.set('include_closed', String(opts.includeClosed ?? true))
  // 'created' gives STABLE pagination (immutable key) — required by the
  // backfill's page cursor; reconciliation uses 'updated' for its date filter.
  params.set('order_by', opts.orderBy ?? 'updated')
  params.set('reverse', 'true')
  if (opts.dateUpdatedGt != null) params.set('date_updated_gt', String(Math.floor(opts.dateUpdatedGt)))
  if (opts.dateCreatedGt != null) params.set('date_created_gt', String(Math.floor(opts.dateCreatedGt)))
  if (opts.dateCreatedLt != null) params.set('date_created_lt', String(Math.floor(opts.dateCreatedLt)))
  if (opts.dueDateGt != null) params.set('due_date_gt', String(Math.floor(opts.dueDateGt)))
  if (opts.dueDateLt != null) params.set('due_date_lt', String(Math.floor(opts.dueDateLt)))
  const data = await request<{ tasks?: ClickUpTask[]; last_page?: boolean }>(
    `/list/${listId}/task?${params.toString()}`,
  )
  const tasks = data.tasks ?? []
  return { tasks, lastPage: data.last_page ?? tasks.length === 0 }
}

export async function getTask(taskId: string): Promise<ClickUpTask> {
  return request<ClickUpTask>(`/task/${taskId}`)
}

// ── Rich task detail (read-only, on demand for the task drawer) ───────────────

export interface ClickUpUser {
  id: number
  username?: string
  email?: string
  initials?: string
  color?: string
  profilePicture?: string | null
}
export interface ClickUpAttachment {
  id: string
  title?: string
  url?: string
  extension?: string
  size?: number
  date?: string
}
export interface ClickUpCustomFieldValue {
  id: string
  name: string
  type: string
  type_config?: { options?: Array<{ id: string; label: string; color?: string }> }
  value?: unknown
}
export interface ClickUpTaskDetail extends Omit<ClickUpTask, 'assignees'> {
  markdown_description?: string | null
  description?: string | null
  creator?: ClickUpUser | null
  assignees?: ClickUpUser[] | null
  watchers?: ClickUpUser[] | null
  attachments?: ClickUpAttachment[] | null
  custom_fields?: ClickUpCustomFieldValue[] | null
}
export interface ClickUpComment {
  id: string
  comment_text?: string
  user?: ClickUpUser | null
  date?: string
  resolved?: boolean
}

/** Full task payload (brief, custom fields, people, files) — for the drawer. */
export async function getTaskDetail(taskId: string): Promise<ClickUpTaskDetail> {
  return request<ClickUpTaskDetail>(`/task/${taskId}?include_markdown_description=true`)
}

/** Recent comments, newest first (ClickUp returns them reverse-chronological). */
export async function getTaskComments(taskId: string): Promise<ClickUpComment[]> {
  const data = await request<{ comments?: ClickUpComment[] }>(`/task/${taskId}/comment`)
  return data.comments ?? []
}

/** Resolve a `labels`-type custom field's selected option ids → their labels. */
export function resolveLabelField(field: ClickUpCustomFieldValue | undefined): string[] {
  if (!field || !Array.isArray(field.value)) return []
  const options = field.type_config?.options ?? []
  return (field.value as string[])
    .map((id) => options.find((o) => o.id === id)?.label)
    .filter((l): l is string => !!l)
}

// ── Time in status (historical backfill, spec §3.4 / §6.3) ────────────────────

export async function getTaskTimeInStatus(taskId: string): Promise<TimeInStatusResponse> {
  return request<TimeInStatusResponse>(`/task/${taskId}/time_in_status`)
}

/**
 * Bulk time-in-status, chunked ≤100 ids per call. The bulk endpoint requires
 * at least 2 ids — a lone id falls back to the single-task endpoint.
 */
export async function getBulkTimeInStatus(
  taskIds: string[],
): Promise<Record<string, TimeInStatusResponse>> {
  const out: Record<string, TimeInStatusResponse> = {}
  for (let i = 0; i < taskIds.length; i += 100) {
    const chunk = taskIds.slice(i, i + 100)
    if (chunk.length === 0) continue
    if (chunk.length === 1) {
      out[chunk[0]] = await getTaskTimeInStatus(chunk[0])
      continue
    }
    const params = chunk.map((id) => `task_ids=${encodeURIComponent(id)}`).join('&')
    const data = await request<Record<string, TimeInStatusResponse>>(
      `/task/bulk_time_in_status/task_ids?${params}`,
    )
    Object.assign(out, data)
  }
  return out
}

// ── Webhook management (NOT a task write — registering our own receiver) ─────

export async function createWebhook(
  teamId: string,
  endpoint: string,
  spaceId: string = DESIGNERS_SPACE_ID,
): Promise<{ id: string; webhook: ClickUpWebhook }> {
  return request<{ id: string; webhook: ClickUpWebhook }>(`/team/${teamId}/webhook`, {
    method: 'POST',
    body: { endpoint, events: [...WEBHOOK_EVENTS], space_id: Number(spaceId) },
  })
}

export async function getWebhooks(teamId: string): Promise<ClickUpWebhook[]> {
  const data = await request<{ webhooks?: ClickUpWebhook[] }>(`/team/${teamId}/webhook`)
  return data.webhooks ?? []
}

/** Re-activate (or re-point) an existing webhook — ClickUp suspends webhooks it deems failing. */
export async function updateWebhook(
  webhookId: string,
  endpoint: string,
): Promise<{ id: string; webhook: ClickUpWebhook }> {
  return request<{ id: string; webhook: ClickUpWebhook }>(`/webhook/${webhookId}`, {
    method: 'PUT',
    body: { endpoint, events: [...WEBHOOK_EVENTS], status: 'active' },
  })
}
