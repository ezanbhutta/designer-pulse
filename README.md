# Studio Pulse — Design Team OS

A real-time production-health and attendance system for a remote graphic-design
team, sourced from **ClickUp task history** plus **in-app attendance marks**.
It replaces a manual checkbox spreadsheet with a live, auditable system that
measures designer **quality, speed, capacity, and presence** — and interprets
the numbers instead of just displaying them.

Built to `docs/SPEC.md` (the contract). Key guarantees:

- **ClickUp is read-only.** The system observes assignment; it never creates,
  edits, or moves a task. Every "act" affordance is a deep link into ClickUp
  for the PM/CSR to act themselves (spec §22.1).
- **One timezone.** All shift/attendance/day-boundary math is
  `Asia/Karachi` (PKT), for everyone, everywhere (spec §22.2).
- **No payroll, no client identity, no CSR individual tracking** (spec §1.2).
- **Raw events are immutable.** Everything derived is recomputable from the
  append-only `clickup_events` log.

## Architecture

```
ClickUp (Designers Team space 90187090116)
   │  webhooks (instant)              │  reconciliation pull (15 min, heals drops)
   ▼                                  ▼
Vercel serverless (api/) ── service-role key ──► Supabase Postgres
   • /api/clickup/webhook      raw events → task_state → task_metrics
   • /api/cron/reconcile       attendance engine, alerts engine
   • /api/cron/pulse           (RLS on every table, append-only triggers,
   • /api/cron/nightly          audit log, effective-dated schedules)
   • /api/admin/backfill              │
   • /api/admin/setup-webhook         │  anon key + RLS + Realtime
                                      ▼
                       React 18 + Vite + Tailwind (src/)
        ┌──────────────┬──────────────────┬───────────────────┐
        │ Ops cockpit  │  CEO decision    │  Designer         │
        │ (PM/HR/Admin,│  surface (read-  │  self-view        │
        │ dark-first)  │  only, private)  │  (mobile, light)  │
        └──────────────┴──────────────────┴───────────────────┘
```

- `shared/` — isomorphic core: canonical statuses, PKT time math, the
  task-metrics engine (attribution model §4), the attendance engine (§9.2),
  and metric aggregation (§11). Used by both the API and the dashboards.
- Compute tiers (§5.1): webhook-instant (alerts, board), view-time (live
  counts), 5-minute cache (quality/attainment/speed via react-query
  `staleTime`), nightly (trends, burnout, forecast).

## Deployment (one time, ~30 minutes)

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Run the migrations in order in the SQL editor (or `supabase db push`):
   `supabase/migrations/001_schema.sql` → `002_rls.sql` → `003_triggers.sql`
   → `004_seed.sql`. See `supabase/README.md`.
3. The seed loads the §8.4 roster and config defaults. **Quotas and shifts are
   best-known defaults — confirm them in the Roster UI on first run.**
4. Create auth users (Authentication → Add user) for each person, then insert
   their `app_users` row (see `supabase/README.md`) mapping
   `role` (`admin | manager | pm | hr | ceo | designer`) and, for designers,
   their `designer_id`.

### 2. Vercel

1. Import this repo into Vercel (Vite is auto-detected; `vercel.json` wires
   the SPA rewrite and crons).
2. Set the environment variables from `.env.example`:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (browser) and
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLICKUP_API_TOKEN`,
   `CLICKUP_WEBHOOK_SECRET` (set after step 3), `CLICKUP_TEAM_ID`,
   `CRON_SECRET` (server-only — never shipped to the browser).
3. Deploy. `vercel.json` ships with DAILY cron schedules so the Hobby plan
   deploys without errors (Hobby rejects sub-daily crons at build time).
   For the real 15-minute cadence on `reconcile` and `pulse`:
   - **Hobby (free):** create two jobs at any external scheduler (e.g.
     [cron-job.org](https://cron-job.org)), each every 15 minutes, calling
     `/api/cron/reconcile` and `/api/cron/pulse` with the request header
     `Authorization: Bearer $CRON_SECRET`.
   - **Pro:** change those two schedules in `vercel.json` to `*/15 * * * *`
     and redeploy.
   The daily entries remain as a safety net either way.

### 3. ClickUp wiring

1. Create the webhook (idempotent):
   `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/admin/setup-webhook`
   — subscribes `taskCreated`, `taskStatusUpdated`, `taskDeleted`,
   `taskUpdated` on the Designers Team space. Copy the returned webhook
   `secret` into the `CLICKUP_WEBHOOK_SECRET` env var and redeploy.
2. One-time historical backfill:
   `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/admin/backfill`
   (re-run per list with `?list_id=` if a run times out; it is resumable and
   idempotent). Backfilled tasks carry `metrics_confidence='backfill'` —
   revision-round counts on them are a lower bound (§6.3).
3. Verify (§17): duplicate a task in ClickUp and confirm the copy appears as
   a **new** task with a fresh status clock.

### 4. Sanity checklist

- Log in as an ops user → `/ops` shows the attention block and live board.
- Move a task in ClickUp → the board updates within seconds (webhook) or
  15 minutes at worst (reconciliation).
- A designer login sees only their own data at `/me` (RLS-enforced).
- `Cancel` a test task → a critical alert appears for Ops + CEO.

### Maintenance endpoints

- `POST /api/admin/recompute-attendance?from=YYYY-MM-DD&to=YYYY-MM-DD[&designer_id=]`
  (Bearer `CRON_SECRET`) — retroactive attendance recompute after late leave
  entries or schedule edits older than the nightly 7-day self-healing sweep.

## Implementation notes & deviations (flagged, not hidden)

- `task_metrics.first_delivered_at`, `attendance_daily.needs_review`, and
  `attendance_daily.checkout_source` are implementation columns added beyond
  spec §7 — needed to compute "delivered in period" (§11 Tier 1) and to
  surface forgotten-checkout review flags (§9.2). No workflow change.
- `audit_log` table per spec §22.8.
- Production time (`production_min`) follows the §7 schema contract
  (assignment → first delivery); start latency is also reported separately.
- CSR send latency on first deliveries is not measurable (no intermediate
  status — §19); it is reported on revision cycles at team level only.
- The weekly report is in-app + PDF (jsPDF). An emailed digest is a
  config-gated add-on requiring an email provider (§22.9) and is not wired.
- **Leave balance** (§13.3) is not computable — the §7 schema holds no leave
  allowance, and §20.12 forbids expanding it. The self-view shows leave days
  recorded this year instead; add an allowance policy to `app_config` if a
  true balance is ever needed.
- `aging_days_client_response` seeds as **2** (lower than the default 3): §12
  normatively requires a lower threshold for `client response`, and §18's
  illustrative "e.g. 4" contradicted it — the normative rule wins (editable).
- Designer self check-in/out timestamps are pinned server-side to "now"
  (±grace for clock skew) by RLS — self marks cannot be backdated. Ops manual
  marks may be backdated and are audit-logged; ops may also delete a
  mis-entered self/manual mark (audited). The ClickUp event log itself is
  strictly append-only for everyone.
- Cancellation is read faithfully as designer-fault **by definition** (§2)
  but surfaced as a flag to investigate, with full history one click away
  (§4.4).

## Local development

```bash
npm install
cp .env.example .env   # fill in the VITE_ vars at minimum
npm run dev            # dashboards on http://localhost:5173
npm run build          # typecheck + production build
```

The API functions run on Vercel (`vercel dev` if you need them locally).
