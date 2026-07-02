-- ═══════════════════════════════════════════════════════════════════════════
-- Studio Pulse — 002_rls.sql
-- Row-Level Security on EVERY table (spec §14) implementing the §22.7
-- permissions matrix. Secure by default: no anonymous access anywhere; the
-- service-role key (ingestion/compute) bypasses RLS by design.
--
--   admin/manager/pm/hr : read everything (the Ops cockpit)
--   admin/manager/pm    : roster CRUD + quota/shift edits
--   admin only          : hard delete (DELETE row or status='deleted')
--   admin/manager/pm/hr : leave / half-day / holiday writes, alert ack/resolve,
--                         manual shift_marks (source='manual')
--   ceo                 : SELECT-only on everything
--   designer            : SELECT own rows only + INSERT own shift_marks
--                         (source='self'); holidays/app_config/holiday_workers
--                         readable by all authenticated
--
-- Helpers are SECURITY DEFINER with `set search_path = public` so policies
-- never recurse into app_users' own RLS. Re-runnable: OR REPLACE + drop policy
-- if exists.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Helper functions ────────────────────────────────────────────────────────

-- Role of the calling user; null when unauthenticated, unknown, or inactive.
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from app_users where id = auth.uid() and active
$$;

-- Designer id bound to the calling user (only set for role='designer').
create or replace function public.app_designer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select designer_id from app_users where id = auth.uid() and active
$$;

-- The caller's own profile row (spec §14: never trust the client to filter).
create or replace function public.get_my_profile()
returns setof public.app_users
language sql
stable
security definer
set search_path = public
as $$
  select * from app_users where id = auth.uid()
$$;

-- Effective-dated schedule change (spec §8.3): atomically closes the
-- currently-open designer_schedule row (effective_to = p_effective_from − 1)
-- and inserts the new row. Ops-role-checked inside; writes audit_log.
create or replace function public.apply_schedule_change(
  p_designer_id uuid,
  p_effective_from date,
  p_daily_quota int,
  p_shift_start time,
  p_shift_end time,
  p_weekly_off smallint,
  p_late_grace_min int default 15,
  p_early_leave_grace_min int default 15
)
returns public.designer_schedule
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_open designer_schedule;
  v_new designer_schedule;
  v_email text;
begin
  if coalesce(app_role(), '') not in ('admin', 'manager', 'pm') then
    raise exception 'apply_schedule_change: role % may not edit schedules', coalesce(app_role(), 'anonymous')
      using errcode = '42501';
  end if;

  select * into v_open
  from designer_schedule
  where designer_id = p_designer_id and effective_to is null
  order by effective_from desc
  limit 1
  for update;

  if found and v_open.effective_from > p_effective_from then
    raise exception 'apply_schedule_change: effective_from % predates the open schedule row (%)',
      p_effective_from, v_open.effective_from;
  end if;

  if found and v_open.effective_from = p_effective_from then
    -- Same-day correction: replace the just-opened row in place (no
    -- zero-length row; history stays clean).
    update designer_schedule
      set daily_quota = p_daily_quota,
          shift_start = p_shift_start,
          shift_end = p_shift_end,
          weekly_off = p_weekly_off,
          late_grace_min = coalesce(p_late_grace_min, 15),
          early_leave_grace_min = coalesce(p_early_leave_grace_min, 15)
      where id = v_open.id
      returning * into v_new;
  else
    if found then
      update designer_schedule
        set effective_to = p_effective_from - 1
        where id = v_open.id;
    end if;

    insert into designer_schedule
      (designer_id, effective_from, effective_to, daily_quota,
       shift_start, shift_end, weekly_off, late_grace_min, early_leave_grace_min)
    values
      (p_designer_id, p_effective_from, null, p_daily_quota,
       p_shift_start, p_shift_end, p_weekly_off,
       coalesce(p_late_grace_min, 15), coalesce(p_early_leave_grace_min, 15))
    returning * into v_new;
  end if;

  select email into v_email from app_users where id = auth.uid();

  insert into audit_log (actor_id, actor_email, action, entity, entity_id, before, after)
  values (
    auth.uid(),
    v_email,
    'schedule_change',
    'designer_schedule',
    v_new.id::text,
    case when v_open.id is null then null else to_jsonb(v_open) end,
    to_jsonb(v_new)
  );

  return v_new;
end;
$$;

-- Lock the functions down: authenticated only (role checks live inside).
revoke execute on function public.app_role() from public, anon;
revoke execute on function public.app_designer_id() from public, anon;
revoke execute on function public.get_my_profile() from public, anon;
revoke execute on function public.apply_schedule_change(uuid, date, int, time, time, smallint, int, int) from public, anon;
grant execute on function public.app_role() to authenticated, service_role;
grant execute on function public.app_designer_id() to authenticated, service_role;
grant execute on function public.get_my_profile() to authenticated, service_role;
grant execute on function public.apply_schedule_change(uuid, date, int, time, time, smallint, int, int) to authenticated, service_role;

-- ─── Enable RLS on every table + shut out anon entirely ─────────────────────

alter table public.designers          enable row level security;
alter table public.designer_schedule  enable row level security;
alter table public.quota_exceptions   enable row level security;
alter table public.clickup_events     enable row level security;
alter table public.task_state         enable row level security;
alter table public.task_metrics       enable row level security;
alter table public.shift_marks        enable row level security;
alter table public.attendance_daily   enable row level security;
alter table public.leaves             enable row level security;
alter table public.half_days          enable row level security;
alter table public.holidays           enable row level security;
alter table public.holiday_workers    enable row level security;
alter table public.alerts             enable row level security;
alter table public.app_config         enable row level security;
alter table public.app_users          enable row level security;
alter table public.audit_log          enable row level security;

revoke all on public.designers, public.designer_schedule, public.quota_exceptions,
  public.clickup_events, public.task_state, public.task_metrics,
  public.shift_marks, public.attendance_daily, public.leaves, public.half_days,
  public.holidays, public.holiday_workers, public.alerts, public.app_config,
  public.app_users, public.audit_log
from anon;

-- ─── designers ───────────────────────────────────────────────────────────────

drop policy if exists designers_select_staff on public.designers;
create policy designers_select_staff on public.designers
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists designers_select_own on public.designers;
create policy designers_select_own on public.designers
  for select to authenticated
  using (id = (select public.app_designer_id()));

drop policy if exists designers_insert_ops on public.designers;
create policy designers_insert_ops on public.designers
  for insert to authenticated
  with check ((select public.app_role()) in ('admin', 'manager', 'pm'));

-- Roster edits: admin/manager/pm — but flipping status to 'deleted' (the soft
-- hard-delete) is admin-only, matching the §22.7 matrix.
drop policy if exists designers_update_ops on public.designers;
create policy designers_update_ops on public.designers
  for update to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm'))
  with check (status <> 'deleted' or (select public.app_role()) = 'admin');

drop policy if exists designers_delete_admin on public.designers;
create policy designers_delete_admin on public.designers
  for delete to authenticated
  using ((select public.app_role()) = 'admin');

-- ─── designer_schedule ───────────────────────────────────────────────────────

drop policy if exists schedule_select_staff on public.designer_schedule;
create policy schedule_select_staff on public.designer_schedule
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists schedule_select_own on public.designer_schedule;
create policy schedule_select_own on public.designer_schedule
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

drop policy if exists schedule_write_ops on public.designer_schedule;
create policy schedule_write_ops on public.designer_schedule
  for all to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm'))
  with check ((select public.app_role()) in ('admin', 'manager', 'pm'));

-- ─── quota_exceptions ────────────────────────────────────────────────────────

drop policy if exists quota_exc_select_staff on public.quota_exceptions;
create policy quota_exc_select_staff on public.quota_exceptions
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists quota_exc_select_own on public.quota_exceptions;
create policy quota_exc_select_own on public.quota_exceptions
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

drop policy if exists quota_exc_write_ops on public.quota_exceptions;
create policy quota_exc_write_ops on public.quota_exceptions
  for all to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm'))
  with check ((select public.app_role()) in ('admin', 'manager', 'pm'));

-- ─── clickup_events (raw; written only by service role) ─────────────────────

drop policy if exists events_select_staff on public.clickup_events;
create policy events_select_staff on public.clickup_events
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists events_select_own on public.clickup_events;
create policy events_select_own on public.clickup_events
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

-- ─── task_state (derived; written only by service role) ─────────────────────

drop policy if exists task_state_select_staff on public.task_state;
create policy task_state_select_staff on public.task_state
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists task_state_select_own on public.task_state;
create policy task_state_select_own on public.task_state
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

-- ─── task_metrics (derived; written only by service role) ───────────────────

drop policy if exists task_metrics_select_staff on public.task_metrics;
create policy task_metrics_select_staff on public.task_metrics
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists task_metrics_select_own on public.task_metrics;
create policy task_metrics_select_own on public.task_metrics
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

-- ─── shift_marks ─────────────────────────────────────────────────────────────

drop policy if exists marks_select_staff on public.shift_marks;
create policy marks_select_staff on public.shift_marks
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists marks_select_own on public.shift_marks;
create policy marks_select_own on public.shift_marks
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

-- Designers mark ONLY themselves, ONLY as source='self'.
drop policy if exists marks_insert_self on public.shift_marks;
create policy marks_insert_self on public.shift_marks
  for insert to authenticated
  with check (
    (select public.app_designer_id()) is not null
    and designer_id = (select public.app_designer_id())
    and source = 'self'
  );

-- Ops manual override (§22.7 "Manual attendance override"): source='manual'.
drop policy if exists marks_insert_manual_ops on public.shift_marks;
create policy marks_insert_manual_ops on public.shift_marks
  for insert to authenticated
  with check (
    (select public.app_role()) in ('admin', 'manager', 'pm', 'hr')
    and source = 'manual'
  );

-- No UPDATE/DELETE policies: marks are raw truth (003 also blocks by trigger).

-- ─── attendance_daily (derived; written only by service role) ────────────────

drop policy if exists attendance_select_staff on public.attendance_daily;
create policy attendance_select_staff on public.attendance_daily
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists attendance_select_own on public.attendance_daily;
create policy attendance_select_own on public.attendance_daily
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

-- ─── leaves ──────────────────────────────────────────────────────────────────

drop policy if exists leaves_select_staff on public.leaves;
create policy leaves_select_staff on public.leaves
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists leaves_select_own on public.leaves;
create policy leaves_select_own on public.leaves
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

drop policy if exists leaves_write_ops_hr on public.leaves;
create policy leaves_write_ops_hr on public.leaves
  for all to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'))
  with check ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'));

-- ─── half_days ───────────────────────────────────────────────────────────────

drop policy if exists half_days_select_staff on public.half_days;
create policy half_days_select_staff on public.half_days
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists half_days_select_own on public.half_days;
create policy half_days_select_own on public.half_days
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

drop policy if exists half_days_write_ops_hr on public.half_days;
create policy half_days_write_ops_hr on public.half_days
  for all to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'))
  with check ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'));

-- ─── holidays (company-wide: readable by everyone signed in) ─────────────────

drop policy if exists holidays_select_all on public.holidays;
create policy holidays_select_all on public.holidays
  for select to authenticated
  using (true);

drop policy if exists holidays_write_ops_hr on public.holidays;
create policy holidays_write_ops_hr on public.holidays
  for all to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'))
  with check ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'));

-- ─── holiday_workers ─────────────────────────────────────────────────────────

drop policy if exists holiday_workers_select_all on public.holiday_workers;
create policy holiday_workers_select_all on public.holiday_workers
  for select to authenticated
  using (true);

drop policy if exists holiday_workers_write_ops_hr on public.holiday_workers;
create policy holiday_workers_write_ops_hr on public.holiday_workers
  for all to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'))
  with check ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'));

-- ─── alerts (fired by service role; ack/resolve by ops+hr; ceo reads) ────────

drop policy if exists alerts_select_staff on public.alerts;
create policy alerts_select_staff on public.alerts
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

drop policy if exists alerts_update_ops_hr on public.alerts;
create policy alerts_update_ops_hr on public.alerts
  for update to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'))
  with check ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'));

-- ─── app_config (thresholds; readable by all signed-in, writable by admin) ───

drop policy if exists app_config_select_all on public.app_config;
create policy app_config_select_all on public.app_config
  for select to authenticated
  using (true);

drop policy if exists app_config_write_admin on public.app_config;
create policy app_config_write_admin on public.app_config
  for all to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

-- ─── app_users (own row readable; admin manages all) ─────────────────────────

drop policy if exists app_users_select_self on public.app_users;
create policy app_users_select_self on public.app_users
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists app_users_admin_all on public.app_users;
create policy app_users_admin_all on public.app_users
  for all to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

-- ─── audit_log (read-only for staff; rows written by definer triggers) ───────

drop policy if exists audit_log_select_staff on public.audit_log;
create policy audit_log_select_staff on public.audit_log
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

-- No INSERT policy: clients cannot forge audit rows. The audit trigger
-- function (003, SECURITY DEFINER) and the service role write them.
