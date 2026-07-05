-- 006 · Day notes — free-text context tied to a specific DATE (and, usually, a
-- specific designer). Written by the people who prepare the reports to explain
-- why a day's numbers look the way they do — for example, a workload agreement
-- to give a designer fewer or more projects on a given day. App-owned data;
-- never touches ClickUp. Mirrors the `leaves` access model exactly.

create table if not exists public.day_notes (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid references public.designers(id) on delete cascade, -- null = the whole studio
  the_date date not null,
  note text not null,
  created_by uuid,
  created_at timestamptz default now()
);
create index if not exists day_notes_date_idx on public.day_notes (the_date);
create index if not exists day_notes_designer_idx on public.day_notes (designer_id);

alter table public.day_notes enable row level security;
revoke all on public.day_notes from anon;
grant select, insert, update, delete on public.day_notes to authenticated;

-- Staff (and the CEO, read-only) can see every note.
drop policy if exists day_notes_select_staff on public.day_notes;
create policy day_notes_select_staff on public.day_notes
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr', 'ceo'));

-- A designer can see notes written about themselves.
drop policy if exists day_notes_select_own on public.day_notes;
create policy day_notes_select_own on public.day_notes
  for select to authenticated
  using (designer_id = (select public.app_designer_id()));

-- Ops / PM / HR / admin can add, edit and remove notes.
drop policy if exists day_notes_write_ops on public.day_notes;
create policy day_notes_write_ops on public.day_notes
  for all to authenticated
  using ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'))
  with check ((select public.app_role()) in ('admin', 'manager', 'pm', 'hr'));
