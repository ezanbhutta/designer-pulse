import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface FilterOption {
  value: string
  label: string
}

/**
 * The one flat multi-select filter, used for stage, priority and team
 * anywhere a list or board can be narrowed. Same shape and behaviour as
 * DesignerFilter: an "All" choice sits at the top, ticked by default; picking
 * a specific option starts a real selection; picking everything (or nothing)
 * snaps back to the clean "All" state, so the view can never be filtered down
 * to an empty page by accident.
 */
export function MultiSelectFilter({
  label,
  icon: Icon,
  options,
  selected,
  onChange,
  allLabel = 'All',
}: {
  label: string
  icon: LucideIcon
  options: FilterOption[]
  /** Chosen values. Empty = everything (no filter). */
  selected: string[]
  onChange: (values: string[]) => void
  allLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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
  const isChecked = (v: string) => selected.includes(v)

  const toggle = (v: string) => {
    const base = isEveryone ? [] : selected
    const next = base.includes(v) ? base.filter((x) => x !== v) : [...base, v]
    onChange(next.length === 0 || next.length === options.length ? [] : next)
  }

  const triggerText = isEveryone
    ? `${allLabel} ${label.toLowerCase()}`
    : selected.length === 1
      ? options.find((o) => o.value === selected[0])?.label ?? '1 selected'
      : `${selected.length} ${label.toLowerCase()}`

  return (
    <div ref={rootRef} className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2"
      >
        <Icon className="h-4 w-4 text-muted" aria-hidden="true" />
        {triggerText}
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`Choose which ${label.toLowerCase()} to show`}
          className="absolute left-0 top-full z-palette mt-2 max-h-[60vh] w-[240px] overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-raised"
        >
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
            {allLabel} {label.toLowerCase()}
          </button>
          <div className="mx-1 my-1.5 h-px bg-border" />
          {options.map((o) => {
            const checked = isChecked(o.value)
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => toggle(o.value)}
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
                <span className="truncate">{o.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default MultiSelectFilter
