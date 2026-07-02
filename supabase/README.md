# Supabase — Studio Pulse database

Four migrations build the entire data spine (spec §7, §14, §22.7–§22.8). They
are ordered and re-runnable:

| File | Contents |
|---|---|
| `migrations/001_schema.sql` | All tables + indexes + `updated_at` touch triggers |
| `migrations/002_rls.sql` | RLS on every table, `app_role()` / `get_my_profile()` / `apply_schedule_change()` |
| `migrations/003_triggers.sql` | Append-only enforcement, audit trigger, realtime publication |
| `migrations/004_seed.sql` | `app_config` defaults + the §8.4 roster (editable defaults) |

## Applying the migrations

### Option A — Supabase CLI (recommended)

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push          # applies migrations/ in filename order (001 → 004)
```

The files use an ordered numeric version prefix (`001_…` … `004_…`), which the
CLI treats as the migration version.

### Option B — SQL editor

Open the Supabase dashboard → SQL Editor and run the four files **in order**:
`001_schema.sql` → `002_rls.sql` → `003_triggers.sql` → `004_seed.sql`.
Every statement is guarded (`if not exists` / `or replace` / `on conflict do
nothing` / `drop … if exists`), so re-running a file is safe and never
clobbers values already edited in the UI.

## Creating users (auth + app_users)

Authentication is Supabase email/password; authorization is the `app_users`
row keyed by the auth uid (`app_users.id references auth.users(id)`). A signed-in
user with **no** `app_users` row can read nothing — secure by default.

1. **Create the auth user.** Dashboard → Authentication → Users → *Add user*
   (email + password, confirm email), or via the Admin API:

   ```bash
   curl -X POST "https://YOUR-PROJECT.supabase.co/auth/v1/admin/users" \
     -H "apikey: SERVICE_ROLE_KEY" -H "Authorization: Bearer SERVICE_ROLE_KEY" \
     -H "Content-Type: application/json" \
     -d '{"email":"ops@example.com","password":"…","email_confirm":true}'
   ```

2. **Insert the profile row** (SQL editor, runs as postgres so RLS does not
   apply). Roles: `admin | manager | pm | hr | ceo | designer`.

   ```sql
   -- Ops / CEO staff — designer_id stays null
   insert into public.app_users (id, email, role)
   select id, email, 'admin' from auth.users where email = 'ops@example.com'
   on conflict (id) do update set role = excluded.role, active = true;

   -- Designer — MUST be linked to their roster row (self-view scope, spec §13.3)
   insert into public.app_users (id, email, role, designer_id)
   select u.id, u.email, 'designer', d.id
   from auth.users u
   join public.designers d on d.name = 'Amin Ullah'
   where u.email = 'amin@example.com'
   on conflict (id) do update
     set role = excluded.role, designer_id = excluded.designer_id, active = true;
   ```

3. Sign in through the app. `get_my_profile()` returns the row; routing sends
   admin/manager/pm/hr → `/ops`, ceo → `/ceo`, designer → `/me`.

To off-board someone, set `active = false` (their `app_role()` becomes null
and every policy denies) or delete the auth user (the profile row cascades).

## Service-role key usage

- **Browser** uses `VITE_SUPABASE_ANON_KEY` only. The anon key is safe to ship
  because RLS gates every row: no `app_users` row → no data; designers are
  physically scoped to their own `designer_id`; only `holidays`,
  `holiday_workers`, and `app_config` are readable by every authenticated user.
- **Server (Vercel `api/**`)** uses `SUPABASE_SERVICE_ROLE_KEY`, which
  **bypasses RLS** — required for ingestion (`clickup_events`, `task_state`,
  `task_metrics`), attendance compute (`attendance_daily`), alert firing, and
  the `last_sync` watermark in `app_config`. It must exist only in Vercel env
  vars; never in client code, never in `VITE_*` variables.
- The service role does **not** bypass triggers: `clickup_events` and
  `audit_log` reject UPDATE/DELETE for everyone (a true purge requires
  `alter table … disable trigger …` in the SQL editor first). `shift_marks`
  rejects UPDATE for everyone and DELETE for everyone except the service role.

## Behavioral notes

- **Effective-dated schedules** — never UPDATE `designer_schedule` rows to
  change quota/shift. Call `apply_schedule_change(...)` (the Roster UI does):
  it closes the open row at `effective_from − 1 day`, inserts the new row
  atomically, checks the caller is admin/manager/pm, and writes `audit_log`.
- **Audit** — every write to `designers`, `designer_schedule`,
  `quota_exceptions`, `leaves`, `half_days`, `holidays`, alert lifecycle
  updates, and manual shift marks lands in `audit_log` with actor uid + email
  (null actor = service role / seed). The log is append-only.
- **Realtime** — `task_state`, `alerts`, `attendance_daily` are in the
  `supabase_realtime` publication; the frontend subscribes and invalidates
  queries (spec §22.4).
- **Seed is a default, not truth** — quotas, shifts, and weekly offs in
  `004_seed.sql` must be confirmed in the Roster UI (spec §8.4). Amin Ullah's
  two reduced Fridays per month are entered as `quota_exceptions` in the UI.
- **ClickUp is read-only** (spec §22.1) — nothing in this database ever writes
  back to ClickUp; `clickup_list_id` / `clickup_user_id` exist only to map
  ingested events and build deep links.
