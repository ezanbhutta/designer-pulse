/**
 * The Work workspace's default reading of the board.
 *
 * A status kanban answers "where is everything", which is a filing question.
 * A manager opening this page is asking a different one: "what is blocked, what
 * is going to miss today, and what is simply not mine to chase." These four
 * buckets answer that, and the kanban stays available as a secondary view for
 * the times the filing question is the real one.
 *
 * Two rules hold this together:
 *
 *  1. Every open project lands in exactly one bucket, first match wins, so the
 *     counts add up to the board and nothing hides between categories.
 *  2. Bucketing runs on the WHOLE board, never the filtered view. The Board
 *     page was explicit that health counts must not be computed from filtered
 *     data, or an active filter silently hides a stuck project. Filters here
 *     narrow what is listed inside a bucket; they never change its count.
 */

import { agingDelay, ageMinutes } from '../../../shared/aggregate'
import { pktDateOf } from '../../../shared/pkt'
import { STATUS_LABELS, type CanonicalStatus } from '../../../shared/statuses'
import type { AgingOwner } from '../../../shared/aggregate'
import type { Config, Designer, TaskState } from '../../../shared/types'
import { fmtDurationLong } from '../../lib/format'

export type WorkBucket = 'needs-action' | 'at-risk' | 'waiting' | 'healthy'

/**
 * A focused view: one cause, opened on its own from the navigation.
 * A bucket answers "how urgent", a cause answers "what kind of job this is".
 * Both matter, so both are reachable, and each opens as its own page rather
 * than as a fold inside a longer one.
 */
export type WorkFocus =
  | 'stuck-designer'
  | 'ready-to-send'
  | 'unassigned'
  | 'unknown-status'

export const FOCUS_META: Record<
  WorkFocus,
  { label: string; blurb: string; tone: 'danger' | 'warning' }
> = {
  'stuck-designer': {
    label: 'Stuck with the designer',
    blurb: 'Gone quiet while a designer has them. A nudge usually clears it.',
    tone: 'warning',
  },
  'ready-to-send': {
    label: 'Ready to send, waiting on us',
    blurb: 'Finished work waiting for someone to pass it to the client. This delay is ours.',
    tone: 'warning',
  },
  unassigned: {
    label: 'Nobody is on it',
    blurb: 'No active designer, so these cannot move until someone picks them up.',
    tone: 'danger',
  },
  'unknown-status': {
    label: 'Status ClickUp does not recognise',
    blurb: 'The status name matches no stage the app knows, so none of these are being counted.',
    tone: 'danger',
  },
}

/** Which focused view a project belongs to, if any. One project, one answer. */
export function focusOf(bt: BucketedTask): WorkFocus | null {
  if (!bt.task.current_status) return 'unknown-status'
  if (bt.reason.startsWith('No active designer')) return 'unassigned'
  if (bt.bucket !== 'needs-action') return null
  return bt.owner === 'team' ? 'ready-to-send' : 'stuck-designer'
}

/**
 * WHY a project has nobody on it. The difference matters enormously: work that
 * is genuinely unassigned is a backlog to hand out, but a project whose ClickUp
 * list was never linked to a roster designer is a wiring gap, and those are far
 * worse. A wiring gap means the work IS being done and the app cannot see it,
 * so the designer gets no credit, the age inflates the stuck counts, and every
 * capacity percentage is computed without them. One is a management problem,
 * the other quietly corrupts every number in the product.
 */
export type UnassignedCause = 'list-not-linked' | 'designer-archived' | 'no-designer-set'

export const UNASSIGNED_CAUSE: Record<UnassignedCause, { label: string; fix: string }> = {
  'list-not-linked': {
    label: 'Their ClickUp list is not linked to anyone',
    fix: 'Link the list to a designer on the roster, and all of these become visible at once.',
  },
  'designer-archived': {
    label: 'The designer who had these is archived',
    fix: 'Either restore them, or move the work to someone active in ClickUp.',
  },
  'no-designer-set': {
    label: 'Genuinely unassigned in ClickUp',
    fix: 'These need handing to someone before they can move.',
  },
}

export function unassignedCause(
  t: TaskState,
  designerById: Map<string, Designer>,
): UnassignedCause {
  if (!t.designer_id) return 'list-not-linked'
  const d = designerById.get(t.designer_id)
  if (!d) return 'list-not-linked'
  return d.status === 'active' ? 'no-designer-set' : 'designer-archived'
}

/** Counts for every focused view, computed over the whole board. */
export function focusCounts(all: BucketedTask[]): Record<WorkFocus, number> {
  const out: Record<WorkFocus, number> = {
    'stuck-designer': 0,
    'ready-to-send': 0,
    unassigned: 0,
    'unknown-status': 0,
  }
  for (const bt of all) {
    const f = focusOf(bt)
    if (f) out[f] += 1
  }
  return out
}

export const BUCKET_ORDER: WorkBucket[] = ['needs-action', 'at-risk', 'waiting', 'healthy']

export const BUCKET_META: Record<
  WorkBucket,
  { label: string; blurb: string; tone: 'danger' | 'warning' | 'waiting' | 'success' }
> = {
  'needs-action': {
    label: 'Needs action',
    blurb: 'Our clock is running and something here is blocked on us.',
    tone: 'danger',
  },
  'at-risk': {
    label: 'At risk today',
    blurb: 'Due today or already past due, and the first design has not gone out.',
    tone: 'warning',
  },
  waiting: {
    label: 'Waiting',
    blurb: 'With the client. Their clock, not ours, so nothing here needs chasing.',
    tone: 'waiting',
  },
  healthy: {
    label: 'Healthy',
    blurb: 'Moving along on their own, with time still in hand.',
    tone: 'success',
  },
}

/**
 * Statuses where the work has actually reached the client. Anything outside
 * this set is still inside the studio, however far along it looks.
 * 'revision complete' is deliberately NOT here: it means finished but not yet
 * passed on, which is precisely the delay this page exists to surface.
 */
const REACHED_CLIENT: ReadonlySet<string> = new Set<CanonicalStatus>([
  'deliver to client',
  'client response',
  'final files',
  'complete',
])

export interface BucketedTask {
  task: TaskState
  bucket: WorkBucket
  /** Why it landed here, in one plain line. */
  reason: string
  age: number
  thresholdMin: number
  owner: AgingOwner | null
}

export interface BucketInput {
  openTasks: TaskState[]
  designerById: Map<string, Designer>
  cfg: Config
  /** PKT day, so "due today" means the studio's today. */
  today: string
  now: Date
}

/**
 * Classify one project. First match wins, so the order of these checks IS the
 * priority: a project that is both blocked and due today is a blockage, and
 * saying so once is more useful than counting it twice.
 */
function classify(
  t: TaskState,
  { designerById, cfg, today, now }: Omit<BucketInput, 'openTasks'>,
): BucketedTask {
  const delay = agingDelay(t.current_status, cfg)
  const age = ageMinutes(t, now)
  const base = { task: t, age, thresholdMin: delay.thresholdMin, owner: delay.owner }

  // ── Needs action ───────────────────────────────────────────────────────────
  // An unrecognised status name means the app cannot reason about this project
  // at all, which is worse than any delay and must never be quietly filed.
  if (!t.current_status) {
    return {
      ...base,
      bucket: 'needs-action',
      reason: 'The status name in ClickUp is not one this app recognises, so nothing here is being measured.',
    }
  }
  // Nobody owns it. An unassigned project cannot move on its own.
  const designer = t.designer_id ? designerById.get(t.designer_id) : undefined
  if (!designer || designer.status !== 'active') {
    return {
      ...base,
      bucket: 'needs-action',
      reason: 'No active designer is on this, so it cannot move until someone picks it up.',
    }
  }
  // Past its threshold, on our clock.
  if (delay.ages && age >= delay.thresholdMin) {
    const stage = STATUS_LABELS[t.current_status]
    return {
      ...base,
      bucket: 'needs-action',
      reason:
        delay.owner === 'team'
          ? `Finished and sitting in ${stage} for ${fmtDurationLong(age)}, waiting for someone to pass it to the client.`
          : `Has not moved out of ${stage} for ${fmtDurationLong(age)}.`,
    }
  }

  // ── At risk today ──────────────────────────────────────────────────────────
  // Forward looking: it has a deadline of today or earlier and the client has
  // still not seen anything. This is the bucket that prevents tomorrow's
  // "needs action" from ever existing.
  const due = t.due_date ? pktDateOf(t.due_date) : null
  if (due && due <= today && !REACHED_CLIENT.has(t.current_status)) {
    return {
      ...base,
      bucket: 'at-risk',
      reason:
        due < today
          ? `Was due on ${due} and the first design has still not gone to the client.`
          : 'Due today and the first design has not gone to the client yet.',
    }
  }

  // ── Waiting ────────────────────────────────────────────────────────────────
  // Client owned by the ownership model, so waiting is the normal state and
  // nobody here should be chased for it.
  if (delay.owner === 'client') {
    return {
      ...base,
      bucket: 'waiting',
      reason: `With the client for ${fmtDurationLong(age)}. Their clock, not ours.`,
    }
  }

  // ── Healthy ────────────────────────────────────────────────────────────────
  return {
    ...base,
    bucket: 'healthy',
    reason: `In ${STATUS_LABELS[t.current_status]}, with time still in hand.`,
  }
}

export interface BucketResult {
  /** Every open project, bucketed. Whole board, never filtered. */
  all: BucketedTask[]
  /** Bucket to its projects, worst first inside each. */
  byBucket: Map<WorkBucket, BucketedTask[]>
  /** Whole board counts, safe to show beside an active filter. */
  counts: Record<WorkBucket, number>
}

export function bucketWork(input: BucketInput): BucketResult {
  const { openTasks, ...rest } = input
  const all = openTasks.map((t) => classify(t, rest))

  const byBucket = new Map<WorkBucket, BucketedTask[]>()
  for (const b of BUCKET_ORDER) byBucket.set(b, [])
  for (const bt of all) byBucket.get(bt.bucket)!.push(bt)

  // Worst first inside every bucket: how far past its own threshold it is,
  // which compares fairly across stages with different thresholds.
  for (const list of byBucket.values()) {
    list.sort((a, b) => {
      const oa = a.thresholdMin > 0 ? a.age / a.thresholdMin : a.age
      const ob = b.thresholdMin > 0 ? b.age / b.thresholdMin : b.age
      return ob - oa
    })
  }

  const counts = {} as Record<WorkBucket, number>
  for (const b of BUCKET_ORDER) counts[b] = byBucket.get(b)!.length
  return { all, byBucket, counts }
}
