import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { LogOut, Menu, Moon, Search, Sun, X } from 'lucide-react'
import { BrandLogo } from '../ui/BrandLogo'
import { useAuth } from '../../hooks/useAuth'
import { syncThemeColorMeta } from '../../lib/themeColor'
import { CommandPalette, OPEN_PALETTE_EVENT, type Command } from '../ui/CommandPalette'
import { ToastProvider } from '../ui/ToastProvider'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  badge?: number
}

export interface AppShellProps {
  title: string
  nav: NavItem[]
  commands?: Command[]
  children?: ReactNode
}

/** Dense 32px control row for the precision sidebar (manifesto pillar 4). */
const DENSE_ROW =
  'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg'
/** 44px touch row for the mobile slide-over (pillar 12 — touch targets). */
const TOUCH_ROW =
  'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-caption font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg'

/**
 * Theme toggle (spec §21.9 — dark-first cockpit, light designer view):
 * persists to localStorage('theme') and flips the `dark` class on <html>.
 * A MutationObserver keeps the icon honest if the route-level default
 * (App.useSurfaceTheme) changes the class underneath us.
 */
function ThemeToggle({ dense = false }: { dense?: boolean }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    // Keep the browser-chrome color in step with whatever set the class —
    // the toggle here, the other surface's toggle, or the route default.
    syncThemeColorMeta(document.documentElement.classList.contains('dark'))
    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.classList.contains('dark')
      setDark(isDark)
      syncThemeColorMeta(isDark)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {
      // Storage unavailable — theme still applies for this session.
    }
    setDark(next)
  }

  const Icon = dark ? Sun : Moon
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={dense ? DENSE_ROW : TOUCH_ROW}
    >
      <Icon className={dense ? 'h-4 w-4 shrink-0 opacity-80' : 'h-5 w-5 shrink-0'} aria-hidden="true" />
      <span className="truncate">{dark ? 'Light theme' : 'Dark theme'}</span>
    </button>
  )
}

function NavBadge({ count, dense }: { count: number; dense: boolean }) {
  if (count <= 0) return null
  return (
    <span
      className={`tnum ml-auto inline-flex items-center justify-center rounded-full bg-danger font-semibold text-danger-fg ${
        dense ? 'h-4 min-w-4 px-1 text-[10px]' : 'h-5 min-w-5 px-1.5 text-[11px]'
      }`}
      aria-hidden="true"
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

function navLinkLabel(item: NavItem): string {
  return item.badge && item.badge > 0
    ? `${item.label}, ${item.badge} needing attention`
    : item.label
}

/**
 * The high-density precision shell (manifesto pillar 4): a fixed 240px
 * sidebar of 32px/13px nav rows on a strict gap-0.5 rhythm, a 2px brand
 * indicator bar on the active row, a minimalist profile footer, and a 56px
 * sticky header that blurs over the void. Content is centered at 1200px with
 * cavernous p-8 margins. Mobile keeps the top bar + 44px slide-over rows.
 * Brand violet marks ONLY the active nav item and the palette selection.
 */
export function AppShell({ title, nav, commands, children }: AppShellProps) {
  const { profile, signOut } = useAuth()
  const { pathname } = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  // Name the tab after the page — screen readers get navigation feedback and
  // history entries stop being identical across Board / Roster / Alerts / …
  useEffect(() => {
    const page =
      nav.find(
        (n) =>
          pathname === n.to ||
          (n.to !== '/ops' && n.to !== '/ceo' && pathname.startsWith(n.to)),
      )?.label ?? title
    document.title = `${page} · Studio Pulse`
  }, [pathname, nav, title])

  // Close the mobile menu on Escape.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  // Mobile menu focus handoff (it's aria-modal): move focus in on open,
  // return it to the hamburger on close.
  useEffect(() => {
    if (!mobileOpen) return
    const raf = requestAnimationFrame(() => menuPanelRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      menuButtonRef.current?.focus()
    }
  }, [mobileOpen])

  // Tab trap for the mobile menu, mirroring Drawer's.
  const handleMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !menuPanelRef.current) return
    const focusables = Array.from(
      menuPanelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement)
    if (focusables.length === 0) {
      e.preventDefault()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === menuPanelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // Dense (desktop) nav rows are h-8/13px; mobile slide-over rows stay 44px.
  const navLinkClass =
    (dense: boolean) =>
    ({ isActive }: { isActive: boolean }) =>
      `group relative flex items-center rounded-md font-medium transition-colors duration-150 ${
        dense ? 'h-8 gap-2.5 px-2 text-[13px]' : 'min-h-11 gap-3 rounded-lg px-3 text-caption'
      } ${isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-fg'}`

  const renderNavItems = (dense: boolean, onNavigate?: () => void) =>
    nav.map((item) => {
      const Icon = item.icon
      return (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/ops' || item.to === '/ceo' || item.to === '/me'}
          className={navLinkClass(dense)}
          aria-label={navLinkLabel(item)}
          title={item.label}
          onClick={onNavigate}
        >
          {({ isActive }) => (
            <>
              {/* 2px indicator bar — the active row is physically marked. */}
              {isActive && (
                <span
                  className="absolute -left-1 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand"
                  aria-hidden="true"
                />
              )}
              <Icon
                className={dense ? 'h-4 w-4 shrink-0 opacity-80' : 'h-5 w-5 shrink-0'}
                aria-hidden="true"
              />
              <span className="truncate">{item.label}</span>
              <NavBadge count={item.badge ?? 0} dense={dense} />
            </>
          )}
        </NavLink>
      )
    })

  const openPalette = () => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))
  const email = profile?.email ?? 'Signed in'

  return (
    <ToastProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-tip focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2.5 focus:text-caption focus:font-medium focus:text-fg focus:shadow-raised"
      >
        Skip to content
      </a>

      <div className="flex min-h-screen bg-bg selection:bg-brand-soft">
        {/* ── Sidebar: exactly 240px, dense 4px/8px rhythm (pillar 4) ────── */}
        <aside className="sticky top-0 hidden h-screen w-[240px] shrink-0 flex-col border-r border-border bg-surface px-3 py-4 md:flex">
          {/* Logo area: tight alignment */}
          <div className="flex items-center gap-2.5 px-2 pb-6">
            <BrandLogo className="h-6 w-6" />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold tracking-[-0.01em] text-fg">
                Studio Pulse
              </p>
            </div>
          </div>

          {/* Navigation: strict 2px gap rhythm */}
          <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
            {renderNavItems(true)}
          </nav>

          {/* Footer: utilities + minimalist profile block */}
          <div className="mt-4 flex flex-col gap-0.5 border-t border-border pt-3">
            {commands && commands.length > 0 && (
              <button
                type="button"
                onClick={openPalette}
                aria-label="Open search"
                title="Search"
                className={DENSE_ROW}
              >
                <Search className="h-4 w-4 shrink-0 opacity-80" aria-hidden="true" />
                <span className="flex-1 truncate text-left">Search</span>
              </button>
            )}
            <ThemeToggle dense />
            <button
              type="button"
              onClick={() => void signOut()}
              aria-label="Sign out"
              title="Sign out"
              className={DENSE_ROW}
            >
              <LogOut className="h-4 w-4 shrink-0 opacity-80" aria-hidden="true" />
              <span className="truncate">Sign out</span>
            </button>
            <div className="mt-1 flex h-8 items-center gap-2.5 px-2" title={email}>
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold uppercase text-muted ring-1 ring-border"
                aria-hidden="true"
              >
                {email.slice(0, 1)}
              </span>
              <span className="truncate text-[13px] font-medium text-muted">{email}</span>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* ── Mobile top bar (§20.10 — never broken on small screens) ──── */}
          <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur-md md:hidden">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              aria-expanded={mobileOpen}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <BrandLogo className="h-7 w-7" />
            <h1 className="min-w-0 flex-1 truncate text-caption font-semibold text-fg">{title}</h1>
            {commands && commands.length > 0 && (
              <button
                type="button"
                onClick={openPalette}
                aria-label="Open command palette"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
              >
                <Search className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
          </header>

          {/* ── Desktop header: 56px, glass over the void (pillar 4/14) ──── */}
          <header className="sticky top-0 z-40 hidden h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-bg/80 px-8 backdrop-blur-md md:flex">
            <p className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-fg">
              {title}
            </p>
            {commands && commands.length > 0 && (
              <button
                type="button"
                onClick={openPalette}
                aria-label="Open search"
                title="Search"
                className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-border bg-surface/60 px-2.5 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
              >
                <Search className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Search</span>
              </button>
            )}
          </header>

          {/* ── Main content: centered 1200px, massive breathing room ────── */}
          <main id="main-content" className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-[1200px] p-4 md:p-8">
              {children ?? <Outlet />}
            </div>
          </main>
        </div>
      </div>

      {/* ── Mobile slide-over menu ─────────────────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-overlay md:hidden">
          <div
            className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={menuPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            className="animate-fade-in absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface p-4 shadow-raised"
          >
            <div className="flex items-center justify-between pb-4">
              <div className="flex items-center gap-2.5">
                <BrandLogo className="h-8 w-8" />
                <div>
                  <p className="text-caption font-semibold leading-tight text-fg">Studio Pulse</p>
                  <p className="text-label normal-case text-muted">{title}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 overflow-y-auto">
              {renderNavItems(false, () => setMobileOpen(false))}
            </nav>
            <div className="mt-4 flex flex-col gap-1 border-t border-border pt-3">
              <ThemeToggle />
              <button type="button" onClick={() => void signOut()} className={TOUCH_ROW}>
                <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
                Sign out
              </button>
              {profile?.email && (
                <p className="truncate px-3 pt-1 text-label normal-case text-muted">
                  {profile.email}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {commands && <CommandPalette commands={commands} />}
    </ToastProvider>
  )
}

export default AppShell
