import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useToast } from '../ui/ToastProvider'
import { InfoTip } from '../ui/InfoTip'
import { Button } from '../ui/Button'
import { deleteDayNote, fetchDayNotes, insertDayNote, qk } from '../../lib/queries'
import { fmtDate } from '../../lib/format'
import { pktToday } from '../../../shared/pkt'
import type { DayNote, Designer } from '../../../shared/types'

/** Roles allowed to write notes (the CEO view is read-only). */
const WRITER_ROLES = ['admin', 'manager', 'pm', 'hr']

/** Shared query for the dated notes in a period — used by the panel and the PDF. */
export function useDayNotes(start: string, end: string) {
  return useQuery({
    queryKey: qk.dayNotes(start, end),
    queryFn: () => fetchDayNotes(start, end),
    staleTime: 60_000,
  })
}

/** True when the error means the one-time database table has not been added yet. */
function isSetupError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  return /day_notes|does not exist|schema cache|relation|find the table/i.test(msg)
}

/** Fold the dated notes into one text block for the printed report. */
export function dayNotesToText(notes: DayNote[], designers: Designer[]): string {
  if (!notes.length) return ''
  const nameById = new Map(designers.map((d) => [d.id, d.name]))
  return [...notes]
    .sort((a, b) => a.the_date.localeCompare(b.the_date))
    .map((n) => {
      const who = n.designer_id ? nameById.get(n.designer_id) ?? 'a designer' : 'the whole studio'
      return `On ${fmtDate(n.the_date)}, about ${who}: ${n.note}`
    })
    .join('\n')
}

/**
 * Dated notes for the reports: a note is tied to a specific day (and usually a
 * specific designer) and saved centrally so the whole team sees the same thing.
 * It shows on screen and is printed on the PDF. Ops/PM/HR/admin can add and
 * remove; everyone else sees them read-only.
 */
export function ReportNotes({
  designers,
  start,
  end,
}: {
  designers: Designer[]
  start: string
  end: string
}) {
  const { role } = useAuth()
  const canWrite = role != null && WRITER_ROLES.includes(role)
  const toast = useToast()
  const queryClient = useQueryClient()
  const notesQ = useDayNotes(start, end)

  const today = pktToday()
  const [designerId, setDesignerId] = useState('') // '' = the whole studio
  const [date, setDate] = useState(today >= start && today <= end ? today : end)
  const [text, setText] = useState('')

  const nameById = useMemo(() => new Map(designers.map((d) => [d.id, d.name])), [designers])
  const notes = notesQ.data ?? []
  const setupNeeded = notesQ.isError && isSetupError(notesQ.error)

  const addMut = useMutation({
    mutationFn: () =>
      insertDayNote({ designer_id: designerId || null, the_date: date, note: text.trim() }),
    onSuccess: () => {
      setText('')
      void queryClient.invalidateQueries({ queryKey: ['day-notes'] })
      toast({ message: 'Note saved.' })
    },
    onError: (e: Error) =>
      toast({
        message: isSetupError(e)
          ? 'Saving notes needs a small setup first, done just once. Please see the message below.'
          : `That did not save. ${e.message}`,
      }),
  })

  const delMut = useMutation({
    mutationFn: (id: string) => deleteDayNote(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['day-notes'] }),
    onError: (e: Error) => toast({ message: `That could not be removed. ${e.message}` }),
  })

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!text.trim() || !date) return
    addMut.mutate()
  }

  return (
    <section aria-label="Notes for these days" className="card p-6">
      <h2 className="eyebrow inline-flex items-center gap-1">
        Notes for these days
        <InfoTip text="Save a note on a specific day. For example, if you agreed with a designer to give them fewer or more projects that day because of the workload, write it here. These notes appear here and are printed on the PDF, so the reason behind the numbers is never lost." />
      </h2>

      {canWrite && (
        <form onSubmit={submit} className="mt-4 flex flex-col gap-3 rounded-xl bg-surface-2 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-label font-medium text-muted">
              Who is it about
              <select
                value={designerId}
                onChange={(e) => setDesignerId(e.target.value)}
                className="min-h-11 rounded-xl border border-border bg-surface px-3 text-caption text-fg"
              >
                <option value="">The whole studio</option>
                {designers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-label font-medium text-muted">
              Which day
              <input
                type="date"
                value={date}
                min={start}
                max={end}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className="tnum min-h-11 rounded-xl border border-border bg-surface px-3 text-caption text-fg"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1.5 text-label font-medium text-muted">
            What happened
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder="For example: gave Nimeazad fewer projects today, agreed with him, to focus on Aldercrest."
              className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-caption text-fg placeholder:text-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            />
          </label>
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={addMut.isPending || !text.trim()}
              className="whitespace-nowrap"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {addMut.isPending ? 'Saving…' : 'Add note'}
            </Button>
          </div>
        </form>
      )}

      {setupNeeded ? (
        <p className="mt-4 max-w-prose rounded-xl bg-warning-soft px-4 py-3 text-caption leading-relaxed text-warning">
          Saving notes needs one quick setup in your database first. Run the file
          <span className="font-medium"> 006_day_notes.sql</span> once, and this will start working.
        </p>
      ) : notes.length === 0 ? (
        <p className="mt-4 text-caption text-muted">No notes for these days yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border/60">
          {notes.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="max-w-prose text-caption text-fg">{n.note}</p>
                <p className="tnum mt-0.5 text-label text-muted">
                  {fmtDate(n.the_date)}, about{' '}
                  {n.designer_id ? nameById.get(n.designer_id) ?? 'a designer' : 'the whole studio'}
                </p>
              </div>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => delMut.mutate(n.id)}
                  aria-label={`Remove the note from ${fmtDate(n.the_date)}`}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default ReportNotes
