import { useMemo } from 'react'
import { Outlet, useNavigate, useSearchParams } from 'react-router-dom'
import { FileText, Home, Kanban, Users } from 'lucide-react'
import { AppShell, type NavItem } from '../../components/layout/AppShell'
import type { Command } from '../../components/ui/CommandPalette'
import { Drawer } from '../../components/ui/Drawer'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { DesignerDetail } from '../../components/shared/DesignerDetail'
import { DesktopAlertsProvider } from '../../components/shared/DesktopAlerts'
import { SyncStatus } from '../../components/shared/SyncStatus'
import { useKeepFresh } from '../../hooks/useKeepFresh'
import { clickupListUrl } from '../../lib/queries'
import {
  useActiveDesigners,
  useConfigValues,
  useDesigners,
  useOpenAlerts,
  useOpenTasks,
  useQuotaCtx,
} from './opsData'
import { bucketWork, focusCounts } from './workBuckets'
import { pktToday } from '../../../shared/pkt'

/**
 * The Ops cockpit shell (spec §22.3): persistent nav with the attention surface
 * as home, a global the search palette palette (navigate + jump-to-designer, §20.6), and the
 * layout-level designer drawer driven by the `d` search param so any page can
 * drill into a designer without losing its place.
 */
export default function OpsLayout() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const alertsQ = useOpenAlerts()
  // Keep the board in step with ClickUp while the cockpit is open (spec §5.2).
  const fresh = useKeepFresh()

  const openAlertCount = (alertsQ.data ?? []).filter((a) => a.status === 'open').length
  const active = useActiveDesigners()

  // Live counts for the focused views, so the navigation itself says where the
  // work is rather than making someone open a page to find out. Computed over
  // the whole board, exactly like every other count in the app.
  const cfg = useConfigValues()
  const designersQ = useDesigners()
  const openTasksQ = useOpenTasks()
  const { ctx } = useQuotaCtx()
  const counts = useMemo(() => {
    const designerById = new Map((designersQ.data ?? []).map((d) => [d.id, d]))
    const now = new Date()
    const b = bucketWork({
      openTasks: openTasksQ.data ?? [],
      designerById,
      cfg,
      today: pktToday(now),
      now,
    })
    return { ...focusCounts(b.all), needsAction: b.counts['needs-action'], atRisk: b.counts['at-risk'] }
    // ctx is unused by bucketWork but keeps this in step with the quota loads.
  }, [openTasksQ.data, designersQ.data, cfg, ctx])

  const designerId = searchParams.get('d')

  const closeDesigner = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('d')
    // Replace, don't push: closing must not add a history entry, or Back
    // re-opens the drawer just dismissed. Opening keeps push semantics so
    // Back still closes an open drawer.
    setSearchParams(next, { replace: true })
  }

  // Four destinations, not eight. Everything that used to be its own tab is a
  // view inside one of these, so the nav stops being a filing cabinet and
  // starts naming the four things a manager actually does here.
  const nav: NavItem[] = [
    { to: '/ops', label: 'Command Center', icon: Home },
    {
      to: '/ops/work',
      label: 'Work',
      icon: Kanban,
      badge: openAlertCount || undefined,
      children: [
        { to: '/ops/work?focus=unassigned', label: 'Nobody is on it', count: counts.unassigned, tone: 'danger' },
        { to: '/ops/work?focus=ready-to-send', label: 'Ready to send', count: counts['ready-to-send'], tone: 'warning' },
        { to: '/ops/work?focus=stuck-designer', label: 'Stuck with the designer', count: counts['stuck-designer'], tone: 'warning' },
        { to: '/ops/work?focus=unknown-status', label: 'Unknown status', count: counts['unknown-status'], tone: 'danger' },
      ],
    },
    {
      to: '/ops/team',
      label: 'Team',
      icon: Users,
      children: [
        { to: '/ops/team?view=today', label: 'Who is here today' },
        { to: '/ops/team?view=time-off', label: 'Time off' },
        { to: '/ops/team?view=onsite', label: 'Onsite team' },
      ],
    },
    { to: '/ops/reports', label: 'Insights', icon: FileText },
  ]

  const commands: Command[] = useMemo(() => {
    const go = (path: string) => () => navigate(path)
    const pages: Command[] = [
      { id: 'nav-home', label: 'Go to Command Center', hint: 'what needs you right now', keywords: 'home command center attention today decisions', run: go('/ops') },
      { id: 'nav-work', label: 'Go to Work', hint: 'what is blocked, at risk, waiting or healthy', keywords: 'work board kanban projects tasks', run: go('/ops/work') },
      { id: 'nav-team', label: 'Go to Team', hint: 'people, availability, time off', keywords: 'team roster people designers', run: go('/ops/team') },
      { id: 'nav-insights', label: 'Go to Insights', hint: 'how each person did, with a PDF', keywords: 'insights reports weekly pdf export', run: go('/ops/reports') },
    ]
    // The palette answers management questions, not just "which page". Each of
    // these lands on the exact reading that answers the question asked.
    const questions: Command[] = [
      { id: 'q-blocked', label: 'Show blocked work', hint: 'projects our clock is running on', keywords: 'blocked stuck needs action not moving stalled overdue', run: go('/ops/work?focus=stuck-designer') },
      { id: 'q-at-risk', label: 'What is at risk today', hint: 'due today and not sent yet', keywords: 'at risk today due deadline miss late', run: go('/ops/work') },
      { id: 'q-unassigned', label: 'What has nobody on it', hint: 'no active designer, cannot move', keywords: 'unassigned nobody no designer orphan', run: go('/ops/work?focus=unassigned') },
      { id: 'q-ready', label: 'What is ready to send', hint: 'finished, waiting on us', keywords: 'ready send deliver waiting on us finished', run: go('/ops/work?focus=ready-to-send') },
      { id: 'q-waiting', label: 'What is waiting on clients', hint: 'their clock, not ours', keywords: 'waiting client response hear back', run: go('/ops/work') },
      { id: 'q-capacity', label: 'Who has capacity', hint: 'room for more work today', keywords: 'capacity room free spare who can take more slots open', run: go('/ops/team') },
      { id: 'q-here', label: 'Who is here today', hint: 'presence and late starts', keywords: 'here present attendance who is in late checked in', run: go('/ops/team?view=today') },
      { id: 'q-timeoff', label: 'Who is off', hint: 'leave, half days and holidays', keywords: 'off leave holiday absent time off away', run: go('/ops/team?view=time-off') },
      { id: 'q-alerts', label: 'Show every alert', hint: openAlertCount ? `${openAlertCount} waiting` : 'nothing waiting', keywords: 'alerts log everything full list acknowledge resolve', run: go('/ops/alerts') },
    ]
    // Frequent actions, one keystroke away (§20.6 / §21.6).
    const actions: Command[] = [
      {
        id: 'action-log-leave',
        label: 'Add leave',
        hint: 'record time off for someone',
        keywords: 'leave log record add time off holiday absence',
        run: go('/ops/team?view=time-off&new=leave'),
      },
    ]
    const jumps: Command[] = active.map((d) => ({
      id: `designer-${d.id}`,
      label: `Open ${d.name}'s workload`,
      hint: `${d.team}, their work, hours and trend`,
      keywords: `designer workload ${d.name} ${d.team} ${d.specialty ?? ''} capacity performance`,
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
          hint: `${d.team}, opens a new tab`,
          keywords: `clickup list open ${d.name} ${d.team} ${d.specialty ?? ''}`,
          run: () => {
            window.open(url, '_blank', 'noopener,noreferrer')
          },
        },
      ]
    })
    return [...pages, ...questions, ...actions, ...jumps, ...lists]
  }, [active, navigate, openAlertCount, setSearchParams])

  return (
    <ToastProvider>
      <DesktopAlertsProvider>
        <AppShell title="Studio Pulse Ops" nav={nav} commands={commands}>
          <div className="mb-6 flex justify-end">
            <SyncStatus syncing={fresh.syncing} lastSyncIso={fresh.lastSyncIso} onRefresh={fresh.syncNow} />
          </div>
          <Outlet />
        </AppShell>
      </DesktopAlertsProvider>
      {/* Generic chrome title — DesignerDetail's own header carries the
          name + team once, so the drawer never says it twice. */}
      <Drawer open={designerId != null} onClose={closeDesigner} title="Designer details" wide>
        {designerId && <DesignerDetail designerId={designerId} scope="ops" />}
      </Drawer>
    </ToastProvider>
  )
}
