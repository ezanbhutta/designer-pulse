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
import { activeDesigners, useDesigners, useOpenAlerts } from './opsData'

/**
 * The Ops cockpit shell (spec §22.3): persistent nav with the attention surface
 * as home, a global ⌘K palette (navigate + jump-to-designer, §20.6), and the
 * layout-level designer drawer driven by the `d` search param so any page can
 * drill into a designer without losing its place.
 */
export default function OpsLayout() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const designersQ = useDesigners()
  const alertsQ = useOpenAlerts()

  const openAlertCount = (alertsQ.data ?? []).filter((a) => a.status === 'open').length
  const active = activeDesigners(designersQ.data)

  const designerId = searchParams.get('d')
  const detailDesigner = designerId
    ? (designersQ.data ?? []).find((d) => d.id === designerId)
    : undefined

  const closeDesigner = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('d')
    setSearchParams(next)
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
      { id: 'nav-home', label: 'Go to Home', hint: 'needs attention now', keywords: 'home attention verdict today', run: go('/ops') },
      { id: 'nav-board', label: 'Go to Board', hint: 'live status board', keywords: 'board kanban tasks status live', run: go('/ops/board') },
      { id: 'nav-roster', label: 'Go to Roster', hint: 'designers, quotas, shifts', keywords: 'roster designers schedule quota shift', run: go('/ops/roster') },
      { id: 'nav-attendance', label: 'Go to Attendance', hint: 'presence + warm-up gaps', keywords: 'attendance presence check-in warmup', run: go('/ops/attendance') },
      { id: 'nav-leave', label: 'Go to Leave', hint: 'leave, half-days, holidays', keywords: 'leave holiday half-day calendar', run: go('/ops/leave') },
      { id: 'nav-alerts', label: 'Go to Alerts', hint: openAlertCount ? `${openAlertCount} open` : 'inbox zero', keywords: 'alerts inbox acknowledge resolve', run: go('/ops/alerts') },
      { id: 'nav-reports', label: 'Go to Reports', hint: 'per-designer summaries + PDF', keywords: 'reports weekly pdf export attainment', run: go('/ops/reports') },
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
    return [...pages, ...jumps]
  }, [active, navigate, openAlertCount, setSearchParams])

  return (
    <ToastProvider>
      <AppShell title="Studio Pulse — Ops" nav={nav} commands={commands}>
        <Outlet />
      </AppShell>
      <Drawer
        open={designerId != null}
        onClose={closeDesigner}
        title={detailDesigner?.name ?? 'Designer'}
        wide
      >
        {designerId && <DesignerDetail designerId={designerId} scope="ops" />}
      </Drawer>
    </ToastProvider>
  )
}
