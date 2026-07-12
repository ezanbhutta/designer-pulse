/**
 * Task-metrics engine (spec §4 attribution model + §7 task_metrics).
 * Pure function over the ordered event log — recomputable at any time.
 * Designer speed uses only designer-owned spans; time in `client response`
 * never counts against a designer (spec §4.1).
 */

import { canonicalizeStatus, type CanonicalStatus } from './statuses'
import { minutesBetween } from './pkt'

export interface TransitionEvent {
  event_type: 'created' | 'status_change' | 'deleted'
  from_status: CanonicalStatus | null
  to_status: CanonicalStatus | null
  event_time: string
}

export interface ComputedTaskMetrics {
  start_latency_min: number | null
  production_min: number | null
  first_pass_clean: boolean
  revision_rounds: number
  csr_caught_rounds: number
  client_caught_rounds: number
  revision_turnaround_min: number | null
  client_wait_min: number | null
  first_delivered_at: string | null
  outcome: 'complete' | 'cancelled' | 'in_flight'
  is_cancelled: boolean
  current_status: CanonicalStatus
}

/**
 * @param createdAt task `date_created` = assignment time (spec §2)
 * @param events    ordered by event_time ascending (ties: created first)
 * @param now       clock for open spans held in revision/client response
 */
export function computeTaskMetrics(
  createdAt: string,
  events: TransitionEvent[],
  now: Date = new Date(),
): ComputedTaskMetrics {
  let current: CanonicalStatus = 'pickup your projects'
  let currentSince = createdAt

  let startLatency: number | null = null
  let firstDeliveredAt: string | null = null
  let revisionRounds = 0
  let csrCaught = 0
  let clientCaught = 0
  let revisionHeld = 0
  let clientWaitHeld = 0
  let sawRevisionSpan = false
  let sawClientWaitSpan = false

  const closeSpan = (status: CanonicalStatus, from: string, to: string) => {
    const mins = Math.max(0, minutesBetween(from, to))
    if (status === 'revision') {
      revisionHeld += mins
      sawRevisionSpan = true
    } else if (status === 'client response') {
      clientWaitHeld += mins
      sawClientWaitSpan = true
    }
  }

  for (const ev of events) {
    if (ev.event_type !== 'status_change' || !ev.to_status) continue
    const to = ev.to_status
    // Trust the recorded from_status when present; otherwise the tracked one.
    const from = ev.from_status ?? current

    closeSpan(current, currentSince, ev.event_time)

    if (to === 'in progress' && startLatency === null) {
      startLatency = Math.max(0, minutesBetween(createdAt, ev.event_time))
    }
    if (to === 'deliver to client' && firstDeliveredAt === null) {
      firstDeliveredAt = ev.event_time
    }
    if (to === 'revision') {
      revisionRounds += 1
      // Every round is attributed so the split always reconciles with the total
      // (owner's rule: "by us" + "by the client" must equal the changes count).
      // Only a change that came straight from the client's reply is the client's;
      // a change from any of our own stages (deliver to client, revision complete,
      // in progress, final files …) is our own team's catch.
      if (from === 'client response') clientCaught += 1
      else csrCaught += 1
    }

    current = to
    currentSince = ev.event_time
  }

  // Open span for a task currently parked in revision / client response.
  if (current === 'revision' || current === 'client response') {
    closeSpan(current, currentSince, now.toISOString())
  }

  const outcome: ComputedTaskMetrics['outcome'] =
    current === 'complete' ? 'complete' : current === 'cancelled' ? 'cancelled' : 'in_flight'

  return {
    start_latency_min: startLatency,
    // Production time = assignment → first delivery, all designer-owned
    // (per §7 schema contract; start latency is also reported separately).
    production_min: firstDeliveredAt
      ? Math.max(0, minutesBetween(createdAt, firstDeliveredAt))
      : null,
    first_pass_clean: revisionRounds === 0,
    revision_rounds: revisionRounds,
    csr_caught_rounds: csrCaught,
    client_caught_rounds: clientCaught,
    revision_turnaround_min: sawRevisionSpan ? revisionHeld : null,
    client_wait_min: sawClientWaitSpan ? clientWaitHeld : null,
    first_delivered_at: firstDeliveredAt,
    outcome,
    is_cancelled: current === 'cancelled',
    current_status: current,
  }
}

/**
 * Reconstruct a transition sequence from ClickUp's time-in-status payload
 * (historical backfill, spec §6.3). Re-entries are aggregated by ClickUp, so
 * counts derived from this are a LOWER BOUND — callers must store
 * metrics_confidence='backfill'.
 */
export interface TimeInStatusEntry {
  status: string
  orderindex?: number
  total_time?: { by_minute?: number; since?: string }
}

export function reconstructBackfillEvents(
  statusHistory: TimeInStatusEntry[],
): Array<Omit<TransitionEvent, 'event_type'> & { event_type: 'status_change' }> {
  // Unknown status names are dropped entirely (§6.4) so the reconstructed
  // chain never carries a non-canonical from_status; the chain simply links
  // the canonical neighbors.
  const entries = statusHistory
    .filter((e) => e.total_time?.since)
    .map((e) => ({
      status: canonicalizeStatus(e.status),
      since: new Date(Number(e.total_time!.since!)).toISOString(),
    }))
    .filter((e): e is { status: CanonicalStatus; since: string } => e.status !== null)
    .sort((a, b) => (a.since < b.since ? -1 : 1))

  const events: Array<Omit<TransitionEvent, 'event_type'> & { event_type: 'status_change' }> = []
  let prev: CanonicalStatus | null = null
  for (const e of entries) {
    if (prev === e.status) continue
    // The birth status needs no synthetic transition; everything after does.
    if (prev !== null || e.status !== 'pickup your projects') {
      events.push({
        event_type: 'status_change',
        from_status: prev,
        to_status: e.status,
        event_time: e.since,
      })
    }
    prev = e.status
  }
  return events
}
