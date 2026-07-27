import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from './Badge'
import { InfoTip } from './InfoTip'
import { useLocalStorage } from '../../hooks/useLocalStorage'

export interface OpenSectionProps {
  title: string
  /** Count shown beside the title. Always the WHOLE set, never a filtered one. */
  count?: number
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'waiting'
  /** One line saying what is inside, so the heading alone is enough to decide. */
  blurb?: string
  tip?: string
  /** Remembered across visits when given a key; otherwise session only. */
  storageKey?: string
  defaultOpen?: boolean
  /** Shown on the right of the header, for a link or a small action. */
  trailing?: ReactNode
  children: ReactNode
}

/**
 * A section that can always be opened.
 *
 * The redesign's first pass hid things to protect focus: a hard cap on the
 * decisions, panels deleted outright, a bucket folded away. Focus is worth
 * protecting, but hiding is the wrong tool for it, because the manager then has
 * no way to reach what was hidden without leaving the page. Collapsing keeps
 * the calm first read AND keeps everything one click away, with the count on
 * the header so a folded section still says how much is behind it.
 */
export function OpenSection({
  title,
  count,
  tone = 'neutral',
  blurb,
  tip,
  storageKey,
  defaultOpen = true,
  trailing,
  children,
}: OpenSectionProps) {
  const stored = useLocalStorage<boolean>(storageKey ?? 'pulse.section.unused', defaultOpen)
  const local = useState(defaultOpen)
  const [open, setOpen] = storageKey ? stored : local

  return (
    <section aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="group inline-flex min-h-11 items-center gap-2.5 rounded-lg text-card text-fg transition-colors duration-150 ease-out hover:text-muted"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          )}
          {title}
          {count != null && (
            <Badge tone={tone}>
              <span className="tnum">{count}</span>
            </Badge>
          )}
          {tip && <InfoTip text={tip} label={`About ${title}`} />}
        </button>
        {trailing ?? (blurb ? (
          <p className="text-label font-normal tracking-normal text-muted">{blurb}</p>
        ) : null)}
      </div>
      {open && children}
    </section>
  )
}

export default OpenSection
