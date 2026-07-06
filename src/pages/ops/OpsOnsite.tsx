import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Headset, RefreshCw } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { InfoTip } from '../../components/ui/InfoTip'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { fetchOnsiteLoad, type OnsiteMember } from '../../lib/queries'
import { fmtClock } from '../../lib/format'

/** ClickUp team keys → the plain words shown everywhere else in the app. */
const TEAM_LABEL: Record<string, string> = {
  Logo: 'Logo',
  Branding: 'Branding',
  Animation: 'Animation',
  PPT: 'Slides',
  Canva: 'Canva',
}
const TEAM_ORDER = ['Logo', 'Branding', 'Animation', 'PPT', 'Canva']

function teamChips(byTeam: Record<string, number>): Array<{ label: string; n: number }> {
  return TEAM_ORDER.filter((t) => (byTeam[t] ?? 0) > 0).map((t) => ({
    label: TEAM_LABEL[t] ?? t,
    n: byTeam[t],
  }))
}

/**
 * The onsite team (spec §22.6): CSR 1 to 10 and the project managers, tracked in
 * their own section, kept apart from the remote designers so their numbers never
 * mix in. Each design project's CSR is the person who set it up in ClickUp, so
 * this shows how many live projects each of them is carrying right now, and how
 * those split across the design teams. It is read-only and never assigns work.
 */
export default function OpsOnsite() {
  const q = useQuery({
    queryKey: ['onsite-load'],
    queryFn: () => fetchOnsiteLoad(false),
    staleTime: 5 * 60_000,
  })

  const data = q.data
  const members = data?.members ?? []
  const maxActive = useMemo(() => Math.max(1, ...members.map((m) => m.active)), [members])
  const anyLoad = members.some((m) => m.active > 0)

  const refresh = () => {
    // Force a fresh ClickUp scan past the cache, then let the query pick it up.
    void fetchOnsiteLoad(true).then(() => q.refetch())
  }

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-10">
      <PageHeader
        breadcrumbs={['Ops', 'Onsite team']}
        title="Onsite team"
        titleAccessory={
          <InfoTip text="The people onsite who hand out the work: CSR 1 to 10 and the project managers. This counts how many live projects each of them set up in ClickUp, kept separate from the designers. It only observes, it never assigns." />
        }
        history={
          q.isLoading
            ? 'Reading the latest from ClickUp…'
            : data
              ? `${data.totalActive} live project${data.totalActive === 1 ? '' : 's'} across the onsite team, ${data.totalNewThisWeek} handed out this week.${
                  data.computedAt ? ` As of ${fmtClock(data.computedAt)} Pakistan time.` : ''
                }`
              : 'The onsite team and how much each person is carrying.'
        }
        actions={
          <button
            type="button"
            onClick={refresh}
            disabled={q.isFetching}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-label text-brand transition-colors duration-150 ease-out hover:bg-brand-soft disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
        }
      />

      {q.error && (
        <ErrorBanner
          message={q.error instanceof Error ? q.error.message : 'We could not load the onsite team just now.'}
          onRetry={() => void q.refetch()}
        />
      )}

      {q.isLoading ? (
        <div className="space-y-2" role="status" aria-label="Loading the onsite team">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="card flex items-center gap-4 p-5">
              <div className="skeleton h-10 w-10 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="skeleton h-4 w-1/4" />
                <div className="skeleton h-3.5 w-2/3" />
              </div>
              <div className="skeleton h-8 w-12" />
            </div>
          ))}
        </div>
      ) : !anyLoad ? (
        <EmptyState
          icon={Headset}
          title="Nothing on the onsite team's plate right now."
          hint="When a CSR or project manager sets up a project in ClickUp, it shows up here."
        />
      ) : (
        <div className="space-y-2">
          {members.map((m) => (
            <OnsiteRow key={m.name} member={m} maxActive={maxActive} />
          ))}
        </div>
      )}
    </div>
  )
}

function OnsiteRow({ member, maxActive }: { member: OnsiteMember; maxActive: number }) {
  const chips = teamChips(member.byTeam)
  const frac = Math.max(0, Math.min(1, member.active / maxActive))
  return (
    <article className="card flex items-center gap-4 p-5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
        <Headset className="h-4 w-4" aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-caption font-semibold text-fg">{member.name}</p>
        <div className="mt-1.5 flex items-center gap-3">
          <div className="h-1.5 w-40 max-w-[40vw] overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand" style={{ width: `${frac * 100}%` }} />
          </div>
          <p className="tnum text-label font-normal tracking-normal text-muted">
            {member.newThisWeek > 0
              ? `${member.newThisWeek} handed out this week`
              : 'none handed out this week'}
          </p>
        </div>
        {chips.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-label font-normal tracking-normal text-muted">
            {chips.map((c) => (
              <span key={c.label} className="tnum">
                {c.label} {c.n}
              </span>
            ))}
          </p>
        )}
      </div>

      <div className="shrink-0 text-right">
        <p className="tnum text-card text-fg">{member.active}</p>
        <p className="text-label uppercase tracking-wide text-muted">
          live project{member.active === 1 ? '' : 's'}
        </p>
      </div>
    </article>
  )
}
