# Build Contracts — Studio Pulse

Binding interface contracts for all builder agents. The spec
(`docs/SPEC.md`) is the product contract; this file is the *code* contract.
If they conflict on interfaces, this file wins; on behavior, the spec wins.

## Already built (do not rewrite, import from these)

- `shared/statuses.ts` — canonical statuses, tones, labels, `canonicalizeStatus`, `parseConceptCount`
- `shared/types.ts` — all DB row types (+ `Config`, `mergeConfig`, `CONFIG_DEFAULTS`)
- `shared/pkt.ts` — PKT time math (`pktDateOf`, `pktInstant`, `shiftWindow`, `collectionWindow`, `addDays`, `dateRange`, `minutesBetween`, `dowOf`, `pktToday`)
- `shared/metrics.ts` — `computeTaskMetrics(createdAt, events, now)`, `reconstructBackfillEvents`
- `shared/attendance.ts` — `computeAttendance(inputs)`, `leaveCovers`
- `shared/aggregate.ts` — `median`, `expectedQuotaOn/Range`, `scheduleFor`, `summarizeDesigner`, `activeLoad`, `utilizationPct`, `ageMinutes`, `pipelineBottleneck`, `workloadForecast`, `priorPeriod`
- `src/lib/supabase.ts`, `src/lib/queries.ts` (all fetchers + `qk` query keys + `STALE_ANALYTICS`), `src/lib/format.ts`
- `src/hooks/useAuth.tsx` (`useAuth`, `AuthProvider`, `OPS_ROLES`, `homePathFor`), `src/hooks/useRealtime.ts`
- `src/main.tsx`, `src/App.tsx` (routes are fixed — build the referenced pages), `src/index.css` + `tailwind.config.js` (tokens)

Imports inside `src/` use relative paths (e.g. `../../shared/types`,
`../components/ui/StatTile`). `api/` imports shared via `../_lib/...` and
`../../shared/...`. No path aliases anywhere. TypeScript strict. Icons:
`lucide-react`. Styling: Tailwind semantic tokens only (`bg-surface`,
`text-muted`, `text-danger`, `bg-brand text-brand-fg`, `border-border`,
`shadow-soft`, `rounded-2xl`, `.card`, `.eyebrow`, `.tnum`, `.skeleton`) —
never raw hex/gray-500.

## File ownership (one owner per file — never touch another agent's files)

| Owner | Files |
|---|---|
| SQL agent | `supabase/migrations/*.sql`, `supabase/README.md` |
| API agent | `api/**` |
| UI-kit agent | `src/components/ui/**`, `src/components/layout/**`, `src/hooks/useLocalStorage.ts`, `src/lib/alertPresentation.ts` |
| Ops agent | `src/pages/ops/**`, `src/components/shared/DesignerDetail.tsx`, `src/components/shared/TaskTrail.tsx`, `src/components/shared/TaskCard.tsx` |
| CEO agent | `src/pages/ceo/**`, `src/lib/reportPdf.ts` |
| Designer agent | `src/pages/designer/**`, `src/pages/auth/LoginPage.tsx` |

## SQL contracts (Supabase migrations)

Schema = spec §7 verbatim, plus these implementation columns/tables:
- `task_metrics.first_delivered_at timestamptz` (needed for "delivered in period")
- `attendance_daily.needs_review boolean default false`, `attendance_daily.checkout_source text`
- `audit_log` (spec §22.8): `id bigint identity pk, actor_id uuid, actor_email text, action text, entity text, entity_id text, before jsonb, after jsonb, at timestamptz default now()`
- `app_config` rows seeded with every §18 key; plus key `last_sync` (jsonb string ISO timestamp) used by reconciliation.

Required functions (SECURITY DEFINER, `set search_path = public`):
- `get_my_profile()` → returns the caller's `app_users` row (setof)
- `app_role()` → text role for `auth.uid()` (helper used inside policies)
- `apply_schedule_change(p_designer_id uuid, p_effective_from date, p_daily_quota int, p_shift_start time, p_shift_end time, p_weekly_off smallint, p_late_grace_min int, p_early_leave_grace_min int)` → closes the open `designer_schedule` row (`effective_to = p_effective_from - 1`) and inserts the new row atomically; ops-role-checked inside; writes `audit_log`.

RLS: enable on every table; policies per spec §14 + matrix §22.7
(admin/manager/pm/hr = ops writes per matrix; hard-delete designers = admin
only; ceo = read-only everything; designer = own rows only — including
`shift_marks` INSERT with `designer_id = (select designer_id from app_users where id = auth.uid())`
and `source = 'self'`). `holidays`/`app_config`: readable by all
authenticated. Append-only triggers (block UPDATE/DELETE) on
`clickup_events`, `shift_marks` (allow no updates; deletes admin-only via
service role), `audit_log`. Audit triggers on `designers`,
`designer_schedule`, `quota_exceptions`, `leaves`, `half_days`, `holidays`,
`alerts` (UPDATE), `shift_marks` (INSERT where source='manual').
Realtime: `alter publication supabase_realtime add table task_state, alerts, attendance_daily;`
Indexes per spec §7. Seed per spec §8.4 (all designers + schedules,
`effective_from '2025-01-01'`, known ClickUp list ids, Amin's
`clickup_user_id 101464943`; shifts given in §8.4, defaults 18:00–02:00
where unknown, weekly_off Sunday where unknown — these are editable defaults).

## API contracts (Vercel serverless, Node runtime, TypeScript)

Handlers: `export default async function handler(req: VercelRequest, res: VercelResponse)`.
Auth: cron/admin endpoints require `Authorization: Bearer ${CRON_SECRET}`.
Webhook verifies `X-Signature` = HMAC-SHA256 hex of raw body with
`CLICKUP_WEBHOOK_SECRET`. Space id constant `90187090116`.

- `api/clickup/webhook.ts` — taskCreated / taskStatusUpdated / taskDeleted / taskUpdated → `_lib/ingest`
- `api/cron/reconcile.ts` — list auto-discovery + healing pull since `last_sync` (§6.2)
- `api/cron/pulse.ts` — every 15 min: assignment-gap alerts at shift-start+offset (PKT), task-aging alerts, today's attendance recompute + forgotten-checkout auto-close/alerts
- `api/cron/nightly.ts` — attendance finalize (yesterday + today), open-task metrics refresh, quality-decay / burnout / workload-forecast alerts
- `api/admin/backfill.ts` — one-time historical backfill (§6.3), `metrics_confidence='backfill'`
- `api/admin/setup-webhook.ts` — creates the ClickUp webhook for the space (idempotent)
- `_lib/supabaseAdmin.ts`, `_lib/http.ts`, `_lib/clickup.ts` (rate-limit-aware), `_lib/ingest.ts`, `_lib/alerts.ts` (`fireAlert` with open-alert dedupe), `_lib/attendance-runner.ts`, `_lib/config.ts` (load app_config → `Config`)

Ingest invariants: events insert with `on conflict do nothing` (idempotent);
`task_state` upsert; recompute `task_metrics` from the FULL ordered event log
via `computeTaskMetrics` after every change; cancellation → instant critical
alert. The system NEVER writes to ClickUp (§22.1).

## UI-kit contracts (exact props — pages import these)

All in `src/components/ui/` unless noted. Every component: keyboard
operable, focus-visible, color never sole signal, respects
prefers-reduced-motion.

```ts
// StatTile.tsx — §21.6/§22.5: interpretation ships inline
export interface StatTileProps {
  eyebrow: string; icon?: LucideIcon; value: string;
  delta?: { label: string; direction: 'up'|'down'|'flat'; good: boolean } | null;
  cause?: string | null;              // plain-language cause (§20.2)
  reference?: string | null;          // e.g. "team median 82%" (§22.5)
  state?: 'ok'|'watch'|'flag' | null; // threshold flag
  sparkline?: number[]; onClick?: () => void; loading?: boolean;
}
// DeltaChip.tsx
export interface DeltaChipProps { direction: 'up'|'down'|'flat'; good: boolean; label: string }
// Badge.tsx
export interface BadgeProps { tone: 'neutral'|'success'|'warning'|'danger'|'brand'|'waiting'; icon?: LucideIcon; children: ReactNode }
// StatusBadge.tsx — uses STATUS_TONES/STATUS_LABELS from shared/statuses
export interface StatusBadgeProps { status: CanonicalStatus; showLabel?: boolean }
// VerdictBlock.tsx — the §20.1 lead block
export interface VerdictItem { id: string; severity: 'info'|'warning'|'critical';
  text: string; detail?: string;
  action?: { label: string; href?: string; onClick?: () => void } }
export interface VerdictBlockProps { title: string; items: VerdictItem[]; emptyMessage: string; loading?: boolean }
// Drawer.tsx — right-side panel (§20.6); Esc + overlay close, focus trap
export interface DrawerProps { open: boolean; onClose: () => void; title: string; wide?: boolean; children: ReactNode }
// ToastProvider.tsx — export ToastProvider + useToast(); toast({ message, undo? }) → 5s undo (§20.6)
// ConfirmDialog.tsx — ONLY for delete-designer + bulk ops
export interface ConfirmDialogProps { open: boolean; title: string; body: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void; onCancel: () => void }
// EmptyState.tsx
export interface EmptyStateProps { icon?: LucideIcon; title: string; hint?: string; action?: ReactNode }
// ErrorBanner.tsx — "specific and actionable" (§21.8)
export interface ErrorBannerProps { message: string; asOf?: string | null; onRetry?: () => void }
// Skeleton.tsx
export interface SkeletonProps { className?: string }
// CommandPalette.tsx — global ⌘K/Ctrl-K listener inside; render once in AppShell
export interface Command { id: string; label: string; hint?: string; keywords?: string; run: () => void }
export interface CommandPaletteProps { commands: Command[] }
// InlineEdit.tsx — click→edit, Enter/blur save, Esc cancel
export interface InlineEditProps { value: string; onSave: (v: string) => void | Promise<void>; type?: 'text'|'number'|'time'; className?: string; ariaLabel: string }
// SegmentedControl.tsx
export interface SegmentedControlProps<T extends string> { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; ariaLabel: string }
// Sparkline.tsx / TrendLine.tsx / HBar.tsx — hand-rolled SVG, tokens only
export interface SparklineProps { data: number[]; width?: number; height?: number; tone?: 'brand'|'success'|'warning'|'danger'|'muted' }
export interface TrendPoint { label: string; value: number }
export interface TrendLineProps { points: TrendPoint[]; baseline?: number | null; height?: number; tone?: SparklineProps['tone']; formatValue?: (v: number) => string; ariaLabel: string }
export interface HBarRow { label: string; value: number; secondary?: string; tone?: 'neutral'|'success'|'warning'|'danger'|'waiting' }
export interface HBarProps { rows: HBarRow[]; formatValue?: (v: number) => string; ariaLabel: string }
// CountUp.tsx — animates ONLY on genuine value change (§21.7); screen readers see final value only
export interface CountUpProps { value: number; format?: (v: number) => string; className?: string }
```

`src/components/layout/AppShell.tsx`:
```ts
export interface NavItem { to: string; label: string; icon: LucideIcon; badge?: number }
export interface AppShellProps { title: string; nav: NavItem[]; commands?: Command[]; children?: ReactNode } // renders <Outlet/> when no children; left rail on desktop; theme toggle; sign-out
```

`src/hooks/useLocalStorage.ts`: `export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void]`

`src/lib/alertPresentation.ts` (§20.3 + §22.1 — deep links, never writes):
```ts
export interface AlertPresentation { title: string; suggestion: string | null; href: string | null; hrefLabel: string | null; icon: LucideIcon; tone: 'brand'|'warning'|'danger' }
export function presentAlert(alert: Alert, designers: Designer[]): AlertPresentation
```

`src/lib/reportPdf.ts` (CEO agent): `export function generateWeeklyReportPdf(args: { period: { start: string; end: string }; teamName?: string; rows: DesignerPeriodSummary[]; designers: Designer[] }): void` — builds and downloads via jsPDF.

## Behavioral rules binding every page (§20–§22 digest)

1. Every surface opens with its verdict/attention block, not a table.
2. Every metric renders with delta vs prior period + plain-language cause + reference point (team median) where sensible. Bare numbers are bugs.
3. Proposed actions are ClickUp deep links (`clickupListUrl`/`clickupTaskUrl` from queries.ts) or in-app one-taps — never ClickUp writes.
4. Defaults: Ops=today, CEO=this week vs last, Designer=this week; sort worst-first; group by team; filters persist via `useLocalStorage`.
5. Drawers over page-jumps; toasts+undo over confirms (except delete-designer/bulk).
6. Skeletons, never spinners; empty states teach; errors say what's shown and what's happening.
7. Cross-designer comparison = Attainment % only. Designer self-view: own data only, own-past comparison only, no peers/rankings.
8. All times displayed PKT via `src/lib/format.ts`.
