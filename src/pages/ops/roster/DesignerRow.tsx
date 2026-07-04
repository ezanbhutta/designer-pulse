import type { MouseEvent, ReactNode } from 'react'
import {
  Archive,
  BarChart3,
  CalendarClock,
  CircleCheck,
  ExternalLink,
  Link2Off,
  Moon,
  Pencil,
} from 'lucide-react'
import { Badge } from '../../../components/ui/Badge'
import { InfoTip } from '../../../components/ui/InfoTip'
import { clickupListUrl } from '../../../lib/queries'
import { DOW_LABELS, fmtShiftTime } from '../../../lib/format'
import type { Designer, DesignerSchedule } from '../../../../shared/types'

/** Deterministic initials — the same name always draws the same avatar. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return `${first}${last}`.toUpperCase()
}

export interface DesignerRowProps {
  designer: Designer
  schedule: DesignerSchedule | null
  exceptionCount: number
  /** Open the edit drawer, optionally scrolled to a section. */
  onEdit: (focus?: 'clickup' | 'schedule') => void
  /** Open the performance drawer (?d= search param). */
  onViewPerformance: () => void
}

/**
 * One designer, scannable in a glance (§21.6 verdict-first rows): status
 * glyph → identity → schedule chips → ClickUp link → actions. The row-wide
 * click is a mouse convenience only — keyboard and SR users get the dedicated
 * "Edit {name}" button (a row must never be a button with buttons inside it,
 * §20.10); inner controls stop the click from bubbling.
 */
export function DesignerRow({
  designer: d,
  schedule,
  exceptionCount,
  onEdit,
  onViewPerformance,
}: DesignerRowProps) {
  const archived = d.status === 'archived'
  const linked = Boolean(d.clickup_list_id)
  const listUrl = clickupListUrl(d.clickup_list_id)
  const overnight = schedule != null && schedule.shift_end <= schedule.shift_start

  const stop = (e: MouseEvent) => e.stopPropagation()

  // Status glyph — always paired with a screen-reader label (§20.10).
  let glyph: ReactNode
  if (archived) {
    glyph = (
      <>
        <Archive className="h-4 w-4 text-muted" aria-hidden="true" />
        <span className="sr-only">Archived</span>
      </>
    )
  } else if (!linked) {
    glyph = (
      <>
        <Link2Off className="h-4 w-4 text-warning" aria-hidden="true" />
        <span className="sr-only">Not linked to ClickUp</span>
      </>
    )
  } else if (!schedule) {
    glyph = (
      <>
        <CalendarClock className="h-4 w-4 text-warning" aria-hidden="true" />
        <span className="sr-only">No work schedule yet</span>
      </>
    )
  } else {
    glyph = (
      <>
        <CircleCheck className="h-4 w-4 text-success" aria-hidden="true" />
        <span className="sr-only">Linked and scheduled</span>
      </>
    )
  }

  return (
    <div
      onClick={() => onEdit()}
      className={`grid min-h-[4.5rem] cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-5 py-4 transition-colors duration-150 ease-out hover:bg-surface-2 active:bg-surface-2 lg:grid-cols-[auto_minmax(0,2.5fr)_minmax(0,3fr)_minmax(0,1.5fr)_auto] lg:gap-x-4 ${
        archived ? 'opacity-60' : ''
      }`}
    >
      {/* (a) status glyph */}
      <span className="flex h-5 w-5 items-center justify-center">{glyph}</span>

      {/* (b) identity */}
      <span className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-label font-semibold tracking-normal text-brand"
        >
          {initialsOf(d.name)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-caption font-medium text-fg">{d.name}</span>
          {d.specialty && (
            <span className="block truncate text-label font-normal tracking-normal text-muted">{d.specialty}</span>
          )}
        </span>
      </span>

      {/* (c) schedule at a glance — quiet labeled chips */}
      <span className="col-span-2 col-start-2 flex flex-wrap items-center gap-1.5 lg:col-span-1 lg:col-start-auto">
        {schedule ? (
          <>
            <Badge tone="neutral">
              <span className="tnum">
                Target {schedule.daily_quota}/day
              </span>
            </Badge>
            <Badge tone="neutral" icon={overnight ? Moon : undefined}>
              <span className="tnum">
                {fmtShiftTime(schedule.shift_start)}–{fmtShiftTime(schedule.shift_end)}
              </span>
              {overnight && <span className="sr-only">works past midnight</span>}
            </Badge>
            {schedule.weekly_off != null && (
              <Badge tone="neutral">Off {DOW_LABELS[schedule.weekly_off]}</Badge>
            )}
            {exceptionCount > 0 && (
              <Badge tone="neutral">
                <span className="tnum">{exceptionCount}</span> special day
                {exceptionCount === 1 ? '' : 's'}
                <InfoTip
                  text="Days with a different daily target — for example a lighter Friday."
                  label="What are special days?"
                />
              </Badge>
            )}
          </>
        ) : (
          <Badge tone="warning">No schedule yet</Badge>
        )}
      </span>

      {/* (d) ClickUp */}
      <span className="col-span-2 col-start-2 flex items-center lg:col-span-1 lg:col-start-auto">
        {linked && listUrl ? (
          <a
            href={listUrl}
            target="_blank"
            rel="noreferrer"
            onClick={stop}
            aria-label={`Open ${d.name}'s ClickUp list in a new tab`}
            title="Open list in ClickUp"
            className="-mx-2 inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-label font-normal tracking-normal text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg"
          >
            <span className="tnum">{d.clickup_list_id}</span>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onEdit('clickup')
            }}
            aria-label={`Link ${d.name}'s ClickUp list`}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-warning/40 bg-warning-soft px-3 text-label text-warning transition-colors duration-150 ease-out hover:border-warning/70"
          >
            <Link2Off className="h-3.5 w-3.5" aria-hidden="true" />
            Link list
          </button>
        )}
      </span>

      {/* (e) actions */}
      <span className="col-start-3 row-start-1 flex items-center justify-end gap-1 lg:col-start-auto lg:row-start-auto">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onViewPerformance()
          }}
          aria-label={`View ${d.name}'s performance`}
          title="View performance"
          className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg motion-safe:active:scale-95"
        >
          <BarChart3 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
          aria-label={`Edit ${d.name}`}
          title="Edit"
          className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg motion-safe:active:scale-95"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}

export default DesignerRow
