/**
 * The decision model behind the Command Center.
 *
 * The old Ops home listed everything it noticed, which on a busy day meant
 * twenty rows and no priority. This module answers a stricter question: what
 * genuinely needs a human right now, and what is the single next thing to do
 * about it.
 *
 * A candidate only becomes a decision if the app can say all four things:
 *   urgency   how much it matters
 *   reason    why it is happening
 *   impact    what it costs if it is left alone
 *   step      one recommended next move, never a menu
 *
 * Anything the app cannot explain that fully is evidence, not a decision, and
 * belongs lower on the page. The list is deduplicated by subject (one decision
 * per person, one per project) and capped, because a command centre that shows
 * twenty urgent things has told the manager nothing.
 */

import { Ban, Clock, Inbox, Send, UserCheck } from 'lucide-react'
import type { Decision } from '../../components/ops/DecisionCard'
import { STATUS_LABELS } from '../../../shared/statuses'
import { fmtDurationLong, fmtShiftTime } from '../../lib/format'
import type { AgingOwner } from '../../../shared/aggregate'
import type { Alert, AttendanceDaily, Designer, DesignerSchedule, TaskState } from '../../../shared/types'

/** How many decisions the top of the page will ever show at once. */
export const MAX_DECISIONS = 5

export interface CapacityRow {
  designer: Designer
  expected: number
  schedule: DesignerSchedule | null
  sinceShift: number | null
  assigned: number
  filled: number
  spare: number
}

export interface AgingRow {
  task: TaskState
  age: number
  threshold: number
  /** null when the stage has no owner; treated as designer owned for wording. */
  owner: AgingOwner | null
}

export interface DecisionInput {
  rows: CapacityRow[]
  agingTasks: AgingRow[]
  alerts: Alert[]
  attendance: AttendanceDaily[]
  cancelledToday: TaskState[]
  designerById: Map<string, Designer>
  /** Minutes after shift start before an empty plate counts as a real gap. */
  gapOffsetMin: number
  clickupTaskUrl: (id: string) => string | null
  clickupListUrl: (listId: string | null) => string | null
  /** In app drills, for the decisions Studio Pulse settles itself. */
  openTaskTrail: (task: TaskState) => void
  goToAttendance: () => void
}

/** Internal: a decision plus the score that decides where it ranks. */
interface Scored {
  decision: Decision
  score: number
}

const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] ?? name

/**
 * Rank and cap, in three tiers so no single term can swamp the others.
 *
 *   urgency  dominates absolutely
 *   type     what kind of thing it is, within that urgency
 *   degree   how bad this instance is, bounded, as the tie breaker
 *
 * The bound on `degree` is the point. Scoring on raw age in minutes made a
 * project that had sat for a week outrank an order the studio had just lost,
 * purely because ten thousand minutes is a bigger number than anything else on
 * the page. A lost order is not recoverable; a stalled project still is.
 */
const URGENCY_WEIGHT: Record<Decision['urgency'], number> = {
  critical: 1_000_000,
  warning: 1_000,
  info: 1,
}

type DecisionType = 'cancelGroup' | 'cancel' | 'stuck' | 'ready' | 'gap' | 'review'

const TYPE_WEIGHT: Record<DecisionType, number> = {
  cancelGroup: 6,
  cancel: 5,
  stuck: 4,
  ready: 3,
  gap: 2,
  review: 1,
}

/** `degree` is capped at 10, so it orders like for like without ever outranking type. */
function rank(urgency: Decision['urgency'], type: DecisionType, degree = 1): number {
  return URGENCY_WEIGHT[urgency] + TYPE_WEIGHT[type] * 100 + Math.min(degree, 10) * 5
}

export interface DecisionResult {
  /** What the manager should act on now, worst first. */
  decisions: Decision[]
  /** How many real candidates did not make the cut, for the honest footnote. */
  heldBack: number
}

export function buildDecisions(input: DecisionInput): DecisionResult {
  const {
    rows,
    agingTasks,
    alerts,
    attendance,
    cancelledToday,
    designerById,
    gapOffsetMin,
    clickupTaskUrl,
    clickupListUrl,
    openTaskTrail,
    goToAttendance,
  } = input

  const scored: Scored[] = []
  // One decision per subject. A designer who is both short of work and flagged
  // elsewhere should interrupt the manager once, not twice.
  const claimedDesigners = new Set<string>()
  const claimedTasks = new Set<string>()

  // ── 1 · Projects that have stopped moving ────────────────────────────────
  // Client owned waits are excluded upstream: waiting for a client to reply is
  // normal and is not a decision for anyone here.
  for (const { task, age, threshold, owner } of agingTasks) {
    if (claimedTasks.has(task.task_id)) continue
    claimedTasks.add(task.task_id)
    const d = task.designer_id ? designerById.get(task.designer_id) : undefined
    const who = d ? firstNameOf(d.name) : 'The designer'
    const name = task.name ?? task.task_id
    const stageLabel = task.current_status ? STATUS_LABELS[task.current_status] : 'one stage'
    const days = Math.max(1, Math.round(threshold / (24 * 60)))
    const critical = age >= threshold * 2
    const href = clickupTaskUrl(task.task_id)
    // How many times past its threshold this one is, which is comparable
    // across projects in a way that raw minutes is not.
    const overdue = threshold > 0 ? age / threshold : 1

    if (owner === 'team') {
      // Finished by the designer, waiting on the team to pass it to the client.
      scored.push({
        score: rank(critical ? 'critical' : 'warning', 'ready', overdue),
        decision: {
          id: `ready-${task.task_id}`,
          urgency: critical ? 'critical' : 'warning',
          icon: Send,
          headline: `"${name}" has been ready to send for ${fmtDurationLong(age)}`,
          reason: `${who} finished it and it is sitting in ${stageLabel}, waiting for someone to pass it to the client.`,
          impact:
            'Finished work earns nothing until the client sees it, and this delay is ours rather than theirs.',
          step: href
            ? { label: 'Open in ClickUp', href }
            : { label: 'See what happened', onClick: () => openTaskTrail(task) },
          signature: `task:${task.task_id}:${task.current_status ?? 'unknown'}`,
          context: `ready to send for ${fmtDurationLong(age)}`,
        },
      })
    } else {
      scored.push({
        score: rank(critical ? 'critical' : 'warning', 'stuck', overdue),
        decision: {
          id: `stuck-${task.task_id}`,
          urgency: critical ? 'critical' : 'warning',
          icon: Clock,
          headline: `"${name}" has not moved in ${fmtDurationLong(age)}`,
          reason: `It has been sitting in ${stageLabel} with ${d ? d.name : 'nobody assigned'}, and the app flags a project once it goes ${days} day${days === 1 ? '' : 's'} without moving.`,
          impact:
            'The client is waiting on this one, and projects that sit this long are the ones that turn into complaints and cancellations.',
          step: href
            ? { label: 'Open in ClickUp', href }
            : { label: 'See what happened', onClick: () => openTaskTrail(task) },
          signature: `task:${task.task_id}:${task.current_status ?? 'unknown'}`,
          context: `stuck in ${stageLabel} for ${fmtDurationLong(age)}`,
        },
      })
    }
  }

  // ── 2 · Orders lost ──────────────────────────────────────────────────────
  // Never phrased as a verdict on the designer. The step is to read the
  // history first, because the reason is often not what it looks like (§4.4).
  if (cancelledToday.length === 1) {
    const t = cancelledToday[0]
    claimedTasks.add(t.task_id)
    const d = t.designer_id ? designerById.get(t.designer_id) : undefined
    scored.push({
      score: rank('critical', 'cancel'),
      decision: {
        id: `cancel-${t.task_id}`,
        urgency: 'critical',
        icon: Ban,
        headline: `An order was lost today: "${t.name ?? t.task_id}"`,
        reason: `It was cancelled while ${d ? d.name : 'the studio'} had it, which the system records as a design problem rather than a client changing their mind.`,
        impact:
          'That is revenue gone and a client we will not hear from again. Please read the history before drawing any conclusion about the person.',
        step: { label: 'See what happened', onClick: () => openTaskTrail(t) },
        signature: `cancel:${t.task_id}`,
        context: `one order lost, "${t.name ?? t.task_id}"`,
      },
    })
  } else if (cancelledToday.length > 1) {
    for (const t of cancelledToday) claimedTasks.add(t.task_id)
    const first = cancelledToday[0]
    scored.push({
      score: rank('critical', 'cancelGroup', cancelledToday.length),
      decision: {
        id: 'cancel-group',
        urgency: 'critical',
        icon: Ban,
        headline: `${cancelledToday.length} orders were lost today`,
        reason:
          'Each one was cancelled while we had it, which the system records as a design problem rather than a client changing their mind.',
        impact:
          'Several losses in one day is a pattern worth understanding today, not at the end of the month. Please read the histories before drawing conclusions about anyone.',
        step: { label: 'Start with the first', onClick: () => openTaskTrail(first) },
        signature: `cancel:count:${cancelledToday.length}`,
        context: `${cancelledToday.length} orders lost today`,
      },
    })
  }

  // ── 3 · People with nothing to work on ───────────────────────────────────
  // The old page said this twice: once from the stored alert and once from a
  // live "who has room" insight. One person, one decision. The live numbers
  // win, because a stored alert is a snapshot from when it fired.
  const alertedIds = new Set(
    alerts
      .filter((a) => a.alert_type === 'assignment_gap' && a.status === 'open')
      .map((a) => a.designer_id)
      .filter((id): id is string => id != null),
  )
  for (const r of rows) {
    if (claimedDesigners.has(r.designer.id)) continue
    if (r.expected <= 0) continue
    const slots = r.expected - r.filled
    if (slots <= 0) continue
    // Only once their day has actually been running long enough to judge.
    const shiftRunning = r.sinceShift != null && r.sinceShift >= gapOffsetMin
    if (!shiftRunning) continue
    claimedDesigners.add(r.designer.id)

    const who = firstNameOf(r.designer.name)
    const alerted = alertedIds.has(r.designer.id)
    const started = r.schedule ? `${fmtShiftTime(r.schedule.shift_start)} Pakistan time` : 'earlier today'
    const href = clickupListUrl(r.designer.clickup_list_id)
    scored.push({
      score: rank(alerted ? 'warning' : 'info', 'gap', slots),
      decision: {
        id: `capacity-${r.designer.id}`,
        urgency: alerted ? 'warning' : 'info',
        icon: Inbox,
        headline: `${who} has room for ${slots} more project${slots === 1 ? '' : 's'} today`,
        reason: `Their day started at ${started} and ${r.filled} of the ${r.expected} projects due today ${r.filled === 1 ? 'has' : 'have'} reached them.`,
        impact: `${slots} slot${slots === 1 ? '' : 's'} of today's capacity ${slots === 1 ? 'goes' : 'go'} unused unless work reaches them before the day ends. Handing work out is the team lead's job, not theirs.`,
        step: href
          ? { label: `Open ${who}'s list`, href }
          : { label: 'Open the roster', onClick: () => undefined },
        signature: `gap:${r.designer.id}:${slots}`,
        context: `${slots} slot${slots === 1 ? '' : 's'} open, ${r.filled} of ${r.expected} handed over`,
      },
    })
  }

  // ── 4 · Days that need confirming ────────────────────────────────────────
  for (const row of attendance.filter((a) => a.needs_review)) {
    if (claimedDesigners.has(row.designer_id)) continue
    claimedDesigners.add(row.designer_id)
    const d = designerById.get(row.designer_id)
    const who = d ? firstNameOf(d.name) : 'Someone'
    scored.push({
      score: rank('info', 'review'),
      decision: {
        id: `review-${row.id}`,
        urgency: 'info',
        icon: UserCheck,
        headline: `${who}'s day needs confirming`,
        reason: `They never pressed Check out, and nothing in ClickUp shows work after their shift ended, so the app closed the day for them.`,
        impact:
          'Until someone confirms it, the day sits unverified in the attendance record and counts against them by default.',
        step: { label: 'Open Attendance', onClick: goToAttendance },
        signature: `review:${row.id}:${row.needs_review}`,
        context: `${who}'s day was closed automatically`,
      },
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return {
    decisions: scored.slice(0, MAX_DECISIONS).map((s) => s.decision),
    heldBack: Math.max(0, scored.length - MAX_DECISIONS),
  }
}
