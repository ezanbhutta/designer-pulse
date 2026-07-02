/**
 * Alert → presentation layer (spec §20.3 + §12): detection lives in the
 * alerts engine; this file is the PRESCRIPTION — a plain-language title with
 * the designer's name resolved, the proposed next move, and (where one
 * exists) a ClickUp deep link.
 *
 * §22.1 is absolute here: the tool observes assignment, it never performs
 * it. Every href is a navigation link for the PM/CSR to act inside ClickUp;
 * the wording is always "Open … in ClickUp", never "assign".
 */

import type { LucideIcon } from 'lucide-react'
import {
  AlarmClockOff,
  CircleAlert,
  Flame,
  Hourglass,
  Inbox,
  OctagonAlert,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import type { Alert, Designer } from '../../shared/types'
import { STATUS_LABELS, canonicalizeStatus } from '../../shared/statuses'
import { clickupListUrl, clickupTaskUrl } from './queries'

export interface AlertPresentation {
  title: string
  suggestion: string | null
  href: string | null
  hrefLabel: string | null
  icon: LucideIcon
  tone: 'brand' | 'warning' | 'danger'
}

const SEVERITY_TONE: Record<Alert['severity'], AlertPresentation['tone']> = {
  info: 'brand',
  warning: 'warning',
  critical: 'danger',
}

const TYPE_ICON: Record<Alert['alert_type'], LucideIcon> = {
  assignment_gap: Inbox,
  task_aging: Hourglass,
  cancellation: OctagonAlert,
  quality_decay: TrendingDown,
  burnout: Flame,
  forgotten_checkout: AlarmClockOff,
  workload_forecast: TrendingUp,
}

/** Defensive readers — the alert `context` jsonb shape is engine-owned. */
function ctxNum(alert: Alert, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = alert.context?.[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

function ctxStr(alert: Alert, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = alert.context?.[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

export function presentAlert(alert: Alert, designers: Designer[]): AlertPresentation {
  const designer = alert.designer_id
    ? designers.find((d) => d.id === alert.designer_id) ?? null
    : null
  const name = designer?.name ?? 'A designer'
  const tone = SEVERITY_TONE[alert.severity] ?? 'warning'
  const icon = TYPE_ICON[alert.alert_type] ?? CircleAlert

  const taskHref = clickupTaskUrl(alert.task_id)
  const listHref = clickupListUrl(designer?.clickup_list_id)

  switch (alert.alert_type) {
    case 'assignment_gap': {
      const gap =
        ctxNum(alert, 'gap', 'open_slots', 'slots_open') ??
        (() => {
          const expected = ctxNum(alert, 'expected', 'expected_quota')
          const created = ctxNum(alert, 'created', 'assigned', 'created_today')
          return expected != null && created != null ? Math.max(0, expected - created) : null
        })()
      return {
        title:
          gap != null
            ? `${name} has ${plural(gap, 'open slot')} an hour into their shift`
            : `${name} is under quota an hour into their shift`,
        suggestion: `Spare capacity is idling — create the next ${gap != null && gap > 1 ? 'tasks' : 'task'} in ${name}'s list. This gap sits with assignment, not the designer.`,
        href: listHref,
        hrefLabel: listHref ? 'Open list in ClickUp' : null,
        icon,
        tone,
      }
    }

    case 'task_aging': {
      const status = canonicalizeStatus(ctxStr(alert, 'status', 'current_status'))
      const statusLabel = status ? STATUS_LABELS[status] : 'its current status'
      const days =
        ctxNum(alert, 'age_days', 'days') ??
        (() => {
          const mins = ctxNum(alert, 'age_minutes', 'age_min')
          return mins != null ? Math.floor(mins / 1440) : null
        })()
      const aged = days != null ? `for ${plural(days, 'day')}` : 'past the threshold'
      const isClientResponse = status === 'client response'
      return {
        title: isClientResponse
          ? `${name}'s task has been parked in Client response ${aged}`
          : `${name}'s task has sat in ${statusLabel} ${aged}`,
        suggestion: isClientResponse
          ? `Nudge the client — this one is waiting on them${days != null ? `, ${plural(days, 'day')} and counting` : ''}. Revenue rots in this status.`
          : `Check in with ${name} — the task has stalled and may need unblocking.`,
        href: taskHref,
        hrefLabel: taskHref ? 'Open task in ClickUp' : null,
        icon,
        tone,
      }
    }

    case 'cancellation':
      return {
        title: `${name}'s task was cancelled — a designer-fault loss was recorded`,
        suggestion:
          'Review the full status trail before judging — a cancellation is a flag to investigate, not a verdict. Watch the trend, not the single row.',
        href: taskHref,
        hrefLabel: taskHref ? 'Open task in ClickUp' : null,
        icon,
        tone,
      }

    case 'quality_decay': {
      const drop = ctxNum(alert, 'drop_pct', 'decay_pct', 'delta_pct')
      return {
        title:
          drop != null
            ? `${name}'s first-pass quality fell ${Math.abs(Math.round(drop))}% vs the prior period`
            : `${name}'s first-pass quality is slipping vs their prior period`,
        suggestion: `Coaching flag — review ${name}'s recent revisions and where they were caught (CSR gate vs client) before it becomes a crisis.`,
        href: null,
        hrefLabel: null,
        icon,
        tone,
      }
    }

    case 'burnout': {
      const score = ctxNum(alert, 'score', 'burnout_score')
      return {
        title:
          score != null
            ? `Burnout risk is rising for ${name} — composite at ${Math.round(score)} of 100`
            : `Burnout risk is rising for ${name}`,
        suggestion: `Check in with ${name} — online as much as ever but producing less. This is a leading indicator, not a verdict.`,
        href: null,
        hrefLabel: null,
        icon,
        tone,
      }
    }

    case 'forgotten_checkout':
      return {
        title: `${name} checked in but never checked out`,
        suggestion:
          'Attendance was auto-closed from their last activity — review the day and correct the checkout if it looks wrong.',
        href: null,
        hrefLabel: null,
        icon,
        tone,
      }

    case 'workload_forecast': {
      const team = ctxStr(alert, 'team')
      const backlog = ctxNum(alert, 'projected_backlog', 'backlog')
      return {
        title:
          backlog != null
            ? `${team ? `${team} team` : 'Team'} backlog is forecast to reach ${plural(Math.round(backlog), 'open task')} within the week`
            : `${team ? `${team} team` : 'Team'} inflow is outpacing completion`,
        suggestion:
          'Next week’s overload is visible now — rebalance work toward spare capacity or add hands before it lands.',
        href: null,
        hrefLabel: null,
        icon,
        tone,
      }
    }

    default:
      return {
        title: alert.message ?? 'Alert',
        suggestion: null,
        href: taskHref,
        hrefLabel: taskHref ? 'Open task in ClickUp' : null,
        icon: CircleAlert,
        tone,
      }
  }
}
