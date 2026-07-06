/**
 * Keeps the open dashboard in step with ClickUp. The reconcile cron runs only
 * once a day on the hosting plan, so while any signed-in surface is open this
 * hook quietly asks the server to pull the latest from ClickUp — on mount,
 * every few minutes, and whenever the tab regains focus. The server debounces,
 * so many open tabs stay cheap. A real pull invalidates the caches so the board
 * updates; realtime then keeps it live between pulls.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from './useAuth'
import { requestSync } from '../lib/queries'

const AUTO_INTERVAL_MS = 3 * 60_000

export interface KeepFresh {
  syncing: boolean
  lastSyncIso: string | null
  syncNow: () => void
}

export function useKeepFresh(): KeepFresh {
  const qc = useQueryClient()
  const { session } = useAuth()
  const [syncing, setSyncing] = useState(false)
  const [lastSyncIso, setLastSyncIso] = useState<string | null>(null)
  const inFlight = useRef(false)

  const run = useCallback(async (force = false) => {
    if (inFlight.current || !session) return
    inFlight.current = true
    setSyncing(true)
    try {
      const r = await requestSync(force)
      // A fresh pull actually landed — refresh every open view and stamp the
      // clock to NOW, because we just pulled the current state from ClickUp.
      // (Pressing Refresh always forces a real pull, so a click always lands on
      // "Synced just now".) A skip means the data was already recent, so keep
      // showing the real stored time instead.
      if (r.ok && r.triggered && !r.skipped) {
        await qc.invalidateQueries()
        setLastSyncIso(new Date().toISOString())
      } else if (r.ok && typeof r.lastSync === 'string') {
        setLastSyncIso(r.lastSync)
      } else if (r.ok) {
        setLastSyncIso(new Date().toISOString())
      }
    } catch {
      /* leave the indicator where it is — a failed poke simply won't advance it */
    } finally {
      inFlight.current = false
      setSyncing(false)
    }
  }, [qc, session])

  useEffect(() => {
    if (!session) return
    void run()
    const id = window.setInterval(() => void run(), AUTO_INTERVAL_MS)
    const onWake = () => {
      if (document.visibilityState !== 'hidden') void run()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [session, run])

  return { syncing, lastSyncIso, syncNow: () => void run(true) }
}
