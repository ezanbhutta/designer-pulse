# Design Team OS — Build Specification

**Working name:** Design Team OS (parallel to the existing *CSR Pulse*; rename freely — a natural fit would be *Studio Pulse*).
**Purpose:** A real-time production-health and attendance system for a remote graphic-design team, sourced from ClickUp task history plus in-app attendance marks. It replaces a manual checkbox spreadsheet with a live, auditable system that measures designer quality, speed, capacity, and presence.
**Build target:** Claude Code. This document is self-contained. Do not assume access to any other system or conversation. Everything needed to build is here.

---

## 0. Reading Order for the Builder

1. §1 Scope, §2 Definitions, §3 ClickUp Data Model — understand the domain.
2. §4 Attribution Model — this is the intellectual core; every metric depends on it.
3. §5 Architecture, §6 Ingestion, §7 Schema — build the data spine.
4. §8–§10 Roster / Attendance / Leave — build the config and presence layers.
5. §11 Metrics, §12 Alerts, §13 Dashboards — build the surfaces.
6. §14–§18 RBAC, Automation, Stack, Sequencing, Config.
7. **§20 Experience & Intelligence + §21 Design Language + §22 Spec Hardening — binding on every screen. Read all three before building any UI. §20 = how it interprets/behaves; §21 = how it looks/feels; §22 = resolved decisions and two hard rules (ClickUp is read-only — the tool observes assignment, never performs it; single PKT timezone for the whole team) that override any conflicting earlier text.**

Build in the order of §17.

---

## 1. Scope

### 1.1 Goals
- Automatically track, per designer: projects assigned, projects completed, revision count, and live status distribution — plus the deeper quality/speed/capacity metrics those volume numbers cannot express.
- Provide **three role-scoped dashboards**: Ops (PM/HR/Admin), CEO (separate), and Designer (self-view).
- Track attendance for a **remote** team via in-app check-in / check-out, cross-validated against ClickUp activity.
- Manage leave, off-days, half-days, and holidays.
- Fire real-time alerts on capacity gaps, task aging, cancellations, and performance decay.

### 1.2 Non-Goals (explicit — do not build these)
- **No payroll or salary computation.** Paid/unpaid flags are *recorded for reporting only*. The system never calculates money.
- **No revenue, order value, client identity, or profile/brand tracking.** This is a production-health system, not a P&L or CRM. Do not add value/client/profile fields.
- **No individual CSR performance tracking.** CSRs act on tasks but are not measured here. CSR-related latency is reported only at the team/ops level.

### 1.3 Design principle
The volume counts (assigned / completed / revisions) are the **base layer**, not the product. The product is the layer beneath them: *first-pass quality, quota attainment, real speed, and trend*. Build the volume counts, but treat quality and attainment as the headline.

---

## 2. Core Concepts & Definitions

- **Project = one ClickUp task.** The atomic unit. All metrics derive from tasks and their status-transition history.
- **Assignment.** A PM/CSR/admin creates a **new task inside a specific designer's ClickUp list**. The task is born in status `pickup your projects`. Task creation time **is** the assignment time.
- **Duplication.** Reassigning existing work is always done by **duplicating** the task (never editing the original's assignee). A duplicate is a **new task** with a fresh clock and counts as a new project. Two duplication reasons exist:
  - **Handoff (relay):** logo → branding → animation, etc. Cross-discipline forward pass to the next specialist. Both designers did correct work. **Neutral** — both count, no fault.
  - **Redo (rescue):** the first designer's work was not good enough, so it is duplicated to another designer. **Rule: a redo always ends the original task in `cancelled`.** Therefore failure is never lost — it lives entirely in the `cancelled` status. The system does **not** need to infer handoff-vs-redo; it only needs to read `cancelled`.
- **Fault rule (given by the business, encode as-is):**
  - If an order is lost and it is the **designer's fault** in any way → the task is set to `cancelled`. **`cancelled` = designer-fault terminal failure, by definition.**
  - If an order dies for an **account / CSR / client** reason → the task is set to `complete`. Therefore **`complete` ≠ business win.** Completion rate is not success rate; do not conflate them.
- **Quota.** Each designer has a **daily project intake target** (a floor, not a ceiling). Unfilled slots = **spare capacity**, not "behind." The quota is a **calendar**, not a constant: it can vary by weekday and by specific date (e.g. one designer does 3/day but 2 on two specific Fridays a month). Model it as a per-designer, per-day expected number.
- **Capacity units are not comparable across teams.** A logo, a 25-page brand guide, a landing page, and an animation are different units. **Never compare raw project counts across disciplines.** The only fair cross-team comparison is **Quota Attainment %** (did they hit *their own* number).

---

## 3. ClickUp Data Model

### 3.1 Location
All designer projects live in the ClickUp space **"Designers Team"** (space id `90187090116`). Do **not** read any other space (a separate "Design Department" space exists and must be ignored).

Structure: Space → **Folders by team** → **one List per designer**.
- Folder **Logo Team** (`90189446367`)
- Folder **Branding Team** (`90189446382`)
- Folder **Animation Team** (`901812772007`)
- Folder **Website designs** (`901813962820`)

Each designer has a personal list. Example list ids (discover the full, current set at build time via the hierarchy API — designers change):
- Amin Ullah `901811577312`, Nimeazad `901816036362`, Rejaul Karim `901815604933`, Shaoor Haider `901814946775`, Md Dulal `901811883458`, Hamid `901811883441`, Owais Nadeem `901816113089`, etc.

**At startup and on a schedule, auto-discover lists** by walking the Designers Team space hierarchy, and map each list to a roster designer via `clickup_list_id`.

### 3.2 The status flow (9 statuses, one ordered pipeline)
Every designer list uses the same **status names** in this order. **Critical:** ClickUp status *IDs are per-list* (e.g. Amin's `revision` is `sc901811577312_hncYmo3E`, another designer's `revision` has a different id). **Canonicalize by status NAME (lowercased, trimmed), never by id.**

| # | Canonical status | Set by | Meaning |
|---|---|---|---|
| 0 | `pickup your projects` | (birth) | Assigned, not yet started |
| 1 | `in progress` | Designer | Actively designing |
| 2 | `deliver to client` | Designer | First draft delivered internally (file attached) |
| 3 | `revision` | CSR | Changes required (internal reject OR client revision) |
| 4 | `revision complete` | Designer | Revision done, file attached |
| 5 | `client response` | CSR | Sent to client; waiting on client |
| 6 | `final files` | Designer | Approved; packaging production files |
| 7 | `cancelled` | CSR | Designer-fault terminal loss |
| 8 | `complete` | CSR | Closed (may or may not be a business win) |

Both `deliver to client` and `revision complete` transition **forward to `client response`** when the CSR sends to the client. `client response` is the **universal outbound/client-wait gate**.

### 3.3 Other task fields to capture
- **Assignee** (ClickUp user id; e.g. Amin = `101464943`) — secondary link to designer.
- **Priority** (urgent/high/normal/low).
- **Due date**, **date closed**.
- **Tags** encode scope: `2 concepts`, `3 concepts`, `4 concepts`, `premium`, `social media kit`, etc. Parse a leading integer + "concept(s)" into `concept_count`. Tags are **inconsistent** (some tasks lack them) — treat `concept_count` as nullable.

### 3.4 Time-in-status availability
The **"Total time in Status" ClickApp is enabled**. The API returns per-status history with cumulative time and the timestamp each status was entered (`since`). This is usable for **historical backfill**. Note: it **aggregates re-entries** (one row per status), so it under-counts *revision rounds* on historical tasks. For tasks tracked going forward via webhooks, revision rounds and prior-status classification are **exact** (see §6).

---

## 4. Attribution Model (the core)

Every status is owned by exactly one actor. This split is what makes the metrics fair and defensible.

### 4.1 Clock ownership
| Span | Owner | Metric it produces |
|---|---|---|
| `pickup` → `in progress` | Designer | Start latency |
| `in progress` → `deliver to client` | Designer | **Production time** (first-pass speed) |
| time held in `revision` | Designer | Revision turnaround (recovery speed) |
| `client response` → `final files` | Designer | Final-file prep time |
| `revision complete` → `client response` | CSR/Ops | CSR send latency (revisions) |
| `final files` → `complete` | CSR/Ops | CSR close latency |
| time held in `client response` | Client | **Client wait** (excluded from designer speed) |

**Rule:** designer speed metrics use only designer-owned spans. Time parked in `client response` must **never** count against a designer.

### 4.2 Defect classification (by the status *before* `revision`)
Every revision is a first-pass-quality defect (whether CSR- or client-caught, both count against quality). The **prior status classifies the source** for diagnosis:
- `deliver to client` → `revision` = **CSR-caught** (internal reject; never reached the client).
- `revision complete` → `revision` = **CSR-caught** on a revised file (worse signal — the fix also failed).
- `client response` → `revision` = **Client-caught** (client saw it and wants changes).

Diagnostic use: high CSR-caught = coach the designer; high client-caught with low CSR-caught = tighten the CSR gate or the brief.

### 4.3 Failure tiers
- **Revision** = recoverable defect (order survived).
- **Cancelled** = terminal defect, designer-fault (order lost).
- **Clean complete, zero revisions** = the win.

### 4.4 Known integrity caveat (surface, don't hide)
Fault attribution on cancellations rests on **human CSR judgment at close**. The system reads it faithfully but cannot verify it. Treat a cancellation as a **flag to investigate**, not a verdict; build decisions on the *trend*, not a single row. Provide a "cancellations with full history" view for 10-second review (§13).

---

## 5. System Architecture

**Pattern: immutable raw events → derived layers → tiered compute.** (Raw is append-only truth; everything else is recomputable from it. Corrections never mutate raw.)

### 5.1 Real-time, but tiered — do NOT live-recompute everything
Ingest every ClickUp change instantly. Split what is *shown* by how fast it must move:
- **Instant (event-driven):** assignment-gap window, task-aging thresholds, cancellations, live status board. Fire the moment the webhook lands.
- **View-time (compute on open):** current status distribution, utilization, who's loaded now. Cheap, always fresh.
- **Short-cache (~5 min):** first-pass quality, attainment, speed. Averages over many tasks; a 5-minute-old value is decision-identical to live. Do not recompute per event.
- **Nightly (scheduled):** trends, forecasts, burnout composites. Historical by nature.

### 5.2 Ingestion reliability — two channels
- **ClickUp webhooks** → instant event ingestion.
- **Reconciliation pull every 15–30 min** → re-reads ground truth from ClickUp to heal **dropped webhooks**. This is mandatory, not optional. Webhooks fail (network, downtime, restarts); without reconciliation one dropped event permanently desyncs a designer's counts.

### 5.3 Stack (match existing internal systems)
- **Frontend:** React 18 + Vite + Tailwind. Lucide icons. jsPDF for report/PDF export. papaparse/xlsx if CSV import is ever needed.
- **Backend/data:** Supabase (Postgres + Row-Level Security + `pg_cron`). Serverless functions on Vercel for webhook receiver, reconciliation, and compute jobs.
- **Auth:** server-side session; secrets never reach the browser; role-scoped reads via RLS (mirror the token/role pattern used in the existing handbook app).
- **Deploy:** Vercel (Vite auto-detected). ClickUp API token and webhook secret stored as environment variables/secrets, never client-side.

---

## 6. Data Ingestion

### 6.1 Webhook subscriptions (Designers Team space or per designer list)
Subscribe to: `taskCreated`, `taskStatusUpdated`, `taskDeleted` (optionally `taskUpdated` for tag/due changes). Verify webhook signatures with the shared secret.

Handling:
- **`taskCreated`** in a designer list → insert `clickup_events(created)`; upsert `task_state`; **assignment time = task `date_created`**; evaluate assignment-gap timing.
- **`taskStatusUpdated`** → insert `clickup_events(status_change, from_status, to_status, event_time)` with **canonicalized names**; update `task_state.current_status`; recompute `task_metrics` for that task; evaluate alerts (cancellation, aging reset).
- **`taskDeleted`** → mark `task_state` deleted (soft); do not purge history.

### 6.2 Reconciliation (cron, every 15–30 min)
- Pull tasks in all Designers Team lists updated since `last_sync` (filter by list, order by updated, date filter).
- For each: if ClickUp's current status ≠ `task_state.current_status` **and** no matching event exists, insert a `clickup_events(source='reconciliation')` transition and recompute.
- Detect tasks that exist in ClickUp but not in `task_state` (missed `taskCreated`) and backfill them.
- Persist `last_sync`.

### 6.3 One-time historical backfill
For every existing task at first run:
- Call the time-in-status endpoint → `status_history` (ordered by `since`) → reconstruct the transition sequence into `clickup_events(source='backfill')`.
- Compute `task_metrics`. **Caveat:** re-entries are aggregated, so `revision_rounds` for pre-webhook tasks is a **lower bound**; going forward it is exact. Store a `metrics_confidence` flag (`backfill` vs `live`).

### 6.4 Status canonicalization
`canonical = lower(trim(status_name))`. Map every list's statuses by name to the 9 canonical values in §3.2. Reject/log any unknown status name for review.

---

## 7. Database Schema (Postgres / Supabase)

> All timestamps `timestamptz`. Enable RLS on every table (§14). Raw tables are append-only (block UPDATE/DELETE via trigger; corrections go through separate log/manual entries). Service-role key used by ingestion/compute (bypasses RLS); dashboard uses anon→authenticated.

```sql
-- ─── ROSTER: config source of truth (ClickUp cannot hold this) ───────────────
create table designers (
  id uuid primary key default gen_random_uuid(),
  clickup_list_id text unique,
  clickup_user_id bigint,
  name text not null,
  team text not null,                       -- Logo | Branding | Animation | PPT | Canva
  specialty text,
  timezone text not null default 'Asia/Karachi',
  status text not null default 'active',    -- active | archived | deleted
  order_index int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Effective-dated capacity + schedule so historical metrics stay anchored to
-- the config that was true at the time. A quota/shift change opens a new row.
create table designer_schedule (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references designers(id) on delete cascade,
  effective_from date not null,
  effective_to date,                        -- null = current
  daily_quota int not null,
  shift_start time not null,
  shift_end time not null,
  is_overnight boolean generated always as (shift_end <= shift_start) stored,
  weekly_off smallint,                      -- 0=Sun .. 6=Sat (Postgres dow); null=none
  late_grace_min int default 15,
  early_leave_grace_min int default 15
);

-- Specific-date quota overrides (e.g. Amin's two reduced Fridays). PM enters them.
create table quota_exceptions (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references designers(id) on delete cascade,
  the_date date not null,
  daily_quota int not null,
  reason text,
  unique (designer_id, the_date)
);

-- ─── RAW EVENT LAYER (immutable, append-only) ────────────────────────────────
create table clickup_events (
  id bigint generated always as identity primary key,
  task_id text not null,
  list_id text not null,
  designer_id uuid references designers(id),
  event_type text not null,                 -- created | status_change | deleted
  from_status text,                         -- canonical name
  to_status text,                           -- canonical name
  event_time timestamptz not null,
  source text not null default 'webhook',   -- webhook | reconciliation | backfill
  raw jsonb,
  inserted_at timestamptz default now(),
  unique (task_id, event_type, event_time, to_status)
);

-- ─── DERIVED: current task snapshot ──────────────────────────────────────────
create table task_state (
  task_id text primary key,
  list_id text not null,
  designer_id uuid references designers(id),
  name text,
  current_status text,
  priority text,
  concept_count int,                        -- parsed from tags; nullable
  scope_tags text[],
  created_at timestamptz,                   -- assignment time
  due_date timestamptz,
  closed_at timestamptz,
  last_event_at timestamptz,
  deleted boolean default false,
  updated_at timestamptz default now()
);

-- ─── DERIVED: per-task metrics (recomputable from clickup_events) ─────────────
create table task_metrics (
  task_id text primary key references task_state(task_id) on delete cascade,
  designer_id uuid references designers(id),
  start_latency_min int,                    -- pickup -> in progress
  production_min int,                       -- pickup -> first 'deliver to client'
  first_pass_clean boolean,                 -- never entered 'revision'
  revision_rounds int default 0,            -- entries into 'revision'
  csr_caught_rounds int default 0,          -- from 'deliver to client' or 'revision complete'
  client_caught_rounds int default 0,       -- from 'client response'
  revision_turnaround_min int,              -- total time held in 'revision'
  client_wait_min int,                      -- total time held in 'client response'
  outcome text,                             -- complete | cancelled | in_flight
  is_cancelled boolean default false,       -- designer-fault terminal
  metrics_confidence text default 'live',   -- live | backfill
  computed_at timestamptz default now()
);

-- ─── ATTENDANCE: self-marks (raw, append-only) ───────────────────────────────
create table shift_marks (
  id bigint generated always as identity primary key,
  designer_id uuid references designers(id) on delete cascade,
  mark_type text not null,                  -- check_in | check_out
  marked_at timestamptz not null,
  source text default 'self',               -- self | auto_clickup | auto_shift_end | manual
  created_at timestamptz default now()
);

-- ─── ATTENDANCE: derived daily (recomputable) ────────────────────────────────
create table attendance_daily (
  id bigint generated always as identity primary key,
  designer_id uuid references designers(id) on delete cascade,
  work_date date not null,                  -- shift-START day (overnight-aware)
  declared_in timestamptz,                  -- self check-in
  declared_out timestamptz,                 -- self check-out or auto-close
  first_activity timestamptz,               -- first ClickUp event in shift window
  last_activity timestamptz,                -- last ClickUp event in shift window
  scheduled_in timestamptz,
  scheduled_out timestamptz,
  worked_minutes int default 0,
  warmup_gap_min int,                       -- declared_in -> first_activity
  late_minutes int default 0,
  early_leave_minutes int default 0,
  is_half_day boolean default false,
  status text,                              -- Present|Incomplete|Absent|Leave|Holiday|HolidayWorked|WeeklyOff
  computed_at timestamptz default now(),
  unique (designer_id, work_date)
);

-- ─── LEAVE / CALENDAR ────────────────────────────────────────────────────────
create table leaves (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references designers(id) on delete cascade,
  leave_type text,
  start_date date not null,
  end_date date,                            -- null = single day
  paid boolean not null default true,       -- recorded only; no pay computed
  status text not null default 'approved',
  reason text,
  created_by uuid,
  created_at timestamptz default now()
);

create table half_days (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references designers(id) on delete cascade,
  the_date date not null,
  from_time time,                           -- absent window
  to_time time,
  paid boolean default false,
  reason text
);

create table holidays (
  id uuid primary key default gen_random_uuid(),
  the_date date not null unique,
  name text
);

create table holiday_workers (              -- volunteers who work a holiday (bonus-eligible)
  the_date date not null,
  designer_id uuid references designers(id) on delete cascade,
  primary key (the_date, designer_id)
);

-- ─── ALERTS ──────────────────────────────────────────────────────────────────
create table alerts (
  id bigint generated always as identity primary key,
  alert_type text not null,   -- assignment_gap | task_aging | cancellation |
                              -- quality_decay | burnout | forgotten_checkout | workload_forecast
  designer_id uuid references designers(id),
  task_id text,
  severity text default 'warning',          -- info | warning | critical
  message text,
  context jsonb,
  status text default 'open',               -- open | acknowledged | resolved
  fired_at timestamptz default now(),
  resolved_at timestamptz
);

-- ─── CONFIG + USERS ──────────────────────────────────────────────────────────
create table app_config (key text primary key, value jsonb not null);

create table app_users (
  id uuid primary key default gen_random_uuid(),  -- = supabase auth uid
  email text unique,
  role text not null,          -- admin | manager | pm | hr | ceo | designer
  designer_id uuid references designers(id),      -- set only for role='designer'
  active boolean default true
);
```

Add indexes on: `clickup_events(task_id)`, `clickup_events(designer_id, event_time)`, `task_state(designer_id, current_status)`, `task_metrics(designer_id)`, `attendance_daily(work_date)`, `shift_marks(designer_id, marked_at)`, `leaves(designer_id)`, `alerts(status, fired_at)`.

---

## 8. Roster Module

The **source of truth ClickUp does not hold**: quota, shift, timezone, off-day, lifecycle. Without it, ClickUp data is raw counts with no target to measure against.

### 8.1 Fields (per designer)
Identity (name, team, specialty, `clickup_list_id`, `clickup_user_id`, timezone) + effective-dated schedule (daily quota, shift start/end, weekly off, grace) + quota exceptions + lifecycle status.

### 8.2 Lifecycle
- **Active / Archived / Deleted.** **Archive is the default exit** — the designer leaves but their tasks and metrics remain queryable (history survives). **Delete** is a rare hard purge. Never let removing a designer orphan their production history.

### 8.3 Effective-dating (mandatory)
Editing quota/shift/weekly-off **opens a new `designer_schedule` row** (closes the prior with `effective_to`); it does **not** overwrite. Last month's attainment is judged against last month's quota. **Editing a name triggers no recompute.** Editing schedule/quota/off-day **triggers a recompute** of affected `attendance_daily` and attainment over the affected date range.

### 8.4 Seed roster (verify quotas/shifts on first run — treat as editable defaults)
Teams and members (specialty in parentheses). **Daily quotas below are best-known and must be confirmed in the UI; several designers have exceptions.**

- **Logo:** Nimeazad (5), Rejaul Karim (3), Md Dulal (3), Amin Ullah (**3/day, but 2 on two specific Fridays a month** → enter those Fridays as `quota_exceptions`), Atta Razaq (3), M. Tariq (2), Md Zahid Hasan (3, with 3 concepts each), Abiha Imran (3), Shaoor Haider (2), Md Rashadul Haque (3/day, 3 concepts each), Md Rezaul (2).
- **Branding:** Owais Nadeem (6), Khubaib (2 brand style guidelines), Hamid (4), Owais Rehan (2), Afjal Hussain (2 brandings, min 25 pages).
- **Animation:** Syed Mubahat (1–2).
- **Other:** Aqeel (PPT), Shahmeer (Canva).

Shifts are **staggered and several cross midnight** (examples: Amin 11:00–23:00, Owais Rehan 21:00–05:00, Md Dulal 18:00–03:00, Rejaul 21:00–05:00, Nimeazad 09:00–17:00). Off-days vary per designer (Friday / Saturday / Sunday). Enter exact values in the UI.

---

## 9. Attendance & Presence Module

Remote team → **no hardware clock**. Presence is a **dual signal**: the designer's self-mark (declared) cross-validated against ClickUp activity (verified).

### 9.1 Capture
Two self-marks per shift: **Check-In** and **Check-Out** (buttons in the app; also settable via `manual` by PM/HR). These give a true session length and the worked-minutes engine.

### 9.2 Derived daily compute — `compute_attendance(designer, work_date)`
Recompute on: new shift mark, relevant ClickUp activity, schedule/leave/holiday change, or nightly.

1. **Resolve schedule** (effective-dated for `work_date`): shift window, `is_overnight`, `weekly_off`, grace values, timezone.
2. **Define the window.** Day shift: local calendar date. **Overnight shift:** collect marks/activity by **time window `[scheduled_in − 4h, scheduled_out + 4h]`** and attribute the whole night to the day the shift **started** (`work_date` = shift-start day). A post-midnight event recomputes **both** the start day and the next day so it lands on the correct one. Holiday/Leave/WeeklyOff are looked up on the shift's **physical calendar day**.
3. **Gather signals:** `declared_in` = first `check_in`; `declared_out` = last `check_out`; `first_activity`/`last_activity` = first/last `clickup_events` in the window.
4. **Forgotten-checkout fallback:** if `declared_in` exists but `declared_out` does not →
   - if ClickUp activity exists → auto-close `declared_out = last_activity` (source `auto_clickup`);
   - else → `declared_out = scheduled_out` (source `auto_shift_end`), **and** mark this day for review.
   - Only classify **Incomplete** when there is a check-in but **neither a check-out nor any ClickUp activity** (nothing corroborates work).
5. **Compute:** `worked_minutes = declared_out − declared_in`; `warmup_gap_min = first_activity − declared_in`; `late_minutes = max(0, declared_in − (scheduled_in + late_grace))`; `early_leave_minutes = max(0, (scheduled_out − early_grace) − declared_out)`.
6. **Status resolution:**
   - Any marks or activity in window → **Present** (plus **HalfDay** flag if a `half_days` row exists for the date; worked minutes reduced by the absent window).
   - No marks and no activity → resolve in priority order: **Holiday → Leave → WeeklyOff → Absent** (Holiday/Leave keyed on physical day; WeeklyOff if `weekly_off = dow(work_date)`).
   - Holiday **volunteer** who has activity/marks → **HolidayWorked** (bonus-eligible; system marks only).
   - Working on a weekly-off day (activity present on the off day) → **Present** (worked on a day off), never Absent.

### 9.3 Warm-Up Gap (headline attendance metric)
`declared_in → first_activity`. This is the honest remote-presence metric: not "did you clock in" but "how long after clocking in did real work start." A green "present" light with a 2.5-hour warm-up gap is idle paid time. Surface per designer and team-wide.

---

## 10. Leave & Calendar Module

Feeds §9's status resolution. Recorded for reporting; **no pay is computed** anywhere.

- **Leave:** type, date range, `paid` flag (Paid/Unpaid — recorded only), status (default approved), reason. May span multiple days. Entered by PM/HR/Admin.
- **Half-day:** date + absent window (`from_time`→`to_time`) + `paid` + reason. Day stays **Present + HalfDay**; worked minutes reduced by the window.
- **Holiday:** company-wide date + name. Everyone → **Holiday** unless in `holiday_workers` and they worked → **HolidayWorked**.
- **Weekly off:** per-designer `weekly_off` day on the schedule; auto-neutralized so that day never reads Absent.

---

## 11. Metrics Catalog

All metrics derive from `clickup_events` / `task_metrics` / `attendance_daily`. Use **median** (not mean) for durations so one nightmare client does not distort. Period = day / week / month unless noted. **All cross-designer comparison uses Attainment %, never raw counts.**

### Tier 0 — Volume base
- **Projects Assigned** = count of tasks created in a designer's list in period.
- **Projects Completed** = count reaching `complete` in period.
- **Revision Count** = total entries into `revision` in period.
- **Status Distribution** = live count of open tasks per canonical status, per designer and team-wide.

### Tier 1 — Judgment (headline)
- **First-Pass Quality %** = (tasks delivered in period that are `first_pass_clean`) / (tasks delivered in period). "Delivered" = reached at least `deliver to client`. *This is the primary designer score — skill, not volume.*
- **Quota Attainment %** = completed / expected-quota. Daily: `completed_today / expected_quota_today` (schedule + `quota_exceptions`). Weekly/monthly: `Σ completed / Σ expected`. *The only fair cross-team number.*
- **Production Speed** = median `production_min` over tasks first-delivered in period (client-wait excluded).

### Tier 2 — Diagnostic
- **Defect Source Split** = Σ `csr_caught_rounds` vs Σ `client_caught_rounds`.
- **Revision Turnaround** = median `revision_turnaround_min`.
- **Cancellation Rate** = count `is_cancelled` / count assigned in period.
- **Rework Load** = mean `revision_rounds` per task.

### Tier 3 — Capacity & workload
- **Assignment Gap** = `expected_quota_today − tasks_created_today`, **evaluated at shift-start + 60 min**. Positive = idle paid capacity. **Attributed to the PM/assignment team, not the designer.**
- **Utilization** = active load / quota, where active load = tasks in designer-owned statuses (`pickup`, `in progress`, `revision`). Live gauge.
- **Warm-Up Gap** = §9.3.
- **Project Aging** = per open task, `now − last_event_at` (time in current status); flag tasks over threshold, **especially in `client response`** (revenue rotting in limbo).

### Tier 4 — Trend & forecast (nightly)
- **Quality Trend** = First-Pass Quality this period vs previous (Δ). Detects slow decay before it's a crisis.
- **Speed Trend** = Production Speed over time (early burnout signal).
- **Burnout Risk** = composite: rising revision turnaround + falling attainment + shrinking warm-up gap with sustained presence (online but producing less). Weighted, normalized 0–100; thresholds in config. Leading indicator.
- **Workload Forecast** = 7-day rolling inflow (tasks created/day) vs completion rate (tasks completed/day); projected backlog = `open_now + (inflow − completion) × horizon`. Warns of next week's overload before it lands.

### Tier 5 — Team / CEO
- **Team Throughput** = completions/week, trended.
- **Team First-Pass Quality** = per team (Logo / Branding / Animation).
- **CSR Send Latency** = median `revision complete → client response` and `final files → complete` (team/ops level only; no individual CSR tracking).
- **Client Wait** = median `client_wait_min` (isolates client drag from team drag).
- **Bottleneck Heatmap** = distribution of open tasks across statuses + median time-in-status per status (shows whether the constraint is production, the CSR gate, or the client).

---

## 12. Alerts Engine

Watches the raw event layer; writes to `alerts`; routes to dashboards. Thresholds in `app_config`.

| Alert | Trigger | Data | Routes to | Severity |
|---|---|---|---|---|
| **Assignment gap** | Shift-start + 60 min timer per designer; slots still open | roster shift + today's created count | Ops (PM) | warning |
| **Task aging** | Open task crosses `aging_days` in a status (lower threshold for `client response`) | `task_state.last_event_at` | Ops | warning→critical by age |
| **Cancellation** | Task enters `cancelled` | task + designer | Ops + CEO | critical |
| **Quality decay** | Nightly: First-Pass Quality drop > `decay_pct` vs prior period | trend | CEO + Ops | warning |
| **Burnout risk** | Nightly: composite crosses `burnout_score` | trend composite | CEO + Ops | warning |
| **Forgotten checkout** | Check-in with no check-out and auto-close applied | attendance_daily flag | Ops (HR) | info |
| **Workload forecast** | Projected backlog > `forecast_threshold` | inflow vs completion | CEO + Ops | warning |

Alerts have lifecycle `open → acknowledged → resolved`.

---

## 13. Dashboards (three role-scoped products)

Build as **three distinct surfaces**, not one view with a filter. All reads role-scoped via RLS (§14). **Every surface is bound by §20** — each leads with a verdict (not a table), every metric ships with its interpretation, and the system proposes the next action. The lists below are the *content*; §20 governs *how it must feel*.

### 13.1 Ops Dashboard — PM / HR / Admin (the daily cockpit; full control)
- **Leads with — the Attention block (top of page, before any table):** the ranked list of what needs a human *now* — open assignment gaps past the shift+60 window (with a one-tap "assign N to [designer]" suggestion), tasks aged past threshold in `client response`, fresh cancellations, forgotten-checkout flags. If nothing needs attention, it says so plainly ("All designers staffed to quota, no aging tasks") — a calm empty state is a feature.
- **Live board:** every open task by status, per designer; assignment gaps highlighted at shift-start+60.
- **Assignment view:** who is under quota *now* (spare capacity), who is drowning.
- **Roster management:** full CRUD, effective-dated schedule edits, archive/delete.
- **Leave/holiday/half-day management:** full CRUD.
- **Attendance:** today's presence, warm-up gaps, forgotten-checkout flags; manual check-in/out override.
- **Alerts inbox:** all alerts, acknowledge/resolve.
- **Per-designer drill-down:** all Tier 0–4 metrics + task history.
- **Aging list:** oldest tasks, `client response` swamp surfaced.

### 13.2 CEO Dashboard — separate surface (decisions: keep / coach / cut / scale)
- **Leads with — the Verdict block:** at most 3–5 plain-language calls the CEO should act on this week, each pre-interpreted. Not "Rejaul: 71% FPQ" but *"Rejaul's first-pass quality fell 12% this month — 3 of his last 10 went to revision, all CSR-caught. Coaching flag."* Not a chart of throughput but *"Logo team is the constraint — 60% of aging tasks sit there; consider one more logo hire before next week's forecasted overload."* The dashboard interprets; the CEO decides.
- **Team health:** Team Throughput, Team First-Pass Quality (by team), Bottleneck Heatmap.
- **Outliers:** top/bottom designers by First-Pass Quality and Attainment (normalized, cross-team-fair).
- **Trends:** Quality Trend, Speed Trend, Burnout Risk board.
- **Forecast:** Workload Forecast (hire/rebalance-ahead signal).
- **Cancellations with full history:** every cancel, one click to its status trail, for 10-second fault review (§4.4).
- **Auto weekly per-designer report:** PDF/card — attainment, quality, speed, trend (the pre-built Monday review).
- Read-only on operations; this is a decision cockpit, not a control panel.

### 13.3 Designer Self-View — designer role (own numbers only)
- **Leads with — one honest line about their day/week:** *"You're at 2 of 3 today — one slot open."* or *"Your first-pass quality is up this week — 8 of 9 clean."* Motivating and truthful, never a wall of numbers. The check-in/out control is the most prominent element when they haven't marked in yet.
- Their own: assigned, completed, attainment %, first-pass quality, production speed, revision turnaround, current tasks by status.
- Their own attendance: check-in/out buttons, today's status, warm-up gap, worked hours, leave balance/history.
- **No peer data, no other designers, no CSR names, no team rankings.** (Enforced at the RLS/RPC layer, not just the UI.)

---

## 14. RBAC & Auth

- **Roles:** `admin`, `manager`, `pm`, `hr` → full Ops access. `ceo` → CEO dashboard. `designer` → self-view only (scoped by `app_users.designer_id`).
- **Enforcement:** Row-Level Security on every table. Designer reads are constrained to their own `designer_id` via a security-definer RPC (never trust the client to filter). Ingestion/compute use the service-role key (bypass RLS). Dashboard uses anon→authenticated; unauthenticated = no access (secure by default).
- **Secrets:** ClickUp API token, webhook secret, service-role key — server-side only, never shipped to the browser.

---

## 15. Automation Map (manual task → automation)

| Manual task today | Replaced by | Trigger | Output / dashboard impact |
|---|---|---|---|
| Two managers hand-copying a daily checkbox grid | **Deleted.** Auto-detected assignment | webhook on `taskCreated` in a designer list | Live assigned-count vs quota |
| "Is his quota filled?" eyeballing | **Assignment-gap alert** | shift-start+60 timer | Ops red flag *in time to fill it* |
| Chasing stale tasks from memory | **Task-aging alert + aging list** | task crosses age threshold | Revenue caught before client complains |
| Eyeballing overload | **Live Utilization gauge** | view-time | No human counting |
| Manual "how's the team" reporting | **Auto weekly per-designer report** | scheduled weekly | Pre-built Monday review (PDF/card) |
| Spotting a declining designer | **Quality-decay / burnout alert** | nightly trend cross | Early warning, not post-mortem |
| Judging cancellations | **Cancellations-with-history view** | on cancel | 10-second fault review |

---

## 16. Tech Stack & Deployment (summary)
React 18 + Vite + Tailwind + Lucide + jsPDF. Supabase (Postgres + RLS + `pg_cron`). Vercel serverless (webhook receiver, reconciliation cron, compute jobs). Env/secrets: `CLICKUP_API_TOKEN`, `CLICKUP_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, session secret. Deploy target Vercel; one-click from repo.

---

## 17. Build Sequencing

1. **Schema + RLS** (§7, §14). Append-only triggers on raw tables.
2. **Roster module** (§8) with seed + effective-dating + recompute-on-change.
3. **Ingestion** (§6): webhook receiver → `clickup_events` → `task_state`; status canonicalization; then reconciliation cron; then one-time backfill.
4. **Task metrics compute** (§4, §11 Tier 0–2) from the event log.
5. **Attendance + Leave** (§9, §10): self-marks, dual-signal compute, forgotten-checkout fallback, night-shift window, leave/holiday tables.
6. **Capacity/workload metrics** (§11 Tier 3) + **Alerts engine** (§12).
7. **Trends/forecast** (§11 Tier 4) as nightly `pg_cron` jobs.
8. **Dashboards** (§13): Ops → CEO → Designer, each RLS-scoped. **Build every screen to §20** — the verdict block, per-metric interpretation, proposed actions, smart defaults, and designed states are acceptance criteria, not later polish. A screen that only displays data is not done.
9. **Weekly report generation** (PDF) + polish.

Verify at step 3/4: **duplicate a task and confirm the copy starts with a fresh status clock** (the duplicate should not inherit the parent's time-in-status). All speed metrics on duplicated tasks depend on this.

---

## 18. Configuration (`app_config` keys to set)

- `timezone_default` = `Asia/Karachi`
- `assignment_gap_check_offset_min` = 60
- `aging_days_default` = e.g. 3; `aging_days_client_response` = e.g. 4
- `late_grace_min` / `early_leave_grace_min` defaults = 15
- `forgotten_checkout_mode` = `last_activity` | `scheduled_end` (default `last_activity`)
- `quality_decay_pct`, `burnout_score`, `forecast_threshold`, `forecast_horizon_days`
- `reconciliation_interval_min` = 15–30
- `overnight_window_buffer_hours` = 4

---

## 19. Assumptions & Open Items (flagged during discovery)

- **Cancellation fault is human-judged.** Reads faithfully; treat as investigate-flag, not verdict (§4.4).
- **Quotas/shifts in §8.4 are best-known defaults** — must be confirmed in the UI on first run; several designers carry exceptions.
- **Forgotten-checkout auto-close rule** (last-activity vs scheduled-end) is configurable; default last-activity.
- **Revision-rounds on pre-webhook (backfilled) tasks are a lower bound**; exact going forward. `metrics_confidence` distinguishes them.
- **Assignment-gap attribution defaults to the PM/assignment team**, not the designer.
- **First-delivery blind spot:** on the *first* draft, `deliver to client → client response` merges CSR send-time and client review-time (no intermediate status). Individual CSR speed is therefore only measurable on revision cycles, reported at team level.

---

## 20. Experience & Intelligence Requirements (cross-cutting — binding on every screen)

This section is not optional polish. It is a build requirement on **every** page, panel, dialog, and state in §13 and the modules. A screen that violates §20 is incomplete, the same as a screen missing a metric. The bar: *would this feel at home in a product built by Linear, Stripe, or Vercel?* If not, it is not done.

### 20.1 The Prime Directive — interpret, do not display
A page that only shows data is a bug. Every surface must answer, at the top, in this order:
1. **What do I need to know right now?** (the verdict / attention block)
2. **What should I do next?** (a proposed action, not just a red dot)
3. **What did the system catch that I would have missed?** (auto-detected problems)
4. **What insight is hidden in this data?** (the "so what" behind the numbers)

If a screen renders a number, a table, or a chart without also rendering its meaning, it fails this section.

### 20.2 Every metric ships with its interpretation
A figure never appears alone. Each metric renders with:
- **A delta** vs the relevant prior period (▲/▼ + magnitude), color-coded by *good/bad direction for that metric* (faster speed = green even though the number went down).
- **A state flag** where thresholds apply (on-track / watch / flag), from `app_config`.
- **A plain-language cause** when one is derivable from the event log. Not "Revision rate 30%" but "Revision rate 30% — 6 of 20, four caught by the client." The cause is already in `task_metrics` (defect source, rounds); surface it.

### 20.3 The system proposes the next action (recommendation layer)
Alerts (§12) are detection. This is **prescription** — every flagged state carries a suggested move, one tap where possible:

| Detected state | Proposed action rendered |
|---|---|
| Designer under quota at shift+60 | "Assign 2 more to Nimeazad" (he has open capacity) — one-tap deep-link into assignment |
| Task aging in `client response` | "Nudge client — parked 5 days" |
| Rising CSR-caught revisions on a designer | "Coaching flag: [designer], 3 internal rejects this week" |
| Forecast backlog breach next week | "Logo inflow > completion — rebalance or add capacity" |
| Designer online, warm-up gap > threshold | "[designer] checked in 2h ago, no production yet — check in with them" |

Recommendations are suggestions, never auto-actions. The human always confirms.

### 20.4 Smart defaults — never a blank-state configuration
The user adjusts; they never configure from empty. On open:
- **Date range** defaults to the decision window (Ops = today; CEO = this week vs last; Designer = this week).
- **Sort** defaults to worst-first / needs-attention-first, not alphabetical.
- **Grouping** defaults by team on any cross-designer view (because cross-team raw comparison is invalid — §2).
- **Filters** remember the last used per user. Every default is overridable and the override persists.

### 20.5 Progressive disclosure
Summary first, detail on demand. A designer row shows the verdict (attainment, quality flag, one-line status); expanding reveals the task list and full metric set; a task reveals its status trail. Never force the full picture on someone scanning for the one thing that's wrong.

### 20.6 Interaction standards (the Ops cockpit is used all day — treat it like a pro tool)
- **Fewer clicks:** any frequent action (assign, mark leave, acknowledge alert, check-in) is reachable in **one action** from where the user already is. No drill-then-act where act-in-place is possible.
- **Keyboard-first on Ops:** a **command palette** (⌘K / Ctrl-K) for jump-to-designer, assign, log leave, search. Arrow-key navigation of lists. Shortcuts for acknowledge/resolve.
- **Optimistic UI** on marks, edits, acknowledgements — reflect instantly, reconcile in background, roll back visibly on failure.
- **Undo over confirm.** Replace "Are you sure?" dialogs with immediate action + a 5-second Undo toast, *except* for the two irreversible/heavy operations: **delete a designer** (vs archive) and any bulk action — those keep an explicit confirm. Everything else: act, then offer undo.
- **No context switching for related work:** leave-logging, assignment, and alert-resolution happen in-panel (drawer/modal), not on a separate page that loses the user's place.

### 20.7 State design — every state is designed, not defaulted
- **Empty states teach.** "No designers yet — add your first from the roster" with the action inline; "No aging tasks — the board is clean" as reassurance. Never a blank panel.
- **Loading = skeletons, never spinners.** Match the shape of the incoming content so the layout doesn't jump. For the short-cache analytics (§5.1), show the last known value with a subtle "updating" shimmer rather than blanking.
- **Errors are actionable and specific.** "Couldn't reach ClickUp — showing data as of 14:32, retrying" beats "Something went wrong." Always state what the user is seeing and what the system is doing about it.
- **Success is felt, not just done.** Quiet confirmation (toast, checkmark, row settle) on every write.

### 20.8 Visual hierarchy & scanability
- **One accent color** carries meaning (attention/action). Status uses a **consistent semantic palette** across the whole app (e.g. `revision` and `cancelled` share the same warning/danger language everywhere they appear). Never re-color the same status differently on two screens.
- **Density with air:** the Ops board is dense by necessity — use whitespace, alignment, and typographic weight (not boxes and borders) to separate. Numbers right-aligned and tabular-figure aligned for scanning columns.
- **Size communicates priority.** The verdict block is visually dominant; raw tables recede. A manager's eye should land on the problem before the data.
- **Color is never the only signal** (accessibility — §20.10): pair every color state with an icon or label.

### 20.9 Micro-interactions & feedback
Purposeful motion only, 150–250ms. A status change on the live board animates the card to its new column. A resolved alert settles out of the list. A newly-fired alert arrives with a subtle pulse. The check-in button gives tactile, immediate response. Motion reinforces what changed; it never decorates.

### 20.10 Accessibility & responsiveness (baseline, not backlog)
- Contrast ≥ 4.5:1 on all text. Touch targets ≥ 44×44px. Base font ≥ 16px. Full keyboard operability. Visible focus states. Screen-reader labels on every control and every status.
- The **Designer self-view is mobile-first** (they check in and glance at their day from a phone). The **Ops and CEO dashboards are desktop-primary** but never broken on tablet.

### 20.11 Per-surface intelligence map (binding)
Each surface must satisfy all four columns. This is the acceptance test for §20.1.

| Surface | Immediate verdict | Proposed next action | Auto-detected problem | Hidden insight surfaced |
|---|---|---|---|---|
| **Ops** | Who needs staffing / what's aging / what cancelled — now | One-tap assign to a designer with capacity; nudge-client on aged tasks | Assignment gaps at shift+60; `client response` swamp; forgotten checkouts | Which designer has spare capacity *right now* to absorb overflow |
| **CEO** | 3–5 pre-interpreted weekly calls | Coach [designer] / add capacity to [team] / review cancellations | Quality decay, burnout risk, forecast breach | Whether the team constraint is production, the CSR gate, or client wait (bottleneck heatmap read in one line) |
| **Designer** | "You're at 2 of 3 — one slot open" | Check in; pick up next task | Their own aging tasks; unmarked check-in | Their own quality/speed trend vs their own past (never vs peers) |

### 20.12 What §20 does not change
No new modules, no altered data model, no new metrics, no workflow changes. §20 governs **presentation, interpretation, and interaction only** — how the already-specified system communicates and feels. If satisfying §20 appears to require a schema or workflow change, stop and flag it rather than expanding scope.

---


## 21. Design Language (cross-cutting — the visual and interaction system)

Studied from three existing internal systems and elevated past them. This section gives Claude Code the concrete tokens, patterns, and motion grammar so every screen inherits a coherent, premium feel by construction. §20 governs *what to show and how it behaves*; §21 governs *how it looks and feels at the pixel level*. Target bar: Linear, Stripe, Vercel.

### 21.0 Origin — what is reused, what is elevated
- **Reused (proven, keep):** the semantic **CSS-variable token architecture** (`R G B` triplets → `rgb(var(--token) / <alpha>)`), the violet brand `#7229FF` / deep ink `#160A33`, **Inter** as UI type, 44px minimum targets, restrained two-shadow elevation, 200ms motion, focus-visible rings, and the dashboard component vocabulary (animated stat tiles, sparklines, inline-edit cells, info-tips, sortable headers, status badges).
- **Elevated past baseline (this is the point):** the reading product leads with saturated violet; **an all-day ops cockpit must not**. Color becomes *signal*, motion becomes *calmer*, interpretation travels *with* the number, and dark mode becomes *first-class*. Details and rationale below.

### 21.1 Color system — semantic tokens (reuse the architecture verbatim)
Use CSS-variable semantic tokens, never raw hex in components, so the whole UI retunes from one place and stays WCAG-safe:
`--color-bg, --color-surface, --color-surface-2, --color-border, --color-fg, --color-muted, --color-brand (+ -fg, -soft), --color-success, --color-warning, --color-danger (+ -soft)`. Tailwind maps these to `bg-surface`, `text-muted`, etc. Muted text must clear **4.5:1** on its background (their handbook proved `#534A78` at 7.5:1 on white — keep that discipline).

**The elevation — color discipline (this is what makes it feel like Linear, not a template):**
The interface is **near-monochrome by default** — ink on canvas, with `surface`/`surface-2`/`border` doing the structural work. **Brand violet is reserved for exactly two things: the primary action and the active nav/selection state.** Status colors (success/warning/danger) are reserved for *meaning* — a red only ever means "problem," never decoration.
- *Why it improves the experience:* on a dense ops board, saturated brand color everywhere is noise; the eye can't find the one thing that's wrong.
- *Problem it solves:* the aging-task flag and the single primary action must pop — they can't if they compete with decorative violet.
- *Trade-off:* the app feels less overtly "branded" than the handbook.
- *Why it beats the baseline:* the handbook is a reading product where violet-forward is warmth; a cockpit is a scanning tool where color must be earned. Restraint is the upgrade.

### 21.2 Status color semantics (one palette, used identically everywhere)
Map the domain to a **single, consistent** status language. The same status wears the same color on every screen — never re-color a status between the board, a badge, and a chart.

| Domain state | Token | Read as |
|---|---|---|
| `pickup`, `in progress` | `fg`/`muted` neutral | in flight, no attention |
| `deliver to client`, `revision complete`, `final files` | `success` (soft) | forward motion / done-ish |
| `revision` | `warning` | defect, recoverable |
| `client response` | `muted` + a subtle "waiting" treatment | client-owned, not designer's fault |
| `cancelled` | `danger` | terminal failure |
| `complete` | `success` | closed (note: not always a win — §4) |
| Attendance: Present / HolidayWorked | `success` | working |
| Leave / Holiday / WeeklyOff | `muted` (calm, expected) | legitimately off — never alarming |
| Absent / Incomplete | `warning`→`danger` | needs a look |
| Alert severity | info `brand` · warning `warning` · critical `danger` | — |
Pair every color with an icon or label (color is never the sole signal — accessibility).

### 21.3 Typography
- **Inter throughout the app** (UI and data). 16px base, `optimizeLegibility`, antialiased. The existing Lora serif is available only for the CEO weekly-report PDF header if an editorial touch is wanted — the app itself stays all-Inter for data clarity.
- **Tabular figures on every number** (`font-variant-numeric: tabular-nums`) so metric columns align and don't shimmer as counts change. This is a small, high-impact premium detail their attendance tiles already imply.
- **Type scale (restrained):** page verdict/H1 ~28–32px semibold; section titles ~18–20px semibold; body 14–16px; metric values large (~28–40px) medium-weight; **eyebrow** label 11px uppercase `tracking-[0.2em]` muted. Weight and size carry hierarchy — not color.

### 21.4 Spacing, rhythm, density
- **8px base rhythm.** Consistent vertical spacing; align everything to the grid. Right-align numeric table columns.
- **Dense but calm.** The ops board is data-dense by necessity — separate rows and groups with **whitespace and typographic weight, not boxes and heavy borders** (the handbook's calm-considered feel applied to tables). Hairline `border` only where structure genuinely needs it.
- Tighter vertical rhythm on data tables than on any reading surface; generous padding inside cards and the verdict block so the important things breathe.

### 21.5 Elevation & shape
- **Two shadows only** (reuse): `soft` (`0 2px 12px rgba(22,10,51,.06)`) for resting cards; `brand`/deeper (`0 14px 40px -12px rgba(22,10,51,.22)`) for raised surfaces (drawers, popovers, command palette). Nothing else. Flat by default; elevation means "this floats above."
- **Radius scale:** cards `rounded-2xl` (~1.125rem), controls/inputs `rounded-xl` (~0.875rem), pills full. Consistent everywhere.

### 21.6 Component patterns (reuse their vocabulary, apply the §20 elevations)
- **Stat tile** (reuse their `Stat`): eyebrow + small icon, large value, **delta with directional color**, optional sparkline or progress bar, optional click→drill. **Elevation:** the delta and its **plain-language cause ship inline by default** (§20.2) — the info-tip becomes the deeper "how it's calculated" layer, so the user never has to hover to get the "so what."
- **Verdict-first rows:** every designer/task row **leads with a status glyph** so the eye lands on the problem row before reading text. Default sort **worst-first / needs-attention-first** (§20.4), never alphabetical.
- **Drawers over page-jumps:** assignment, leave-logging, alert-resolution, and drill-downs open in a right-side **drawer/modal** so the user never loses their place (§20.6). Full pages only for the top-level surfaces.
- **Command palette (⌘K/Ctrl-K):** jump-to-designer, assign, log leave, search, acknowledge. First-class on Ops.
- **Inline-edit cells** (reuse their `InlineEdit`): click, type, Enter/blur saves, Esc cancels, auto-width by type. Roster and schedule edits happen in place.
- **Toasts with Undo** (§20.6): act → 5s Undo toast, replacing "are you sure?" everywhere except delete-designer and bulk actions.
- **Badges, sortable headers, sparklines** (reuse) — carry over as-is.

### 21.7 Motion grammar (one vocabulary, calmer than the baseline)
150–250ms, `ease-out`, purposeful only. Reuse their `fade-in` (opacity + 4px rise) for entering content.
- **Count-up on *change*, not on every render** — and **suppress it on the short-cache refresh** (§5.1) so numbers don't perpetually re-animate on a live dashboard. *Their attendance count-up is lovely on load but would jitter on a real-time board; gating it to genuine value changes is the elevation.*
- **Board transitions:** a task card animates to its new status column on change (FLIP), so the change is *seen*, not just re-rendered.
- **Alerts:** arrive with a subtle pulse, settle out of the list when resolved.
- Motion reinforces what changed; it never decorates. Respect `prefers-reduced-motion`.

### 21.8 State design (elevate past the Spinner)
- **Skeletons, not spinners,** on first load — matched to content shape so layout never jumps. On short-cache refresh, show the last known value with a faint "updating" shimmer rather than blanking (the tiered-refresh model, §5.1). *Their dashboards ship a `Spinner`; skeletons are the upgrade for a data product that reloads constantly.*
- **Empty states teach** (their info-tip instinct, extended): "No aging tasks — the board is clean" as reassurance; "Add your first designer" with the action inline.
- **Errors are specific and actionable** (their `ErrorBanner`, elevated): "Couldn't reach ClickUp — showing data as of 14:32, retrying" over "Something went wrong."

### 21.9 Dark-first for the cockpit
Their handbook defaults to a light "Day" theme because it is a reading product. **An all-day ops tool defaults to dark** (their existing "Night" theme is a strong, ready foundation — deep `#0B0618` canvas, `#160A33` surfaces, glow-violet `#9F66FF` accent) to reduce eye strain over long sessions, with light available.
- **Designer self-view defaults to light and is mobile-first** (glance-and-check-in from a phone).
- *Why:* PM/CEO live in this tool for hours; a designer taps it for seconds. Different default per audience is the refinement.
- *Trade-off:* two well-tuned themes to maintain — but the token architecture makes that nearly free.

### 21.10 Rationale ledger (the elevations, at a glance)
| Decision | Why it improves UX | Problem solved | Trade-off | Better than baseline because |
|---|---|---|---|---|
| Near-monochrome, brand as accent only | Color becomes signal | Flags/actions get lost in decorative violet | Less overtly branded | Cockpit ≠ reading product; color must be earned |
| Interpretation inline (delta + cause) | "So what" with no hover | Numbers without meaning are a bug (§20) | More text on screen (managed by hierarchy) | Their info-tip is reactive; this is proactive |
| Count-up only on change + suppressed on refresh | Calm, not jittery | Live dashboards re-animating constantly | Slightly more logic | Their count-up jitters on real-time data |
| Skeletons over spinners | No layout jump | Constant reloads look broken with spinners | More state variants to build | Data product reloads too often for spinners |
| Verdict-first rows + worst-first sort | Problem found in <3s | Scanning a table for the bad row | — | Their tables sort but don't triage |
| Dark-first cockpit / light mobile self-view | Matches session length | Eye strain in an all-day tool | Two themes to tune | Handbook is light-default because it's for reading |
| Drawers over page-jumps | Never lose your place | Context switching (§20.6) | Drawer state management | — |

### 21.11 What §21 does not change
Presentation and interaction only. No new modules, no schema change, no new metrics, no workflow change (same guardrail as §20.12). If a visual requirement appears to need a structural change, stop and flag it.

---


## 22. Spec Hardening — Resolved Design Decisions (first-principles multi-lens review)

Binding resolutions from a rigorous review of §0–§21 across product, information-architecture, interaction, data-viz, frontend, accessibility, operations, and PM lenses. These close real gaps and one architectural contradiction. Recommended defaults are marked; where a v2 path exists it is labelled optional.

### 22.1 CRITICAL — ClickUp is read-only; the tool observes assignment, it does not perform it
The ingestion architecture (§6) reads ClickUp (webhooks + reconciliation); it never writes tasks. **Assignment is always done by the PM/CSR inside ClickUp — the system only observes it.** The proposed actions in §20.3 / §20.11 are **navigation deep-links, not writes**:
- Where §20 says "assign to [designer]," build it as **"Open [designer]'s list in ClickUp"** — a link to the right place for the PM/CSR to create the task themselves. The tool never creates a task. (Reword any "assign" affordance to "open in ClickUp" so it never implies the system acts.)
- "Nudge client" → opens the ClickUp task for the CSR to act. The system holds no client contact channel (§1.2) and sends nothing to clients.
- The system writes only its **own** data (attendance marks, roster, leave, alert state).
- **There is no write-back path.** Read-only is a permanent guarantee of this system, not a v1 limitation.

### 22.2 Timezone — single zone, PKT (Asia/Karachi) for the whole team
The team operates on **Pakistan time regardless of physical location** — every designer's shift window is defined in PKT and worked to PKT. Therefore **all shift/attendance/day-boundary math uses one timezone: `Asia/Karachi`.** Do not implement per-designer timezones; a single global zone is correct here and simpler. The `timezone` column on `designers` (§7) may remain for future flexibility but is set to `Asia/Karachi` for everyone and not surfaced in the UI. Reports and alerts are PKT.

### 22.3 Navigation & Information Architecture (was unspecified)
- **Persistent nav** (left rail or top), with each dashboard's **Attention/Verdict surface as its home** (§20.1) — the tool opens on "what needs me," not a menu.
- **Ops** top-level: Home (attention) · Board · Roster · Attendance · Leave · Alerts · Reports. Everything else nested/drill.
- **CEO** top-level: Overview (verdict) · Teams · Trends · Reports.
- **Designer:** single scrolling view — check-in, today, my tasks, my trend. No nav needed.
- One shared, RLS-scoped **Designer Detail** component reused by Ops and the Designer self-view (same component, different scope) for consistency and less code.

### 22.4 Live-update mechanism (the "real-time" promise, client-side)
- **Supabase Realtime** subscriptions on `task_state`, `alerts`, `attendance_daily` drive the live board and alert inbox (push, not poll).
- Short-cache analytics (§5.1) refresh on cadence via query invalidation.
- **Debounce/batch UI updates (~250ms)** on high-frequency bursts so the board never janks.
- Accessibility: `aria-live="polite"` on the alert region and a **summarized** board-change announcement (not per-card) — never a firehose.

### 22.5 Visualization per metric (close the "how is this drawn" gap)
- Single value → **stat tile with a reference point**: every metric shows **vs prior period AND vs team median**, so "is this good?" is answerable instantly. A bare number is a bug.
- Status distribution / board → status columns (kanban-style) with per-status counts.
- Trends (quality, speed) → small line chart with the designer's **own baseline** drawn. **Sparklines for at-a-glance context only — never for a metric the user must judge.**
- "Bottleneck Heatmap" (§11 T5) is mis-named → build as a **horizontal bar of median time-in-status per status** (answers "where is it clogging" directly). Rename **Pipeline Bottleneck**.

### 22.6 MVP cut line (ship a walking skeleton first, not a big bang)
1. **Ingest (webhooks + reconciliation) → live Board + Tier-0 counts + Roster.** This slice alone replaces the spreadsheet — ship it first.
2. Attendance + Leave. 3. Tier-1/2 quality + speed. 4. Alerts + recommendations. 5. CEO trends/forecast + weekly report.
Mark **Tiers 3–5, forecasting, and burnout as post-MVP.** Value in week one; intelligence layered after.

### 22.7 Permissions matrix (PM ≠ HR ≠ Admin — §14 lumps them)
| Capability | Admin | Manager | PM | HR | CEO | Designer |
|---|---|---|---|---|---|---|
| View all metrics | ✓ | ✓ | ✓ | ✓ | CEO surface | own only |
| Roster CRUD / archive | ✓ | ✓ | ✓ | – | – | – |
| Delete designer (hard) | ✓ | – | – | – | – | – |
| Edit quota / shift | ✓ | ✓ | ✓ | – | – | – |
| Leave / half-day / holiday | ✓ | ✓ | ✓ | ✓ | – | request own |
| Acknowledge / resolve alerts | ✓ | ✓ | ✓ | ✓ | – | – |
| Manual attendance override | ✓ | ✓ | ✓ | ✓ | – | – |
Tune to the real org, but **separate the roles** — "full control for everyone" is an enterprise anti-pattern.

### 22.8 Audit log (accountability for a multi-writer system)
Add an append-only `audit_log` (actor, action, entity, before/after, at). Log every roster edit, archive/delete, leave approval, quota change, manual attendance override, and alert resolution. Effective-dating (§8.3) preserves *what* changed; the audit log preserves *who* and *when*. Necessary once PM/HR/Admin all hold write access.

### 22.9 Report delivery (close the "how does it reach them" gap)
Weekly per-designer report: **in-app first** — a Reports surface with per-designer cards + PDF export. **Optional emailed digest** — a scheduled job emailing the CEO summary + flagged designers (needs an email provider/env config). **Default: in-app + PDF; email as a config-gated add-on.**

### 22.10 First-principles principle — measure the system, coach the individual
The deepest finding. In a pipeline where the designer controls only part of the clock and CSR/client control the rest, **public individual leaderboards drive gaming** — designers dodge hard briefs to protect first-pass quality, or rush to protect speed. Guardrails:
- Individual interpretation (coach / keep / cut) lives on the **CEO surface — private, manager-facing.**
- The **Designer self-view compares a designer only to their own past, never to peers** (hold §13.3 firmly).
- **Never render a public, designer-visible ranking.** Metrics exist to *aim coaching*, not to shame. The moment designers feel ranked and punished, they optimize the metric instead of the work and every number degrades — this guardrail protects the honesty of the entire dataset.

### 22.11 Smaller resolved calls (merged, deduped)
- **Overnight check-in UI** shows the designer's *shift* context (which shift-day they are marking), never calendar-naive.
- **Count-up animation** exposes only the final value to screen readers (suppress intermediate values).
- **Long lists virtualize;** the board collapses/paginates closed tasks by default.
- **AI-native touch (bounded, opt-in):** the CEO weekly summary may be an **LLM-generated natural-language paragraph over the computed metrics** — summarization only, never a metric or a decision. Fits an AI-first stack without letting a model touch the numbers.

### 22.12 Still deferred (correctly) — pixel-level review
Per-screen, per-state visual critique (exact layout, spacing, the feel of each empty / loading / error / success state) is only meaningful on **built screens**. That review runs post-build against §20–§22 on real pixels or a mock — not before. It is the one thing that cannot be done at the spec stage, and forcing it now would produce fiction.

---


*End of specification. Build to this document; it is the contract.*
