-- ═══════════════════════════════════════════════════════════════════════════
-- Studio Pulse — 003_triggers.sql
-- 1) Append-only enforcement on the raw layers (spec §5/§7: raw is immutable
--    truth; corrections are new rows, never mutations).
-- 2) Generic audit trigger (spec §22.8) on every ops-writable table.
-- 3) Realtime publication for the live board / alert inbox / attendance
--    (spec §22.4 — task_state, alerts, attendance_daily).
-- Re-runnable: OR REPLACE + drop trigger if exists + guarded DO blocks.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Append-only enforcement ──────────────────────────────────────────────

-- Unconditional block: nobody — service role included — mutates raw history.
-- (A true purge requires explicitly disabling the trigger in the SQL editor.)
create or replace function public.block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: % is not allowed (corrections are new rows, never edits)',
    tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

-- DELETE gate for shift_marks: service role / cascades always allowed; ops
-- roles (RLS also enforces this) may correct a mis-entered self/manual mark —
-- the §9.1 correction path — but the auto_* audit marks stay immutable. Every
-- allowed delete is audit-logged (trigger below).
create or replace function public.block_delete_unless_service()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return old;
  end if;
  if pg_trigger_depth() > 1 then
    -- Cascaded delete from a parent row (e.g. designer hard-purge) — allow.
    return old;
  end if;
  if tg_table_name = 'shift_marks'
     and old.source in ('self', 'manual')
     and public.app_role() in ('admin', 'manager', 'pm', 'hr') then
    return old;
  end if;
  raise exception '% is append-only: direct DELETE is not allowed', tg_table_name
    using errcode = '42501';
end;
$$;

-- clickup_events: immutable raw event log.
drop trigger if exists trg_clickup_events_append_only on public.clickup_events;
create trigger trg_clickup_events_append_only
  before update or delete on public.clickup_events
  for each row execute function public.block_mutation();

-- audit_log: the accountability record itself can never be rewritten.
drop trigger if exists trg_audit_log_append_only on public.audit_log;
create trigger trg_audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.block_mutation();

-- shift_marks: no updates ever; deletes only via service role / cascade.
drop trigger if exists trg_shift_marks_no_update on public.shift_marks;
create trigger trg_shift_marks_no_update
  before update on public.shift_marks
  for each row execute function public.block_mutation();

drop trigger if exists trg_shift_marks_no_delete on public.shift_marks;
create trigger trg_shift_marks_no_delete
  before delete on public.shift_marks
  for each row execute function public.block_delete_unless_service();

-- (Mark-correction DELETEs are audited — trigger defined in section 2 below,
-- after audit_row_change() exists.)

-- ─── 2. Generic audit trigger (§22.8) ────────────────────────────────────────

-- SECURITY DEFINER so the INSERT into audit_log succeeds for ops users even
-- though audit_log has no client INSERT policy (clients cannot forge entries).
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_entity_id text;
  v_actor uuid;
  v_email text;
begin
  if tg_op = 'INSERT' then
    v_before := null;
    v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
  else
    v_before := to_jsonb(old);
    v_after := null;
  end if;

  v_entity_id := coalesce(v_after ->> 'id', v_before ->> 'id');
  v_actor := auth.uid();  -- null when the service role / a job is the writer
  select email into v_email from app_users where id = v_actor;

  insert into audit_log (actor_id, actor_email, action, entity, entity_id, before, after)
  values (v_actor, v_email, lower(tg_op), tg_table_name, v_entity_id, v_before, v_after);

  return coalesce(new, old);
end;
$$;

revoke execute on function public.audit_row_change() from public, anon;

-- Ops-writable config tables: full INSERT/UPDATE/DELETE audit.
drop trigger if exists trg_audit_designers on public.designers;
create trigger trg_audit_designers
  after insert or update or delete on public.designers
  for each row execute function public.audit_row_change();

drop trigger if exists trg_audit_designer_schedule on public.designer_schedule;
create trigger trg_audit_designer_schedule
  after insert or update or delete on public.designer_schedule
  for each row execute function public.audit_row_change();

drop trigger if exists trg_audit_quota_exceptions on public.quota_exceptions;
create trigger trg_audit_quota_exceptions
  after insert or update or delete on public.quota_exceptions
  for each row execute function public.audit_row_change();

drop trigger if exists trg_audit_leaves on public.leaves;
create trigger trg_audit_leaves
  after insert or update or delete on public.leaves
  for each row execute function public.audit_row_change();

drop trigger if exists trg_audit_half_days on public.half_days;
create trigger trg_audit_half_days
  after insert or update or delete on public.half_days
  for each row execute function public.audit_row_change();

drop trigger if exists trg_audit_holidays on public.holidays;
create trigger trg_audit_holidays
  after insert or update or delete on public.holidays
  for each row execute function public.audit_row_change();

-- Alerts: only lifecycle changes (acknowledge / resolve) are human actions.
drop trigger if exists trg_audit_alerts on public.alerts;
create trigger trg_audit_alerts
  after update on public.alerts
  for each row execute function public.audit_row_change();

-- Manual attendance overrides (§22.7) are audited; self-marks are not noise.
drop trigger if exists trg_audit_shift_marks_manual on public.shift_marks;
create trigger trg_audit_shift_marks_manual
  after insert on public.shift_marks
  for each row
  when (new.source = 'manual')
  execute function public.audit_row_change();

-- Mark corrections are accountability events: every DELETE is audited (who
-- removed which mark).
drop trigger if exists trg_audit_shift_marks_delete on public.shift_marks;
create trigger trg_audit_shift_marks_delete
  after delete on public.shift_marks
  for each row execute function public.audit_row_change();

-- ─── 3. Realtime (spec §22.4) ────────────────────────────────────────────────

-- Push, not poll: the live board, the alert inbox, and today's attendance.
-- Guarded so re-runs (and environments without the publication) don't fail.
do $$
declare
  t text;
begin
  foreach t in array array['task_state', 'alerts', 'attendance_daily'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;   -- already in the publication
      when undefined_object then null;   -- publication absent (non-Supabase env)
    end;
  end loop;
end;
$$;
