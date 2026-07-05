import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, CircleCheck, TriangleAlert, UserPlus } from 'lucide-react'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Drawer } from '../../components/ui/Drawer'
import { PageHeader } from '../../components/layout/PageHeader'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { InfoTip } from '../../components/ui/InfoTip'
import { Skeleton } from '../../components/ui/Skeleton'
import { useToast } from '../../components/ui/ToastProvider'
import { qk, setDesignerStatus } from '../../lib/queries'
import { fmtClock } from '../../lib/format'
import { pktToday } from '../../../shared/pkt'
import { scheduleFor } from '../../../shared/aggregate'
import type { Designer, DesignerSchedule, Team } from '../../../shared/types'
import { useDesignerDrawer, useDesigners, useQuotaCtx } from './opsData'
import { DesignerRow } from './roster/DesignerRow'
import { DesignerEditor, TEAMS } from './roster/DesignerEditor'

type EditorState =
  | { mode: 'add'; team: Team }
  | { mode: 'edit'; id: string; focus?: 'clickup' | 'schedule' }

interface AttentionIssue {
  designer: Designer
  unlinked: boolean
  unscheduled: boolean
}

/**
 * Roster (spec §8): the config source of truth ClickUp cannot hold. Verdict
 * first (§20.1 — the attention strip), teams as sections, one drawer for
 * every input, archive-with-undo as the default exit (§8.2, §20.6), hard
 * delete admin-only behind the one allowed confirm dialog.
 */
export default function OpsRoster() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const openDesigner = useDesignerDrawer()
  const today = pktToday()

  const designersQ = useDesigners()
  const { ctx, isLoading: ctxLoading } = useQuotaCtx()
  const isLoading = designersQ.isLoading || ctxLoading

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Designer | null>(null)
  // Discard guard (§20.6): Esc/overlay on a dirty 15-field form must never
  // silently throw the typed work away — a pristine form still closes freely.
  const [editorDirty, setEditorDirty] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const closeEditor = () => {
    setEditor(null)
    setEditorDirty(false)
    setConfirmDiscard(false)
  }

  const designers = useMemo(() => designersQ.data ?? [], [designersQ.data])
  const editingDesigner =
    editor?.mode === 'edit' ? (designers.find((d) => d.id === editor.id) ?? null) : null

  const scheduleOf = (d: Designer): DesignerSchedule | null =>
    scheduleFor(ctx.schedules, d.id, today)
  const exceptionCountOf = (d: Designer): number =>
    ctx.exceptions.filter((e) => e.designer_id === d.id).length

  // ── Header summary ("19 designers · 16 active · 3 not linked to ClickUp") ──
  const activeList = useMemo(() => designers.filter((d) => d.status === 'active'), [designers])
  const unlinkedCount = activeList.filter((d) => !d.clickup_list_id).length
  const summaryParts = [
    `${designers.length} designer${designers.length === 1 ? '' : 's'}`,
    `${activeList.length} active`,
  ]
  if (unlinkedCount > 0) summaryParts.push(`${unlinkedCount} not linked to ClickUp`)

  // ── Attention strip: config gaps the numbers silently depend on (§20.1) ────
  const attention = useMemo<AttentionIssue[]>(() => {
    if (isLoading) return []
    const issues: AttentionIssue[] = []
    for (const d of designers.filter((x) => x.status === 'active')) {
      const unlinked = !d.clickup_list_id
      const unscheduled = !scheduleFor(ctx.schedules, d.id, today)
      if (unlinked || unscheduled) issues.push({ designer: d, unlinked, unscheduled })
    }
    return issues
  }, [designers, ctx.schedules, today, isLoading])

  const issueText = (i: AttentionIssue): string => {
    if (i.unlinked && i.unscheduled)
      return `${i.designer.name} isn't linked to ClickUp and has no work schedule yet, so nothing is being tracked for them`
    if (i.unlinked) return `${i.designer.name} isn't linked to ClickUp yet, so their work isn't being tracked`
    return `${i.designer.name} has no work schedule yet, so their days and targets can't be counted`
  }

  // ── Hard delete — the one confirm dialog this page is allowed (§20.6) ──────
  const deleteMutation = useMutation({
    mutationFn: (id: string) => setDesignerStatus(id, 'deleted'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.designers })
      void queryClient.invalidateQueries({ queryKey: qk.schedules })
      void queryClient.invalidateQueries({ queryKey: qk.quotaExceptions })
    },
    onError: (e: Error) => toast({ message: `We couldn't delete them. ${e.message}` }),
  })

  const confirmDelete = () => {
    if (deleteTarget) {
      const name = deleteTarget.name
      deleteMutation.mutate(deleteTarget.id, {
        onSuccess: () => toast({ message: `${name} deleted permanently` }),
      })
    }
    setDeleteTarget(null)
    closeEditor()
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-12">
      {/* ── 1 · Header (4-question, §pillar 7) ── */}
      <PageHeader
        breadcrumbs={['Ops', 'Roster']}
        title="Roster"
        titleAccessory={
          <InfoTip
            text="Everyone on the design team, with their daily target and work hours."
            label="About the roster"
          />
        }
        history={
          isLoading ? (
            <Skeleton className="h-4 w-72" />
          ) : (
            <span className="tnum">
              {summaryParts.join(', ')}, showing everyone's daily targets and work hours.
            </span>
          )
        }
        actions={
          <button
            type="button"
            onClick={() => setEditor({ mode: 'add', team: 'Logo' })}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-caption font-semibold text-brand-fg transition-opacity duration-150 ease-out hover:opacity-90 motion-safe:active:scale-[0.98]"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Add designer
          </button>
        }
      />

      {designersQ.error != null && (
        <ErrorBanner
          message="We couldn't load the roster, so you're seeing the last loaded designers."
          asOf={
            designersQ.dataUpdatedAt > 0
              ? fmtClock(new Date(designersQ.dataUpdatedAt).toISOString())
              : null
          }
          onRetry={() => void designersQ.refetch()}
        />
      )}

      {/* ── 2 · Attention strip (verdict first, §20.1) ── */}
      {isLoading ? (
        <div className="space-y-6" role="status" aria-label="Loading roster">
          <Skeleton className="h-12 rounded-2xl" />
          {[0, 1].map((s) => (
            <div key={s} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <div className="card divide-y divide-border/40 overflow-hidden">
                {[0, 1, 2].map((r) => (
                  <Skeleton key={r} className="h-16 rounded-none" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {attention.length > 0 ? (
            <section
              aria-label="Needs attention"
              className="animate-fade-in rounded-2xl border border-warning/30 bg-warning-soft/40 p-5 sm:p-6"
            >
              <div className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <h2 className="flex items-center gap-1.5 text-caption font-semibold text-fg">
                  Needs attention <span className="tnum text-muted">({attention.length})</span>
                  <InfoTip
                    text="These gaps stop the numbers from counting. Tap Fix to sort each one out."
                    label="About Needs attention"
                  />
                </h2>
              </div>
              <ul className="mt-3 space-y-1">
                {attention.map((i) => (
                  <li
                    key={i.designer.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                  >
                    <p className="min-w-0 max-w-prose text-caption text-fg">{issueText(i)}</p>
                    <button
                      type="button"
                      onClick={() =>
                        setEditor({
                          mode: 'edit',
                          id: i.designer.id,
                          focus: i.unlinked ? 'clickup' : 'schedule',
                        })
                      }
                      aria-label={`Fix ${i.designer.name}'s setup`}
                      className="min-h-11 shrink-0 rounded-xl border border-border bg-surface px-3.5 text-caption font-medium text-fg transition-colors duration-150 ease-out hover:bg-surface-2 motion-safe:active:scale-[0.97]"
                    >
                      Fix
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-4 max-w-prose text-label font-normal leading-relaxed tracking-normal text-muted">
                ClickUp lists named exactly after the designer link themselves within 15 minutes. You
                only need to step in when the names differ.
              </p>
            </section>
          ) : (
            <p className="flex items-center gap-2 text-caption text-muted">
              <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              Everyone is linked and scheduled.
            </p>
          )}

          {/* ── 3 · Teams as sections ── */}
          {designers.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="No designers yet"
              hint="Add your first designer. Their daily target and work hours make every other number possible."
              action={
                <button
                  type="button"
                  onClick={() => setEditor({ mode: 'add', team: 'Logo' })}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-caption font-semibold text-brand-fg transition-opacity duration-150 ease-out hover:opacity-90 motion-safe:active:scale-[0.98]"
                >
                  <UserPlus className="h-4 w-4" aria-hidden="true" />
                  Add designer
                </button>
              }
            />
          ) : (
            TEAMS.map((team) => (
              <TeamSection
                key={team}
                team={team}
                members={designers.filter((d) => d.team === team)}
                scheduleOf={scheduleOf}
                exceptionCountOf={exceptionCountOf}
                onEdit={(d, focus) => setEditor({ mode: 'edit', id: d.id, focus })}
                onView={(d) => openDesigner(d.id)}
                onAdd={(t) => setEditor({ mode: 'add', team: t })}
              />
            ))
          )}
        </>
      )}

      {/* ── The one drawer for every input ── */}
      <Drawer
        open={editor != null}
        onClose={() => {
          if (editorDirty) setConfirmDiscard(true)
          else closeEditor()
        }}
        title={editor?.mode === 'edit' ? (editingDesigner?.name ?? 'Designer') : 'Add designer'}
        wide
      >
        {editor && (editor.mode === 'add' || editingDesigner) && (
          <DesignerEditor
            key={editor.mode === 'edit' ? editor.id : 'add'}
            designer={editingDesigner}
            initialTeam={editor.mode === 'add' ? editor.team : undefined}
            currentSchedule={editingDesigner ? scheduleOf(editingDesigner) : null}
            exceptions={
              editingDesigner
                ? ctx.exceptions.filter((e) => e.designer_id === editingDesigner.id)
                : []
            }
            focusSection={editor.mode === 'edit' ? editor.focus : undefined}
            onDirtyChange={setEditorDirty}
            onClose={closeEditor}
            onRequestDelete={(d) => setDeleteTarget(d)}
          />
        )}
      </Drawer>

      {/* ── Dirty-form discard guard ── */}
      <ConfirmDialog
        open={confirmDiscard}
        title={
          editor?.mode === 'edit'
            ? `Discard unsaved changes to ${editingDesigner?.name ?? 'this designer'}?`
            : 'Discard this new designer?'
        }
        body="You typed changes that have not been saved. Closing now throws them away."
        confirmLabel="Discard changes"
        destructive
        onConfirm={closeEditor}
        onCancel={() => setConfirmDiscard(false)}
      />

      {/* ── Hard delete (admin only) — explicit confirm, per §20.6 ── */}
      <ConfirmDialog
        open={deleteTarget != null}
        title={deleteTarget ? `Delete ${deleteTarget.name} permanently?` : 'Delete designer'}
        body="Archiving is the safe way out, and their tasks and history stay. Deleting hides them everywhere and is meant for rare mistakes only. This cannot be undone."
        confirmLabel="Delete designer"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

// ── One team = one section: eyebrow header, active rows, archived tucked away ─

function TeamSection({
  team,
  members,
  scheduleOf,
  exceptionCountOf,
  onEdit,
  onView,
  onAdd,
}: {
  team: Team
  members: Designer[]
  scheduleOf: (d: Designer) => DesignerSchedule | null
  exceptionCountOf: (d: Designer) => number
  onEdit: (d: Designer, focus?: 'clickup' | 'schedule') => void
  onView: (d: Designer) => void
  onAdd: (team: Team) => void
}) {
  const [showArchived, setShowArchived] = useState(false)

  const byOrder = (a: Designer, b: Designer) =>
    a.order_index - b.order_index || a.name.localeCompare(b.name)
  const active = members.filter((d) => d.status === 'active').sort(byOrder)
  const archived = members.filter((d) => d.status === 'archived').sort(byOrder)

  const row = (d: Designer) => (
    <DesignerRow
      key={d.id}
      designer={d}
      schedule={scheduleOf(d)}
      exceptionCount={exceptionCountOf(d)}
      onEdit={(focus) => onEdit(d, focus)}
      onViewPerformance={() => onView(d)}
    />
  )

  return (
    <section aria-label={`${team} team`}>
      <div className="flex items-center gap-2">
        <h2 className="eyebrow">{team}</h2>
        <span className="tnum text-label font-normal tracking-normal text-muted" aria-label={`${active.length} active`}>
          {active.length}
        </span>
        <InfoTip
          text={`Everyone on the ${team} team, sorted by display order. Click a person to edit them.`}
          label={`About the ${team} team`}
        />
      </div>
      {active.length === 0 && archived.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-dashed border-border bg-surface/50 px-5 py-6 text-caption text-muted">
          No {team} designers yet,{' '}
          <button
            type="button"
            onClick={() => onAdd(team)}
            className="font-medium text-brand underline-offset-2 hover:underline"
          >
            add one
          </button>{' '}
          to start tracking this team's targets and attendance.
        </div>
      ) : (
        <div className="card mt-3 overflow-hidden">
          <div className="divide-y divide-border/40">
            {active.map(row)}
            {active.length === 0 && (
              <p className="px-5 py-5 text-caption text-muted">
                No active designers on this team. {archived.length} archived below.
              </p>
            )}
          </div>
          {archived.length > 0 && (
            <div className="border-t border-border/40">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                aria-expanded={showArchived}
                className="flex min-h-11 w-full items-center gap-1.5 px-5 text-left text-label text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg"
              >
                <ChevronRight
                  className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ease-out ${
                    showArchived ? 'rotate-90' : ''
                  }`}
                  aria-hidden="true"
                />
                Archived ({archived.length})
              </button>
              {showArchived && (
                <div className="animate-fade-in divide-y divide-border/40 border-t border-border/40">
                  {archived.map(row)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
