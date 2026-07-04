-- ─── 005: self check-in/out must tolerate device clock skew ──────────────────
-- marks_insert_self (002_rls.sql) pinned marked_at to
-- [now() - 10 min, now() + 1 min] while the app sends the DEVICE's clock:
-- any designer phone more than 60 seconds fast got an RLS violation on every
-- check-in/check-out — the self-view's core action failed with an opaque
-- error until the clock synced.
--
-- Two-part fix:
--   1. shift_marks.marked_at gains `default now()` so the client can simply
--      omit it for source='self' marks — the server clock wins and skew
--      becomes impossible.
--   2. The policy's FORWARD bound widens to +5 minutes as a backstop for
--      clients that still send a timestamp. This does not weaken §22.10
--      dataset honesty: forging an on-time arrival requires BACKdating, and
--      the past bound (now() - 10 minutes) is unchanged.
-- Idempotent and re-runnable, like every migration in this directory.

alter table public.shift_marks alter column marked_at set default now();

drop policy if exists marks_insert_self on public.shift_marks;
create policy marks_insert_self on public.shift_marks
  for insert to authenticated
  with check (
    (select public.app_designer_id()) is not null
    and designer_id = (select public.app_designer_id())
    and source = 'self'
    and marked_at between now() - interval '10 minutes' and now() + interval '5 minutes'
  );
