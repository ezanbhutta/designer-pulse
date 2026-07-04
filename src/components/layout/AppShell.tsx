import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { LogOut, Menu, Moon, Search, Sun, X } from 'lucide-react'
import { BrandLogo } from '../ui/BrandLogo'
import { useAuth } from '../../hooks/useAuth'
import { CommandPalette, OPEN_PALETTE_EVENT, type Command } from '../ui/CommandPalette'
import { ToastProvider } from '../ui/ToastProvider'

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

/**
 * Theme toggle (spec §21.9 — dark-first cockpit, light designer view):
 * persists to localStorage('theme') and flips the `dark` class on <html>.
 * A MutationObserver keeps the icon honest if the route-level default
 * (App.useSurfaceTheme) changes the class underneath us.
 */
function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'))
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
      className="flex min-h-[2.75rem] w-full items-center justify-center gap-3 rounded-xl px-3 text-sm font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg lg:justify-start"
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className={showLabel ? '' : 'hidden lg:inline'}>
        {dark ? 'Light theme' : 'Dark theme'}
      </span>
    </button>
  )
}

function NavBadge({ count, expanded }: { count: number; expanded: boolean }) {
  if (count <= 0) return null
  return (
    <>
      {/* Full count when labels are visible; a danger dot on the icon-only rail */}
      <span
        className={`tnum ml-auto h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-semibold text-bg ${expanded ? 'inline-flex' : 'hidden lg:inline-flex'}`}
        aria-hidden="true"
      >
        {count > 99 ? '99+' : count}
      </span>
      <span
        className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger ${expanded ? 'hidden' : 'lg:hidden'}`}
        aria-hidden="true"
      />
    </>
  )
}

function navLinkLabel(item: NavItem): string {
  return item.badge && item.badge > 0
    ? `${item.label}, ${item.badge} needing attention`
    : item.label
}

/**
 * App frame (spec §22.3): persistent left rail on desktop (icon + label,
 * icons only at md), top bar + slide-over menu on mobile. Brand violet marks
 * ONLY the active nav item (§21.1). Includes theme toggle, sign-out,
 * skip-to-content link, and the ⌘K command palette when commands are
 * provided. Children render in place of <Outlet/> when given.
 */
export function AppShell({ title, nav, commands, children }: AppShellProps) {
  const { profile, signOut } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)

  // Close the mobile menu on Escape.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `group relative flex min-h-[2.75rem] items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors duration-150 ${
      isActive
        ? 'bg-brand-soft text-brand'
        : 'text-muted hover:bg-surface-2 hover:text-fg'
    }`

  const renderNavItems = (expanded: boolean, onNavigate?: () => void) =>
    nav.map((item) => {
      const Icon = item.icon
      return (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/ops' || item.to === '/ceo' || item.to === '/me'}
          className={navLinkClass}
          aria-label={navLinkLabel(item)}
          title={item.label}
          onClick={onNavigate}
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span
                  className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand"
                  aria-hidden="true"
                />
              )}
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className={expanded ? '' : 'hidden lg:inline'}>{item.label}</span>
              <NavBadge count={item.badge ?? 0} expanded={expanded} />
            </>
          )}
        </NavLink>
      )
    })

  return (
    <ToastProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[70] focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-fg focus:shadow-raised"
      >
        Skip to content
      </a>

      <div className="flex min-h-screen bg-bg">
        {/* ── Left rail: icons at md, icon + label at lg (§22.3) ─────────── */}
        <aside className="sticky top-0 hidden h-screen w-[4.5rem] shrink-0 flex-col border-r border-border bg-surface px-3 py-4 md:flex lg:w-60">
          <div className="flex items-center gap-2.5 px-2 pb-5">
            <BrandLogo className="h-9 w-9" />
            <div className="hidden min-w-0 lg:block">
              <p className="truncate text-sm font-semibold leading-tight text-fg">Studio Pulse</p>
              <p className="truncate text-xs text-muted">{title}</p>
            </div>
          </div>

          <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 overflow-y-auto">
            {renderNavItems(false)}
          </nav>

          <div className="mt-4 flex flex-col gap-1 border-t border-border pt-3">
            {commands && commands.length > 0 && (
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))}
                aria-label="Open command palette"
                title="Command palette (Ctrl+K)"
                className="flex min-h-[2.75rem] items-center justify-center gap-3 rounded-xl px-3 text-sm font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg lg:justify-start"
              >
                <Search className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="hidden flex-1 text-left lg:inline">Search</span>
                <kbd className="hidden rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted lg:inline">
                  ⌘K
                </kbd>
              </button>
            )}
            <ThemeToggle />
            <button
              type="button"
              onClick={() => void signOut()}
              aria-label="Sign out"
              title="Sign out"
              className="flex min-h-[2.75rem] items-center justify-center gap-3 rounded-xl px-3 text-sm font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg lg:justify-start"
            >
              <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="hidden lg:inline">Sign out</span>
            </button>
            {profile?.email && (
              <p className="hidden truncate px-3 pt-1 text-xs text-muted lg:block" title={profile.email}>
                {profile.email}
              </p>
            )}
          </div>
        </aside>

        {/* ── Mobile top bar (§20.10 — never broken on small screens) ────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur md:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              aria-expanded={mobileOpen}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <BrandLogo className="h-8 w-8" />
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-fg">{title}</h1>
          </header>

          <main id="main-content" className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-[1440px] p-4 md:p-6 lg:p-8">
              {children ?? <Outlet />}
            </div>
          </main>
        </div>
      </div>

      {/* ── Mobile slide-over menu ─────────────────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-bg/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="animate-fade-in absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface p-4 shadow-raised"
          >
            <div className="flex items-center justify-between pb-4">
              <div className="flex items-center gap-2.5">
                <BrandLogo className="h-9 w-9" />
                <div>
                  <p className="text-sm font-semibold leading-tight text-fg">Studio Pulse</p>
                  <p className="text-xs text-muted">{title}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 overflow-y-auto">
              {renderNavItems(true, () => setMobileOpen(false))}
            </nav>
            <div className="mt-4 flex flex-col gap-1 border-t border-border pt-3">
              <ThemeToggle showLabel />
              <button
                type="button"
                onClick={() => void signOut()}
                className="flex min-h-[2.75rem] items-center gap-3 rounded-xl px-3 text-sm font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
              >
                <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
                Sign out
              </button>
              {profile?.email && (
                <p className="truncate px-3 pt-1 text-xs text-muted">{profile.email}</p>
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
