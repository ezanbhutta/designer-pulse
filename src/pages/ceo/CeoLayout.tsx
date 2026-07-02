/**
 * CEO decision cockpit frame (spec §13.2, §22.3): Overview (verdict) · Teams ·
 * Trends · Reports · Cancellations. Read-only on operations — a decision
 * cockpit, not a control panel (§22.1). Desktop-primary, dark-first (§21.9).
 * AppShell provides the ToastProvider, left rail, theme toggle and renders
 * the <Outlet/>; the ⌘K palette here carries page navigation (§20.6).
 */

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, Gauge, OctagonX, TrendingUp, Users } from 'lucide-react'
import { AppShell, type NavItem } from '../../components/layout/AppShell'
import type { Command } from '../../components/ui/CommandPalette'

const NAV: NavItem[] = [
  { to: '/ceo', label: 'Overview', icon: Gauge },
  { to: '/ceo/teams', label: 'Teams', icon: Users },
  { to: '/ceo/trends', label: 'Trends', icon: TrendingUp },
  { to: '/ceo/reports', label: 'Reports', icon: FileText },
  { to: '/ceo/cancellations', label: 'Cancellations', icon: OctagonX },
]

export default function CeoLayout() {
  const navigate = useNavigate()

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'ceo-nav-overview',
        label: 'Go to Overview',
        hint: 'This week’s verdicts',
        keywords: 'home verdict calls week dashboard',
        run: () => navigate('/ceo'),
      },
      {
        id: 'ceo-nav-teams',
        label: 'Go to Teams',
        hint: 'Per-team health',
        keywords: 'logo branding animation ppt canva throughput utilization designers',
        run: () => navigate('/ceo/teams'),
      },
      {
        id: 'ceo-nav-trends',
        label: 'Go to Trends',
        hint: 'Quality · speed · burnout · forecast',
        keywords: 'quality speed burnout risk forecast backlog trend',
        run: () => navigate('/ceo/trends'),
      },
      {
        id: 'ceo-nav-reports',
        label: 'Go to Reports',
        hint: 'Weekly per-designer PDF',
        keywords: 'weekly report pdf download monday review',
        run: () => navigate('/ceo/reports'),
      },
      {
        id: 'ceo-nav-cancellations',
        label: 'Go to Cancellations',
        hint: '10-second fault review',
        keywords: 'cancelled fault review trail history',
        run: () => navigate('/ceo/cancellations'),
      },
    ],
    [navigate],
  )

  return <AppShell title="Studio Pulse — CEO" nav={NAV} commands={commands} />
}
