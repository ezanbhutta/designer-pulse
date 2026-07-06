/**
 * The on/off card for desktop (operating-system) alerts, shown at the top of
 * the Alerts page. It turns the browser's notification permission and our own
 * switch into one plain-language control, and lets a person fire a test so they
 * can see for themselves that the pop-up reaches them.
 *
 * Every state a browser can be in has its own honest line here: some browsers
 * cannot do it at all, some have the permission blocked in their settings, and
 * the rest can be switched on with a single click.
 */

import { Bell, BellRing, Check, MonitorCheck } from 'lucide-react'
import { useDesktopAlerts } from './DesktopAlerts'

export function DesktopAlertsCard() {
  const { supported, permission, enabled, turnOn, turnOff, sendTest } = useDesktopAlerts()

  // Browser has no notification support at all (rare, mostly very old ones).
  if (!supported) {
    return (
      <div className="card flex items-start gap-4 p-5">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Bell className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-caption font-semibold text-fg">Desktop alerts</p>
          <p className="mt-1 max-w-prose text-caption text-muted">
            This browser cannot show desktop pop-ups. Open Studio Pulse in Chrome, Edge, or Firefox
            to get them.
          </p>
        </div>
      </div>
    )
  }

  const blocked = permission === 'denied'
  const on = enabled && permission === 'granted'

  return (
    <div className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
      <span
        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          on ? 'bg-brand-soft text-brand' : 'bg-surface-2 text-muted'
        }`}
      >
        {on ? (
          <BellRing className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Bell className="h-4 w-4" aria-hidden="true" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-caption font-semibold text-fg">Desktop alerts</p>
        <p className="mt-1 max-w-prose text-caption text-muted">
          {blocked
            ? 'Your browser has these blocked. Open its site settings for this page, allow notifications, then come back and switch them on.'
            : on
              ? "A pop-up shows up in your computer's notification area the moment a warning or urgent alert arrives, even while you work in another tab. Keep a Studio Pulse tab open."
              : "Get a pop-up in your computer's notification area the moment a warning or urgent alert arrives, even while you work in another tab. One click and it stays quiet until something real needs you."}
        </p>

        {on && (
          <p className="mt-2 inline-flex items-center gap-1 text-label font-normal tracking-normal text-brand">
            <MonitorCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Turned on for this browser
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {on ? (
          <>
            <button
              type="button"
              onClick={sendTest}
              className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border bg-surface px-3 text-label text-fg transition-colors duration-150 ease-out hover:bg-surface-2 motion-safe:active:scale-[0.97]"
            >
              Send a test
            </button>
            <button
              type="button"
              onClick={turnOff}
              className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border bg-surface px-3 text-label text-fg transition-colors duration-150 ease-out hover:bg-surface-2 motion-safe:active:scale-[0.97]"
            >
              Turn off
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void turnOn()}
            disabled={blocked}
            className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-brand px-3.5 text-label font-medium text-brand-fg transition-colors duration-150 ease-out hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50 motion-safe:active:scale-[0.97]"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Turn on
          </button>
        )}
      </div>
    </div>
  )
}
