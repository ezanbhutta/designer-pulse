import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Minus, Moon, Plus, Trash2 } from 'lucide-react'
import { InfoTip } from '../../../components/ui/InfoTip'
import { useToast } from '../../../components/ui/ToastProvider'
import { useAuth } from '../../../hooks/useAuth'
import {
  applyScheduleChange,
  clickupListUrl,
  deleteQuotaException,
  qk,
  setDesignerStatus,
  upsertDesigner,
  upsertQuotaException,
} from '../../../lib/queries'
import { DOW_LABELS, fmtDate } from '../../../lib/format'
import { pktToday } from '../../../../shared/pkt'
import type {
  Designer,
  DesignerSchedule,
  QuotaException,
  Team,
} from '../../../../shared/types'

export const TEAMS: Team[] = ['Logo', 'Branding', 'Animation', 'PPT', 'Canva']

const QUOTA_MIN = 1
const QUOTA_MAX = 12

const clampQuota = (n: number) =>
  Math.min(QUOTA_MAX, Math.max(QUOTA_MIN, Math.round(Number.isFinite(n) ? n : 3)))
const clampGrace = (n: number) =>
  Math.min(240, Math.max(0, Math.round(Number.isFinite(n) ? n : 15)))

const inputCls = (invalid?: boolean) =>
  `mt-1.5 block w-full min-h-11 rounded-xl border bg-surface px-3 text-caption text-fg placeholder:text-muted/70 ${
    invalid ? 'border-danger' : 'border-border'
  }`

// ── Labeled field with plain-English tip + inline error (§20.7) ──────────────

function Field({
  id,
  label,
  required,
  tip,
  hint,
  error,
  trailing,
  children,
}: {
  id: string
  label: string
  required?: boolean
  tip?: string
  hint?: string
  error?: string
  trailing?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="flex items-center gap-1.5 text-caption font-medium text-fg">
          {label}
          {required && (
            <span className="text-muted" aria-hidden="true">
              *
            </span>
          )}
          {tip && <InfoTip text={tip} label={`About ${label}`} />}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-label text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-label font-normal leading-relaxed tracking-normal text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

function SectionHeading({ title, tip }: { title: string; tip: string }) {
  return (
    <h3 className="eyebrow flex items-center gap-1.5">
      {title}
      <InfoTip text={tip} label={`About ${title}`} />
    </h3>
  )
}

// ── The drawer body: every designer input in one place ───────────────────────

interface EditorForm {
  name: string
  team: Team
  specialty: string
  order_index: string
  clickup_list_id: string
  clickup_user_id: string
  daily_quota: string
  shift_start: string // 'HH:MM'
  shift_end: string
  weekly_off: number | null
  late_grace: string
  early_grace: string
  effective_from: string
}

type ErrorKey =
  | 'name'
  | 'clickup_list_id'
  | 'clickup_user_id'
  | 'shift_start'
  | 'shift_end'
  | 'effective_from'
type FieldErrors = Partial<Record<ErrorKey, string>>

export interface DesignerEditorProps {
  /** null = add a new designer. */
  designer: Designer | null
  /** Pre-selected team when adding from a team section. */
  initialTeam?: Team
  currentSchedule: DesignerSchedule | null
  exceptions: QuotaException[]
  /** Scroll + focus a section on open (the "Link list" / Fix paths). */
  focusSection?: 'clickup' | 'schedule'
  /** Reports whether the form differs from its opening snapshot, so the
   * drawer can guard Esc/overlay-close behind a discard confirmation. */
  onDirtyChange?: (dirty: boolean) => void
  onClose: () => void
  onRequestDelete: (d: Designer) => void
}

/**
 * The one place every designer input lives (the "easy" part of the brief):
 * identity, ClickUp link, effective-dated work schedule (§8.3), and special
 * days. Save = upsertDesigner + applyScheduleChange when the schedule
 * actually changed (or the designer is new).
 */
export function DesignerEditor({
  designer,
  initialTeam,
  currentSchedule,
  exceptions,
  focusSection,
  onDirtyChange,
  onClose,
  onRequestDelete,
}: DesignerEditorProps) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { role } = useAuth()
  const today = pktToday()
  const uid = useId()

  const [form, setForm] = useState<EditorForm>(() => ({
    name: designer?.name ?? '',
    team: designer?.team ?? initialTeam ?? 'Logo',
    specialty: designer?.specialty ?? '',
    order_index: String(designer?.order_index ?? 0),
    clickup_list_id: designer?.clickup_list_id ?? '',
    clickup_user_id: designer?.clickup_user_id != null ? String(designer.clickup_user_id) : '',
    daily_quota: String(currentSchedule?.daily_quota ?? 3),
    shift_start: (currentSchedule?.shift_start ?? '18:00:00').slice(0, 5),
    shift_end: (currentSchedule?.shift_end ?? '02:00:00').slice(0, 5),
    weekly_off: currentSchedule?.weekly_off ?? null,
    late_grace: String(currentSchedule?.late_grace_min ?? 15),
    early_grace: String(currentSchedule?.early_leave_grace_min ?? 15),
    effective_from: today,
  }))
  const [errors, setErrors] = useState<FieldErrors>({})

  const patch = (p: Partial<EditorForm>) => setForm((f) => ({ ...f, ...p }))

  // Field refs so the first invalid field gets focus on save (§20.7).
  const nameRef = useRef<HTMLInputElement>(null)
  const listIdRef = useRef<HTMLInputElement>(null)
  const userIdRef = useRef<HTMLInputElement>(null)
  const shiftStartRef = useRef<HTMLInputElement>(null)
  const shiftEndRef = useRef<HTMLInputElement>(null)
  const effectiveFromRef = useRef<HTMLInputElement>(null)
  const quotaRef = useRef<HTMLInputElement>(null)
  const clickupSectionRef = useRef<HTMLElement>(null)
  const scheduleSectionRef = useRef<HTMLElement>(null)

  const fieldRefs: Record<ErrorKey, RefObject<HTMLInputElement>> = {
    name: nameRef,
    clickup_list_id: listIdRef,
    clickup_user_id: userIdRef,
    shift_start: shiftStartRef,
    shift_end: shiftEndRef,
    effective_from: effectiveFromRef,
  }

  // "Link list" / attention-strip Fix: scroll to the right section and focus
  // its first input, after the Drawer's own focus handoff has run.
  useEffect(() => {
    if (!focusSection) return
    const t = setTimeout(() => {
      const target =
        focusSection === 'clickup' ? clickupSectionRef.current : scheduleSectionRef.current
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      target?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
      if (focusSection === 'clickup') listIdRef.current?.focus({ preventScroll: true })
      else quotaRef.current?.focus({ preventScroll: true })
    }, 120)
    return () => clearTimeout(t)
  }, [focusSection])

  const invalidateRoster = () => {
    void queryClient.invalidateQueries({ queryKey: qk.designers })
    void queryClient.invalidateQueries({ queryKey: qk.schedules })
    void queryClient.invalidateQueries({ queryKey: qk.quotaExceptions })
  }

  const overnight =
    form.shift_start !== '' && form.shift_end !== '' && form.shift_end <= form.shift_start

  const trimmedListId = form.clickup_list_id.trim()
  const listUrl = /^\d{4,}$/.test(trimmedListId) ? clickupListUrl(trimmedListId) : null

  // Only open a new schedule period when a schedule field actually changed —
  // renaming someone must never recompute history (§8.3).
  const scheduleChanged = useMemo(() => {
    if (!currentSchedule) return true
    const graceOr = (raw: string, fallback: number) =>
      raw.trim() === '' ? fallback : clampGrace(Number(raw))
    return (
      clampQuota(Number(form.daily_quota)) !== currentSchedule.daily_quota ||
      form.shift_start !== currentSchedule.shift_start.slice(0, 5) ||
      form.shift_end !== currentSchedule.shift_end.slice(0, 5) ||
      (form.weekly_off ?? null) !== (currentSchedule.weekly_off ?? null) ||
      graceOr(form.late_grace, 15) !== currentSchedule.late_grace_min ||
      graceOr(form.early_grace, 15) !== currentSchedule.early_leave_grace_min
    )
  }, [form, currentSchedule])

  // ── Save ────────────────────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: async () => {
      const saved = await upsertDesigner({
        ...(designer ?? {}),
        name: form.name.trim(),
        team: form.team,
        specialty: form.specialty.trim() || null,
        clickup_list_id: trimmedListId || null,
        clickup_user_id: form.clickup_user_id.trim() === '' ? null : Number(form.clickup_user_id),
        order_index: Math.max(0, Math.round(Number(form.order_index) || 0)),
      })
      if (!designer || scheduleChanged) {
        await applyScheduleChange({
          designer_id: saved.id,
          effective_from: form.effective_from,
          daily_quota: clampQuota(Number(form.daily_quota)),
          shift_start: form.shift_start,
          shift_end: form.shift_end,
          weekly_off: form.weekly_off,
          late_grace_min: form.late_grace.trim() === '' ? 15 : clampGrace(Number(form.late_grace)),
          early_leave_grace_min:
            form.early_grace.trim() === '' ? 15 : clampGrace(Number(form.early_grace)),
        })
      }
      return saved
    },
    onSuccess: (saved) => {
      invalidateRoster()
      toast({
        message: designer
          ? scheduleChanged
            ? `${saved.name} saved — new schedule starts ${fmtDate(form.effective_from)}`
            : `${saved.name} saved`
          : `${saved.name} added to the ${form.team} team`,
      })
      onClose()
    },
    onError: (e: Error) => toast({ message: `Couldn't save — ${e.message}` }),
  })

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const errs: FieldErrors = {}
    if (!form.name.trim()) errs.name = 'Please enter a name.'
    if (trimmedListId && !/^\d+$/.test(trimmedListId))
      errs.clickup_list_id = 'List IDs are numbers only — copy it from the list URL.'
    const userId = form.clickup_user_id.trim()
    if (userId && !/^\d+$/.test(userId)) errs.clickup_user_id = 'User IDs are numbers only.'
    if (!form.shift_start) errs.shift_start = 'Please pick a start time.'
    if (!form.shift_end) errs.shift_end = 'Please pick an end time.'
    if (!form.effective_from) errs.effective_from = 'Please pick a date.'
    setErrors(errs)
    const firstInvalid = (
      [
        'name',
        'clickup_list_id',
        'clickup_user_id',
        'shift_start',
        'shift_end',
        'effective_from',
      ] as const
    ).find((k) => errs[k])
    if (firstInvalid) {
      fieldRefs[firstInvalid].current?.focus()
      return
    }
    if (!saveMutation.isPending) saveMutation.mutate()
  }

  // Cmd/Ctrl+Enter saves from anywhere in the form (§20.6 keyboard-first).
  const onFormKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  // ── Archive / restore (undo toast, §20.6) ───────────────────────────────────

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'archived' }) =>
      setDesignerStatus(id, status),
    onSuccess: () => invalidateRoster(),
    onError: (e: Error) => toast({ message: `Couldn't update — ${e.message}` }),
  })

  const archive = () => {
    if (!designer) return
    statusMutation.mutate(
      { id: designer.id, status: 'archived' },
      {
        onSuccess: () => {
          toast({
            message: `${designer.name} archived — their history stays`,
            undo: () => statusMutation.mutate({ id: designer.id, status: 'active' }),
          })
          onClose()
        },
      },
    )
  }

  const restore = () => {
    if (!designer) return
    statusMutation.mutate(
      { id: designer.id, status: 'active' },
      {
        onSuccess: () => {
          toast({
            message: `${designer.name} is active again`,
            undo: () => statusMutation.mutate({ id: designer.id, status: 'archived' }),
          })
          onClose()
        },
      },
    )
  }

  // ── Special days (quota exceptions — existing designers only) ───────────────

  const [exDate, setExDate] = useState(today)
  const [exQuota, setExQuota] = useState('')
  const [exReason, setExReason] = useState('')
  const exQuotaRef = useRef<HTMLInputElement>(null)

  // Dirty tracking for the drawer's discard guard (§20.6 — never lose typed
  // work silently): compare the form and any typed special-day draft against
  // the snapshot taken when the drawer opened.
  const initialFormRef = useRef(form)
  const dirty =
    exQuota.trim() !== '' ||
    exReason.trim() !== '' ||
    (Object.keys(form) as (keyof EditorForm)[]).some(
      (k) => form[k] !== initialFormRef.current[k],
    )
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const exceptionAdd = useMutation({
    mutationFn: () =>
      upsertQuotaException({
        designer_id: designer?.id ?? '',
        the_date: exDate,
        daily_quota: Math.min(QUOTA_MAX, Math.max(0, Math.round(Number(exQuota)))),
        reason: exReason.trim() || undefined,
      }),
    onSuccess: () => {
      invalidateRoster()
      toast({ message: `Special day added for ${fmtDate(exDate)}` })
      setExQuota('')
      setExReason('')
    },
    onError: (e: Error) => toast({ message: `Couldn't add — ${e.message}` }),
  })

  const exceptionDelete = useMutation({
    mutationFn: (id: string) => deleteQuotaException(id),
    onSuccess: () => invalidateRoster(),
    onError: (e: Error) => toast({ message: `Couldn't remove — ${e.message}` }),
  })

  const addException = () => {
    if (!designer) return
    if (exQuota.trim() === '' || !exDate) {
      exQuotaRef.current?.focus()
      return
    }
    if (!exceptionAdd.isPending) exceptionAdd.mutate()
  }

  const removeException = (ex: QuotaException) => {
    exceptionDelete.mutate(ex.id, {
      onSuccess: () =>
        toast({
          message: `Special day on ${fmtDate(ex.the_date)} removed`,
          undo: async () => {
            await upsertQuotaException({
              designer_id: ex.designer_id,
              the_date: ex.the_date,
              daily_quota: ex.daily_quota,
              reason: ex.reason ?? undefined,
            })
            invalidateRoster()
          },
        }),
    })
  }

  // ── Small controls ──────────────────────────────────────────────────────────

  const stepQuota = (delta: number) =>
    patch({ daily_quota: String(clampQuota((Number(form.daily_quota) || 0) + delta)) })
  const quotaNow = Number(form.daily_quota)

  const dayChip = (active: boolean) =>
    `min-h-11 rounded-xl border px-3 text-caption font-medium transition-colors duration-150 ease-out motion-safe:active:scale-[0.97] ${
      active
        ? 'border-brand bg-brand-soft text-brand'
        : 'border-border bg-surface text-muted hover:text-fg'
    }`

  const id = (k: string) => `${uid}-${k}`

  return (
    <form noValidate onSubmit={submit} onKeyDown={onFormKeyDown} className="flex min-h-full flex-col">
      <div className="flex-1 space-y-8 pb-8">
        {/* subtitle: the team */}
        <p className="eyebrow -mt-1">{form.team} team</p>

        {/* ── 1 · Who they are ── */}
        <section aria-label="Who they are" className="space-y-4">
          <SectionHeading title="Who they are" tip="Their name, team, and what they make." />
          <Field id={id('name')} label="Name" required error={errors.name}>
            <input
              ref={nameRef}
              id={id('name')}
              type="text"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? `${id('name')}-error` : undefined}
              className={inputCls(!!errors.name)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id={id('team')} label="Team" required>
              <select
                id={id('team')}
                value={form.team}
                onChange={(e) => patch({ team: e.target.value as Team })}
                className={inputCls()}
              >
                {TEAMS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id={id('specialty')}
              label="Specialty"
              tip="What kind of work they do — shown under their name in the list."
            >
              <input
                id={id('specialty')}
                type="text"
                value={form.specialty}
                onChange={(e) => patch({ specialty: e.target.value })}
                placeholder="e.g. 3-concept logos"
                className={inputCls()}
              />
            </Field>
          </div>
          <Field
            id={id('order')}
            label="Display order"
            tip="Where they appear on the roster page — lower numbers show first."
            hint="Lower numbers show higher in the list."
          >
            <input
              id={id('order')}
              type="number"
              min={0}
              value={form.order_index}
              onChange={(e) => patch({ order_index: e.target.value })}
              onBlur={() =>
                patch({ order_index: String(Math.max(0, Math.round(Number(form.order_index) || 0))) })
              }
              aria-describedby={`${id('order')}-hint`}
              // max-width wins over the recipe's w-full — a 1–2 digit field
              // must not stretch across the whole drawer.
              className={`${inputCls()} tnum max-w-[7rem]`}
            />
          </Field>
        </section>

        {/* ── 2 · ClickUp ── */}
        <section ref={clickupSectionRef} aria-label="ClickUp" className="scroll-mt-4 space-y-4">
          <SectionHeading
            title="ClickUp"
            tip="Connects this person to their task list in ClickUp so their work is counted."
          />
          <Field
            id={id('list')}
            label="List ID"
            tip="The number of this person's task list in ClickUp. If the list has exactly the same name as the person, it connects by itself."
            hint="Lists named exactly after the designer connect by themselves within 15 minutes — only needed when the names differ."
            error={errors.clickup_list_id}
            trailing={
              listUrl ? (
                <a
                  href={listUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-label text-brand underline-offset-2 hover:underline"
                >
                  Open list ↗
                </a>
              ) : undefined
            }
          >
            <input
              ref={listIdRef}
              id={id('list')}
              type="text"
              inputMode="numeric"
              value={form.clickup_list_id}
              onChange={(e) => patch({ clickup_list_id: e.target.value })}
              placeholder="e.g. 901811577312"
              aria-invalid={errors.clickup_list_id ? true : undefined}
              aria-describedby={
                errors.clickup_list_id ? `${id('list')}-error` : `${id('list')}-hint`
              }
              className={`${inputCls(!!errors.clickup_list_id)} tnum`}
            />
          </Field>
          <Field
            id={id('user')}
            label="User ID"
            tip="Their personal ID in ClickUp — used to match tasks assigned to them."
            hint="Optional — for assignee matching."
            error={errors.clickup_user_id}
          >
            <input
              ref={userIdRef}
              id={id('user')}
              type="number"
              min={0}
              value={form.clickup_user_id}
              onChange={(e) => patch({ clickup_user_id: e.target.value })}
              placeholder="e.g. 101464943"
              aria-invalid={errors.clickup_user_id ? true : undefined}
              aria-describedby={
                errors.clickup_user_id ? `${id('user')}-error` : `${id('user')}-hint`
              }
              className={`${inputCls(!!errors.clickup_user_id)} tnum`}
            />
          </Field>
        </section>

        {/* ── 3 · Work schedule (effective-dated, §8.3) ── */}
        <section ref={scheduleSectionRef} aria-label="Work schedule" className="scroll-mt-4 space-y-4">
          <SectionHeading
            title="Work schedule"
            tip="Their daily target and work hours. Changes start from a date you pick — past days keep their old numbers."
          />
          <Field
            id={id('quota')}
            label="Daily target"
            required
            tip="How many new projects this person should take each day. It's a floor, not a ceiling."
          >
            <div className="mt-1.5 inline-flex items-stretch overflow-hidden rounded-xl border border-border bg-surface">
              <button
                type="button"
                onClick={() => stepQuota(-1)}
                disabled={quotaNow <= QUOTA_MIN}
                aria-label="Lower the daily target"
                className="flex h-11 w-11 items-center justify-center text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg disabled:opacity-40"
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
              </button>
              <input
                ref={quotaRef}
                id={id('quota')}
                type="text"
                inputMode="numeric"
                value={form.daily_quota}
                onChange={(e) => patch({ daily_quota: e.target.value })}
                onBlur={() => patch({ daily_quota: String(clampQuota(Number(form.daily_quota))) })}
                className="tnum w-14 border-x border-border bg-transparent text-center text-caption text-fg"
              />
              <button
                type="button"
                onClick={() => stepQuota(1)}
                disabled={quotaNow >= QUOTA_MAX}
                aria-label="Raise the daily target"
                className="flex h-11 w-11 items-center justify-center text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg disabled:opacity-40"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </Field>
          <div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                id={id('start')}
                label="Work starts"
                required
                tip="All times are Pakistan time — the whole team works to one clock."
                error={errors.shift_start}
              >
                <input
                  ref={shiftStartRef}
                  id={id('start')}
                  type="time"
                  value={form.shift_start}
                  onChange={(e) => patch({ shift_start: e.target.value })}
                  aria-invalid={errors.shift_start ? true : undefined}
                  aria-describedby={errors.shift_start ? `${id('start')}-error` : undefined}
                  className={`${inputCls(!!errors.shift_start)} tnum`}
                />
              </Field>
              <Field id={id('end')} label="Work ends" required error={errors.shift_end}>
                <input
                  ref={shiftEndRef}
                  id={id('end')}
                  type="time"
                  value={form.shift_end}
                  onChange={(e) => patch({ shift_end: e.target.value })}
                  aria-invalid={errors.shift_end ? true : undefined}
                  aria-describedby={errors.shift_end ? `${id('end')}-error` : undefined}
                  className={`${inputCls(!!errors.shift_end)} tnum`}
                />
              </Field>
            </div>
            {overnight && (
              <p className="mt-2 flex items-center gap-1.5 text-label font-normal tracking-normal text-muted">
                <Moon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Overnight — they work past midnight, so the day ends on the next date.
              </p>
            )}
          </div>
          <div>
            <span className="flex items-center gap-1.5 text-caption font-medium text-fg">
              Day off
              <InfoTip
                text="Their day off each week. That day never counts against them."
                label="About Day off"
              />
            </span>
            <div role="group" aria-label="Day off" className="mt-1.5 flex flex-wrap gap-1.5">
              <button
                type="button"
                aria-pressed={form.weekly_off === null}
                onClick={() => patch({ weekly_off: null })}
                className={dayChip(form.weekly_off === null)}
              >
                None
              </button>
              {DOW_LABELS.map((label, i) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={form.weekly_off === i}
                  onClick={() => patch({ weekly_off: form.weekly_off === i ? null : i })}
                  className={dayChip(form.weekly_off === i)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              id={id('late')}
              label="Late allowance (min)"
              tip="How many minutes late they can check in before it counts as late."
            >
              <input
                id={id('late')}
                type="number"
                min={0}
                max={240}
                value={form.late_grace}
                onChange={(e) => patch({ late_grace: e.target.value })}
                onBlur={() =>
                  form.late_grace.trim() !== '' &&
                  patch({ late_grace: String(clampGrace(Number(form.late_grace))) })
                }
                placeholder="15"
                className={`${inputCls()} tnum`}
              />
            </Field>
            <Field
              id={id('early')}
              label="Early-leave allowance (min)"
              tip="How many minutes early they can leave before it counts as leaving early."
            >
              <input
                id={id('early')}
                type="number"
                min={0}
                max={240}
                value={form.early_grace}
                onChange={(e) => patch({ early_grace: e.target.value })}
                onBlur={() =>
                  form.early_grace.trim() !== '' &&
                  patch({ early_grace: String(clampGrace(Number(form.early_grace))) })
                }
                placeholder="15"
                className={`${inputCls()} tnum`}
              />
            </Field>
          </div>
          <Field
            id={id('from')}
            label="Starts from"
            required
            tip="The date these new numbers start counting. Old days keep the old numbers."
            hint="Schedule changes start a new period — past days stay judged against the old numbers."
            error={errors.effective_from}
          >
            <input
              ref={effectiveFromRef}
              id={id('from')}
              type="date"
              value={form.effective_from}
              onChange={(e) => patch({ effective_from: e.target.value })}
              aria-invalid={errors.effective_from ? true : undefined}
              aria-describedby={
                errors.effective_from ? `${id('from')}-error` : `${id('from')}-hint`
              }
              className={`${inputCls(!!errors.effective_from)} tnum`}
            />
          </Field>
          {designer && !scheduleChanged && (
            <p className="text-label font-normal tracking-normal text-muted">
              Schedule unchanged — saving keeps the current period.
            </p>
          )}
        </section>

        {/* ── 4 · Special days (existing designers only) ── */}
        {designer && (
          <section
            aria-label="Special days"
            className="space-y-4"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
                e.preventDefault()
                addException()
              }
            }}
          >
            <SectionHeading
              title="Special days"
              tip="One-day changes to the daily target — for example a lighter Friday. They beat the schedule on that date only."
            />
            <p className="text-label font-normal leading-relaxed tracking-normal text-muted">
              One-off overrides — e.g. a reduced Friday.
            </p>
            <ul className="space-y-1.5">
              {exceptions.length === 0 && (
                <li className="text-caption text-muted">None — the daily target applies every day.</li>
              )}
              {[...exceptions]
                .sort((a, b) => b.the_date.localeCompare(a.the_date))
                .map((ex) => (
                  <li
                    key={ex.id}
                    className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-1.5 text-caption"
                  >
                    <span className="tnum min-w-0 truncate">
                      {fmtDate(ex.the_date)} → {ex.daily_quota}/day
                      {ex.reason && <span className="text-muted"> · {ex.reason}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeException(ex)}
                      aria-label={`Remove the special day on ${fmtDate(ex.the_date)}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-danger-soft hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label htmlFor={id('exdate')} className="block text-label text-muted">
                  Date
                </label>
                <input
                  id={id('exdate')}
                  type="date"
                  value={exDate}
                  onChange={(e) => setExDate(e.target.value)}
                  className={`${inputCls()} tnum mt-1 w-auto`}
                />
              </div>
              <div>
                <label htmlFor={id('exquota')} className="block text-label text-muted">
                  Target
                </label>
                <input
                  ref={exQuotaRef}
                  id={id('exquota')}
                  type="number"
                  min={0}
                  max={QUOTA_MAX}
                  value={exQuota}
                  onChange={(e) => setExQuota(e.target.value)}
                  className={`${inputCls()} tnum mt-1 w-20`}
                />
              </div>
              <div className="min-w-[8rem] flex-1">
                <label htmlFor={id('exreason')} className="block text-label text-muted">
                  Reason
                </label>
                <input
                  id={id('exreason')}
                  type="text"
                  value={exReason}
                  onChange={(e) => setExReason(e.target.value)}
                  placeholder="optional"
                  className={`${inputCls()} mt-1`}
                />
              </div>
              <button
                type="button"
                onClick={addException}
                disabled={exceptionAdd.isPending}
                className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border bg-surface px-3 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2 disabled:opacity-50 motion-safe:active:scale-[0.97]"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add
              </button>
            </div>
          </section>
        )}
      </div>

      {/* ── Sticky footer ── */}
      <footer className="sticky bottom-0 z-10 -mx-6 -mb-5 border-t border-border bg-surface px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={saveMutation.isPending}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 text-caption font-semibold text-brand-fg transition-opacity duration-150 ease-out hover:opacity-90 disabled:opacity-50 motion-safe:active:scale-[0.98]"
          >
            Save
            <kbd
              aria-hidden="true"
              className="rounded-md border border-brand-fg/40 bg-transparent px-1.5 py-0.5 text-label opacity-90"
            >
              ⌘↵
            </kbd>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-caption font-medium text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg"
          >
            Cancel
            <kbd
              aria-hidden="true"
              className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-label text-muted"
            >
              Esc
            </kbd>
          </button>
          {designer && (
            <span className="ml-auto flex items-center gap-1">
              {designer.status === 'archived' ? (
                <button
                  type="button"
                  onClick={restore}
                  disabled={statusMutation.isPending}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-caption font-medium text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                >
                  <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                  Restore
                </button>
              ) : (
                <button
                  type="button"
                  onClick={archive}
                  disabled={statusMutation.isPending}
                  title="They leave the roster but their tasks and history stay."
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-caption font-medium text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                >
                  <Archive className="h-4 w-4" aria-hidden="true" />
                  Archive designer
                </button>
              )}
              {role === 'admin' && (
                <button
                  type="button"
                  onClick={() => onRequestDelete(designer)}
                  className="inline-flex min-h-11 items-center rounded-xl px-3 text-caption font-medium text-danger transition-colors duration-150 ease-out hover:bg-danger-soft"
                >
                  Delete permanently…
                </button>
              )}
            </span>
          )}
        </div>
      </footer>
    </form>
  )
}

export default DesignerEditor
