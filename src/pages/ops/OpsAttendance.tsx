import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CalendarX,
  Check,
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
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InfoTip } from '../../components/ui/InfoTip'
import { PageHeader } from '../../components/layout/PageHeader'
import { DesignerFilter } from '../../components/ui/DesignerFilter'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { StatTile } from '../../components/ui/StatTile'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { useToast } from '../../components/ui/ToastProvider'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { insertShiftMark } from '../../lib/queries'
import { DOW_LABELS, fmtClock, fmtDate, fmtDuration, fmtDurationLong, fmtShiftTime, fmtTime } from '../../lib/format'
import { addDays, dateRange, pktInstant, pktToday } from '../../../shared/pkt'
import { expectedQuotaOn, median, scheduleFor } from '../../../shared/aggregate'
import {
  isPerProject,
  type AttendanceDaily,
  type AttendanceStatus,
  type Designer,
  type DesignerSchedule,
} from '../../../shared/types'
import {
  deleteManualShiftMark,
  metricDelta,
  useActiveDesigners,
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

/** Plain-English display names for attendance statuses (visible text only). */
const STATUS_DISPLAY: Record<AttendanceStatus, string> = {
  Present: 'Present',
  HolidayWorked: 'Holiday worked',
  Leave: 'Leave',
  Holiday: 'Holiday',
  WeeklyOff: 'Day off',
  Absent: 'Absent',
  Incomplete: 'Incomplete',
}

interface DayRow {
  designer: Designer
  row: AttendanceDaily | undefined
  expected: number
  schedule: DesignerSchedule | null
  shiftLabel: string | null
}

interface MarkVars {
  designerId: string
  markType: 'check_in' | 'check_out'
  markedAt: string
  workDate: string
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

  // Focus the whole page on a few people (empty = everyone), remembered here.
  const [selectedIds, setSelectedIds] = useLocalStorage<string[]>(
    'pulse.ops.attendance.designers',
    [],
  )
  const allActive = useActiveDesigners()
  // Per project designers have no shift and no attendance, so they never appear
  // on the attendance page — not in the rows, the week grid, or the filter.
  const attEligible = useMemo(() => allActive.filter((d) => !isPerProject(d)), [allActive])
  const designers = useMemo(
    () => (selectedIds.length ? attEligible.filter((d) => selectedIds.includes(d.id)) : attEligible),
    [attEligible, selectedIds],
  )
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
          schedule,
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

  // Numerator and denominator over the SAME population (people expected in) —
  // off-day and holiday volunteers are surfaced separately, never "5 of 3".
  const checkedIn = dayRows.filter((r) => r.expected > 0 && r.row?.declared_in != null).length
  const scheduledCount = dayRows.filter((r) => r.expected > 0).length
  const extraCheckIns = dayRows.filter((r) => r.expected === 0 && r.row?.declared_in != null).length
  const needsReview = dayRows.filter((r) => r.row?.needs_review).length
  const lateCount = dayRows.filter((r) => (r.row?.late_minutes ?? 0) > 0).length
  // "Arrived late" can be worked out from ClickUp activity alone, with no
  // Check-in press at all — so it is never a subset of `checkedIn` above.
  // The header line needs a population "late" IS always inside, or "0 have
  // checked in, 4 arrived late" reads as a straight contradiction. Presence —
  // pressed Check in OR made their first move in ClickUp — is that population.
  const presentCount = dayRows.filter(
    (r) => r.expected > 0 && (r.row?.declared_in != null || r.row?.first_activity != null),
  ).length

  // Prior-day values for the tile deltas — same week-range query, no extra fetch.
  const prevStats = useMemo(() => {
    let checked = 0
    let late = 0
    let review = 0
    for (const d of designers) {
      const r = rowsByKey.get(`${d.id}|${prevDate}`)
      // Same population rule as today's tile: only people expected in count.
      if (r?.declared_in != null && expectedQuotaOn(d.id, prevDate, ctx) > 0) checked++
      if ((r?.late_minutes ?? 0) > 0) late++
      if (r?.needs_review) review++
    }
    return { checked, late, review }
  }, [designers, rowsByKey, prevDate, ctx])

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
          text: `Please take another look at ${designer.name}'s day. The system closed it because they forgot to press Check out.`,
          detail: 'They pressed Check in, but no work showed up afterward. Please confirm the day before it counts.',
          action: { label: 'Open details', onClick: () => openDesigner(designer.id) },
        })
      } else if (row.status === 'Incomplete') {
        items.push({
          id: `incomplete-${row.id}`,
          severity: 'warning',
          text: `${designer.name} checked in but never checked out, and no work showed up`,
          action: { label: 'Open details', onClick: () => openDesigner(designer.id) },
        })
      } else if (row.status === 'Absent') {
        items.push({
          id: `absent-${row.id}`,
          severity: 'warning',
          text: `${designer.name} was absent, with no sign of checking in and no work during their hours`,
          detail: 'It was not a holiday, leave or day off, so this one is unexplained.',
          action: { label: 'Open details', onClick: () => openDesigner(designer.id) },
        })
      } else if (
        (row.status === 'Present' || row.status === 'HolidayWorked') &&
        (row.warmup_gap_min ?? 0) > 60
      ) {
        items.push({
          id: `warmup-${row.id}`,
          severity: 'info',
          text: `${designer.name} checked in at ${fmtClock(row.declared_in)} but took ${fmtDurationLong(
            row.warmup_gap_min,
          )} to get going. Might be worth a quick, friendly chat.`,
          detail: 'Start delay is the time between pressing Check in and doing the first real work in ClickUp.',
          action: { label: 'Open details', onClick: () => openDesigner(designer.id) },
        })
      }
    }
    return items
  }, [dayRows, openDesigner])

  // ── Manual marks (undo = fingerprint delete; errors surface, §20.6) ──
  // attendance_daily is recomputed by the 15-minute pulse cron, so a refetch
  // right after a mark returns the SAME stale rows. The mark is therefore
  // reflected in the cache optimistically and kept until the recompute lands;
  // `recalcPending` keeps the pressed button from being pressable twice.
  const [recalcPending, setRecalcPending] = useState<Set<string>>(() => new Set())
  const recalcKey = (designerId: string, workDate: string, markType: string) =>
    `${designerId}|${workDate}|${markType}`

  const applyMarkToCache = (vars: MarkVars) => {
    for (const [key] of queryClient.getQueriesData<AttendanceDaily[]>({ queryKey: ['attendance'] })) {
      const [, start, end] = key as readonly unknown[]
      if (typeof start !== 'string' || typeof end !== 'string') continue
      if (vars.workDate < start || vars.workDate > end) continue
      queryClient.setQueryData<AttendanceDaily[]>(key, (rows) => {
        const list = rows ?? []
        const idx = list.findIndex(
          (r) => r.designer_id === vars.designerId && r.work_date === vars.workDate,
        )
        if (idx >= 0) {
          return list.map((r, i) =>
            i !== idx
              ? r
              : vars.markType === 'check_in'
                ? { ...r, declared_in: r.declared_in ?? vars.markedAt, status: r.status ?? 'Present' }
                : { ...r, declared_out: vars.markedAt, checkout_source: 'manual' },
          )
        }
        const synthetic: AttendanceDaily = {
          id: -Date.now(), // negative sentinel — replaced by the next recompute
          designer_id: vars.designerId,
          work_date: vars.workDate,
          declared_in: vars.markType === 'check_in' ? vars.markedAt : null,
          declared_out: vars.markType === 'check_out' ? vars.markedAt : null,
          first_activity: null,
          last_activity: null,
          scheduled_in: null,
          scheduled_out: null,
          worked_minutes: 0,
          warmup_gap_min: null,
          late_minutes: 0,
          early_leave_minutes: 0,
          is_half_day: false,
          needs_review: false,
          checkout_source: vars.markType === 'check_out' ? 'manual' : null,
          status: vars.markType === 'check_in' ? 'Present' : null,
          computed_at: new Date().toISOString(),
        }
        return [...list, synthetic]
      })
    }
  }

  const markMutation = useMutation({
    mutationFn: (vars: MarkVars) =>
      insertShiftMark({
        designer_id: vars.designerId,
        mark_type: vars.markType,
        source: 'manual',
        marked_at: vars.markedAt,
      }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['attendance'] })
      const snapshots = queryClient.getQueriesData<AttendanceDaily[]>({ queryKey: ['attendance'] })
      applyMarkToCache(vars)
      return { snapshots }
    },
    onSuccess: (_data, vars) => {
      // Deliberately NOT invalidating ['attendance'] here — the server rows
      // stay stale until the pulse cron recomputes, and a refetch now would
      // clobber the optimistic mark and resurrect the button just pressed.
      void queryClient.invalidateQueries({ queryKey: ['shift-marks'] })
      setRecalcPending((s) => new Set(s).add(recalcKey(vars.designerId, vars.workDate, vars.markType)))
      toast({
        message: `${vars.markType === 'check_in' ? 'Start of day' : 'End of day'} saved for ${fmtClock(vars.markedAt)}`,
        undo: async () => {
          // The delete works server-side for ops roles — but a failure must be
          // seen, never swallowed (§20.6): surface the exact error and leave
          // the recorded mark standing.
          try {
            await deleteManualShiftMark(vars.designerId, vars.markedAt)
          } catch (e) {
            toast({ message: `We couldn't undo that. ${(e as Error).message}` })
            return
          }
          setRecalcPending((s) => {
            const next = new Set(s)
            next.delete(recalcKey(vars.designerId, vars.workDate, vars.markType))
            return next
          })
          // Here a refetch is exactly right: server rows without the deleted
          // mark ARE the reverted state.
          void queryClient.invalidateQueries({ queryKey: ['attendance'] })
          void queryClient.invalidateQueries({ queryKey: ['shift-marks'] })
        },
      })
    },
    onError: (e: Error, _vars, mctx) => {
      for (const [key, data] of mctx?.snapshots ?? []) queryClient.setQueryData(key, data)
      toast({ message: `We couldn't save that. ${e.message}` })
    },
  })

  const mark = (designerId: string, markType: 'check_in' | 'check_out') =>
    markMutation.mutate({
      designerId,
      markType,
      markedAt: new Date().toISOString(),
      workDate: date,
    })

  const isToday = date === today
  const weekDates = dateRange(weekStart, date)

  // ── Fixing a past day: pick the time the mark really happened (§20.6) ──
  const [fixDraft, setFixDraft] = useState<{
    designerId: string
    markType: 'check_in' | 'check_out'
    time: string
  } | null>(null)
  useEffect(() => setFixDraft(null), [date])

  const openFix = (r: DayRow, markType: 'check_in' | 'check_out') =>
    setFixDraft({
      designerId: r.designer.id,
      markType,
      time:
        (markType === 'check_in' ? r.schedule?.shift_start : r.schedule?.shift_end)?.slice(0, 5) ??
        (markType === 'check_in' ? '09:00' : '17:00'),
    })

  const saveFix = (r: DayRow) => {
    if (!fixDraft || !fixDraft.time) return
    // Overnight shifts cross midnight: a checkout at/before the start time
    // belongs to the NEXT calendar date, though it still fixes this work day.
    const overnight = r.schedule != null && r.schedule.shift_end <= r.schedule.shift_start
    const onDate =
      fixDraft.markType === 'check_out' &&
      overnight &&
      r.schedule != null &&
      `${fixDraft.time}:00` <= r.schedule.shift_start
        ? addDays(date, 1)
        : date
    markMutation.mutate({
      designerId: fixDraft.designerId,
      markType: fixDraft.markType,
      markedAt: pktInstant(onDate, fixDraft.time).toISOString(),
      workDate: date,
    })
    setFixDraft(null)
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-12">
      <PageHeader
        breadcrumbs={['Ops', 'Attendance']}
        title="Attendance"
        titleAccessory={
          <InfoTip text="Who is in, when they started and stopped, and how long after checking in they began real work." />
        }
        history={
          attendanceQ.isLoading
            ? `Matching check in times against real work in ClickUp for ${fmtDate(date)}…`
            : `On ${fmtDate(date)}, ${presentCount} of ${scheduledCount} scheduled ${
                scheduledCount === 1 ? 'person has' : 'people have'
              } shown up${needsReview > 0 ? `, ${needsReview} day${needsReview === 1 ? '' : 's'} to look over` : ''}${
                lateCount > 0 ? `, ${lateCount} arriving late` : ''
              }.`
        }
        actions={
          <>
            <span className="flex items-center gap-1">
              <SegmentedControl<View>
                options={[
                  { value: 'day', label: 'Day' },
                  { value: 'week', label: 'Week' },
                ]}
                value={view}
                onChange={setView}
                ariaLabel="Attendance view"
              />
              <InfoTip text="See one day in detail, or the whole week at a glance." />
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setDate(addDays(date, view === 'week' ? -7 : -1))}
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface text-fg transition-colors duration-150 ease-out hover:bg-surface-2 motion-safe:active:scale-95"
                aria-label={view === 'week' ? 'Previous week' : 'Previous day'}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <input
                type="date"
                value={date}
                max={today}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                aria-label="Attendance date (Pakistan time)"
                className="tnum min-h-11 rounded-xl border border-border bg-surface px-3 text-caption text-fg"
              />
              <button
                type="button"
                onClick={() => {
                  const next = addDays(date, view === 'week' ? 7 : 1)
                  setDate(next > today ? today : next)
                }}
                disabled={isToday}
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface text-fg transition-colors duration-150 ease-out hover:bg-surface-2 disabled:opacity-40 motion-safe:active:scale-95"
                aria-label={view === 'week' ? 'Next week' : 'Next day'}
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
              {!isToday && (
                <button
                  type="button"
                  onClick={() => setDate(today)}
                  className="min-h-11 rounded-xl px-3 text-caption font-medium text-brand transition-colors duration-150 ease-out hover:bg-brand-soft"
                >
                  Today
                </button>
              )}
            </span>
            <span className="flex items-center gap-1">
              <DesignerFilter designers={attEligible} selected={selectedIds} onChange={setSelectedIds} />
              <InfoTip text="Focus on one or more people. Leave it on everyone to see the whole team." />
            </span>
          </>
        }
      />

      {attendanceQ.error && (
        <ErrorBanner
          message="We couldn't load the latest attendance, so you're seeing the last saved view."
          asOf={
            attendanceQ.dataUpdatedAt > 0
              ? fmtClock(new Date(attendanceQ.dataUpdatedAt).toISOString())
              : null
          }
          onRetry={() => void attendanceQ.refetch()}
        />
      )}

      <VerdictBlock
        title={`Needs a look for ${fmtDate(date)}`}
        items={verdictItems}
        emptyMessage="Everyone is accounted for, nothing to check."
        loading={attendanceQ.isLoading || designersQ.isLoading}
      />

      {/* ── Tiles (§20.2) — 2-up so labels never truncate (whitespace pillar) ── */}
      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2" aria-label="Attendance summary">
        <StatTile
          eyebrow="Start delay"
          tip="The time between pressing Check in and doing the first real work in ClickUp. This is the usual (middle) value for the whole team."
          icon={Hourglass}
          value={fmtDurationLong(warmupMedian)}
          delta={metricDelta(warmupMedian, warmupPrev, {
            goodWhen: 'down',
            format: fmtDurationLong,
            vs: 'compared with the day before',
          })}
          cause="the usual gap between checking in and starting real work"
          state={warmupMedian == null ? null : warmupMedian > 60 ? 'flag' : warmupMedian > 30 ? 'watch' : 'ok'}
          loading={attendanceQ.isLoading}
        />
        <StatTile
          eyebrow="Checked in"
          tip="How many of today's scheduled people have pressed Check in."
          icon={UserCheck}
          value={`${checkedIn} of ${scheduledCount}`}
          delta={metricDelta(checkedIn, prevStats.checked, { goodWhen: 'up', vs: 'compared with the day before' })}
          cause={`${
            scheduledCount - checkedIn > 0
              ? `${scheduledCount - checkedIn} still to check in`
              : 'everyone scheduled today has checked in'
          }${extraCheckIns > 0 ? `, plus ${extraCheckIns} in on a day off` : ''}`}
          state={scheduledCount > 0 && checkedIn < scheduledCount ? 'watch' : 'ok'}
          loading={attendanceQ.isLoading}
        />
        <StatTile
          eyebrow="Days to look over"
          tip="The system closed these days on its own because the person forgot to press Check out. Please look them over when you can."
          icon={TriangleAlert}
          value={String(needsReview)}
          delta={metricDelta(needsReview, prevStats.review, { goodWhen: 'down', vs: 'compared with the day before' })}
          cause="the system closed these days on its own, so please look them over"
          state={needsReview > 0 ? 'flag' : 'ok'}
          loading={attendanceQ.isLoading}
        />
        <StatTile
          eyebrow="Arrived late"
          tip="People who checked in after their start time, allowing a small grace period."
          icon={LogIn}
          value={String(lateCount)}
          delta={metricDelta(lateCount, prevStats.late, { goodWhen: 'down', vs: 'compared with the day before' })}
          cause="checked in after their start time"
          state={lateCount > 0 ? 'watch' : 'ok'}
          loading={attendanceQ.isLoading}
        />
      </section>

      {attendanceQ.isLoading && designers.length === 0 ? (
        // Skeleton mirrors the day table: header band, then name + cell rows.
        <div className="card overflow-hidden" role="status" aria-label="Loading attendance">
          <div className="border-b border-border/60 px-4 py-3">
            <div className="skeleton h-3.5 w-56" />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-6 border-b border-border/40 px-4 py-4 last:border-0">
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-5 w-24 rounded-full" />
              <div className="skeleton ml-auto h-4 w-64" />
            </div>
          ))}
        </div>
      ) : designers.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title="No designers yet"
          hint="Add people on the Roster page, and their attendance will show up here."
        />
      ) : view === 'day' ? (
        // ── Day table, needs-attention-first ──
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-caption">
            <thead>
              <tr className="border-b border-border/60 text-label text-muted">
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">Designer</th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    Status
                    <InfoTip text="What kind of day it was: worked, on leave, day off, absent, and so on." />
                  </span>
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    In
                    <InfoTip text="The time they pressed Check in." />
                  </span>
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    Out
                    <InfoTip text="The time they pressed Check out. If they forgot, the system fills it in and flags the day for a second look." />
                  </span>
                </th>
                <th scope="col" className="whitespace-nowrap bg-surface-2/70 px-4 py-3 text-right font-semibold text-fg">
                  <span className="inline-flex items-center gap-1">
                    Start delay
                    <InfoTip text="The time between pressing Check in and doing the first real work in ClickUp." />
                  </span>
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    Worked
                    <InfoTip text="Total time worked that day." />
                  </span>
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    Late / early
                    <InfoTip text="Started late or left early, and by how much." />
                  </span>
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    {isToday ? 'Mark for them' : 'Fix their day'}
                    <InfoTip
                      text={
                        isToday
                          ? 'Press Check in or Check out for someone who forgot.'
                          : 'Add a missed check in or check out for this date. Pick the time it really happened.'
                      }
                    />
                  </span>
                </th>
              </tr>
            </thead>
            {/* One tbody per team so the team name is a row-group header, not a
                bogus column-group (§20.10); rows stay worst-first (§20.4). */}
            {dayGroups.map(([team, rows]) => (
              <tbody key={team}>
                <tr className="border-b border-border/40 bg-surface-2/40">
                  <th scope="rowgroup" colSpan={8} className="px-4 py-2.5 text-left">
                    <span className="eyebrow">{team}</span>
                  </th>
                </tr>
                {rows.map((dayRow) => {
                  const { designer, row, expected, shiftLabel } = dayRow
                  const meta = row?.status ? STATUS_META[row.status] : null
                  const warmup = row?.warmup_gap_min ?? null
                  const warmupFlagged = warmup != null && warmup > 60
                  const editing = fixDraft != null && fixDraft.designerId === designer.id
                  const outSaved = recalcPending.has(recalcKey(designer.id, date, 'check_out'))
                  return (
                    <tr key={designer.id} className="border-b border-border/40 last:border-0 transition-colors duration-150 ease-out hover:bg-surface-2/60">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openDesigner(designer.id)}
                          className="min-h-11 text-left font-medium text-fg hover:text-brand"
                        >
                          {designer.name}
                          <span className="ml-2 text-label font-normal tracking-normal text-muted">{designer.team}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        {meta && row?.status ? (
                          <div>
                            <Badge tone={meta.tone} icon={meta.icon}>
                              {STATUS_DISPLAY[row.status]}
                              {row.is_half_day ? ', half day' : ''}
                            </Badge>
                            {row.needs_review && (
                              <p className="mt-1 text-label font-normal tracking-normal text-warning">
                                closed by the system, please look it over
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-label font-normal tracking-normal text-muted">
                            {shiftLabel
                              ? `Hours ${shiftLabel} Pakistan time, and nothing logged yet${
                                  expected === 0 ? ', though they are not expected in today' : ''
                                }`
                              : 'No work hours set'}
                          </span>
                        )}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-muted">{fmtTime(row?.declared_in)}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="tnum text-muted">{fmtTime(row?.declared_out)}</span>
                        {row?.declared_out && row.checkout_source === 'auto_clickup' && (
                          <p className="text-label font-normal tracking-normal text-muted">filled in from their last bit of work</p>
                        )}
                        {row?.declared_out && row.checkout_source === 'auto_shift_end' && (
                          <p className="text-label font-normal tracking-normal text-warning">filled in by the system, please look it over</p>
                        )}
                      </td>
                      <td className={`px-4 py-3 text-right ${warmupFlagged ? 'bg-warning-soft/60' : 'bg-surface-2/40'}`}>
                        {warmup == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <div>
                            <span className={`tnum font-medium ${warmupFlagged ? 'text-warning' : 'text-fg'}`}>
                              {fmtDuration(warmup)}
                            </span>
                            {warmupFlagged && (
                              <p className="text-label font-normal tracking-normal text-warning">
                                in at {fmtTime(row?.declared_in)}, first work {fmtTime(row?.first_activity)}
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-muted">
                        {row && (row.worked_minutes > 0 || row.status === 'Present' || row.status === 'HolidayWorked')
                          ? fmtDuration(row.worked_minutes)
                          : '—'}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-muted">
                        {row && (row.late_minutes > 0 || row.early_leave_minutes > 0) ? (
                          <span className="text-warning">
                            {row.late_minutes > 0 ? `+${fmtDuration(row.late_minutes)} late` : ''}
                            {row.late_minutes > 0 && row.early_leave_minutes > 0 ? ' and ' : ''}
                            {row.early_leave_minutes > 0 ? `${fmtDuration(row.early_leave_minutes)} early` : ''}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {editing && fixDraft ? (
                          <span className="inline-flex items-center justify-end gap-1">
                            <input
                              type="time"
                              value={fixDraft.time}
                              onChange={(e) => setFixDraft({ ...fixDraft, time: e.target.value })}
                              aria-label={`${
                                fixDraft.markType === 'check_in' ? 'Start of day' : 'End of day'
                              } time for ${designer.name} (Pakistan time)`}
                              className="tnum min-h-11 rounded-xl border border-border bg-surface px-2 text-label font-normal text-fg"
                            />
                            <button
                              type="button"
                              onClick={() => saveFix(dayRow)}
                              disabled={markMutation.isPending || !fixDraft.time}
                              className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border bg-surface px-2.5 text-label text-fg transition-colors duration-150 ease-out hover:bg-surface-2 disabled:opacity-50 motion-safe:active:scale-[0.97]"
                            >
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setFixDraft(null)}
                              aria-label={`Cancel fixing ${designer.name}'s day`}
                              className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg"
                            >
                              <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </span>
                        ) : !row?.declared_in ? (
                          <button
                            type="button"
                            onClick={() =>
                              isToday ? mark(designer.id, 'check_in') : openFix(dayRow, 'check_in')
                            }
                            disabled={markMutation.isPending}
                            className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border bg-surface px-2.5 text-label text-fg transition-colors duration-150 ease-out hover:bg-surface-2 disabled:opacity-50 motion-safe:active:scale-[0.97]"
                          >
                            <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                            Check in
                          </button>
                        ) : outSaved ? (
                          <span className="text-label font-normal tracking-normal text-muted">saved, updating shortly</span>
                        ) : !row.declared_out || row.checkout_source !== 'self' ? (
                          <button
                            type="button"
                            onClick={() =>
                              isToday ? mark(designer.id, 'check_out') : openFix(dayRow, 'check_out')
                            }
                            disabled={markMutation.isPending}
                            className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border bg-surface px-2.5 text-label text-fg transition-colors duration-150 ease-out hover:bg-surface-2 disabled:opacity-50 motion-safe:active:scale-[0.97]"
                          >
                            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                            Check out
                          </button>
                        ) : (
                          <span className="text-label font-normal tracking-normal text-muted">done</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            ))}
          </table>
        </div>
      ) : (
        // ── Week grid: 7 days × designers, letters not color-only (§20.10) ──
        <div className="card overflow-x-auto p-6">
          <p className="tnum mb-4 text-label font-normal tracking-normal text-muted">
            Showing the 7 days {fmtDate(weekStart)} – {fmtDate(date)}
          </p>
          <table className="w-full text-left text-caption">
            <thead>
              <tr className="text-label text-muted">
                <th scope="col" className="px-2 py-2 font-medium">Designer</th>
                {weekDates.map((d) => (
                  <th key={d} scope="col" className="px-2 py-2 text-center font-medium">
                    <span className="block">{DOW_LABELS[new Date(`${d}T00:00:00Z`).getUTCDay()]}</span>
                    <span className="tnum font-normal">{fmtDate(d)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            {/* One tbody per team so the team name is a row-group header, not a
                bogus column-group (§20.10); worst week first per team (§20.4). */}
            {weekGroups.map(({ team, members }) => (
              <tbody key={team}>
                <tr className="border-t border-border/40 bg-surface-2/40">
                  <th
                    scope="rowgroup"
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
                        className="min-h-11 text-left font-medium text-fg hover:text-brand"
                      >
                        {d.name}
                      </button>
                    </td>
                    {weekDates.map((wd) => {
                      const r = rowsByKey.get(`${d.id}|${wd}`)
                      const meta = r?.status ? STATUS_META[r.status] : null
                      const cellText = `${fmtDate(wd)}: ${
                        r?.status ? STATUS_DISPLAY[r.status] : 'no record'
                      }${
                        r?.warmup_gap_min != null
                          ? `, with a ${fmtDurationLong(r.warmup_gap_min)} start delay`
                          : ''
                      }${r?.needs_review ? ', and needs a look' : ''}`
                      return (
                        <td key={wd} className="px-2 py-2 text-center">
                          <span
                            className={`tnum inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-1 text-label font-semibold tracking-normal ${
                              meta ? meta.cell : 'bg-surface-2/50 text-muted/50'
                            }`}
                            title={cellText}
                          >
                            <span aria-hidden="true">
                              {meta ? meta.letter : '·'}
                              {r?.needs_review ? '!' : ''}
                            </span>
                            {/* The full meaning, not just the letter, for AT (§20.10). */}
                            <span className="sr-only">{cellText}</span>
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          <p className="mt-4 max-w-prose text-label font-normal tracking-normal text-muted">
            P means present, HW means they worked on a holiday, L means leave, H means holiday, W
            means a weekly day off, A means absent, I means incomplete, and an exclamation mark
            means it needs a look.
          </p>
        </div>
      )}
    </div>
  )
}
