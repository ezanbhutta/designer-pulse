import { useRef, type KeyboardEvent } from 'react'

export interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  ariaLabel: string
}

/**
 * Segmented switch (period pickers, view modes). Radiogroup semantics with
 * roving tabindex: arrow keys move AND select, per the WAI-ARIA radio
 * pattern. The active segment lifts on the surface token — brand stays
 * reserved for primary actions and nav (§21.1).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedControlProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null)

  const move = (delta: number) => {
    const idx = options.findIndex((o) => o.value === value)
    const next = options[(idx + delta + options.length) % options.length]
    if (!next) return
    onChange(next.value)
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)
        ?.focus()
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    }
  }

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className="inline-flex items-center gap-1 rounded-xl bg-surface-2 p-1"
    >
      {options.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-value={opt.value}
            onClick={() => onChange(opt.value)}
            className={`min-h-[2.5rem] rounded-lg px-3.5 text-sm font-medium transition-colors duration-150 ${
              selected
                ? 'bg-surface text-fg shadow-soft'
                : 'text-muted hover:text-fg'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export default SegmentedControl
