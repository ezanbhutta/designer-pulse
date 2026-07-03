/**
 * The 9-status pipeline (spec §3.2). ClickUp status IDs are per-list, so we
 * canonicalize by NAME only: `lower(trim(name))`. Never key on status id.
 */

export const STATUSES = [
  'pickup your projects',
  'in progress',
  'deliver to client',
  'revision',
  'revision complete',
  'client response',
  'final files',
  'cancelled',
  'complete',
] as const

export type CanonicalStatus = (typeof STATUSES)[number]

export const STATUS_ORDER: Record<CanonicalStatus, number> = {
  'pickup your projects': 0,
  'in progress': 1,
  'deliver to client': 2,
  revision: 3,
  'revision complete': 4,
  'client response': 5,
  'final files': 6,
  cancelled: 7,
  complete: 8,
}

/** Statuses where the clock is owned by the designer (spec §4.1). */
export const DESIGNER_OWNED: CanonicalStatus[] = [
  'pickup your projects',
  'in progress',
  'revision',
  'final files',
]

/** Open = not terminal. */
export const TERMINAL_STATUSES: CanonicalStatus[] = ['cancelled', 'complete']

/** Active load for the Utilization gauge (spec §11 Tier 3). */
export const ACTIVE_LOAD_STATUSES: CanonicalStatus[] = [
  'pickup your projects',
  'in progress',
  'revision',
]

/** Prior statuses that classify a revision as CSR-caught (spec §4.2). */
export const CSR_CAUGHT_SOURCES: CanonicalStatus[] = [
  'deliver to client',
  'revision complete',
]

export function canonicalizeStatus(raw: string | null | undefined): CanonicalStatus | null {
  if (!raw) return null
  const name = raw.trim().toLowerCase()
  return (STATUSES as readonly string[]).includes(name) ? (name as CanonicalStatus) : null
}

/**
 * Short display labels, used identically on every screen (spec §21.2).
 * Written in plain everyday English so non-technical users read them
 * instantly; the canonical ClickUp names stay internal.
 */
export const STATUS_LABELS: Record<CanonicalStatus, string> = {
  'pickup your projects': 'Waiting to start',
  'in progress': 'Working',
  'deliver to client': 'First design sent',
  revision: 'Changes asked',
  'revision complete': 'Changes done',
  'client response': 'Waiting for client',
  'final files': 'Final files',
  cancelled: 'Cancelled',
  complete: 'Done',
}

/** One-line plain-language meaning per status — for ⓘ info tips. */
export const STATUS_EXPLAINERS: Record<CanonicalStatus, string> = {
  'pickup your projects': 'A new project the designer has not started yet.',
  'in progress': 'The designer is working on it right now.',
  'deliver to client': 'The first design is ready and was sent for checking.',
  revision: 'Someone asked for changes. The designer needs to fix it.',
  'revision complete': 'The changes are done and sent back for checking.',
  'client response': 'We are waiting for the client to reply. This waiting never counts against the designer.',
  'final files': 'The client said yes — the designer is preparing the final files.',
  cancelled: 'The order was lost because of a design problem. Check the task history before judging.',
  complete: 'The project is closed.',
}

/**
 * One semantic tone per status, worn identically everywhere (spec §21.2).
 * neutral = in flight · success = forward motion / closed ·
 * warning = recoverable defect · waiting = client-owned · danger = terminal failure
 */
export type StatusTone = 'neutral' | 'success' | 'warning' | 'waiting' | 'danger'

export const STATUS_TONES: Record<CanonicalStatus, StatusTone> = {
  'pickup your projects': 'neutral',
  'in progress': 'neutral',
  'deliver to client': 'success',
  revision: 'warning',
  'revision complete': 'success',
  'client response': 'waiting',
  'final files': 'success',
  cancelled: 'danger',
  complete: 'success',
}

/** Parse `concept_count` from scope tags like "3 concepts" (spec §3.3). Nullable by design. */
export function parseConceptCount(tags: string[]): number | null {
  for (const tag of tags) {
    const m = /^\s*(\d+)\s*concepts?\b/i.exec(tag)
    if (m) return parseInt(m[1], 10)
  }
  return null
}
