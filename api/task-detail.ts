/**
 * Read-only task detail for the in-app task drawer: the brief, deliverable,
 * files, people, and latest comments — fetched LIVE from ClickUp on demand so
 * nothing is stored or ever goes stale. Never writes to ClickUp (§22.1).
 *
 * Auth: the caller passes their Supabase access token (Authorization: Bearer).
 * We verify it, read their role, and enforce the same visibility as RLS — a
 * designer may open only their OWN tasks; ops/ceo/admin/pm/hr may open any.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { json } from './_lib/http'
import { supabaseAdmin } from './_lib/supabaseAdmin'
import {
  ClickUpBudgetError,
  getTaskComments,
  getTaskDetail,
  resolveLabelField,
  setClickUpDeadline,
} from './_lib/clickup'

export const config = { maxDuration: 20 }

const DELIVERABLES_FIELD_ID = '44cbabc0-3889-43ab-a427-222d97e2b78f'
const MAX_COMMENTS = 6

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const started = Date.now()
  setClickUpDeadline(started + 15_000)

  const taskId = typeof req.query.task_id === 'string' ? req.query.task_id : null
  if (!taskId) {
    json(res, 400, { error: 'task_id is required' })
    return
  }

  // ── Verify the caller and resolve their visibility ─────────────────────────
  const authHeader = req.headers.authorization
  const token =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null
  if (!token) {
    json(res, 401, { error: 'Sign in to view task details' })
    return
  }
  const supa = supabaseAdmin()
  const { data: userData, error: userErr } = await supa.auth.getUser(token)
  if (userErr || !userData?.user) {
    json(res, 401, { error: 'Your session has expired — sign in again' })
    return
  }
  const { data: profile, error: profErr } = await supa
    .from('app_users')
    .select('role,designer_id,active')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profErr || !profile || profile.active === false) {
    json(res, 403, { error: 'Your account is not set up to view this' })
    return
  }

  const { data: taskRow, error: taskErr } = await supa
    .from('task_state')
    .select('designer_id,deleted')
    .eq('task_id', taskId)
    .maybeSingle()
  if (taskErr) {
    json(res, 500, { error: 'Could not check access to this task' })
    return
  }
  // Designers see only their own tasks (matches RLS §14).
  if (profile.role === 'designer' && (!taskRow || taskRow.designer_id !== profile.designer_id)) {
    json(res, 403, { error: 'That project is on someone else’s board' })
    return
  }

  // ── Fetch the live detail + conversation from ClickUp ──────────────────────
  try {
    const [task, comments] = await Promise.all([
      getTaskDetail(taskId),
      getTaskComments(taskId).catch(() => []), // comments are a nice-to-have
    ])

    const deliverables = resolveLabelField(
      (task.custom_fields ?? []).find((f) => f.id === DELIVERABLES_FIELD_ID) ??
        (task.custom_fields ?? []).find((f) => f.type === 'labels'),
    )

    const person = (u?: { username?: string; email?: string } | null) =>
      u ? { name: u.username ?? u.email ?? 'Someone', email: u.email ?? null } : null

    json(res, 200, {
      ok: true,
      task_id: taskId,
      name: task.name ?? null,
      description: task.markdown_description ?? task.description ?? null,
      status: task.status?.status ?? null,
      priority: task.priority?.priority ?? null,
      due_date: task.due_date ?? null,
      deliverables,
      creator: person(task.creator),
      assignees: (task.assignees ?? []).map((u) => person(u)).filter(Boolean),
      watchers: (task.watchers ?? []).map((u) => person(u)).filter(Boolean),
      attachments: (task.attachments ?? []).map((a) => ({
        title: a.title ?? 'file',
        url: a.url ?? null,
        extension: a.extension ?? null,
      })),
      comments: comments.slice(0, MAX_COMMENTS).map((c) => ({
        text: c.comment_text ?? '',
        by: c.user?.username ?? c.user?.email ?? 'Someone',
        at: c.date ?? null,
      })),
      tookMs: Date.now() - started,
    })
  } catch (err) {
    if (err instanceof ClickUpBudgetError) {
      json(res, 200, { ok: false, partial: true, reason: 'ClickUp was slow — try again' })
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('404') || /not found/i.test(msg)) {
      json(res, 200, { ok: false, gone: true, reason: 'This task no longer exists in ClickUp' })
      return
    }
    console.error('[task-detail]', err)
    json(res, 500, { ok: false, error: 'Could not load the task details' })
  }
}
