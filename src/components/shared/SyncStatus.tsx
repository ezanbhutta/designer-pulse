/**
 * A quiet freshness line: how long ago the data was pulled from ClickUp, plus a
 * Refresh button. Turns amber when the last pull is old, so a stale board is
 * always visible instead of silently wrong. Presentational — the polling lives
 * in useKeepFresh.
 */

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { InfoTip } from '../ui/InfoTip'

/** Minutes past which the board is treated as possibly behind ClickUp. */
const STALE_MIN = 20

function describe(iso: string | null, nowMs: number): { label: string; stale: boolean } {
  if (!iso) return { label: 'Not synced yet', stale: true }
  const min = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000))
  if (min < 1) return { label: 'Synced just now', stale: false }
  if (min === 1) return { label: 'Synced one minute ago', stale: false }
  if (min < 60) return { label: `Synced ${min} minutes ago`, stale: min >= STALE_MIN }
  const h = Math.round(min / 60)
  return { label: `Synced ${h} hour${h === 1 ? '' : 's'} ago`, stale: true }
}

export function SyncStatus({
  syncing,
  lastSyncIso,
  onRefresh,
}: {
  syncing: boolean
  lastSyncIso: string | null
  onRefresh: () => void
}) {
  // Re-tick so "x minutes ago" keeps counting up without a fresh sync.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const { label, stale } = describe(lastSyncIso, nowMs)
  const text = syncing ? 'Checking ClickUp for changes…' : stale ? `${label}, may be behind ClickUp` : label

  return (
    <div className="flex items-center gap-2 text-label tracking-normal">
      <span
        className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
          syncing ? 'bg-brand animate-pulse' : stale ? 'bg-warning' : 'bg-success'
        }`}
        aria-hidden="true"
      />
      <span className={stale && !syncing ? 'font-medium text-warning' : 'text-muted'}>{text}</span>
      <InfoTip text="The board is a live copy of ClickUp. This shows how long ago it was last pulled. Press Refresh to pull the newest changes right now." />
      <button
        type="button"
        onClick={onRefresh}
        disabled={syncing}
        aria-label="Refresh from ClickUp now"
        className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-brand transition-colors duration-150 ease-out hover:bg-brand-soft disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
        Refresh
      </button>
    </div>
  )
}
