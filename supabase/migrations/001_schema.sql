-- ═══════════════════════════════════════════════════════════════════════════
-- Studio Pulse — 001_schema.sql
-- Every table from spec §7, verbatim, plus the CONTRACTS.md additions:
--   • task_metrics.first_delivered_at            (needed for "delivered in period")
--   • attendance_daily.needs_review              (forgotten-checkout review flag)
--   • attendance_daily.checkout_source           (self | auto_clickup | auto_shift_end | manual)
--   • audit_log                                  (spec §22.8 accountability log)
--   • app_users.id references auth.users(id)     (profile row = auth uid)
-- All timestamps timestamptz. Single PKT timezone for the whole team (§22.2);
-- the designers.timezone column remains for future flexibility only.
-- Re-runnable: IF NOT EXISTS / OR REPLACE throughout.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── ROSTER: config source of truth (ClickUp cannot hold this) ───────────────

create table if not exists public.designers (
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

comment on table public.designers is
  'Roster — the config source of truth ClickUp does not hold (spec §8). Archive is the default exit; hard delete is admin-only and rare.';

-- Effective-dated capacity + schedule so historical metrics stay anchored to
-- the config that was true at the time. A quota/shift change opens a new row
-- (spec §8.3 — apply_schedule_change() in 002_rls.sql enforces this).
create table if not exists public.designer_schedule (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references public.designers(id) on delete cascade,
  effective_from date not null,
  effective_to date,                        -- null = current
  daily_quota int not null,
  shift_start time not null,                -- PKT wall time (§22.2)
  shift_end time not null,
  is_overnight boolean generated always as (shift_end <= shift_start) stored,
  weekly_off smallint,                      -- 0=Sun .. 6=Sat (Postgres dow); null=none
  late_grace_min int default 15,
  early_leave_grace_min int default 15
);

-- Specific-date quota overrides (e.g. Amin's two reduced Fridays). PM enters them.
create table if not exists public.quota_exceptions (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references public.designers(id) on delete cascade,
  the_date date not null,
  daily_quota int not null,
  reason text,
  unique (designer_id, the_date)
);

-- ─── RAW EVENT LAYER (immutable, append-only — triggers in 003) ──────────────

create table if not exists public.clickup_events (
  id bigint generated always as identity primary key,
  task_id text not null,
  list_id text not null,
  designer_id uuid references public.designers(id),
  event_type text not null,                 -- created | status_change | deleted
  from_status text,                         -- canonical name (lower(trim(name)))
  to_status text,                           -- canonical name
  event_time timestamptz not null,
  source text not null default 'webhook',   -- webhook | reconciliation | backfill
  raw jsonb,
  inserted_at timestamptz default now(),
  -- NULLS NOT DISTINCT so re-delivered `created`/`deleted` events (null
  -- to_status) also dedupe under the contract's `on conflict do nothing`.
  constraint clickup_events_dedupe_key
    unique nulls not distinct (task_id, event_type, event_time, to_status)
);

comment on table public.clickup_events is
  'Immutable raw truth (spec §5). Append-only: UPDATE/DELETE blocked by trigger; corrections are new rows, never mutations.';

-- ─── DERIVED: current task snapshot ──────────────────────────────────────────

create table if not exists public.task_state (
  task_id text primary key,
  list_id text not null,
  designer_id uuid references public.designers(id),
  name text,
  current_status text,
  priority text,
  concept_count int,                        -- parsed from tags; nullable by design
  scope_tags text[],
  created_at timestamptz,                   -- assignment time (§2)
  due_date timestamptz,
  closed_at timestamptz,
  last_event_at timestamptz,
  deleted boolean default false,
  updated_at timestamptz default now()
);

-- ─── DERIVED: per-task metrics (recomputable from clickup_events) ─────────────

create table if not exists public.task_metrics (
  task_id text primary key references public.task_state(task_id) on delete cascade,
  designer_id uuid references public.designers(id),
  start_latency_min int,                    -- pickup -> in progress
  production_min int,                       -- pickup -> first 'deliver to client'
  first_pass_clean boolean,                 -- never entered 'revision'
  revision_rounds int default 0,            -- entries into 'revision'
  csr_caught_rounds int default 0,          -- from 'deliver to client' or 'revision complete'
  client_caught_rounds int default 0,       -- from 'client response'
  revision_turnaround_min int,              -- total time held in 'revision'
  client_wait_min int,                      -- total time held in 'client response'
  first_delivered_at timestamptz,           -- first entry into 'deliver to client' (contract addition)
  outcome text,                             -- complete | cancelled | in_flight
  is_cancelled boolean default false,       -- designer-fault terminal (§4.3)
  metrics_confidence text default 'live',   -- live | backfill
  computed_at timestamptz default now()
);

-- ─── ATTENDANCE: self-marks (raw, append-only) ───────────────────────────────

create table if not exists public.shift_marks (
  id bigint generated always as identity primary key,
  designer_id uuid references public.designers(id) on delete cascade,
  mark_type text not null,                  -- check_in | check_out
  marked_at timestamptz not null,
  source text default 'self',               -- self | auto_clickup | auto_shift_end | manual
  created_at timestamptz default now()
);

-- ─── ATTENDANCE: derived daily (recomputable) ────────────────────────────────

create table if not exists public.attendance_daily (
  id bigint generated always as identity primary key,
  designer_id uuid references public.designers(id) on delete cascade,
  work_date date not null,                  -- shift-START day (overnight-aware, §9.2)
  declared_in timestamptz,                  -- self check-in
  declared_out timestamptz,                 -- self check-out or auto-close
  first_activity timestamptz,               -- first ClickUp event in shift window
  last_activity timestamptz,                -- last ClickUp event in shift window
  scheduled_in timestamptz,
  scheduled_out timestamptz,
  worked_minutes int default 0,
  warmup_gap_min int,                       -- declared_in -> first_activity (§9.3)
  late_minutes int default 0,
  early_leave_minutes int default 0,
  is_half_day boolean default false,
  needs_review boolean default false,       -- forgotten-checkout auto-close applied (contract addition)
  checkout_source text,                     -- self | auto_clickup | auto_shift_end | manual (contract addition)
  status text,                              -- Present|Incomplete|Absent|Leave|Holiday|HolidayWorked|WeeklyOff
  computed_at timestamptz default now(),
  unique (designer_id, work_date)
);

-- ─── LEAVE / CALENDAR ────────────────────────────────────────────────────────

create table if not exists public.leaves (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references public.designers(id) on delete cascade,
  leave_type text,
  start_date date not null,
  end_date date,                            -- null = single day
  paid boolean not null default true,       -- recorded only; no pay computed (§1.2)
  status text not null default 'approved',
  reason text,
  created_by uuid,
  created_at timestamptz default now()
);

create table if not exists public.half_days (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references public.designers(id) on delete cascade,
  the_date date not null,
  from_time time,                           -- absent window (PKT)
  to_time time,
  paid boolean default false,
  reason text
);

create table if not exists public.holidays (
  id uuid primary key default gen_random_uuid(),
  the_date date not null unique,
  name text
);

-- Volunteers who work a holiday (bonus-eligible; system marks only, no pay math).
create table if not exists public.holiday_workers (
  the_date date not null,
  designer_id uuid references public.designers(id) on delete cascade,
  primary key (the_date, designer_id)
);

-- ─── ALERTS ──────────────────────────────────────────────────────────────────

create table if not exists public.alerts (
  id bigint generated always as identity primary key,
  alert_type text not null,   -- assignment_gap | task_aging | cancellation |
                              -- quality_decay | burnout | forgotten_checkout | workload_forecast
  designer_id uuid references public.designers(id),
  task_id text,
  severity text default 'warning',          -- info | warning | critical
  message text,
  context jsonb,
  status text default 'open',               -- open | acknowledged | resolved
  fired_at timestamptz default now(),
  resolved_at timestamptz
);

-- ─── CONFIG + USERS + AUDIT ──────────────────────────────────────────────────

create table if not exists public.app_config (
  key text primary key,
  value jsonb not null
);

create table if not exists public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,  -- = supabase auth uid
  email text unique,
  role text not null,          -- admin | manager | pm | hr | ceo | designer
  designer_id uuid references public.designers(id),  -- set only for role='designer'
  active boolean default true
);

-- Append-only accountability log (spec §22.8). Who changed what, when —
-- effective-dating preserves WHAT changed; this preserves WHO and WHEN.
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  at timestamptz default now()
);

-- ─── INDEXES (spec §7 list + what src/lib/queries.ts scans) ──────────────────

-- Spec §7 required indexes
create index if not exists idx_clickup_events_task on public.clickup_events (task_id);
create index if not exists idx_clickup_events_designer_time on public.clickup_events (designer_id, event_time);
create index if not exists idx_task_state_designer_status on public.task_state (designer_id, current_status);
create index if not exists idx_task_metrics_designer on public.task_metrics (designer_id);
create index if not exists idx_attendance_daily_work_date on public.attendance_daily (work_date);
create index if not exists idx_shift_marks_designer_time on public.shift_marks (designer_id, marked_at);
create index if not exists idx_leaves_designer on public.leaves (designer_id);
create index if not exists idx_alerts_status_fired on public.alerts (status, fired_at);

-- Query-layer scans (src/lib/queries.ts + api crons)
create index if not exists idx_task_state_status on public.task_state (current_status) where deleted = false;      -- open board / cancelled list
create index if not exists idx_task_state_created on public.task_state (created_at);                               -- fetchTasksSince / daily intake counts
create index if not exists idx_task_state_last_event on public.task_state (last_event_at);                         -- fetchTasksSince / aging scans
create index if not exists idx_task_metrics_computed on public.task_metrics (computed_at);                          -- fetchTaskMetricsSince
create index if not exists idx_task_metrics_delivered on public.task_metrics (first_delivered_at);                  -- "delivered in period"
create index if not exists idx_shift_marks_time on public.shift_marks (marked_at);                                  -- fetchShiftMarksAround
create index if not exists idx_alerts_fired on public.alerts (fired_at desc);                                       -- alert inbox ordering
create index if not exists idx_alerts_open_dedupe on public.alerts (alert_type, designer_id, task_id) where status = 'open'; -- fireAlert dedupe
create index if not exists idx_leaves_dates on public.leaves (start_date, end_date);                                 -- leave-covers lookups
create index if not exists idx_half_days_designer_date on public.half_days (designer_id, the_date);
create index if not exists idx_audit_log_at on public.audit_log (at desc);
create index if not exists idx_audit_log_entity on public.audit_log (entity, entity_id);
create index if not exists idx_app_users_designer on public.app_users (designer_id);

-- ─── updated_at auto-touch (designers, task_state) ───────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_designers_touch on public.designers;
create trigger trg_designers_touch
  before update on public.designers
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_task_state_touch on public.task_state;
create trigger trg_task_state_touch
  before update on public.task_state
  for each row execute function public.touch_updated_at();
