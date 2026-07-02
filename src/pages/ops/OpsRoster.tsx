import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  CircleCheck,
  ExternalLink,
  Link2Off,
  Plus,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Drawer } from '../../components/ui/Drawer'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InlineEdit } from '../../components/ui/InlineEdit'
import { VerdictBlock, type VerdictItem } from '../../components/ui/VerdictBlock'
import { useToast } from '../../components/ui/ToastProvider'
import { useAuth } from '../../hooks/useAuth'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import {
  applyScheduleChange,
  clickupListUrl,
  deleteQuotaException,
  setDesignerStatus,
  upsertDesigner,
  upsertQuotaException,
} from '../../lib/queries'
import { DOW_LABELS, fmtDate, fmtShiftTime } from '../../lib/format'
import { pktToday } from '../../../shared/pkt'
import { scheduleFor } from '../../../shared/aggregate'
import type { Designer, QuotaException, Team } from '../../../shared/types'
import { useDesignerDrawer, useDesigners, useQuotaCtx } from './opsData'

const TEAMS: Team[] = ['Logo', 'Branding', 'Animation', 'PPT', 'Canva']

interface ScheduleForm {
  effective_from: string
  daily_quota: string
  shift_start: string
  shift_end: string
  weekly_off: string // '' = none
  late_grace_min: string
  early_leave_grace_min: string
}

/**
 * Roster CRUD (spec §8): the config source of truth ClickUp cannot hold.
 * Inline edits in place (§21.6), schedule changes effective-dated (§8.3),
 * archive as the default exit with Undo (§8.2, §20.6), hard delete admin-only
 * behind the one allowed confirm dialog.
 */
export default function OpsRoster() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { role } = useAuth()
  const openDesigner = useDesignerDrawer()
  const today = pktToday()

  const designersQ = useDesigners()
  const { ctx } = useQuotaCtx()
  const [showArchived, setShowArchived] = useLocalStorage('pulse.ops.roster.showArchived', false)
  const [scheduleTarget, setScheduleTarget] = useState<Designer | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Designer | null>(null)

  const invalidateRoster = () => {
    void queryClient.invalidateQueries({ queryKey: ['designers'] })
    void queryClient.invalidateQueries({ queryKey: ['schedules'] })
    void queryClient.invalidateQueries({ queryKey: ['quota-exceptions'] })
  }

  const saveDesigner = useMutation({
    mutationFn: (d: Partial<Designer> & { name: string; team: string }) => upsertDesigner(d),
    onSuccess: () => invalidateRoster(),
    onError: (e: Error) => toast({ message: `Couldn't save — ${e.message}` }),
  })

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'archived' | 'deleted' }) =>
      setDesignerStatus(id, status),
    onSuccess: () => invalidateRoster(),
    onError: (e: Error) => toast({ message: `Couldn't update status — ${e.message}` }),
  })

  const patchField = (d: Designer, patch: Partial<Designer>) => {
    const original = { ...d }
    saveDesigner.mutate(
      { ...d, ...patch },
      {
        onSuccess: () =>
          toast({
            message: `${d.name} updated`,
            undo: () => saveDesigner.mutate(original),
          }),
      },
    )
  }

  const archive = (d: Designer) => {
    statusMutation.mutate(
      { id: d.id, status: 'archived' },
      {
        onSuccess: () =>
          toast({
            message: `${d.name} archived — history stays queryable`,
            undo: () => statusMutation.mutate({ id: d.id, status: 'active' }),
          }),
      },
    )
  }

  const restore = (d: Designer) => {
    statusMutation.mutate(
      { id: d.id, status: 'active' },
      {
        onSuccess: () =>
          toast({
            message: `${d.name} restored to active`,
            undo: () => statusMutation.mutate({ id: d.id, status: 'archived' }),
          }),
      },
    )
  }

  const visible = (designersQ.data ?? []).filter(
    (d) => d.status === 'active' || (showArchived && d.status === 'archived'),
  )
  const teams = useMemo(() => {
    const grouped = new Map<string, Designer[]>()
    for (const d of visible) {
      const list = grouped.get(d.team) ?? []
      list.push(d)
      grouped.set(d.team, list)
    }
    return grouped
  }, [visible])

  // ── Verdict: configuration gaps the numbers silently depend on (§20.1) ──
  const verdictItems = useMemo(() => {
    const items: VerdictItem[] = []
    for (const d of (designersQ.data ?? []).filter((x) => x.status === 'active')) {
      if (!d.clickup_list_id) {
        items.push({
          id: `unlinked-${d.id}`,
          severity: 'warning',
          text: `${d.name} isn't linked to a ClickUp list — their tasks can't ingest`,
          detail: 'Set the list id inline below; ingestion picks it up on the next sync.',
        })
      }
      if (!scheduleFor(ctx.schedules, d.id, today)) {
        items.push({
          id: `nosched-${d.id}`,
          severity: 'warning',
          text: `${d.name} has no schedule — quota attainment and attendance can't be computed`,
          detail: 'Open Edit schedule on their row to set quota, shift and weekly off.',
          action: {
            label: 'Edit schedule',
            onClick: () => {
              const target = (designersQ.data ?? []).find((x) => x.id === d.id)
              if (target) setScheduleTarget(target)
            },
          },
        })
      }
    }
    return items
  }, [designersQ.data, ctx.schedules, today])

  const activeCount = (designersQ.data ?? []).filter((d) => d.status === 'active').length

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Roster · quotas are floors, not ceilings (§2)</p>
          <h1 className="mt-1 text-3xl font-semibold text-fg">Roster</h1>
          <p className="mt-1 text-sm text-muted">
            {activeCount} active designer{activeCount === 1 ? '' : 's'} across {teams.size} team
            {teams.size === 1 ? '' : 's'} — schedule edits are effective-dated; history keeps its
            own numbers (§8.3).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex min-h-[2.75rem] cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--color-brand))]"
            />
            Show archived
          </label>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Add designer
          </button>
        </div>
      </header>

      {designersQ.error && (
        <ErrorBanner
          message="Couldn't load the roster — showing the last loaded designers."
          onRetry={() => void designersQ.refetch()}
        />
      )}

      <VerdictBlock
        title="Configuration gaps"
        items={verdictItems}
        emptyMessage="Roster fully configured — every active designer is linked to ClickUp and scheduled."
        loading={designersQ.isLoading}
      />

      {designersQ.isLoading ? (
        <div className="space-y-3" role="status" aria-label="Loading roster">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-14" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="No designers yet"
          hint="Add your first designer — quota and shift make every other number possible."
          action={
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg"
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Add designer
            </button>
          }
        />
      ) : (
        [...teams.entries()].map(([team, members]) => (
          <section key={team} aria-label={`${team} team`}>
            <h2 className="eyebrow">{team}</h2>
            <div className="card mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted">
                    <th scope="col" className="w-10 px-3 py-2.5">
                      <span className="sr-only">State</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Specialty</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">ClickUp list</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">ClickUp user</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Order</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Schedule</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((d) => {
                    const schedule = scheduleFor(ctx.schedules, d.id, today)
                    const exceptions = ctx.exceptions.filter((e) => e.designer_id === d.id)
                    const archived = d.status === 'archived'
                    return (
                      <tr
                        key={d.id}
                        onClick={() => openDesigner(d.id)}
                        className={`cursor-pointer border-b border-border/40 last:border-0 hover:bg-surface-2 ${
                          archived ? 'opacity-60' : ''
                        }`}
                      >
                        <td className="px-3 py-2.5">
                          {archived ? (
                            <Archive className="h-4 w-4 text-muted" aria-label="Archived" />
                          ) : !d.clickup_list_id ? (
                            <Link2Off className="h-4 w-4 text-warning" aria-label="Not linked to ClickUp" />
                          ) : (
                            <CircleCheck className="h-4 w-4 text-success" aria-label="Active" />
                          )}
                        </td>
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <InlineEdit
                            value={d.name}
                            onSave={(v) => patchField(d, { name: v })}
                            ariaLabel={`Name of ${d.name}`}
                            className="font-medium text-fg"
                          />
                        </td>
                        <td className="px-3 py-2.5 text-muted" onClick={(e) => e.stopPropagation()}>
                          <InlineEdit
                            value={d.specialty ?? ''}
                            onSave={(v) => patchField(d, { specialty: v || null })}
                            ariaLabel={`Specialty of ${d.name}`}
                          />
                        </td>
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
                            <InlineEdit
                              value={d.clickup_list_id ?? ''}
                              onSave={(v) => patchField(d, { clickup_list_id: v || null })}
                              ariaLabel={`ClickUp list id of ${d.name}`}
                              className="tnum text-muted"
                            />
                            {clickupListUrl(d.clickup_list_id) && (
                              <a
                                href={clickupListUrl(d.clickup_list_id) ?? '#'}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open ${d.name}'s list in ClickUp`}
                                title="Open list in ClickUp"
                                className="text-brand hover:opacity-80"
                              >
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <InlineEdit
                            value={d.clickup_user_id != null ? String(d.clickup_user_id) : ''}
                            type="number"
                            onSave={(v) =>
                              patchField(d, {
                                clickup_user_id: v.trim() === '' ? null : Number(v),
                              })
                            }
                            ariaLabel={`ClickUp user id of ${d.name}`}
                            className="tnum text-muted"
                          />
                        </td>
                        <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <InlineEdit
                            value={String(d.order_index)}
                            type="number"
                            onSave={(v) => patchField(d, { order_index: Number(v) || 0 })}
                            ariaLabel={`Sort order of ${d.name}`}
                            className="tnum"
                          />
                        </td>
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <div className="flex flex-wrap items-center gap-2">
                            {schedule ? (
                              <span className="tnum text-muted">
                                {schedule.daily_quota}/day · {fmtShiftTime(schedule.shift_start)}–
                                {fmtShiftTime(schedule.shift_end)}
                                {schedule.weekly_off != null &&
                                  ` · off ${DOW_LABELS[schedule.weekly_off]}`}
                                {` · grace ${schedule.late_grace_min}m`}
                                {exceptions.length > 0 && ` · ${exceptions.length} exception${exceptions.length === 1 ? '' : 's'}`}
                              </span>
                            ) : (
                              <Badge tone="warning">No schedule</Badge>
                            )}
                            <button
                              type="button"
                              onClick={() => setScheduleTarget(d)}
                              className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium text-brand hover:bg-brand-soft"
                            >
                              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                              Edit schedule
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {archived ? (
                              <button
                                type="button"
                                onClick={() => restore(d)}
                                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
                                aria-label={`Restore ${d.name}`}
                                title="Restore to active"
                              >
                                <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => archive(d)}
                                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
                                aria-label={`Archive ${d.name}`}
                                title="Archive — history stays queryable"
                              >
                                <Archive className="h-4 w-4" aria-hidden="true" />
                              </button>
                            )}
                            {role === 'admin' && (
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(d)}
                                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
                                aria-label={`Delete ${d.name} permanently`}
                                title="Hard delete (admin only)"
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      {/* ── Effective-dated schedule drawer (§8.3) ── */}
      <Drawer
        open={scheduleTarget != null}
        onClose={() => setScheduleTarget(null)}
        title={scheduleTarget ? `Schedule — ${scheduleTarget.name}` : 'Schedule'}
      >
        {scheduleTarget && (
          <ScheduleEditor
            key={scheduleTarget.id}
            designer={scheduleTarget}
            exceptions={ctx.exceptions.filter((e) => e.designer_id === scheduleTarget.id)}
            current={scheduleFor(ctx.schedules, scheduleTarget.id, today)}
            onDone={() => setScheduleTarget(null)}
            onInvalidate={invalidateRoster}
          />
        )}
      </Drawer>

      {/* ── Add designer drawer ── */}
      <Drawer open={addOpen} onClose={() => setAddOpen(false)} title="Add designer">
        <AddDesignerForm
          onDone={() => setAddOpen(false)}
          onInvalidate={invalidateRoster}
        />
      </Drawer>

      {/* ── Hard delete — the one confirm dialog this page is allowed (§20.6) ── */}
      <ConfirmDialog
        open={deleteTarget != null}
        title={deleteTarget ? `Delete ${deleteTarget.name} permanently?` : 'Delete designer'}
        body="Archive is the default exit — an archived designer keeps every task, metric and attendance row queryable (§8.2). Delete hides them everywhere and is meant for rare mistakes only. This cannot be undone from the UI."
        confirmLabel="Delete designer"
        destructive
        onConfirm={() => {
          if (deleteTarget) {
            statusMutation.mutate(
              { id: deleteTarget.id, status: 'deleted' },
              { onSuccess: () => toast({ message: `${deleteTarget.name} deleted` }) },
            )
          }
          setDeleteTarget(null)
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

// ── Schedule editor (effective-dated) + quota exceptions ─────────────────────

function ScheduleEditor({
  designer,
  current,
  exceptions,
  onDone,
  onInvalidate,
}: {
  designer: Designer
  current: ReturnType<typeof scheduleFor>
  exceptions: QuotaException[]
  onDone: () => void
  onInvalidate: () => void
}) {
  const toast = useToast()
  const today = pktToday()
  const [form, setForm] = useState<ScheduleForm>({
    effective_from: today,
    daily_quota: String(current?.daily_quota ?? 3),
    shift_start: (current?.shift_start ?? '18:00:00').slice(0, 5),
    shift_end: (current?.shift_end ?? '02:00:00').slice(0, 5),
    weekly_off: current?.weekly_off != null ? String(current.weekly_off) : '',
    late_grace_min: String(current?.late_grace_min ?? 15),
    early_leave_grace_min: String(current?.early_leave_grace_min ?? 15),
  })
  const [exDate, setExDate] = useState(today)
  const [exQuota, setExQuota] = useState('')
  const [exReason, setExReason] = useState('')

  const scheduleMutation = useMutation({
    mutationFn: () =>
      applyScheduleChange({
        designer_id: designer.id,
        effective_from: form.effective_from,
        daily_quota: Number(form.daily_quota) || 0,
        shift_start: form.shift_start,
        shift_end: form.shift_end,
        weekly_off: form.weekly_off === '' ? null : Number(form.weekly_off),
        late_grace_min: Number(form.late_grace_min) || 15,
        early_leave_grace_min: Number(form.early_leave_grace_min) || 15,
      }),
    onSuccess: () => {
      onInvalidate()
      toast({
        message: `Schedule for ${designer.name} applies from ${fmtDate(form.effective_from)} — history keeps the old numbers`,
      })
      onDone()
    },
    onError: (e: Error) => toast({ message: `Couldn't save schedule — ${e.message}` }),
  })

  const exceptionAdd = useMutation({
    mutationFn: () =>
      upsertQuotaException({
        designer_id: designer.id,
        the_date: exDate,
        daily_quota: Number(exQuota),
        reason: exReason || undefined,
      }),
    onSuccess: () => {
      onInvalidate()
      toast({ message: `Quota exception added for ${fmtDate(exDate)}` })
      setExQuota('')
      setExReason('')
    },
    onError: (e: Error) => toast({ message: `Couldn't add exception — ${e.message}` }),
  })

  const exceptionDelete = useMutation({
    mutationFn: (id: string) => deleteQuotaException(id),
    onSuccess: () => onInvalidate(),
    onError: (e: Error) => toast({ message: `Couldn't remove exception — ${e.message}` }),
  })

  const removeException = (ex: QuotaException) => {
    exceptionDelete.mutate(ex.id, {
      onSuccess: () =>
        toast({
          message: `Exception for ${fmtDate(ex.the_date)} removed`,
          undo: async () => {
            await upsertQuotaException({
              designer_id: ex.designer_id,
              the_date: ex.the_date,
              daily_quota: ex.daily_quota,
              reason: ex.reason ?? undefined,
            })
            onInvalidate()
          },
        }),
    })
  }

  const inputCls =
    'mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg focus:outline-none'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    scheduleMutation.mutate()
  }

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">
          Effective-dated (§8.3): saving opens a <strong className="text-fg">new</strong> schedule
          row from the date below and closes the current one — last month's attainment stays judged
          against last month's quota. Name edits never recompute; schedule edits recompute the
          affected range.
        </p>
        <label className="block text-sm font-medium text-fg">
          Effective from
          <input
            type="date"
            required
            value={form.effective_from}
            onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
            className={inputCls}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-fg">
            Daily quota
            <input
              type="number"
              min={0}
              required
              value={form.daily_quota}
              onChange={(e) => setForm({ ...form, daily_quota: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="block text-sm font-medium text-fg">
            Weekly off
            <select
              value={form.weekly_off}
              onChange={(e) => setForm({ ...form, weekly_off: e.target.value })}
              className={inputCls}
            >
              <option value="">None</option>
              {DOW_LABELS.map((label, i) => (
                <option key={label} value={String(i)}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-fg">
            Shift start (PKT)
            <input
              type="time"
              required
              value={form.shift_start}
              onChange={(e) => setForm({ ...form, shift_start: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="block text-sm font-medium text-fg">
            Shift end (PKT)
            <input
              type="time"
              required
              value={form.shift_end}
              onChange={(e) => setForm({ ...form, shift_end: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="block text-sm font-medium text-fg">
            Late grace (min)
            <input
              type="number"
              min={0}
              value={form.late_grace_min}
              onChange={(e) => setForm({ ...form, late_grace_min: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="block text-sm font-medium text-fg">
            Early-leave grace (min)
            <input
              type="number"
              min={0}
              value={form.early_leave_grace_min}
              onChange={(e) => setForm({ ...form, early_leave_grace_min: e.target.value })}
              className={inputCls}
            />
          </label>
        </div>
        {form.shift_end <= form.shift_start && (
          <p className="text-xs text-muted">
            Shift end ≤ start — treated as an overnight shift; the whole night counts on the day it
            starts (§9.2).
          </p>
        )}
        <button
          type="submit"
          disabled={scheduleMutation.isPending}
          className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          Apply from {fmtDate(form.effective_from)}
        </button>
      </form>

      {/* ── Quota exceptions (specific-date overrides, §8.4) ── */}
      <section>
        <h3 className="eyebrow">Quota exceptions</h3>
        <p className="mt-1 text-xs text-muted">
          Specific-date overrides (e.g. reduced Fridays). They beat the schedule quota on that date
          only.
        </p>
        <ul className="mt-3 space-y-1.5">
          {exceptions.length === 0 && (
            <li className="text-sm text-muted">None — the schedule quota applies every day.</li>
          )}
          {[...exceptions]
            .sort((a, b) => b.the_date.localeCompare(a.the_date))
            .map((ex) => (
              <li
                key={ex.id}
                className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm"
              >
                <span className="tnum">
                  {fmtDate(ex.the_date)} → {ex.daily_quota}/day
                  {ex.reason && <span className="text-muted"> · {ex.reason}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => removeException(ex)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
                  aria-label={`Remove exception on ${fmtDate(ex.the_date)}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (exQuota !== '') exceptionAdd.mutate()
          }}
          className="mt-3 flex flex-wrap items-end gap-2"
        >
          <label className="block text-xs font-medium text-muted">
            Date
            <input type="date" required value={exDate} onChange={(e) => setExDate(e.target.value)} className={inputCls} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Quota
            <input
              type="number"
              min={0}
              required
              value={exQuota}
              onChange={(e) => setExQuota(e.target.value)}
              className={`${inputCls} w-20`}
            />
          </label>
          <label className="block min-w-[8rem] flex-1 text-xs font-medium text-muted">
            Reason
            <input
              type="text"
              value={exReason}
              onChange={(e) => setExReason(e.target.value)}
              placeholder="optional"
              className={inputCls}
            />
          </label>
          <button
            type="submit"
            disabled={exceptionAdd.isPending}
            className="inline-flex min-h-[2.75rem] items-center gap-1 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add
          </button>
        </form>
      </section>
    </div>
  )
}

// ── Add designer ──────────────────────────────────────────────────────────────

function AddDesignerForm({ onDone, onInvalidate }: { onDone: () => void; onInvalidate: () => void }) {
  const toast = useToast()
  const today = pktToday()
  const [name, setName] = useState('')
  const [team, setTeam] = useState<Team>('Logo')
  const [specialty, setSpecialty] = useState('')
  const [listId, setListId] = useState('')
  const [userId, setUserId] = useState('')
  const [quota, setQuota] = useState('3')
  const [shiftStart, setShiftStart] = useState('18:00')
  const [shiftEnd, setShiftEnd] = useState('02:00')
  const [weeklyOff, setWeeklyOff] = useState('0')

  const createMutation = useMutation({
    mutationFn: async () => {
      const created = await upsertDesigner({
        name: name.trim(),
        team,
        specialty: specialty.trim() || null,
        clickup_list_id: listId.trim() || null,
        clickup_user_id: userId.trim() === '' ? null : Number(userId),
      })
      await applyScheduleChange({
        designer_id: created.id,
        effective_from: today,
        daily_quota: Number(quota) || 0,
        shift_start: shiftStart,
        shift_end: shiftEnd,
        weekly_off: weeklyOff === '' ? null : Number(weeklyOff),
      })
      return created
    },
    onSuccess: (created) => {
      onInvalidate()
      toast({ message: `${created.name} added to the ${team} team` })
      onDone()
    },
    onError: (e: Error) => toast({ message: `Couldn't add designer — ${e.message}` }),
  })

  const inputCls =
    'mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg focus:outline-none'

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) createMutation.mutate()
      }}
      className="space-y-4"
    >
      <label className="block text-sm font-medium text-fg">
        Name
        <input type="text" required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm font-medium text-fg">
          Team
          <select value={team} onChange={(e) => setTeam(e.target.value as Team)} className={inputCls}>
            {TEAMS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-fg">
          Specialty
          <input type="text" value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="optional" className={inputCls} />
        </label>
        <label className="block text-sm font-medium text-fg">
          ClickUp list id
          <input type="text" value={listId} onChange={(e) => setListId(e.target.value)} placeholder="e.g. 901811577312" className={inputCls} />
        </label>
        <label className="block text-sm font-medium text-fg">
          ClickUp user id
          <input type="number" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="optional" className={inputCls} />
        </label>
      </div>
      <fieldset className="rounded-xl border border-border p-3">
        <legend className="px-1 text-xs font-medium text-muted">Initial schedule (from today)</legend>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-fg">
            Daily quota
            <input type="number" min={0} required value={quota} onChange={(e) => setQuota(e.target.value)} className={inputCls} />
          </label>
          <label className="block text-sm font-medium text-fg">
            Weekly off
            <select value={weeklyOff} onChange={(e) => setWeeklyOff(e.target.value)} className={inputCls}>
              <option value="">None</option>
              {DOW_LABELS.map((label, i) => (
                <option key={label} value={String(i)}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-fg">
            Shift start (PKT)
            <input type="time" required value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className={inputCls} />
          </label>
          <label className="block text-sm font-medium text-fg">
            Shift end (PKT)
            <input type="time" required value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} className={inputCls} />
          </label>
        </div>
      </fieldset>
      <button
        type="submit"
        disabled={createMutation.isPending}
        className="inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
      >
        <UserPlus className="h-4 w-4" aria-hidden="true" />
        Add designer
      </button>
    </form>
  )
}
