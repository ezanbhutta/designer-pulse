import { ArrowUpDown } from 'lucide-react'

export interface SortOption<T extends string> {
  value: T
  label: string
}

/**
 * The one "Sort by" dropdown, used wherever a list or board can be reordered.
 * A native <select> styled to match the filter chips — simplest possible
 * keyboard and screen-reader behaviour, no custom popover needed for a single
 * choice.
 */
export function SortMenu<T extends string>({
  value,
  onChange,
  options,
  label = 'Sort by',
}: {
  value: T
  onChange: (value: T) => void
  options: SortOption<T>[]
  label?: string
}) {
  return (
    <label className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2">
      <ArrowUpDown className="h-4 w-4 text-muted" aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        aria-label={label}
        className="min-h-11 cursor-pointer appearance-none bg-transparent pr-1 text-caption font-medium text-fg focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export default SortMenu
