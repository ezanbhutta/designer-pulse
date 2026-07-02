import { useMemo, useRef, type KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellOff, Check, CheckCheck, ExternalLink } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { useToast } from '../../components/ui/ToastProvider'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { presentAlert } from '../../lib/alertPresentation'
import { STALE_LIVE, fetchAlerts, qk, setAlertStatus } from '../../lib/queries'
import { fmtDateTime, fmtTime } from '../../lib/format'
import type { Alert, AlertType } from '../../../shared/types'
import { useDesigners } from './opsData'

type View = 'open' | 'all'
type AlertStatus = Alert['status']

const TYPE_ORDER: AlertType[] = [
  'cancellation',
  'assignment_gap',
  'task_aging',
  'forgotten_checkout',
  'quality_decay',
  'burnout',
  'workload_forecast',
]

const TYPE_LABELS: Record<AlertType, string> = {
  cancellation: 'Cancellations',
  assignment_gap: 'Assignment gaps',
  task_aging: 'Aging tasks',
  forgotten_checkout: 'Forgotten checkouts',
  quality_decay: 'Quality decay',
  burnout: 'Burnout risk',
  workload_forecast: 'Workload forecast',
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const
const SEVERITY_TONE = { info: 'brand', warning: 'warning', critical: 'danger' } as const

/**
 * Alerts inbox (spec §12): detection rows carry their prescription (§20.3) via
 * presentAlert — icon, suggestion, and a ClickUp deep link (never a write,
 * §22.1). Acknowledge/resolve are optimistic one-taps with Undo; new arrivals
 * pulse once; keyboard: ↑↓ navigate, A acknowledge, R resolve.
 */
export default function OpsAlerts() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [view, setView] = useLocalStorage<View>('pulse.ops.alerts.view', 'open')

  const designersQ = useDesigners()
  const alertsQ = useQuery({
    queryKey: qk.alerts(view),
    queryFn: () => fetchAlerts(view),
    staleTime: STALE_LIVE,
  })

  const alerts = alertsQ.data ?? []
  const designers = designersQ.data ?? []

  // Newly-arrived alerts pulse once (§21.7). First load never pulses.
  const seenIds = useRef<Set<number> | null>(null)
  const freshIds = useMemo(() => {
    const fresh = new Set<number>()
    if (!alertsQ.data) return fresh
    if (seenIds.current === null) {
      seenIds.current = new Set(alertsQ.data.map((a) => a.id))
      return fresh
    }
    for (const a of alertsQ.data) {
      if (!seenIds.current.has(a.id)) {
        fresh.add(a.id)
        seenIds.current.add(a.id)
      }
    }
    return fresh
  }, [alertsQ.data])

  // ── Optimistic status writes: reflect instantly, roll back visibly (§20.6) ──
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: AlertStatus }) => setAlertStatus(id, status),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ['alerts'] })
      const snapshots = queryClient.getQueriesData<Alert[]>({ queryKey: ['alerts'] })
      queryClient.setQueriesData<Alert[]>({ queryKey: ['alerts'] }, (old) =>
        old?.map((a) =>
          a.id === id
            ? {
                ...a,
                status,
                resolved_at: status === 'resolved' ? new Date().toISOString() : null,
              }
            : a,
        ),
      )
      return { snapshots }
    },
    onError: (e: Error, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) queryClient.setQueryData(key, data)
      toast({ message: `Couldn't update the alert — rolled back (${e.message})` })
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['alerts'] }),
  })

  const acknowledge = (a: Alert) => statusMutation.mutate({ id: a.id, status: 'acknowledged' })
  const resolve = (a: Alert) => {
    const previous = a.status
    statusMutation.mutate(
      { id: a.id, status: 'resolved' },
      {
        onSuccess: () =>
          toast({
            message: 'Alert resolved',
            undo: () => statusMutation.mutate({ id: a.id, status: previous }),
          }),
      },
    )
  }

  const groups = useMemo(() => {
    const byType = new Map<AlertType, Alert[]>()
    for (const a of alerts) {
      const list = byType.get(a.alert_type) ?? []
      list.push(a)
      byType.set(a.alert_type, list)
    }
    for (const list of byType.values()) {
      list.sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          b.fired_at.localeCompare(a.fired_at),
      )
    }
    return TYPE_ORDER.filter((t) => byType.has(t)).map((t) => ({
      type: t,
      alerts: byType.get(t) ?? [],
    }))
  }, [alerts])

  const openCount = alerts.filter((a) => a.status === 'open').length
  const criticalCount = alerts.filter((a) => a.status !== 'resolved' && a.severity === 'critical').length

  // ── Keyboard: ↑↓ move focus between rows; A/R act on the focused row ──
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const flatIds = useMemo(() => groups.flatMap((g) => g.alerts.map((a) => a.id)), [groups])
  const alertById = useMemo(() => new Map(alerts.map((a) => [a.id, a])), [alerts])

  const onRowKeyDown = (e: KeyboardEvent<HTMLElement>, id: number) => {
    const idx = flatIds.indexOf(id)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = flatIds[e.key === 'ArrowDown' ? idx + 1 : idx - 1]
      if (next != null) rowRefs.current.get(next)?.focus()
      return
    }
    const a = alertById.get(id)
    if (!a || a.status === 'resolved') return
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault()
      if (a.status === 'open') acknowledge(a)
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault()
      resolve(a)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Alerts · open → acknowledged → resolved (§12)</p>
          <h1 className="mt-1 text-3xl font-semibold text-fg">Alerts</h1>
          <p className="mt-1 text-sm text-muted">
            {openCount === 0
              ? 'Nothing open.'
              : `${openCount} open${criticalCount > 0 ? ` — ${criticalCount} critical` : ''}.`}{' '}
            <span className="text-xs">↑↓ navigate · A acknowledge · R resolve</span>
          </p>
        </div>
        <SegmentedControl<View>
          options={[
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
          ]}
          value={view}
          onChange={setView}
          ariaLabel="Alert filter"
        />
      </header>

      {alertsQ.error && (
        <ErrorBanner
          message="Couldn't refresh alerts — showing the last loaded inbox."
          asOf={
            alertsQ.dataUpdatedAt > 0
              ? fmtTime(new Date(alertsQ.dataUpdatedAt).toISOString())
              : null
          }
          onRetry={() => void alertsQ.refetch()}
        />
      )}

      <div aria-live="polite" aria-label="Alerts inbox" className="space-y-8">
        {alertsQ.isLoading ? (
          <div className="space-y-2" role="status" aria-label="Loading alerts">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-20" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title="Inbox zero — nothing needs you."
            hint={
              view === 'open'
                ? 'Gaps, aging tasks, cancellations and attendance flags land here the moment they fire.'
                : 'No alerts have ever fired.'
            }
          />
        ) : (
          groups.map((group) => (
            <section key={group.type} aria-label={TYPE_LABELS[group.type]}>
              <h2 className="eyebrow">
                {TYPE_LABELS[group.type]}
                <span className="tnum ml-2 font-normal normal-case tracking-normal">
                  {group.alerts.length}
                </span>
              </h2>
              <div className="mt-2 space-y-2">
                {group.alerts.map((a) => {
                  const p = presentAlert(a, designers)
                  const Icon = p.icon
                  const resolved = a.status === 'resolved'
                  return (
                    <article
                      key={a.id}
                      tabIndex={0}
                      ref={(el) => {
                        if (el) rowRefs.current.set(a.id, el)
                        else rowRefs.current.delete(a.id)
                      }}
                      onKeyDown={(e) => onRowKeyDown(e, a.id)}
                      aria-label={p.title}
                      className={`card flex items-start gap-3 p-4 ${
                        freshIds.has(a.id) ? 'animate-pulse-once' : ''
                      } ${resolved ? 'opacity-60' : ''}`}
                    >
                      <span
                        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                          p.tone === 'danger'
                            ? 'bg-danger-soft text-danger'
                            : p.tone === 'warning'
                              ? 'bg-warning-soft text-warning'
                              : 'bg-brand-soft text-brand'
                        }`}
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-fg">{p.title}</p>
                        {p.suggestion && <p className="mt-0.5 text-sm text-muted">{p.suggestion}</p>}
                        <p className="tnum mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                          <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
                          {a.status === 'acknowledged' && <Badge tone="neutral">acknowledged</Badge>}
                          {resolved && <Badge tone="success" icon={CheckCheck}>resolved</Badge>}
                          <span>fired {fmtDateTime(a.fired_at)}</span>
                          {resolved && a.resolved_at && <span>· resolved {fmtDateTime(a.resolved_at)}</span>}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        {p.href && p.hrefLabel && (
                          <a
                            href={p.href}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-[2.25rem] items-center gap-1 rounded-lg px-2 text-xs font-medium text-brand hover:bg-brand-soft"
                          >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            {p.hrefLabel}
                          </a>
                        )}
                        {!resolved && (
                          <div className="flex items-center gap-1">
                            {a.status === 'open' && (
                              <button
                                type="button"
                                onClick={() => acknowledge(a)}
                                className="inline-flex min-h-[2.75rem] items-center gap-1 rounded-xl border border-border bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2"
                                aria-label={`Acknowledge: ${p.title}`}
                              >
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                Acknowledge
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => resolve(a)}
                              className="inline-flex min-h-[2.75rem] items-center gap-1 rounded-xl border border-border bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2"
                              aria-label={`Resolve: ${p.title}`}
                            >
                              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                              Resolve
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
