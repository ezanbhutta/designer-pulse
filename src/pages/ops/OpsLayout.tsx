import { useMemo } from 'react'
import { Outlet, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Bell,
  CalendarDays,
  FileText,
  Home,
  Kanban,
  UserCheck,
  Users,
} from 'lucide-react'
import { AppShell, type NavItem } from '../../components/layout/AppShell'
import type { Command } from '../../components/ui/CommandPalette'
import { Drawer } from '../../components/ui/Drawer'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { DesignerDetail } from '../../components/shared/DesignerDetail'
import { clickupListUrl } from '../../lib/queries'
import { useActiveDesigners, useOpenAlerts } from './opsData'

/**
 * The Ops cockpit shell (spec §22.3): persistent nav with the attention surface
 * as home, a global ⌘K palette (navigate + jump-to-designer, §20.6), and the
 * layout-level designer drawer driven by the `d` search param so any page can
 * drill into a designer without losing its place.
 */
export default function OpsLayout() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const alertsQ = useOpenAlerts()

  const openAlertCount = (alertsQ.data ?? []).filter((a) => a.status === 'open').length
  const active = useActiveDesigners()

  const designerId = searchParams.get('d')

  const closeDesigner = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('d')
    // Replace, don't push: closing must not add a history entry, or Back
    // re-opens the drawer just dismissed. Opening keeps push semantics so
    // Back still closes an open drawer.
    setSearchParams(next, { replace: true })
  }

  const nav: NavItem[] = [
    { to: '/ops', label: 'Home', icon: Home },
    { to: '/ops/board', label: 'Board', icon: Kanban },
    { to: '/ops/roster', label: 'Roster', icon: Users },
    { to: '/ops/attendance', label: 'Attendance', icon: UserCheck },
    { to: '/ops/leave', label: 'Leave', icon: CalendarDays },
    { to: '/ops/alerts', label: 'Alerts', icon: Bell, badge: openAlertCount || undefined },
    { to: '/ops/reports', label: 'Reports', icon: FileText },
  ]

  const commands: Command[] = useMemo(() => {
    const go = (path: string) => () => navigate(path)
    const pages: Command[] = [
      { id: 'nav-home', label: 'Go to Home', hint: 'what needs you right now', keywords: 'home attention verdict today', run: go('/ops') },
      { id: 'nav-board', label: 'Go to Board', hint: 'every open project and its stage', keywords: 'board kanban tasks status live', run: go('/ops/board') },
      { id: 'nav-roster', label: 'Go to Roster', hint: 'people, daily targets, work hours', keywords: 'roster designers schedule quota shift', run: go('/ops/roster') },
      { id: 'nav-attendance', label: 'Go to Attendance', hint: 'who is in and when they started', keywords: 'attendance presence check-in warmup', run: go('/ops/attendance') },
      { id: 'nav-leave', label: 'Go to Leave', hint: 'time off, half-days, holidays', keywords: 'leave holiday half-day calendar', run: go('/ops/leave') },
      { id: 'nav-alerts', label: 'Go to Alerts', hint: openAlertCount ? `${openAlertCount} waiting` : 'nothing waiting', keywords: 'alerts inbox acknowledge resolve', run: go('/ops/alerts') },
      { id: 'nav-reports', label: 'Go to Reports', hint: 'how each person did, with a PDF', keywords: 'reports weekly pdf export attainment', run: go('/ops/reports') },
    ]
    // Frequent actions, one keystroke away (§20.6 / §21.6).
    const actions: Command[] = [
      {
        id: 'action-log-leave',
        label: 'Add leave',
        hint: 'record time off for someone',
        keywords: 'leave log record add time off holiday absence',
        run: go('/ops/leave?new=leave'),
      },
    ]
    const jumps: Command[] = active.map((d) => ({
      id: `designer-${d.id}`,
      label: `Jump to ${d.name}`,
      hint: d.team,
      keywords: `designer ${d.name} ${d.team} ${d.specialty ?? ''}`,
      run: () => {
        const next = new URLSearchParams(window.location.search)
        next.set('d', d.id)
        setSearchParams(next)
      },
    }))
    // The §21.6 'assign' verb, worded per §22.1: the tool never assigns —
    // it opens the designer's list in ClickUp for the PM/CSR to act.
    const lists: Command[] = active.flatMap((d) => {
      const url = clickupListUrl(d.clickup_list_id)
      if (!url) return []
      return [
        {
          id: `list-${d.id}`,
          label: `Open ${d.name}'s list in ClickUp`,
          hint: `${d.team} · new tab`,
          keywords: `clickup list open ${d.name} ${d.team} ${d.specialty ?? ''}`,
          run: () => {
            window.open(url, '_blank', 'noopener,noreferrer')
          },
        },
      ]
    })
    return [...pages, ...actions, ...jumps, ...lists]
  }, [active, navigate, openAlertCount, setSearchParams])

  return (
    <ToastProvider>
      <AppShell title="Studio Pulse — Ops" nav={nav} commands={commands}>
        <Outlet />
      </AppShell>
      {/* Generic chrome title — DesignerDetail's own header carries the
          name + team once, so the drawer never says it twice. */}
      <Drawer open={designerId != null} onClose={closeDesigner} title="Designer details" wide>
        {designerId && <DesignerDetail designerId={designerId} scope="ops" />}
      </Drawer>
    </ToastProvider>
  )
}
