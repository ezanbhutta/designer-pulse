import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CalendarX,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Coffee,
  Hourglass,
  LogIn,
  LogOut,
  PartyPopper,
  TriangleAlert,
  UserCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { StatTile } from '../../components/ui/StatTile'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { useToast } from '../../components/ui/ToastProvider'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { insertShiftMark } from '../../lib/queries'
import { DOW_LABELS, fmtDate, fmtDuration, fmtShiftTime, fmtTime } from '../../lib/format'
import { addDays, dateRange, pktToday } from '../../../shared/pkt'
import { expectedQuotaOn, median, scheduleFor } from '../../../shared/aggregate'
import type { AttendanceDaily, AttendanceStatus, Designer } from '../../../shared/types'
import {
  activeDesigners,
  deleteManualShiftMark,
  metricDelta,
  useAttendanceRange,
  useDesigners,
  useDesignerDrawer,
  useQuotaCtx,
} from './opsData'

type View = 'day' | 'week'

const STATUS_META: Record<
  AttendanceStatus,
  { tone: 'neutral' | 'success' | 'warning' | 'danger'; icon: LucideIcon; letter: string; cell: string }
> = {
  Present: { tone: 'success', icon: CircleCheck, letter: 'P', cell: 'bg-success-soft text-success' },
  HolidayWorked: { tone: 'success', icon: PartyPopper, letter: 'HW', cell: 'bg-success-soft text-success' },
  Leave: { tone: 'neutral', icon: Coffee, letter: 'L', cell: 'bg-surface-2 text-muted' },
  Holiday: { tone: 'neutral', icon: PartyPopper, letter: 'H', cell: 'bg-surface-2 text-muted' },
  WeeklyOff: { tone: 'neutral', icon: CalendarX, letter: 'W', cell: 'bg-surface-2 text-muted' },
  Absent: { tone: 'danger', icon: TriangleAlert, letter: 'A', cell: 'bg-danger-soft text-danger' },
  Incomplete: { tone: 'warning', icon: Hourglass, letter: 'I', cell: 'bg-warning-soft text-warning' },
}

interface DayRow {
  designer: Designer
  row: AttendanceDaily | undefined
  expected: number
  shiftLabel: string | null
}

/**
 * Attendance cockpit (spec §9): dual-signal presence with the Warm-Up Gap as
 * the headline (§9.3) — not "did you clock in" but "how long after clocking in
 * did real work start". Needs-attention rows sort first; manual overrides are
 * one tap with Undo.
 */
export default function OpsAttendance() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const openDesigner = useDesignerDrawer()
  const today = pktToday()

  const [date, setDate] = useState(today)
  const [view, setView] = useLocalStorage<View>('pulse.ops.attendance.view', 'day')

  const weekStart = addDays(date, -6)
  const designersQ = useDesigners()
  const { ctx } = useQuotaCtx()
  const attendanceQ = useAttendanceRange(weekStart, date)

  const designers = activeDesigners(designersQ.data)
  const rowsByKey = useMemo(() => {
    const map = new Map<string, AttendanceDaily>()
    for (const r of attendanceQ.data ?? []) map.set(`${r.designer_id}|${r.work_date}`, r)
    return map
  }, [attendanceQ.data])

  const dayRows: DayRow[] = useMemo(() => {
    const score = (r: AttendanceDaily | undefined) => {
      if (!r || r.status == null) return 6
      if (r.needs_review) return 0
      switch (r.status) {
        case 'Incomplete':
          return 1
        case 'Absent':
          return 2
        case 'Present':
        case 'HolidayWorked':
          if ((r.warmup_gap_min ?? 0) > 60) return 3
          if (r.late_minutes > 0) return 4
          return 5
        default:
          return 7 // Leave / Holiday / WeeklyOff — legitimately off, never alarming (§21.2)
      }
    }
    return designers
      .map((d) => {
        const schedule = scheduleFor(ctx.schedules, d.id, date)
        return {
          designer: d,
          row: rowsByKey.get(`${d.id}|${date}`),
          expected: expectedQuotaOn(d.id, date, ctx),
          shiftLabel: schedule
            ? `${fmtShiftTime(schedule.shift_start)}–${fmtShiftTime(schedule.shift_end)}`
            : null,
        }
      })
      .sort((a, b) => score(a.row) - score(b.row))
  }, [designers, rowsByKey, ctx, date])

  // Grouped by team (§20.4) — dayRows is already worst-first globally, so each
  // team's list inherits worst-first order and the worst team leads.
  const dayGroups = useMemo(() => {
    const grouped = new Map<string, DayRow[]>()
    for (const r of dayRows) {
      grouped.set(r.designer.team, [...(grouped.get(r.designer.team) ?? []), r])
    }
    return [...grouped.entries()]
  }, [dayRows])

  // ── Tiles: today vs prior day ──
  const prevDate = addDays(date, -1)
  const warmups = (which: string) =>
    designers
      .map((d) => rowsByKey.get(`${d.id}|${which}`)?.warmup_gap_min)
      .filter((v): v is number => v != null)
  const warmupMedian = median(warmups(date))
  const warmupPrev = median(warmups(prevDate))

  const checkedIn = dayRows.filter((r) => r.row?.declared_in != null).length
  const scheduledCount = dayRows.filter((r) => r.expected > 0).length
  const needsReview = dayRows.filter((r) => r.row?.needs_review).length
  const lateCount = dayRows.filter((r) => (r.row?.late_minutes ?? 0) > 0).length

  // Prior-day values for the tile deltas — same week-range query, no extra fetch.
  const prevStats = useMemo(() => {
    let checked = 0
    let late = 0
    let review = 0
    for (const d of designers) {
      const r = rowsByKey.get(`${d.id}|${prevDate}`)
      if (r?.declared_in != null) checked++
      if ((r?.late_minutes ?? 0) > 0) late++
      if (r?.needs_review) review++
    }
    return { checked, late, review }
  }, [designers, rowsByKey, prevDate])

  // Week grid grouping (§20.4): by team, worst week first within each team.
  const weekGroups = useMemo(() => {
    const days = dateRange(weekStart, date)
    const badness = (id: string) => {
      let score = 0
      for (const wd of days) {
        const r = rowsByKey.get(`${id}|${wd}`)
        if (!r) continue
        if (r.needs_review) score += 3
        if (r.status === 'Absent') score += 2
        if (r.status === 'Incomplete') score += 2
        if (r.late_minutes > 0) score += 1
        if ((r.warmup_gap_min ?? 0) > 60) score += 1
      }
      return score
    }
    const grouped = new Map<string, Designer[]>()
    for (const d of designers) {
      grouped.set(d.team, [...(grouped.get(d.team) ?? []), d])
    }
    return [...grouped.entries()].map(([team, members]) => ({
      team,
      members: [...members].sort((a, b) => badness(b.id) - badness(a.id)),
    }))
  }, [designers, rowsByKey, weekStart, date])

  // ── Verdict (§20.1 / §20.3) ──
  const verdictItems = useMemo(() => {
    const items: VerdictItem[] = []
    for (const { designer, row } of dayRows) {
      if (!row) continue
      if (row.needs_review) {
        items.push({
          id: `review-${row.id}`,
          severity: 'warning',
          text: `Verify ${designer.name} — auto-closed at shift end with no ClickUp activity`,
          detail: 'A check-in with nothing corroborating work (§9.2). Confirm before the day counts.',
          action: { label: 'Open details', onClick: () => openDesigner(designer.id) },
        })
      } else if (row.status === 'Incomplete') {
        items.push({
          id: `incomplete-${row.id}`,
          severity: 'warning',
          text: `${designer.name}'s day is incomplete — checked in, never out, no activity`,
          action: { label: 'Open details', onClick: () => openDesigner(designer.id) },
        })
      } else if (row.status === 'Absent') {
        items.push({
          id: `absent-${row.id}`,
          severity: 'warning',
          text: `${designer.name} absent — no marks and no ClickUp activity in the shift window`,
          detail: 'Holiday, leave and weekly off were checked first — this is unexplained.',
          action: { label: 'Open details', onClick: () => openDesigner(designer.id) },
        })
      } else if (
        (row.status === 'Present' || row.status === 'HolidayWorked') &&
        (row.warmup_gap_min ?? 0) > 60
      ) {
        items.push({
          id: `warmup-${row.id}`,
          severity: 'info',
          text: `${designer.name} checked in at ${fmtTime(row.declared_in)} but took ${fmtDuration(
            row.warmup_gap_min,
          )} to start — check in with them`,
          detail: 'Warm-up gap = check-in → first ClickUp activity (§9.3). A green light with idle hours is paid idle time.',
          action: { label: 'Open details', onClick: () => openDesigner(designer.id) },
        })
      }
    }
    return items
  }, [dayRows, openDesigner])

  // ── Manual marks (undo = fingerprint delete; errors surface, §20.6) ──
  const markMutation = useMutation({
    mutationFn: (vars: { designerId: string; markType: 'check_in' | 'check_out'; markedAt: string }) =>
      insertShiftMark({
        designer_id: vars.designerId,
        mark_type: vars.markType,
        source: 'manual',
        marked_at: vars.markedAt,
      }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ['attendance'] })
      void queryClient.invalidateQueries({ queryKey: ['shift-marks'] })
      const label = vars.markType === 'check_in' ? 'check-in' : 'check-out'
      toast({
        message: `Manual ${label} recorded at ${fmtTime(vars.markedAt)}`,
        undo: async () => {
          // The delete works server-side for ops roles — but a failure must be
          // seen, never swallowed (§20.6): surface the exact error and leave
          // the recorded mark standing.
          try {
            await deleteManualShiftMark(vars.designerId, vars.markedAt)
          } catch (e) {
            toast({ message: `Couldn't undo the manual ${label} — ${(e as Error).message}` })
            return
          }
          void queryClient.invalidateQueries({ queryKey: ['attendance'] })
          void queryClient.invalidateQueries({ queryKey: ['shift-marks'] })
        },
      })
    },
    onError: (e: Error) => toast({ message: `Couldn't record the mark — ${e.message}` }),
  })

  const mark = (designerId: string, markType: 'check_in' | 'check_out') =>
    markMutation.mutate({ designerId, markType, markedAt: new Date().toISOString() })

  const isToday = date === today
  const weekDates = dateRange(weekStart, date)

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Attendance · dual signal — declared marks × ClickUp activity (§9)</p>
          <h1 className="mt-1 text-3xl font-semibold text-fg">Attendance</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl<View>
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week grid' },
            ]}
            value={view}
            onChange={setView}
            ariaLabel="Attendance view"
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setDate(addDays(date, -1))}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface text-fg hover:bg-surface-2"
              aria-label="Previous day"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              aria-label="Attendance date (PKT)"
              className="min-h-[2.75rem] rounded-xl border border-border bg-surface px-3 text-sm text-fg"
            />
            <button
              type="button"
              onClick={() => setDate(addDays(date, 1))}
              disabled={isToday}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface text-fg hover:bg-surface-2 disabled:opacity-40"
              aria-label="Next day"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
            {!isToday && (
              <button
                type="button"
                onClick={() => setDate(today)}
                className="min-h-[2.75rem] rounded-xl px-3 text-sm font-medium text-brand hover:underline"
              >
                Today
              </button>
            )}
          </div>
        </div>
      </header>

      {attendanceQ.error && (
        <ErrorBanner
          message="Couldn't refresh attendance — showing the last loaded days."
          asOf={
            attendanceQ.dataUpdatedAt > 0
              ? fmtTime(new Date(attendanceQ.dataUpdatedAt).toISOString())
              : null
          }
          onRetry={() => void attendanceQ.refetch()}
        />
      )}

      <VerdictBlock
        title={`Needs a look — ${fmtDate(date)}`}
        items={verdictItems}
        emptyMessage="Everyone accounted for — presence is clean."
        loading={attendanceQ.isLoading || designersQ.isLoading}
      />

      {/* ── Tiles (§20.2) ── */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Attendance summary">
        <StatTile
          eyebrow="Team warm-up median"
          icon={Hourglass}
          value={fmtDuration(warmupMedian)}
          delta={metricDelta(warmupMedian, warmupPrev, {
            goodWhen: 'down',
            format: fmtDuration,
            vs: 'vs prior day',
          })}
          cause="check-in → first ClickUp activity — the honest remote-presence metric (§9.3)"
          state={warmupMedian == null ? null : warmupMedian > 60 ? 'flag' : warmupMedian > 30 ? 'watch' : 'ok'}
          loading={attendanceQ.isLoading}
        />
        <StatTile
          eyebrow="Checked in"
          icon={UserCheck}
          value={`${checkedIn} of ${scheduledCount}`}
          delta={metricDelta(checkedIn, prevStats.checked, { goodWhen: 'up', vs: 'vs prior day' })}
          cause={
            scheduledCount - checkedIn > 0
              ? `${scheduledCount - checkedIn} scheduled designer${scheduledCount - checkedIn === 1 ? '' : 's'} yet to mark in`
              : 'every scheduled designer has marked in'
          }
          state={scheduledCount > 0 && checkedIn < scheduledCount ? 'watch' : 'ok'}
          loading={attendanceQ.isLoading}
        />
        <StatTile
          eyebrow="Needs review"
          icon={TriangleAlert}
          value={String(needsReview)}
          delta={metricDelta(needsReview, prevStats.review, { goodWhen: 'down', vs: 'vs prior day' })}
          cause="auto-closed at shift end with nothing corroborating work — verify"
          state={needsReview > 0 ? 'flag' : 'ok'}
          loading={attendanceQ.isLoading}
        />
        <StatTile
          eyebrow="Late arrivals"
          icon={LogIn}
          value={String(lateCount)}
          delta={metricDelta(lateCount, prevStats.late, { goodWhen: 'down', vs: 'vs prior day' })}
          cause="checked in past their shift start + grace"
          state={lateCount > 0 ? 'watch' : 'ok'}
          loading={attendanceQ.isLoading}
        />
      </section>

      {attendanceQ.isLoading && designers.length === 0 ? (
        <div className="space-y-2" role="status" aria-label="Loading attendance">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-12" />
          ))}
        </div>
      ) : designers.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title="No active designers"
          hint="Add designers on the Roster page — attendance rows appear per scheduled shift."
        />
      ) : view === 'day' ? (
        // ── Day table, needs-attention-first ──
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border/60 text-xs text-muted">
                <th scope="col" className="px-3 py-2.5 font-medium">Designer</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-3 py-2.5 font-medium">In</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Out</th>
                <th scope="col" className="bg-surface-2/70 px-3 py-2.5 font-semibold text-fg">
                  Warm-up gap
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Worked</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Late / early</th>
                {isToday && (
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Manual mark</th>
                )}
              </tr>
            </thead>
            <tbody>
              {/* Team section headers, worst-first within each team (§20.4). */}
              {dayGroups.map(([team, rows]) => (
                <Fragment key={team}>
                  <tr className="border-b border-border/40 bg-surface-2/40">
                    <th scope="colgroup" colSpan={isToday ? 8 : 7} className="px-3 py-2 text-left">
                      <span className="eyebrow">{team}</span>
                    </th>
                  </tr>
                  {rows.map(({ designer, row, expected, shiftLabel }) => {
                const meta = row?.status ? STATUS_META[row.status] : null
                const warmup = row?.warmup_gap_min ?? null
                const warmupFlagged = warmup != null && warmup > 60
                return (
                  <tr key={designer.id} className="border-b border-border/40 last:border-0 hover:bg-surface-2/60">
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => openDesigner(designer.id)}
                        className="min-h-[2.75rem] text-left font-medium text-fg hover:text-brand"
                      >
                        {designer.name}
                        <span className="ml-2 text-xs font-normal text-muted">{designer.team}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      {meta && row?.status ? (
                        <div>
                          <Badge tone={meta.tone} icon={meta.icon}>
                            {row.status === 'HolidayWorked' ? 'Holiday worked' : row.status}
                            {row.is_half_day ? ' · half day' : ''}
                          </Badge>
                          {row.needs_review && (
                            <p className="mt-1 text-xs text-warning">
                              auto-closed at shift end — verify
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted">
                          {shiftLabel ? `Shift ${shiftLabel} PKT — no signal yet` : 'No schedule'}
                          {expected === 0 && shiftLabel ? ' · not expected today' : ''}
                        </span>
                      )}
                    </td>
                    <td className="tnum px-3 py-2.5 text-muted">{fmtTime(row?.declared_in)}</td>
                    <td className="px-3 py-2.5">
                      <span className="tnum text-muted">{fmtTime(row?.declared_out)}</span>
                      {row?.declared_out && row.checkout_source === 'auto_clickup' && (
                        <p className="text-[11px] text-muted">auto — last ClickUp activity</p>
                      )}
                      {row?.declared_out && row.checkout_source === 'auto_shift_end' && (
                        <p className="text-[11px] text-warning">auto — shift end, verify</p>
                      )}
                    </td>
                    <td className={`px-3 py-2.5 ${warmupFlagged ? 'bg-warning-soft/60' : 'bg-surface-2/40'}`}>
                      {warmup == null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <div>
                          <span className={`tnum font-medium ${warmupFlagged ? 'text-warning' : 'text-fg'}`}>
                            {fmtDuration(warmup)}
                          </span>
                          {warmupFlagged && (
                            <p className="text-[11px] text-warning">
                              in {fmtTime(row?.declared_in)}, first activity {fmtTime(row?.first_activity)}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-muted">
                      {row && (row.worked_minutes > 0 || row.status === 'Present' || row.status === 'HolidayWorked')
                        ? fmtDuration(row.worked_minutes)
                        : '—'}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-muted">
                      {row && (row.late_minutes > 0 || row.early_leave_minutes > 0) ? (
                        <span className="text-warning">
                          {row.late_minutes > 0 ? `+${fmtDuration(row.late_minutes)} late` : ''}
                          {row.late_minutes > 0 && row.early_leave_minutes > 0 ? ' · ' : ''}
                          {row.early_leave_minutes > 0 ? `${fmtDuration(row.early_leave_minutes)} early` : ''}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    {isToday && (
                      <td className="px-3 py-2.5 text-right">
                        {!row?.declared_in ? (
                          <button
                            type="button"
                            onClick={() => mark(designer.id, 'check_in')}
                            disabled={markMutation.isPending}
                            className="inline-flex min-h-[2.75rem] items-center gap-1 rounded-xl border border-border bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
                          >
                            <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                            Check in
                          </button>
                        ) : !row.declared_out || row.checkout_source !== 'self' ? (
                          <button
                            type="button"
                            onClick={() => mark(designer.id, 'check_out')}
                            disabled={markMutation.isPending}
                            className="inline-flex min-h-[2.75rem] items-center gap-1 rounded-xl border border-border bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
                          >
                            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                            Check out
                          </button>
                        ) : (
                          <span className="text-xs text-muted">done</span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        // ── Week grid: 7 days × designers, letters not color-only (§20.10) ──
        <div className="card overflow-x-auto p-4">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-medium">Designer</th>
                {weekDates.map((d) => (
                  <th key={d} scope="col" className="px-2 py-2 text-center font-medium">
                    <span className="block">{DOW_LABELS[new Date(`${d}T00:00:00Z`).getUTCDay()]}</span>
                    <span className="tnum font-normal">{fmtDate(d)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Team section headers, worst week first within each team (§20.4). */}
              {weekGroups.map(({ team, members }) => (
                <Fragment key={team}>
                  <tr className="border-t border-border/40 bg-surface-2/40">
                    <th
                      scope="colgroup"
                      colSpan={weekDates.length + 1}
                      className="px-2 py-2 text-left"
                    >
                      <span className="eyebrow">{team}</span>
                    </th>
                  </tr>
                  {members.map((d) => (
                    <tr key={d.id} className="border-t border-border/40">
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          onClick={() => openDesigner(d.id)}
                          className="min-h-[2.75rem] text-left font-medium text-fg hover:text-brand"
                        >
                          {d.name}
                        </button>
                      </td>
                      {weekDates.map((wd) => {
                        const r = rowsByKey.get(`${d.id}|${wd}`)
                        const meta = r?.status ? STATUS_META[r.status] : null
                        return (
                          <td key={wd} className="px-2 py-2 text-center">
                            <span
                              className={`tnum inline-flex h-9 min-w-[2.25rem] items-center justify-center rounded-lg px-1 text-xs font-semibold ${
                                meta ? meta.cell : 'bg-surface-2/50 text-muted/50'
                              }`}
                              title={`${fmtDate(wd)}: ${r?.status ?? 'no record'}${
                                r?.warmup_gap_min != null ? ` · warm-up ${fmtDuration(r.warmup_gap_min)}` : ''
                              }${r?.needs_review ? ' · needs review' : ''}`}
                            >
                              {meta ? meta.letter : '·'}
                              {r?.needs_review ? '!' : ''}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted">
            P present · HW holiday worked · L leave · H holiday · W weekly off · A absent · I
            incomplete · ! needs review
          </p>
        </div>
      )}
    </div>
  )
}
