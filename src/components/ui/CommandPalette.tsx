import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownLeft, Search } from 'lucide-react'

export interface Command {
  id: string
  label: string
  hint?: string
  keywords?: string
  run: () => void
}

export interface CommandPaletteProps {
  commands: Command[]
}

/** Internal event so an on-screen button (AppShell search) can open the palette too. */
export const OPEN_PALETTE_EVENT = 'studio-pulse:open-command-palette'

/** True when every query token is a substring or in-order subsequence of the haystack. */
function fuzzyMatch(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = haystack.toLowerCase()
  return tokens.every((token) => {
    if (hay.includes(token)) return true
    let i = 0
    for (const ch of hay) {
      if (ch === token[i]) i++
      if (i === token.length) return true
    }
    return false
  })
}

function score(cmd: Command, query: string): number {
  const q = query.toLowerCase()
  const label = cmd.label.toLowerCase()
  if (label.startsWith(q)) return 0
  if (label.includes(q)) return 1
  if ((cmd.keywords ?? '').toLowerCase().includes(q)) return 2
  return 3
}

/**
 * Keyboard-first command palette (spec §20.6): global ⌘K / Ctrl-K listener,
 * fuzzy-ish filter over label + keywords, arrow-key navigation, Enter runs,
 * Esc closes. Result count is announced politely; selection uses the brand
 * token (§21.1 — brand marks the active selection). Render once in AppShell.
 */
export function CommandPalette({ commands }: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const lastActive = useRef<HTMLElement | null>(null)

  const openPalette = useCallback(() => {
    lastActive.current = (document.activeElement as HTMLElement | null) ?? null
    setQuery('')
    setActive(0)
    setOpen(true)
  }, [])

  const closePalette = useCallback(() => {
    setOpen(false)
    lastActive.current?.focus()
  }, [])

  // Global ⌘K / Ctrl-K listener + programmatic open event.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((prev) => {
          if (prev) return false
          lastActive.current = (document.activeElement as HTMLElement | null) ?? null
          setQuery('')
          setActive(0)
          return true
        })
      }
    }
    const onOpenEvent = () => openPalette()
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvent)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvent)
    }
  }, [openPalette])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim()
    if (!q) return commands
    return commands
      .filter((c) => fuzzyMatch(`${c.label} ${c.keywords ?? ''}`, q))
      .sort((a, b) => score(a, q) - score(b, q))
  }, [commands, query])

  // Keep the active row valid and visible as the filter changes.
  useEffect(() => {
    setActive((prev) => Math.min(prev, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const runCommand = useCallback(
    (cmd: Command) => {
      setOpen(false)
      lastActive.current = null // command navigates; don't yank focus back
      cmd.run()
    },
    [],
  )

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Home' && filtered.length > 0) {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End' && filtered.length > 0) {
      e.preventDefault()
      setActive(filtered.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[active]
      if (cmd) runCommand(cmd)
    }
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-start justify-center px-4 pt-[15vh]">
      <div
        className="absolute inset-0 bg-bg/60 backdrop-blur-sm"
        onClick={closePalette}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
        className="animate-fade-in relative w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface shadow-raised"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[active] ? `cmd-opt-${filtered[active].id}` : undefined}
            aria-label="Search commands"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            placeholder="Type a command or search…"
            className="min-h-[3rem] w-full bg-transparent text-sm text-fg outline-none placeholder:text-muted focus-visible:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
            esc
          </kbd>
        </div>

        <div aria-live="polite" className="sr-only">
          {filtered.length === 1 ? '1 result' : `${filtered.length} results`}
        </div>

        <ul
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          className="max-h-72 overflow-y-auto p-2"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted">
              No matching commands — try a different search.
            </li>
          ) : (
            filtered.map((cmd, i) => (
              <li key={cmd.id} role="presentation">
                <button
                  type="button"
                  id={`cmd-opt-${cmd.id}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runCommand(cmd)}
                  className={`flex min-h-[2.75rem] w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors duration-150 ${
                    i === active ? 'bg-brand-soft text-fg' : 'text-fg hover:bg-surface-2'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{cmd.label}</span>
                  {cmd.hint && (
                    <span className="ml-auto shrink-0 text-right text-xs text-muted">
                      {cmd.hint}
                    </span>
                  )}
                  {i === active && (
                    <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>,
    document.body,
  )
}

export default CommandPalette
