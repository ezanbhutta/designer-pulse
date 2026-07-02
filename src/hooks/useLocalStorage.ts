import { useCallback, useState } from 'react'

/**
 * Persisted UI preference state (spec §20.4 — filters/defaults remember the
 * last used value per user). JSON round-trip; storage failures (private mode,
 * quota) degrade silently to in-memory state.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  const set = useCallback(
    (v: T) => {
      setValue(v)
      try {
        window.localStorage.setItem(key, JSON.stringify(v))
      } catch {
        // Storage unavailable — keep the in-memory value for this session.
      }
    },
    [key],
  )

  return [value, set]
}

export default useLocalStorage
