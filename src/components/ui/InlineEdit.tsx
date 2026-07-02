import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface InlineEditProps {
  value: string
  onSave: (v: string) => void | Promise<void>
  type?: 'text' | 'number' | 'time'
  className?: string
  ariaLabel: string
}

/**
 * Click-to-edit cell (spec §21.6 — roster and schedule edits happen in
 * place): the value renders as a button; click or Enter opens an input;
 * Enter or blur saves (awaiting onSave), Esc cancels. On save failure the
 * value reverts and the cell shakes (Web Animations API, skipped under
 * prefers-reduced-motion).
 */
export function InlineEdit({ value, onSave, type = 'text', className = '', ariaLabel }: InlineEditProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  const inFlight = useRef(false)

  useEffect(() => {
    if (!editing) return
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [editing])

  const shake = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    rootRef.current?.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-4px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(-2px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 250, easing: 'ease-out' },
    )
  }

  const startEdit = () => {
    cancelled.current = false
    setDraft(value)
    setEditing(true)
  }

  const save = async () => {
    if (inFlight.current || cancelled.current) return
    if (draft === value) {
      setEditing(false)
      return
    }
    inFlight.current = true
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } catch {
      // Revert + shake (§21.6): the truth is still the old value.
      setDraft(value)
      setEditing(false)
      shake()
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelled.current = true
      setDraft(value)
      setEditing(false)
    }
  }

  if (!editing) {
    return (
      <span ref={rootRef} className="inline-block">
        <button
          type="button"
          onClick={startEdit}
          aria-label={`${ariaLabel} — click to edit`}
          className={`tnum inline-flex min-h-[2.75rem] cursor-text items-center rounded-lg border border-transparent px-2 text-left transition-colors duration-150 hover:border-border hover:bg-surface-2 ${className}`}
        >
          {value === '' ? <span className="text-muted">—</span> : value}
        </button>
      </span>
    )
  }

  const width =
    type === 'time' ? undefined : `${Math.min(Math.max(draft.length, 3) + 3, 32)}ch`

  return (
    <span ref={rootRef} className="inline-block">
      <input
        ref={inputRef}
        type={type}
        value={draft}
        disabled={saving}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => void save()}
        style={width ? { width } : undefined}
        className={`tnum min-h-[2.75rem] rounded-lg border border-brand bg-surface px-2 text-fg outline-none disabled:opacity-60 ${className}`}
      />
    </span>
  )
}

export default InlineEdit
