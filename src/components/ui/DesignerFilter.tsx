import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Users } from 'lucide-react'
import type { Designer } from '../../../shared/types'

/**
 * The one people filter, used wherever a report or list can be narrowed to a
 * few designers. A trigger button opens a popover of every active designer,
 * grouped by team, each a checkbox. An empty selection means "everyone", so the
 * default view is never accidentally filtered to nothing — unchecking the last
 * person simply snaps back to everyone. Matches the DateRangePicker's shape and
 * grayscale-with-brand styling.
 */
export function DesignerFilter({
  designers,
  selected,
  onChange,
  label,
}: {
  designers: Designer[]
  /** Chosen designer ids. Empty = everyone (no filter). */
  selected: string[]
  onChange: (ids: string[]) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const allIds = useMemo(() => designers.map((d) => d.id), [designers])
  const byTeam = useMemo(() => {
    const map = new Map<string, Designer[]>()
    for (const d of designers) {
      const list = map.get(d.team) ?? []
      list.push(d)
      map.set(d.team, list)
    }
    return map
  }, [designers])

  // Close on outside-click or Escape (mirrors DateRangePicker).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const isEveryone = selected.length === 0
  // In "All designers" mode the people below stay unticked — only an explicit,
  // specific pick shows ticks — so "All" reads as one clean choice, not a list
  // of sixteen ticked names.
  const isChecked = (id: string) => selected.includes(id)

  const toggle = (id: string) => {
    // Starting from everyone, picking a person begins a fresh list with just
    // that one. Otherwise add or remove them. Picking everyone, or nobody,
    // snaps back to the clean "All designers" choice.
    const base = isEveryone ? [] : selected
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    onChange(next.length === 0 || next.length === allIds.length ? [] : next)
  }

  const triggerText = isEveryone
    ? 'All designers'
    : selected.length === 1
      ? designers.find((d) => d.id === selected[0])?.name ?? '1 designer'
      : `${selected.length} designers`

  return (
    <div ref={rootRef} className="relative flex items-center gap-1">
      {label && (
        <span className="mr-1 inline-flex items-center gap-1 text-label uppercase text-muted">
          <Users className="h-3 w-3" aria-hidden="true" />
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2"
      >
        <Users className="h-4 w-4 text-muted" aria-hidden="true" />
        {triggerText}
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose which designers to show"
          className="absolute left-0 top-full z-palette mt-2 max-h-[60vh] w-[260px] overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-raised"
        >
          {/* "All designers" is one clean choice, ticked by default — the
              people below stay unticked until you pick someone specific. */}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={isEveryone}
            onClick={() => onChange([])}
            className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-caption font-semibold text-fg transition-colors duration-150 hover:bg-surface-2"
          >
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                isEveryone ? 'border-brand bg-brand text-brand-fg' : 'border-border bg-surface'
              }`}
              aria-hidden="true"
            >
              {isEveryone && <Check className="h-3 w-3" strokeWidth={3} />}
            </span>
            All designers
          </button>
          <div className="mx-1 my-1.5 h-px bg-border" />
          {[...byTeam.entries()].map(([team, members]) => (
            <div key={team} className="mt-1">
              <p className="px-2 pb-1 pt-1.5 text-label font-semibold uppercase tracking-[0.08em] text-muted">
                {team}
              </p>
              {members.map((d) => {
                const checked = isChecked(d.id)
                return (
                  <button
                    key={d.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    onClick={() => toggle(d.id)}
                    className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-caption text-fg transition-colors duration-150 hover:bg-surface-2"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        checked ? 'border-brand bg-brand text-brand-fg' : 'border-border bg-surface'
                      }`}
                      aria-hidden="true"
                    >
                      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    <span className="truncate">{d.name}</span>
                  </button>
                )
              })}
            </div>
          ))}
          {designers.length === 0 && (
            <p className="px-2 py-3 text-caption text-muted">No designers to choose from yet.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default DesignerFilter
