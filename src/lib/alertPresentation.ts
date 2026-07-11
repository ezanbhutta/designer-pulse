/**
 * Alert → presentation layer (spec §20.3 + §12): detection lives in the
 * alerts engine; this file is the PRESCRIPTION — a plain-language title with
 * the designer's name resolved, the proposed next move, and (where one
 * exists) a ClickUp deep link.
 *
 * §22.1 is absolute here: the tool observes assignment, it never performs
 * it. Every href is a navigation link for the PM/CSR to act inside ClickUp;
 * the wording is always "Open … in ClickUp", never "assign".
 *
 * Copy rules: everyday English a non-technical reader gets instantly, and
 * the same plain words as the designer self-view glossary ("open slots",
 * "sent back", "waiting for the client").
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
import { agingOwner, type AgingOwner } from '../../shared/aggregate'
import { fmtDate } from './format'
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
            ? `${name} has ${plural(gap, 'open slot')} today`
            : `${name} has room for more work today`,
        suggestion: `Open ${name}'s list in ClickUp and give them ${
          gap != null && gap > 1 ? 'the next projects' : 'the next project'
        }. This gap is about assigning work, and it is not on ${name}.`,
        href: listHref,
        hrefLabel: listHref ? 'Open list in ClickUp' : null,
        icon,
        tone,
      }
    }

    case 'task_aging': {
      const status = canonicalizeStatus(ctxStr(alert, 'status', 'current_status'))
      const statusLabel = status ? STATUS_LABELS[status] : 'the same step'
      const taskName = ctxStr(alert, 'task_name', 'name')
      const what = taskName ? `"${taskName}"` : `One of ${name}'s projects`
      const days =
        ctxNum(alert, 'age_days', 'days') ??
        (() => {
          const mins = ctxNum(alert, 'age_minutes', 'age_min')
          return mins != null ? Math.floor(mins / 1440) : null
        })()
      const aged = days != null ? `for ${plural(days, 'day')}` : 'for too long'
      const owner = (ctxStr(alert, 'owner') as AgingOwner | null) ?? agingOwner(status)
      const hrefLabel = taskHref ? 'Open task in ClickUp' : null
      if (owner === 'client') {
        return {
          title: `${what} has been with the client ${aged}`,
          suggestion: `This waiting is on the client, not on ${name}. A gentle nudge${
            days != null ? ` after ${plural(days, 'day')}` : ''
          } is fine, but nothing here is late.`,
          href: taskHref,
          hrefLabel,
          icon,
          tone,
        }
      }
      if (owner === 'team') {
        return {
          title: `${what} has been ready to send to the client ${aged}`,
          suggestion: `${name} finished the requested changes — sending it on to the client is the team lead's job, not ${name}'s. It may be worth a nudge so this finished work goes out.`,
          href: taskHref,
          hrefLabel,
          icon,
          tone,
        }
      }
      return {
        title: `${what} has been stuck in ${statusLabel} ${aged}`,
        suggestion: `It may be worth checking in with ${name}, since this one seems stuck and could need help to move.`,
        href: taskHref,
        hrefLabel,
        icon,
        tone,
      }
    }

    case 'cancellation': {
      const taskName = ctxStr(alert, 'task_name', 'name')
      return {
        title: taskName
          ? `"${taskName}" was cancelled`
          : `One of ${name}'s projects was cancelled`,
        suggestion:
          'Please open it and check what happened, reading the whole history before judging anyone. One cancellation is a reason to look, not a verdict.',
        href: taskHref,
        hrefLabel: taskHref ? 'Open task in ClickUp' : null,
        icon,
        tone,
      }
    }

    case 'quality_decay': {
      const drop = ctxNum(alert, 'drop_pts', 'drop_pct', 'decay_pct', 'delta_pct')
      return {
        title:
          drop != null
            ? `More of ${name}'s designs are being sent back lately, down ${Math.abs(Math.round(drop))} points from before`
            : `More of ${name}'s designs are being sent back lately`,
        suggestion: `It might be time for a friendly coaching chat, looking at ${name}'s recent change requests and who asked for them, before it grows into a bigger problem.`,
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
            ? `${name} may be overloaded, at a warning level of ${Math.round(score)} out of 100`
            : `${name} may be overloaded`,
        suggestion: `${name}'s fixes are taking longer and they are finishing less, while being online as much as ever. It may be worth checking in with them, since this is an early warning, not a verdict.`,
        href: null,
        hrefLabel: null,
        icon,
        tone,
      }
    }

    case 'forgotten_checkout': {
      const workDate = ctxStr(alert, 'work_date')
      return {
        title: workDate
          ? `${name} forgot to check out on ${fmtDate(workDate)}`
          : `${name} forgot to check out`,
        suggestion:
          'The system closed their day on its own, going by their last activity, so please take a look and fix the time if it looks wrong.',
        href: null,
        hrefLabel: null,
        icon,
        tone,
      }
    }

    case 'workload_forecast': {
      const team = ctxStr(alert, 'team')
      const backlog = ctxNum(alert, 'projected_backlog', 'projectedBacklog', 'backlog')
      const who = team ? `The ${team} team` : 'The team'
      return {
        title:
          backlog != null
            ? `Work is piling up, and ${who.toLowerCase()} is heading for ${plural(Math.round(backlog), 'open project')} within a week`
            : `${who} is getting new projects faster than it can finish them`,
        suggestion:
          'A pile-up is forming for next week, so it may help to move work to whoever has room, or bring in help before it lands.',
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
