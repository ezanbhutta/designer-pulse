import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle2, ChevronDown, ChevronRight, ExternalLink, TriangleAlert } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { PageHeader } from '../../components/layout/PageHeader'
import { Drawer } from '../../components/ui/Drawer'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InfoTip } from '../../components/ui/InfoTip'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { TaskCard } from '../../components/shared/TaskCard'
import { TaskTrail } from '../../components/shared/TaskTrail'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { clickupListUrl, clickupTaskUrl } from '../../lib/queries'
import { fmtClock, fmtDate, fmtDateTime, fmtDurationLong } from '../../lib/format'
import { pktToday } from '../../../shared/pkt'
import { ageMinutes, expectedQuotaOn, scheduleFor } from '../../../shared/aggregate'
import {
  STATUSES,
  STATUS_EXPLAINERS,
  STATUS_LABELS,
  STATUS_ORDER,
  TERMINAL_STATUSES,
  type CanonicalStatus,
} from '../../../shared/statuses'
import type { Designer, TaskState } from '../../../shared/types'
import {
  agingThresholdMin,
  closedOn,
  createdOn,
  firstName,
  minutesSinceShiftStart,
  slotsFilledToday,
  useActiveDesigners,
  useConfigValues,
  useDesignerDrawer,
  useDesigners,
  useOpenTasks,
  useQuotaCtx,
  useTasksSince,
} from './opsData'

type GroupBy = 'status' | 'designer'

const OPEN_STATUSES = STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s))
const COLUMN_CAP = 100

/**
 * The live status board (spec §13.1): every open task by status or by
 * designer, realtime-fresh, closed statuses collapsed by default (§22.11),
 * assignment gaps highlighted on designer groups.
 */
export default function OpsBoard() {
  // Minute tick so ages, gap checks and the PKT day never freeze on an
  // unattended board across midnight.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  const today = pktToday(now)
  const cfg = useConfigValues()
  const openDesigner = useDesignerDrawer()
  const designersQ = useDesigners()
  const { ctx } = useQuotaCtx()
  const openTasksQ = useOpenTasks()
  const todayTasksQ = useTasksSince(today)

  const [groupBy, setGroupBy] = useLocalStorage<GroupBy>('pulse.ops.board.group', 'status')
  // The disclosure remembers last use (§20.4), like the sibling group-by.
  const [showClosed, setShowClosed] = useLocalStorage<boolean>('pulse.ops.board.closed', false)
  const [trailTask, setTrailTask] = useState<TaskState | null>(null)

  // A true Kanban: the columns fill the viewport below the header and each
  // column scrolls its OWN cards — the page frame never scrolls. The board's
  // top edge varies (breadcrumb, wrapping health chips, error banner), so we
  // measure it and bound the height to whatever's left of the viewport.
  const boardRef = useRef<HTMLDivElement>(null)
  const [boardHeight, setBoardHeight] = useState<number>()
  useLayoutEffect(() => {
    const measure = () => {
      const el = boardRef.current
      if (!el) return
      const h = Math.max(320, window.innerHeight - el.getBoundingClientRect().top - 24)
      setBoardHeight((prev) => (prev === h ? prev : h))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [groupBy, showClosed, openTasksQ.error, openTasksQ.isLoading])

  // Drill-in intent (e.g. Home's "Fixes in progress" tile) can force a
  // grouping via ?group=; it overrides and updates the remembered choice.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const g = searchParams.get('group')
    if (g === 'status' || g === 'designer') {
      setGroupBy(g)
      const next = new URLSearchParams(searchParams)
      next.delete('group')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams, setGroupBy])

  const designers = useActiveDesigners()
  const designerById = useMemo(
    () => new Map((designersQ.data ?? []).map((d) => [d.id, d])),
    [designersQ.data],
  )
  const openTasks = openTasksQ.data ?? []

  const closedToday = useMemo(
    () =>
      (todayTasksQ.data ?? []).filter(
        (t) => closedOn(t, today, 'complete') || closedOn(t, today, 'cancelled'),
      ),
    [todayTasksQ.data, today],
  )

  const derived = useMemo(() => {
    const byStatus = new Map<CanonicalStatus, TaskState[]>()
    for (const s of STATUSES) byStatus.set(s, [])
    // Tasks with a null current_status (unmapped ClickUp status name) get
    // their own clearly-marked bucket — never silently invisible to Ops.
    const unmapped: TaskState[] = []
    for (const t of openTasks) {
      if (t.current_status) byStatus.get(t.current_status)?.push(t)
      else unmapped.push(t)
    }
    for (const t of closedToday) {
      if (t.current_status) byStatus.get(t.current_status)?.push(t)
    }
    for (const list of byStatus.values()) list.sort((a, b) => ageMinutes(b, now) - ageMinutes(a, now))
    unmapped.sort((a, b) => ageMinutes(b, now) - ageMinutes(a, now))

    const assignedToday = new Map<string, number>()
    for (const t of todayTasksQ.data ?? []) {
      if (t.designer_id && createdOn(t, today)) {
        assignedToday.set(t.designer_id, (assignedToday.get(t.designer_id) ?? 0) + 1)
      }
    }

    const gapRows = designers
      .map((d) => {
        const expected = expectedQuotaOn(d.id, today, ctx)
        const schedule = scheduleFor(ctx.schedules, d.id, today)
        const since = minutesSinceShiftStart(schedule, today, now)
        // Owner's rule: ONLY projects due today are today's plate — status
        // and creation date don't matter.
        const filled = slotsFilledToday(openTasks, todayTasksQ.data ?? [], d.id, today)
        return { d, expected, filled, gapLive: expected > 0 && filled < expected && since != null && since >= cfg.assignment_gap_check_offset_min }
      })

    const agingCount = openTasks.filter(
      (t) => ageMinutes(t, now) >= agingThresholdMin(t.current_status, cfg),
    ).length
    const clientWait = openTasks.filter((t) => t.current_status === 'client response').length

    return { byStatus, unmapped, assignedToday, gapRows, agingCount, clientWait }
  }, [openTasks, closedToday, todayTasksQ.data, designers, ctx, cfg, today, now])

  const underQuota = derived.gapRows.filter((r) => r.gapLive)

  const byDesigner = useMemo(() => {
    const map = new Map<string, TaskState[]>()
    // Open tasks with no designer, or a designer who is archived/deleted,
    // must never go invisible in the by-person view (§6.4).
    const orphaned: TaskState[] = []
    for (const t of openTasks) {
      const d = t.designer_id ? designerById.get(t.designer_id) : undefined
      if (!d || d.status !== 'active') {
        orphaned.push(t)
        continue
      }
      const list = map.get(t.designer_id as string) ?? []
      list.push(t)
      map.set(t.designer_id as string, list)
    }
    const sortTasks = (list: TaskState[]) =>
      list.sort(
        (a, b) =>
          (a.current_status ? STATUS_ORDER[a.current_status] : 9) -
            (b.current_status ? STATUS_ORDER[b.current_status] : 9) ||
          ageMinutes(b, now) - ageMinutes(a, now),
      )
    for (const list of map.values()) sortTasks(list)
    sortTasks(orphaned)
    return { map, orphaned }
  }, [openTasks, designerById, now])

  const teams = useMemo(() => {
    const grouped = new Map<string, Designer[]>()
    for (const d of designers) {
      const list = grouped.get(d.team) ?? []
      list.push(d)
      grouped.set(d.team, list)
    }
    return grouped
  }, [designers])

  const healthy =
    derived.agingCount === 0 && underQuota.length === 0 && derived.unmapped.length === 0

  return (
    <div className="space-y-12">
      <PageHeader
        breadcrumbs={['Ops', 'Board']}
        title="Board"
        titleAccessory={
          <InfoTip text="Every open project, in columns. Each column is one stage of the work. The oldest problems rise to the top of each column." />
        }
        history={
          /* Verdict first (§20.1): the live health read, chips not prose. */
          openTasksQ.isLoading ? (
            `Live board for ${fmtDate(today)} Pakistan time, loading every open project…`
          ) : (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>Live board for {fmtDate(today)} Pakistan time:</span>
              {healthy ? (
                <Badge tone="success" icon={CheckCircle2}>
                  All good, nothing is stuck and everyone has enough work
                </Badge>
              ) : (
                <>
                  {derived.agingCount > 0 && (
                    <Badge tone="warning" icon={TriangleAlert}>
                      {derived.agingCount} stuck too long
                    </Badge>
                  )}
                  {derived.clientWait > 0 && (
                    <Badge tone="waiting">{derived.clientWait} waiting to hear back from clients</Badge>
                  )}
                  {underQuota.length > 0 && (
                    <Badge tone="warning" icon={TriangleAlert}>
                      {underQuota.length} {underQuota.length === 1 ? 'person needs' : 'people need'} more work
                    </Badge>
                  )}
                  {derived.unmapped.length > 0 && (
                    <Badge tone="warning" icon={TriangleAlert}>
                      {derived.unmapped.length} project{derived.unmapped.length === 1 ? '' : 's'} with an
                      unknown status
                    </Badge>
                  )}
                </>
              )}
            </span>
          )
        }
        actions={
          <>
            <span className="flex items-center gap-1">
              <SegmentedControl<GroupBy>
                options={[
                  { value: 'status', label: 'By stage' },
                  { value: 'designer', label: 'By person' },
                ]}
                value={groupBy}
                onChange={setGroupBy}
                ariaLabel="Group board by"
              />
              <InfoTip text="Choose how to group the board: by the stage each project is at, or by the person doing it." />
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowClosed(!showClosed)}
                aria-expanded={showClosed}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2 motion-safe:active:scale-[0.98]"
              >
                {showClosed ? (
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                )}
                Closed today ({closedToday.length})
              </button>
              <InfoTip text="Projects finished or cancelled today. Click to show or hide their columns." />
            </span>
          </>
        }
      />

      {openTasksQ.error && (
        <ErrorBanner
          message="We couldn't load the latest projects, so you're seeing the last saved view."
          asOf={
            openTasksQ.dataUpdatedAt > 0
              ? fmtClock(new Date(openTasksQ.dataUpdatedAt).toISOString())
              : null
          }
          onRetry={() => void openTasksQ.refetch()}
        />
      )}

      {openTasksQ.isLoading ? (
        // Skeleton mirrors the final board — same column width, header pill,
        // count, and card heights, so nothing shifts when data lands.
        <div className="flex gap-5 overflow-x-auto pb-2" role="status" aria-label="Loading board">
          {OPEN_STATUSES.map((s) => (
            <div key={s} className="w-72 shrink-0">
              <div className="flex items-center justify-between px-1">
                <div className="skeleton h-5 w-32 rounded-full" />
                <div className="skeleton h-4 w-6" />
              </div>
              <div className="mt-3 space-y-2">
                <div className="skeleton h-24" />
                <div className="skeleton h-24" />
              </div>
            </div>
          ))}
        </div>
      ) : groupBy === 'status' ? (
        // ── Kanban by status: the columns row fills the viewport and scrolls
        // horizontally; each column scrolls its OWN cards vertically. ──
        <div
          ref={boardRef}
          style={boardHeight ? { height: boardHeight } : undefined}
          className="flex items-stretch gap-5 overflow-x-auto pb-2"
        >
          {[...OPEN_STATUSES, ...(showClosed ? TERMINAL_STATUSES : [])].map((status) => {
            const tasks = derived.byStatus.get(status) ?? []
            return (
              <section
                key={status}
                className="flex w-72 shrink-0 flex-col"
                aria-label={STATUS_LABELS[status]}
              >
                <div className="flex items-center justify-between gap-2 px-1 pb-3">
                  <span className="inline-flex items-center gap-1">
                    <StatusBadge status={status} />
                    <InfoTip text={STATUS_EXPLAINERS[status]} />
                  </span>
                  <span className="tnum text-caption text-muted">{tasks.length}</span>
                </div>
                {/* This is the part that scrolls — one column's cards. */}
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
                  {tasks.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-caption text-muted">
                      {status === 'revision'
                        ? 'No change requests, nice and clean'
                        : status === 'cancelled'
                          ? 'No cancellations today'
                          : 'Nothing here'}
                    </p>
                  ) : (
                    <>
                      {tasks.slice(0, COLUMN_CAP).map((t) => (
                        <TaskCard
                          key={t.task_id}
                          task={t}
                          showStatus={false}
                          designerName={
                            t.designer_id ? designerById.get(t.designer_id)?.name : undefined
                          }
                          onOpen={() => setTrailTask(t)}
                        />
                      ))}
                      {tasks.length > COLUMN_CAP && (
                        <p className="pb-1 text-center text-label font-normal tracking-normal text-muted">
                          +{tasks.length - COLUMN_CAP} more, switch to "By person" to see them
                        </p>
                      )}
                    </>
                  )}
                </div>
              </section>
            )
          })}
          {/* ── Unmapped-status bucket — never invisible to Ops ── */}
          {derived.unmapped.length > 0 && (
            <section className="flex w-72 shrink-0 flex-col" aria-label="Unknown status">
              <div className="flex items-center justify-between gap-2 px-1 pb-3">
                <Badge tone="warning" icon={TriangleAlert}>
                  Unknown status
                </Badge>
                <span className="tnum text-caption text-muted">{derived.unmapped.length}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
                <p className="rounded-xl bg-warning-soft px-3 py-2 text-caption leading-snug text-warning">
                  We don't recognize this status name. Please check the list's statuses in ClickUp.
                </p>
                {derived.unmapped.slice(0, COLUMN_CAP).map((t) => (
                  <TaskCard
                    key={t.task_id}
                    task={t}
                    designerName={
                      t.designer_id ? designerById.get(t.designer_id)?.name : undefined
                    }
                    onOpen={() => setTrailTask(t)}
                  />
                ))}
                {derived.unmapped.length > COLUMN_CAP && (
                  <p className="text-center text-label font-normal tracking-normal text-muted">
                    +{derived.unmapped.length - COLUMN_CAP} more with unknown statuses
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      ) : (
        // ── Grouped by designer (teams first — cross-team raw counts aren't comparable, §2) ──
        <div className="space-y-12">
          {[...teams.entries()].map(([team, members]) => (
            <section key={team} aria-label={`${team} team`}>
              <h2 className="eyebrow">{team}</h2>
              <div className="mt-4 space-y-6">
                {members.map((d) => {
                  const tasks = byDesigner.map.get(d.id) ?? []
                  const gap = derived.gapRows.find((r) => r.d.id === d.id)
                  const listUrl = clickupListUrl(d.clickup_list_id)
                  return (
                    <div key={d.id} className="card p-6">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => openDesigner(d.id)}
                          className="min-h-11 text-left text-caption font-semibold text-fg transition-colors duration-150 ease-out hover:text-brand"
                        >
                          {d.name}
                          <span className="ml-2 font-normal text-muted">
                            {tasks.length} open
                            {gap && gap.expected > 0 && (
                              <span className="tnum">
                                , and has {gap.filled} of {gap.expected} today
                              </span>
                            )}
                          </span>
                        </button>
                        {listUrl && (
                          <a
                            href={listUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-11 items-center gap-1 text-label text-brand hover:underline"
                          >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            Open list in ClickUp
                          </a>
                        )}
                      </div>
                      {gap?.gapLive && (
                        <div
                          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-caption text-warning"
                          role="status"
                        >
                          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>
                            {gap.expected - gap.filled} open slot
                            {gap.expected - gap.filled === 1 ? '' : 's'} today, so {firstName(d.name)}{' '}
                            can take on more. Handing out the work is the team lead's job, not theirs.
                          </span>
                        </div>
                      )}
                      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {tasks.length === 0 ? (
                          <p className="text-caption text-muted">
                            No projects right now, so they can take on new work.
                          </p>
                        ) : (
                          tasks.map((t) => (
                            <TaskCard key={t.task_id} task={t} onOpen={() => setTrailTask(t)} />
                          ))
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
          {/* ── Orphaned bucket: no designer, or a former designer — never invisible ── */}
          {byDesigner.orphaned.length > 0 && (
            <section aria-label="No designer or former designer">
              <h2 className="eyebrow">No designer / former designer</h2>
              <div className="card mt-4 p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning" icon={TriangleAlert}>
                    {byDesigner.orphaned.length} open project
                    {byDesigner.orphaned.length === 1 ? '' : 's'} without an active designer
                  </Badge>
                  <span className="text-caption text-muted">
                    These have no designer, or their designer has left the roster. You can hand them
                    to someone in ClickUp.
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {byDesigner.orphaned.slice(0, COLUMN_CAP).map((t) => (
                    <TaskCard
                      key={t.task_id}
                      task={t}
                      designerName={
                        t.designer_id ? designerById.get(t.designer_id)?.name : undefined
                      }
                      onOpen={() => setTrailTask(t)}
                    />
                  ))}
                </div>
                {byDesigner.orphaned.length > COLUMN_CAP && (
                  <p className="mt-3 text-label font-normal tracking-normal text-muted">
                    +{byDesigner.orphaned.length - COLUMN_CAP} more without an active designer
                  </p>
                )}
              </div>
            </section>
          )}
          {teams.size === 0 && (
            <EmptyState
              title="No designers yet"
              hint="Add people on the Roster page."
            />
          )}
        </div>
      )}

      {/* ── Task drill-down drawer ── */}
      <Drawer
        open={trailTask != null}
        onClose={() => setTrailTask(null)}
        title={trailTask?.name ?? 'Project'}
      >
        {trailTask && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              {trailTask.current_status && <StatusBadge status={trailTask.current_status} />}
              <span className="tnum text-caption text-muted">
                at this stage for {fmtDurationLong(ageMinutes(trailTask))}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-caption">
              <dt className="text-muted">Designer</dt>
              <dd className="text-fg">
                {trailTask.designer_id
                  ? designerById.get(trailTask.designer_id)?.name ?? '—'
                  : 'No one yet'}
              </dd>
              <dt className="text-muted">Given on</dt>
              <dd className="tnum text-fg">{fmtDateTime(trailTask.created_at)}</dd>
              <dt className="text-muted">Due</dt>
              <dd className="tnum text-fg">{fmtDateTime(trailTask.due_date)}</dd>
              {trailTask.priority && (
                <>
                  <dt className="text-muted">Priority</dt>
                  <dd className="capitalize text-fg">{trailTask.priority}</dd>
                </>
              )}
              {trailTask.concept_count != null && (
                <>
                  <dt className="text-muted">Size</dt>
                  <dd className="text-fg">{trailTask.concept_count} concepts</dd>
                </>
              )}
            </dl>
            <a
              href={clickupTaskUrl(trailTask.task_id) ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open in ClickUp
            </a>
            <div>
              <h3 className="eyebrow inline-flex items-center gap-1">
                History
                <InfoTip text="Every step this project took, when it happened, and how long each step lasted." />
              </h3>
              <div className="mt-3">
                <TaskTrail taskId={trailTask.task_id} />
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
