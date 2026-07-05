/**
 * Desktop (operating-system) alerts. While a Studio Pulse tab is open — even in
 * the background while you work in another tab — a new warning or urgent alert
 * pops up in your computer's notification area.
 *
 * How it stays quiet at the right times:
 *  - It asks the browser for permission once, on an explicit click.
 *  - On the first load it takes the current alerts as the baseline and says
 *    nothing, so opening the page never fires a burst of old alerts.
 *  - After that, only alerts newer than the last one it announced fire, and a
 *    big catch-up (many at once) collapses into a single summary.
 *  - It only announces the serious ones and warnings, never the quiet
 *    "good to know" notes.
 *
 * The tool observes; it never assigns (§22.1). Clicking a notification just
 * brings the tab forward and opens the Alerts page.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { presentAlert } from '../../lib/alertPresentation'
import type { Alert, Designer } from '../../../shared/types'
import { useActiveDesigners, useOpenAlerts } from '../../pages/ops/opsData'

const ENABLED_KEY = 'pulse.desktopAlerts.enabled'
const LAST_ID_KEY = 'pulse.desktopAlerts.lastId'

/** Permission plus the on/off switch, shared with the settings card. */
interface DesktopAlertsState {
  supported: boolean
  permission: NotificationPermission
  enabled: boolean
  /** Requests permission (if needed) and switches the alerts on. */
  turnOn: () => Promise<void>
  turnOff: () => void
  /** Fires one sample notification so a person can confirm it reaches them. */
  sendTest: () => void
}

const Ctx = createContext<DesktopAlertsState | null>(null)

export function useDesktopAlerts(): DesktopAlertsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDesktopAlerts must be used inside DesktopAlertsProvider')
  return ctx
}

const readNum = (key: string): number | null => {
  try {
    const raw = window.localStorage.getItem(key)
    const n = raw != null ? Number(raw) : NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
const writeStr = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode / quota — degrade silently */
  }
}

/** A warning or urgent alert still waiting — the only ones worth a pop-up. */
const isNotifiable = (a: Alert): boolean =>
  a.status === 'open' && (a.severity === 'critical' || a.severity === 'warning')

function fireOne(alert: Alert, designers: Designer[], onClick: () => void): void {
  const p = presentAlert(alert, designers)
  try {
    const n = new Notification(p.title, {
      body: p.suggestion ?? 'Open Studio Pulse to see what needs you.',
      tag: `studio-pulse-alert-${alert.id}`,
      icon: '/favicon.svg',
    })
    n.onclick = () => {
      onClick()
      n.close()
    }
  } catch {
    /* some browsers throw if the tab lost the gesture context — ignore */
  }
}

function fireSummary(count: number, onClick: () => void): void {
  try {
    const n = new Notification(`${count} new alerts need you`, {
      body: 'Open Studio Pulse to see them all.',
      tag: 'studio-pulse-alert-summary',
      icon: '/favicon.svg',
    })
    n.onclick = () => {
      onClick()
      n.close()
    }
  } catch {
    /* ignore */
  }
}

export function DesktopAlertsProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const alertsQ = useOpenAlerts()
  const designers = useActiveDesigners()

  const supported = typeof window !== 'undefined' && 'Notification' in window
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : 'denied',
  )
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(ENABLED_KEY) === 'true'
    } catch {
      return false
    }
  })

  const lastIdRef = useRef<number | null>(null)
  const baselinedRef = useRef(false)

  const openTab = useCallback(() => {
    window.focus()
    navigate('/ops/alerts')
  }, [navigate])

  const turnOn = useCallback(async () => {
    if (!supported) return
    let perm = Notification.permission
    if (perm === 'default') perm = await Notification.requestPermission()
    setPermission(perm)
    if (perm === 'granted') {
      setEnabled(true)
      writeStr(ENABLED_KEY, 'true')
    }
  }, [supported])

  const turnOff = useCallback(() => {
    setEnabled(false)
    writeStr(ENABLED_KEY, 'false')
  }, [])

  const sendTest = useCallback(() => {
    if (!supported || permission !== 'granted') return
    try {
      const n = new Notification('Studio Pulse desktop alerts are on', {
        body: 'This is a test. Real alerts will appear here the moment the app spots a problem.',
        tag: 'studio-pulse-test',
        icon: '/favicon.svg',
      })
      n.onclick = () => {
        openTab()
        n.close()
      }
    } catch {
      /* ignore */
    }
  }, [supported, permission, openTab])

  // The notifier: runs whenever the open alerts change (realtime keeps this
  // fresh even in a background tab, because the websocket stays connected).
  useEffect(() => {
    if (!supported || !enabled || permission !== 'granted') return
    const open = (alertsQ.data ?? []).filter(isNotifiable)
    if (open.length === 0) return
    const maxId = open.reduce((m, a) => Math.max(m, a.id), 0)

    // First run this session: baseline to the stored watermark, or to the
    // current max if there is none, so opening the tab never blasts old alerts.
    if (!baselinedRef.current) {
      baselinedRef.current = true
      const stored = readNum(LAST_ID_KEY)
      lastIdRef.current = stored ?? maxId
      if (stored == null) writeStr(LAST_ID_KEY, String(maxId))
    }

    const last = lastIdRef.current ?? maxId
    const fresh = open.filter((a) => a.id > last).sort((a, b) => a.id - b.id)
    if (fresh.length === 0) return

    if (fresh.length <= 3) {
      for (const a of fresh) fireOne(a, designers, openTab)
    } else {
      fireSummary(fresh.length, openTab)
    }
    lastIdRef.current = maxId
    writeStr(LAST_ID_KEY, String(maxId))
  }, [alertsQ.data, enabled, permission, supported, designers, openTab])

  const value = useMemo<DesktopAlertsState>(
    () => ({ supported, permission, enabled, turnOn, turnOff, sendTest }),
    [supported, permission, enabled, turnOn, turnOff, sendTest],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
