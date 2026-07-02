/**
 * Alert firing with dedupe (spec §12). An alert is skipped when an
 * open/acknowledged alert with the same alert_type + designer_id + task_id
 * already exists; for the per-day alert types (assignment_gap,
 * forgotten_checkout) the same PKT work day is part of the identity.
 * A higher-severity re-fire ESCALATES the existing open alert in place
 * (task_aging warning → critical at 2× threshold) instead of duplicating it.
 */

import { pktInstant, pktToday } from '../../shared/pkt'
import type { AlertType } from '../../shared/types'
import { expectOk, type SupabaseAdmin } from './supabaseAdmin'

export type AlertSeverity = 'info' | 'warning' | 'critical'

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 }

/** Alert types whose dedupe identity includes the PKT work day. */
const PER_DAY_TYPES: AlertType[] = ['assignment_gap', 'forgotten_checkout']

export interface FireAlertInput {
  alert_type: AlertType
  designer_id?: string | null
  task_id?: string | null
  severity: AlertSeverity
  message: string
  context?: Record<string, unknown> | null
}

export interface FireAlertResult {
  /** A new alert row was inserted. */
  fired: boolean
  /** An existing open alert was raised to a higher severity. */
  escalated: boolean
}

export async function fireAlert(
  supa: SupabaseAdmin,
  input: FireAlertInput,
): Promise<FireAlertResult> {
  const designerId = input.designer_id ?? null
  const taskId = input.task_id ?? null

  let q = supa
    .from('alerts')
    .select('id,severity')
    .eq('alert_type', input.alert_type)
    .in('status', ['open', 'acknowledged'])
  q = designerId ? q.eq('designer_id', designerId) : q.is('designer_id', null)
  q = taskId ? q.eq('task_id', taskId) : q.is('task_id', null)

  if (PER_DAY_TYPES.includes(input.alert_type)) {
    const workDate = input.context?.['work_date']
    if (typeof workDate === 'string' && workDate) {
      q = q.eq('context->>work_date', workDate)
    } else {
      // No work_date in context — fall back to "fired since PKT midnight".
      q = q.gte('fired_at', pktInstant(pktToday(), '00:00').toISOString())
    }
  }

  const { data, error } = await q.limit(10)
  expectOk(error, 'alerts dedupe read')
  const existing = (data ?? []) as Array<{ id: number; severity: AlertSeverity }>

  if (existing.length > 0) {
    const top = existing.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a))
    if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[top.severity]) {
      const { error: upErr } = await supa
        .from('alerts')
        .update({
          severity: input.severity,
          message: input.message,
          context: input.context ?? null,
        })
        .eq('id', top.id)
      expectOk(upErr, 'alert escalation')
      return { fired: false, escalated: true }
    }
    return { fired: false, escalated: false }
  }

  const { error: insErr } = await supa.from('alerts').insert({
    alert_type: input.alert_type,
    designer_id: designerId,
    task_id: taskId,
    severity: input.severity,
    message: input.message,
    context: input.context ?? null,
    status: 'open',
    fired_at: new Date().toISOString(),
  })
  expectOk(insErr, 'alert insert')
  return { fired: true, escalated: false }
}
