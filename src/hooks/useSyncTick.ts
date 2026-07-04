import { useEffect } from 'react'

const TICK_MS = 5 * 60_000

/**
 * Keeps the day's plate fresh even if the external scheduler is down: any
 * open dashboard nudges the server's self-rate-limited micro-sync
 * (/api/tick) on load and every 5 minutes. Fire-and-forget — failures are
 * irrelevant (the 15-minute crons remain the primary engine), and the server
 * ignores nudges that arrive within its 4-minute floor.
 */
export function useSyncTick() {
  useEffect(() => {
    const fire = () => {
      void fetch('/api/tick', { method: 'POST' }).catch(() => {
        /* dev/preview or offline — nothing to do */
      })
    }
    fire()
    const t = setInterval(fire, TICK_MS)
    return () => clearInterval(t)
  }, [])
}
