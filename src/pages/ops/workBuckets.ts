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
