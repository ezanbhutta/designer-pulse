import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, Headset, UserCheck, Users } from 'lucide-react'
import OpsRoster from './OpsRoster'
import OpsAttendance from './OpsAttendance'
import OpsLeave from './OpsLeave'
import OpsOnsite from './OpsOnsite'

type TeamView = 'people' | 'today' | 'time-off' | 'onsite'

const VIEWS: Array<{ value: TeamView; label: string; icon: typeof Users; hint: string }> = [
  { value: 'people', label: 'People', icon: Users, hint: 'who is on the team, their targets and hours' },
  { value: 'today', label: 'Today', icon: UserCheck, hint: 'who is here, who started late, whose day needs confirming' },
  { value: 'time-off', label: 'Time off', icon: CalendarDays, hint: 'leave, half days and holidays' },
  { value: 'onsite', label: 'Onsite team', icon: Headset, hint: 'the CSR and project manager load' },
]

/**
 * The Team workspace.
 *
 * Roster, Attendance, Leave and Onsite were four separate destinations that a
 * manager had to visit in turn to answer one question about one person: are
 * they here, do they have room, how are they doing, is anything owed to them.
 * They are one place now, with the four readings as views rather than as pages,
 * so moving between them keeps the person and the day in view.
 *
 * The view lives in the URL (?view=), which keeps every existing deep link
 * working through a redirect and lets someone bookmark a particular reading.
 * Each view is the original page, unchanged, so nothing that worked before
 * behaves differently here.
 */
export default function OpsTeam() {
  const [searchParams, setSearchParams] = useSearchParams()
  const raw = searchParams.get('view')
  const view: TeamView = useMemo(() => {
    const v = VIEWS.find((x) => x.value === raw)
    return v ? v.value : 'people'
  }, [raw])

  const select = (next: TeamView) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'people') params.delete('view')
    else params.set('view', next)
    // Replace rather than push: flipping between readings of the same team is
    // not a journey, and Back should leave Team rather than walk the tabs.
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="space-y-8">
      <nav aria-label="Team views" className="flex flex-wrap gap-1.5">
        {VIEWS.map((v) => {
          const Icon = v.icon
          const active = v.value === view
          return (
            <button
              key={v.value}
              type="button"
              onClick={() => select(v.value)}
              aria-current={active ? 'page' : undefined}
              title={v.hint}
              className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3.5 text-caption font-medium transition-colors duration-150 ease-out motion-safe:active:scale-[0.98] ${
                active
                  ? 'border-brand bg-brand-soft text-brand'
                  : 'border-border bg-surface text-muted hover:text-fg'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {v.label}
            </button>
          )
        })}
      </nav>

      {view === 'people' && <OpsRoster />}
      {view === 'today' && <OpsAttendance />}
      {view === 'time-off' && <OpsLeave />}
      {view === 'onsite' && <OpsOnsite />}
    </div>
  )
}
