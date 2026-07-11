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

/**
 * Statuses where the designer has DELIVERED the first design — their
 * production work on that project is done for the day, even if it then goes to
 * the client or into changes. The owner counts a project as "done" the moment
 * the first design is sent (it reaches "deliver to client"), NOT only when the
 * whole order is finally closed. This is the set that counts toward the daily
 * target. Excludes "pickup your projects" and "in progress" (not yet delivered)
 * and "cancelled" (never delivered).
 */
export const DELIVERED_STATUSES: CanonicalStatus[] = [
  'deliver to client',
  'revision',
  'revision complete',
  'client response',
  'final files',
  'complete',
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
  revision: 'Changes requested',
  'revision complete': 'Ready to send',
  'client response': 'With the client',
  'final files': 'Final files',
  cancelled: 'Cancelled',
  complete: 'Done',
}

/** One-line plain-language meaning per status — for ⓘ info tips. */
export const STATUS_EXPLAINERS: Record<CanonicalStatus, string> = {
  'pickup your projects':
    'This project has just come in and is waiting for the designer to begin. Nothing is late here; it simply has not been picked up yet.',
  'in progress': 'The designer is working on this one right now.',
  'deliver to client': 'The first design is ready and has gone to the client to look over.',
  revision:
    'The client or one of our checkers asked for a few changes, and the designer is taking care of them.',
  'revision complete':
    "The changes the client asked for are finished, and this is now waiting to be shared with the client. Sending it on is the team lead's job, not the designer's.",
  'client response':
    'The work is now with the client while they take their time to look it over. Clients reply on their own schedule, so this is a normal and healthy part of the job, and it never counts against the designer.',
  'final files':
    'The client is happy with the design, and the designer is putting together the final files to hand over.',
  cancelled:
    'This order did not go ahead, and it is counted here as a lost order. Numbers rarely tell the whole story, so please read through the project history before forming any judgement.',
  complete: 'This project is finished and closed. Nothing more is needed.',
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
