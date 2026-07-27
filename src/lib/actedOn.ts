/**
 * "Ready to act in ClickUp" follow through.
 *
 * Studio Pulse never writes to ClickUp (spec §22.1), so it cannot mark a
 * decision done. What it CAN do is remember that the manager opened one, keep
 * the context they saw at that moment, and then watch the next sync to tell
 * them whether the thing actually moved.
 *
 * The mechanism is a per decision `signature`: a short fingerprint of the
 * condition that made it a decision in the first place (for example a task id
 * plus its status, or a designer plus how many slots were open). When the
 * signature changes after the manager acted, the situation moved on and we can
 * say so plainly. When it does not, we can say that too, which is the more
 * useful half: work that was opened and then forgotten is exactly what a
 * command centre should surface.
 *
 * Records live in localStorage only. They are a memory aid for one person on
 * one machine, never a source of truth, and they expire on their own.
 */

const KEY = 'pulse.ops.actedOn'
const TTL_MS = 7 * 24 * 3600_000

export interface ActedRecord {
  /** Stable decision id, matching the decision it belongs to. */
  id: string
  /** When the manager opened it, ISO. */
  at: string
  /** Fingerprint of the condition at the moment they acted. */
  signature: string
  /** Plain words for what they were looking at, so the follow up keeps context. */
  context: string
}

type Store = Record<string, ActedRecord>

function read(): Store {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Store
    // Drop anything past its life so the store cannot grow without bound.
    const cutoff = Date.now() - TTL_MS
    const live: Store = {}
    for (const [id, rec] of Object.entries(parsed)) {
      if (rec && typeof rec.at === 'string' && new Date(rec.at).getTime() >= cutoff) live[id] = rec
    }
    return live
  } catch {
    return {}
  }
}

function write(store: Store): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Storage unavailable (private mode, quota). The follow up is a courtesy,
    // never a requirement, so failing silently is correct here.
  }
}

/** Everything the manager has acted on recently. */
export function loadActed(): Store {
  return read()
}

/** Record that the manager opened this decision in ClickUp. */
export function markActed(rec: Omit<ActedRecord, 'at'>): Store {
  const store = read()
  store[rec.id] = { ...rec, at: new Date().toISOString() }
  write(store)
  return store
}

/** Forget one decision, so a fresh occurrence starts clean. */
export function clearActed(id: string): Store {
  const store = read()
  delete store[id]
  write(store)
  return store
}

export type FollowUpState =
  | { kind: 'none' }
  | { kind: 'moved'; since: string; context: string }
  | { kind: 'waiting'; since: string; context: string }

/**
 * What happened since the manager acted on this decision.
 *  - none    they have not opened it, so there is nothing to say
 *  - moved   the condition changed after they acted, so it is resolving
 *  - waiting they opened it and it still has not moved
 */
export function followUp(
  store: Store,
  id: string,
  currentSignature: string,
): FollowUpState {
  const rec = store[id]
  if (!rec) return { kind: 'none' }
  if (rec.signature !== currentSignature) {
    return { kind: 'moved', since: rec.at, context: rec.context }
  }
  return { kind: 'waiting', since: rec.at, context: rec.context }
}
