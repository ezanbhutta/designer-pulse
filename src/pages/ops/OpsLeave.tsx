import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  CalendarPlus,
  Coffee,
  Hourglass,
  PartyPopper,
  Plus,
  Trash2,
  Users,
} from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Drawer } from '../../components/ui/Drawer'
import { PageHeader } from '../../components/layout/PageHeader'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InfoTip } from '../../components/ui/InfoTip'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { useToast } from '../../components/ui/ToastProvider'
import {
  STALE_ANALYTICS,
  deleteHalfDay,
  deleteHoliday,
  deleteLeave,
  fetchHalfDays,
  qk,
  setHolidayWorker,
  upsertHalfDay,
  upsertHoliday,
  upsertLeave,
} from '../../lib/queries'
import { fmtClock, fmtDate, fmtShiftTime } from '../../lib/format'
import { addDays, pktToday } from '../../../shared/pkt'
import { leaveCovers } from '../../../shared/attendance'
import type { HalfDay, Holiday, Leave } from '../../../shared/types'
import { useActiveDesigners, useDesigners, useQuotaCtx } from './opsData'

const LEAVE_TYPES = ['annual', 'sick', 'casual', 'unpaid', 'other'] as const

// Same recipe as the roster editor's fields — and no `focus:outline-none`,
// which would beat the global :focus-visible brand ring (§20.10).
const inputCls =
  'mt-1.5 block w-full min-h-11 rounded-xl border border-border bg-surface px-3 text-caption text-fg placeholder:text-muted/70'

/**
 * Leave / half-day / holiday management (spec §10). Feeds attendance status
 * resolution and quota neutralization. Paid/unpaid is RECORDED ONLY — the
 * system never computes pay (§1.2). Deletes act immediately with a 5s Undo.
 */
export default function OpsLeave() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const today = pktToday()
  const horizon = addDays(today, 6)

  const designersQ = useDesigners()
  // Leaves / holidays / workers ride the same query keys the quota context uses.
  const { ctx, isLoading: ctxLoading } = useQuotaCtx()
  const halfDaysQ = useQuery({ queryKey: qk.halfDays, queryFn: fetchHalfDays, staleTime: STALE_ANALYTICS })

  const designers = useActiveDesigners()
  const designerName = useMemo(() => {
    const map = new Map((designersQ.data ?? []).map((d) => [d.id, d.name]))
    return (id: string) => map.get(id) ?? 'Unknown designer'
  }, [designersQ.data])

  const [drawer, setDrawer] = useState<'leave' | 'half' | 'holiday' | null>(null)

  // Command-palette deep link (§20.6): /ops/leave?new=leave opens the
  // add-leave drawer on mount, then clears the param so refresh/back is clean.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('new') === 'leave') {
      setDrawer('leave')
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['leaves'] })
    void queryClient.invalidateQueries({ queryKey: ['half-days'] })
    void queryClient.invalidateQueries({ queryKey: ['holidays'] })
    void queryClient.invalidateQueries({ queryKey: ['holiday-workers'] })
    void queryClient.invalidateQueries({ queryKey: ['attendance'] })
  }

  // ── Mutations (act now, Undo restores, §20.6) ──
  const leaveDelete = useMutation({
    mutationFn: (id: string) => deleteLeave(id),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast({ message: `We couldn't delete that. ${e.message}` }),
  })
  const halfDelete = useMutation({
    mutationFn: (id: string) => deleteHalfDay(id),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast({ message: `We couldn't delete that. ${e.message}` }),
  })
  const holidayDelete = useMutation({
    mutationFn: (id: string) => deleteHoliday(id),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast({ message: `We couldn't delete that. ${e.message}` }),
  })
  const volunteerMutation = useMutation({
    mutationFn: (vars: { the_date: string; designer_id: string; working: boolean }) =>
      setHolidayWorker(vars.the_date, vars.designer_id, vars.working),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast({ message: `We couldn't save that. ${e.message}` }),
  })

  const removeLeave = (row: Leave) => {
    leaveDelete.mutate(row.id, {
      onSuccess: () =>
        toast({
          message: `Leave for ${designerName(row.designer_id)} removed`,
          undo: async () => {
            await upsertLeave(row)
            invalidate()
          },
        }),
    })
  }

  // ── Approve / decline for designer-requested leave (§22.7) ──
  // A pending request neutralizes nothing (leaveCovers ignores it), so it
  // must be decided — approving flips it live, declining removes it (Undo
  // restores the pending request).
  const leaveApprove = useMutation({
    mutationFn: (row: Leave) => upsertLeave({ ...row, status: 'approved' }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast({ message: `We couldn't approve that. ${e.message}` }),
  })
  const approveLeave = (row: Leave) => {
    leaveApprove.mutate(row, {
      onSuccess: () =>
        toast({
          message: `${designerName(row.designer_id)}'s leave approved. Attendance and daily targets adjust on their own.`,
          undo: async () => {
            await upsertLeave({ ...row, status: 'pending' })
            invalidate()
          },
        }),
    })
  }
  const declineLeave = (row: Leave) => {
    leaveDelete.mutate(row.id, {
      onSuccess: () =>
        toast({
          message: `Leave request from ${designerName(row.designer_id)} declined`,
          undo: async () => {
            await upsertLeave(row)
            invalidate()
          },
        }),
    })
  }
  const removeHalf = (row: HalfDay) => {
    halfDelete.mutate(row.id, {
      onSuccess: () =>
        toast({
          message: `Half day for ${designerName(row.designer_id)} removed`,
          undo: async () => {
            await upsertHalfDay(row)
            invalidate()
          },
        }),
    })
  }
  const removeHoliday = (row: Holiday) => {
    holidayDelete.mutate(row.id, {
      onSuccess: () =>
        toast({
          message: `Holiday "${row.name ?? fmtDate(row.the_date)}" removed`,
          undo: async () => {
            await upsertHoliday({ the_date: row.the_date, name: row.name ?? undefined })
            invalidate()
          },
        }),
    })
  }

  // ── Verdict: who's off in the next 7 days (§20.1) ──
  const verdictItems = useMemo(() => {
    const items: VerdictItem[] = []
    // Requests waiting for a decision lead — a pending request changes
    // nothing until it is approved, so silence here strands the designer.
    for (const l of ctx.leaves.filter((x) => x.status === 'pending')) {
      const end = l.end_date ?? l.start_date
      items.push({
        id: `pending-${l.id}`,
        severity: 'warning',
        text: `${designerName(l.designer_id)} asked for ${
          l.leave_type ? `${l.leave_type} leave` : 'leave'
        } ${
          l.start_date === end ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} – ${fmtDate(end)}`
        }. Approve or decline when you get a chance.`,
        detail: `Until you decide, they still count as expected in on those days${
          l.reason ? ` · ${l.reason}` : ''
        }`,
        action: {
          label: 'Review',
          onClick: () =>
            document.getElementById(`leave-row-${l.id}`)?.scrollIntoView({
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'auto'
                : 'smooth',
              block: 'center',
            }),
        },
      })
    }
    for (const d of designers) {
      const covering = ctx.leaves.filter(
        (l) =>
          l.designer_id === d.id &&
          [0, 1, 2, 3, 4, 5, 6].some((i) => leaveCovers(l, addDays(today, i))),
      )
      for (const l of covering) {
        const end = l.end_date ?? l.start_date
        items.push({
          id: `leave-${l.id}`,
          severity: 'info',
          text: `${d.name} on ${l.leave_type ?? 'leave'} ${
            l.start_date === end ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} – ${fmtDate(end)}`
          }`,
          detail: `${l.paid ? 'Paid' : 'Unpaid'} (for records only). No projects are expected from them on those days${
            l.reason ? ` · ${l.reason}` : ''
          }`,
        })
      }
    }
    for (const h of ctx.holidays.filter((x) => x.the_date >= today && x.the_date <= horizon)) {
      const volunteers = ctx.holidayWorkers.filter((w) => w.the_date === h.the_date).length
      items.push({
        id: `holiday-${h.id}`,
        severity: 'info',
        text: `Holiday: ${h.name ?? 'unnamed'} on ${fmtDate(h.the_date)}`,
        detail:
          volunteers > 0
            ? `${volunteers} offered to work that day (they may earn a bonus)`
            : 'No one has offered to work, so everyone gets the day off',
      })
    }
    for (const hd of (halfDaysQ.data ?? []).filter((x) => x.the_date >= today && x.the_date <= horizon)) {
      items.push({
        id: `half-${hd.id}`,
        severity: 'info',
        text: `${designerName(hd.designer_id)} half day on ${fmtDate(hd.the_date)}${
          hd.from_time && hd.to_time
            ? ` (away ${fmtShiftTime(hd.from_time)}–${fmtShiftTime(hd.to_time)})`
            : ''
        }`,
        detail: 'They still count as present, and only the away hours come off their day.',
      })
    }
    return items
  }, [designers, ctx, halfDaysQ.data, today, horizon, designerName])

  const pendingCount = ctx.leaves.filter((l) => l.status === 'pending').length

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-12">
      <PageHeader
        breadcrumbs={['Ops', 'Leave']}
        title="Leave"
        titleAccessory={
          <InfoTip text="Record time off, half days and holidays here. Attendance and daily targets adjust on their own." />
        }
        history={
          ctxLoading
            ? 'For records only. This never changes anyone\u2019s pay. Loading the calendar…'
            : `For records only. This never changes anyone\u2019s pay. ${
                pendingCount > 0
                  ? `${pendingCount} request${pendingCount === 1 ? '' : 's'} waiting for a decision.`
                  : verdictItems.length > 0
                    ? `${verdictItems.length} thing${verdictItems.length === 1 ? '' : 's'} on the next 7 days.`
                    : 'No time off in the next 7 days.'
              }`
        }
        actions={
          <button
            type="button"
            onClick={() => setDrawer('leave')}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-caption font-semibold text-brand-fg transition-opacity duration-150 ease-out hover:opacity-90 motion-safe:active:scale-[0.98]"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add leave
          </button>
        }
      />

      {(designersQ.error || halfDaysQ.error) && (
        <ErrorBanner
          message="We couldn't load the latest calendar, so you're seeing the last saved view."
          asOf={(() => {
            const lastGood = Math.max(designersQ.dataUpdatedAt, halfDaysQ.dataUpdatedAt)
            return lastGood > 0 ? fmtClock(new Date(lastGood).toISOString()) : null
          })()}
          onRetry={() => {
            void designersQ.refetch()
            void halfDaysQ.refetch()
          }}
        />
      )}

      <VerdictBlock
        title="Off in the next 7 days"
        items={verdictItems}
        emptyMessage="No time off in the next 7 days, everyone is available."
        loading={ctxLoading || halfDaysQ.isLoading}
      />

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-3">
        {/* ── Leaves ── */}
        <section className="card p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex min-w-0 items-center gap-2 text-card text-fg">
              <Coffee className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
              <span className="truncate">Leave</span>
              <InfoTip text="Full days off. While someone is on leave, no projects are expected from them." />
            </h2>
            <button
              type="button"
              onClick={() => setDrawer('leave')}
              aria-label="Add leave"
              title="Add leave"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-fg transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-brand motion-safe:active:scale-[0.95]"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <ul className="mt-6 max-h-96 space-y-2 overflow-y-auto pr-1">
            {ctxLoading ? (
              [0, 1, 2].map((i) => <li key={i} className="skeleton h-14" />)
            ) : ctx.leaves.length === 0 ? (
              <li>
                <EmptyState
                  icon={Coffee}
                  title="No leave recorded"
                  hint="Add leave here, and attendance and daily targets adjust on their own."
                />
              </li>
            ) : (
              ctx.leaves.map((l) => {
                const end = l.end_date ?? l.start_date
                const pending = l.status === 'pending'
                return (
                  <li
                    key={l.id}
                    id={`leave-row-${l.id}`}
                    className="flex items-start justify-between gap-2 rounded-xl bg-surface-2/60 px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-caption font-medium text-fg">
                        {designerName(l.designer_id)}
                      </p>
                      <p className="tnum text-label font-normal tracking-normal text-muted">
                        {l.start_date === end
                          ? fmtDate(l.start_date)
                          : `${fmtDate(l.start_date)} – ${fmtDate(end)}`}
                        {l.reason && ` · ${l.reason}`}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge tone="neutral">
                          <span className="capitalize">{l.leave_type ?? 'Leave'}</span>
                        </Badge>
                        <Badge tone={l.paid ? 'success' : 'warning'}>
                          {l.paid ? 'Paid' : 'Unpaid'}, for records only
                        </Badge>
                        {pending && <Badge tone="warning">Awaiting approval</Badge>}
                        {l.status === 'rejected' && <Badge tone="neutral">Declined</Badge>}
                      </div>
                      {pending && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => approveLeave(l)}
                            disabled={leaveApprove.isPending || leaveDelete.isPending}
                            className="inline-flex min-h-11 items-center rounded-xl bg-fg px-3 text-label text-bg transition-opacity duration-150 ease-out hover:opacity-90 disabled:opacity-50 motion-safe:active:scale-[0.97]"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => declineLeave(l)}
                            disabled={leaveApprove.isPending || leaveDelete.isPending}
                            className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-3 text-label text-fg transition-colors duration-150 ease-out hover:bg-surface-2 disabled:opacity-50 motion-safe:active:scale-[0.97]"
                          >
                            Decline
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLeave(l)}
                      className="-m-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-danger-soft hover:text-danger motion-safe:active:scale-95"
                      aria-label={`Remove leave for ${designerName(l.designer_id)}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </section>

        {/* ── Half-days ── */}
        <section className="card p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex min-w-0 items-center gap-2 text-card text-fg">
              <Hourglass className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
              <span className="truncate">Half days</span>
              <InfoTip text="Someone away for part of the day. They still count as present, and only the away hours come off." />
            </h2>
            <button
              type="button"
              onClick={() => setDrawer('half')}
              aria-label="Add half day"
              title="Add half day"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-fg transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-brand motion-safe:active:scale-[0.95]"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <ul className="mt-6 max-h-96 space-y-2 overflow-y-auto pr-1">
            {halfDaysQ.isLoading ? (
              [0, 1].map((i) => <li key={i} className="skeleton h-14" />)
            ) : (halfDaysQ.data ?? []).length === 0 ? (
              <li>
                <EmptyState
                  icon={Hourglass}
                  title="No half days"
                  hint="A half day keeps the person present, and only the away hours come off."
                />
              </li>
            ) : (
              (halfDaysQ.data ?? []).map((hd) => (
                <li
                  key={hd.id}
                  className="flex items-start justify-between gap-2 rounded-xl bg-surface-2/60 px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-caption font-medium text-fg">
                      {designerName(hd.designer_id)}
                    </p>
                    <p className="tnum text-label font-normal tracking-normal text-muted">
                      {fmtDate(hd.the_date)}
                      {hd.from_time && hd.to_time &&
                        ` · away ${fmtShiftTime(hd.from_time)}–${fmtShiftTime(hd.to_time)}`}
                      {hd.reason && ` · ${hd.reason}`}
                    </p>
                    <div className="mt-1">
                      <Badge tone={hd.paid ? 'success' : 'warning'}>
                        {hd.paid ? 'Paid' : 'Unpaid'}, for records only
                      </Badge>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeHalf(hd)}
                    className="-m-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-danger-soft hover:text-danger motion-safe:active:scale-95"
                    aria-label={`Remove half day for ${designerName(hd.designer_id)}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>

        {/* ── Holidays + volunteers ── */}
        <section className="card p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex min-w-0 items-center gap-2 text-card text-fg">
              <PartyPopper className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
              <span className="truncate">Holidays</span>
              <InfoTip text="Days off for the whole company. People can offer to work on a holiday, so tick their name on its row." />
            </h2>
            <button
              type="button"
              onClick={() => setDrawer('holiday')}
              aria-label="Add holiday"
              title="Add holiday"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-fg transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-brand motion-safe:active:scale-[0.95]"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <ul className="mt-6 max-h-96 space-y-2 overflow-y-auto pr-1">
            {ctxLoading ? (
              [0, 1].map((i) => <li key={i} className="skeleton h-14" />)
            ) : ctx.holidays.length === 0 ? (
              <li>
                <EmptyState
                  icon={PartyPopper}
                  title="No holidays"
                  hint="Days off for the whole company, unless someone offers to work."
                />
              </li>
            ) : (
              [...ctx.holidays]
                .sort((a, b) => b.the_date.localeCompare(a.the_date))
                .map((h) => {
                  const volunteers = new Set(
                    ctx.holidayWorkers.filter((w) => w.the_date === h.the_date).map((w) => w.designer_id),
                  )
                  return (
                    <li key={h.id} className="rounded-xl bg-surface-2/60 px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-caption font-medium text-fg">
                            {h.name ?? 'Holiday'}
                          </p>
                          <p className="tnum text-label font-normal tracking-normal text-muted">{fmtDate(h.the_date)}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeHoliday(h)}
                          className="-m-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-danger-soft hover:text-danger motion-safe:active:scale-95"
                          aria-label={`Remove holiday ${h.name ?? fmtDate(h.the_date)}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                      <details className="mt-1">
                        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-label text-brand">
                          <Users className="h-3.5 w-3.5" aria-hidden="true" />
                          {volunteers.size} working this holiday (may earn a bonus)
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {designers.map((d) => (
                            <li key={d.id}>
                              <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-caption text-fg transition-colors duration-150 ease-out hover:bg-surface-2">
                                <input
                                  type="checkbox"
                                  checked={volunteers.has(d.id)}
                                  onChange={(e) =>
                                    volunteerMutation.mutate({
                                      the_date: h.the_date,
                                      designer_id: d.id,
                                      working: e.target.checked,
                                    })
                                  }
                                  className="h-4 w-4 accent-brand"
                                />
                                {d.name}
                                <span className="text-label font-normal tracking-normal text-muted">{d.team}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  )
                })
            )}
          </ul>
        </section>
      </div>

      {/* ── Add drawers ── */}
      <Drawer open={drawer === 'leave'} onClose={() => setDrawer(null)} title="Add leave">
        <LeaveForm
          onDone={() => {
            setDrawer(null)
            invalidate()
          }}
        />
      </Drawer>
      <Drawer open={drawer === 'half'} onClose={() => setDrawer(null)} title="Add half day">
        <HalfDayForm
          onDone={() => {
            setDrawer(null)
            invalidate()
          }}
        />
      </Drawer>
      <Drawer open={drawer === 'holiday'} onClose={() => setDrawer(null)} title="Add holiday">
        <HolidayForm
          onDone={() => {
            setDrawer(null)
            invalidate()
          }}
        />
      </Drawer>
    </div>
  )
}

// ── Forms ─────────────────────────────────────────────────────────────────────

function DesignerSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const designers = useActiveDesigners()
  return (
    <label className="block text-caption font-medium text-fg">
      Designer
      <select required value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        <option value="" disabled>
          Choose a designer…
        </option>
        {designers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} · {d.team}
          </option>
        ))}
      </select>
    </label>
  )
}

function PaidToggle({ paid, setPaid }: { paid: boolean; setPaid: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-caption text-fg">
      <input
        type="checkbox"
        checked={paid}
        onChange={(e) => setPaid(e.target.checked)}
        className="h-4 w-4 accent-brand"
      />
      Paid
      <span className="text-label font-normal tracking-normal text-muted">for records only, pay is never changed here</span>
    </label>
  )
}

function LeaveForm({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const today = pktToday()
  const [designerId, setDesignerId] = useState('')
  const [type, setType] = useState<(typeof LEAVE_TYPES)[number]>('annual')
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState('')
  const [paid, setPaid] = useState(true)
  const [reason, setReason] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      upsertLeave({
        designer_id: designerId,
        leave_type: type,
        start_date: start,
        end_date: end || null,
        paid,
        status: 'approved',
        reason: reason || null,
      }),
    onSuccess: () => {
      toast({ message: 'Leave saved. Attendance and daily targets adjust on their own.' })
      onDone()
    },
    onError: (e: Error) => toast({ message: `We couldn't save the leave. ${e.message}` }),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (designerId) mutation.mutate()
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DesignerSelect value={designerId} onChange={setDesignerId} />
      <label className="block text-caption font-medium text-fg">
        Type
        <select value={type} onChange={(e) => setType(e.target.value as (typeof LEAVE_TYPES)[number])} className={inputCls}>
          {LEAVE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-caption font-medium text-fg">
          Start
          <input type="date" required value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </label>
        <label className="block text-caption font-medium text-fg">
          End
          <input
            type="date"
            value={end}
            min={start}
            onChange={(e) => setEnd(e.target.value)}
            className={inputCls}
          />
          <span className="mt-1 block text-label font-normal tracking-normal text-muted">leave empty for one day</span>
        </label>
      </div>
      <PaidToggle paid={paid} setPaid={setPaid} />
      <label className="block text-caption font-medium text-fg">
        Reason
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="optional" className={inputCls} />
      </label>
      <button
        type="submit"
        disabled={mutation.isPending}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-caption font-semibold text-brand-fg transition-opacity duration-150 ease-out hover:opacity-90 disabled:opacity-50 motion-safe:active:scale-[0.98]"
      >
        <CalendarPlus className="h-4 w-4" aria-hidden="true" />
        Save leave
      </button>
    </form>
  )
}

function HalfDayForm({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const today = pktToday()
  const [designerId, setDesignerId] = useState('')
  const [date, setDate] = useState(today)
  const [from, setFrom] = useState('14:00')
  const [to, setTo] = useState('18:00')
  const [paid, setPaid] = useState(false)
  const [reason, setReason] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      upsertHalfDay({
        designer_id: designerId,
        the_date: date,
        from_time: from || null,
        to_time: to || null,
        paid,
        reason: reason || null,
      }),
    onSuccess: () => {
      toast({ message: 'Half day saved. They still count as present for the day.' })
      onDone()
    },
    onError: (e: Error) => toast({ message: `We couldn't save the half day. ${e.message}` }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (designerId) mutation.mutate()
      }}
      className="space-y-4"
    >
      <DesignerSelect value={designerId} onChange={setDesignerId} />
      <label className="block text-caption font-medium text-fg">
        Date
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-caption font-medium text-fg">
          Away from (Pakistan time)
          <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        </label>
        <label className="block text-caption font-medium text-fg">
          Away until (Pakistan time)
          <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        </label>
      </div>
      <PaidToggle paid={paid} setPaid={setPaid} />
      <label className="block text-caption font-medium text-fg">
        Reason
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="optional" className={inputCls} />
      </label>
      <button
        type="submit"
        disabled={mutation.isPending}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-caption font-semibold text-brand-fg transition-opacity duration-150 ease-out hover:opacity-90 disabled:opacity-50 motion-safe:active:scale-[0.98]"
      >
        <CalendarPlus className="h-4 w-4" aria-hidden="true" />
        Save half day
      </button>
    </form>
  )
}

function HolidayForm({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const today = pktToday()
  const [date, setDate] = useState(today)
  const [name, setName] = useState('')

  const mutation = useMutation({
    mutationFn: () => upsertHoliday({ the_date: date, name: name || undefined }),
    onSuccess: () => {
      toast({ message: `Holiday saved for ${fmtDate(date)}. Tick anyone who will work that day on its row.` })
      onDone()
    },
    onError: (e: Error) => toast({ message: `We couldn't add the holiday. ${e.message}` }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="space-y-4"
    >
      <label className="block text-caption font-medium text-fg">
        Date
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
      </label>
      <label className="block text-caption font-medium text-fg">
        Name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="for example, Eid al-Fitr" className={inputCls} />
      </label>
      <p className="flex max-w-prose items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-caption text-muted">
        <CalendarDays className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        This gives the whole company the day off, and no projects are expected. If someone offers
        to work, tick their name on the holiday's row. Their day counts as "worked on a holiday"
        and may earn a bonus (the app only records this).
      </p>
      <button
        type="submit"
        disabled={mutation.isPending}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-caption font-semibold text-brand-fg transition-opacity duration-150 ease-out hover:opacity-90 disabled:opacity-50 motion-safe:active:scale-[0.98]"
      >
        <CalendarPlus className="h-4 w-4" aria-hidden="true" />
        Add holiday
      </button>
    </form>
  )
}
