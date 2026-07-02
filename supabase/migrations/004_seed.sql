-- ═══════════════════════════════════════════════════════════════════════════
-- Studio Pulse — 004_seed.sql
--
-- ⚠ SEED VALUES ARE EDITABLE DEFAULTS (spec §8.4) — quotas and shifts below
--   are best-known values and MUST be confirmed in the Roster UI on first run.
--   Several designers carry exceptions (e.g. Amin Ullah works 2/day on two
--   specific Fridays a month — enter those dates as quota_exceptions in the
--   UI; the exact Fridays are not known at seed time). Where §8.4 gives no
--   shift, the default is 18:00–02:00 PKT; where it gives no weekly off, the
--   default is Sunday (0). Where it gives no quota (Aqeel, Shahmeer), 2 is
--   seeded as a conservative floor to confirm.
--
-- Deterministic fixed UUIDs + ON CONFLICT DO NOTHING → safe to re-run, and
-- never clobbers values already edited in the UI.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── app_config: every §18 key (defaults = shared/types.ts CONFIG_DEFAULTS) ──

insert into public.app_config (key, value) values
  ('timezone_default',                to_jsonb('Asia/Karachi'::text)),
  ('assignment_gap_check_offset_min', to_jsonb(60)),
  ('aging_days_default',              to_jsonb(3)),
  ('aging_days_client_response',      to_jsonb(4)),
  ('late_grace_min',                  to_jsonb(15)),
  ('early_leave_grace_min',           to_jsonb(15)),
  ('forgotten_checkout_mode',         to_jsonb('last_activity'::text)),
  ('quality_decay_pct',               to_jsonb(10)),
  ('burnout_score',                   to_jsonb(70)),
  ('forecast_threshold',              to_jsonb(20)),
  ('forecast_horizon_days',           to_jsonb(7)),
  ('reconciliation_interval_min',     to_jsonb(15)),
  ('overnight_window_buffer_hours',   to_jsonb(4)),
  -- Reconciliation watermark (contract addition; advanced by api/cron/reconcile)
  ('last_sync',                       to_jsonb('1970-01-01T00:00:00Z'::text))
on conflict (key) do nothing;

-- ─── Roster (§8.4) — fixed ids d…01–d…19 ─────────────────────────────────────
-- Known ClickUp list ids from §3.1; the rest are discovered at runtime by the
-- reconciliation job walking the "Designers Team" space (90187090116) and are
-- mappable in the Roster UI. Amin Ullah's ClickUp user id: 101464943.

insert into public.designers
  (id, clickup_list_id, clickup_user_id, name, team, specialty, timezone, status, order_index)
values
  -- Logo team
  ('d0000000-0000-4000-8000-000000000001', '901816036362', null,      'Nimeazad',          'Logo',      null,                       'Asia/Karachi', 'active', 10),
  ('d0000000-0000-4000-8000-000000000002', '901815604933', null,      'Rejaul Karim',      'Logo',      null,                       'Asia/Karachi', 'active', 20),
  ('d0000000-0000-4000-8000-000000000003', '901811883458', null,      'Md Dulal',          'Logo',      null,                       'Asia/Karachi', 'active', 30),
  ('d0000000-0000-4000-8000-000000000004', '901811577312', 101464943, 'Amin Ullah',        'Logo',      null,                       'Asia/Karachi', 'active', 40),
  ('d0000000-0000-4000-8000-000000000005', null,           null,      'Atta Razaq',        'Logo',      null,                       'Asia/Karachi', 'active', 50),
  ('d0000000-0000-4000-8000-000000000006', null,           null,      'M. Tariq',          'Logo',      null,                       'Asia/Karachi', 'active', 60),
  ('d0000000-0000-4000-8000-000000000007', null,           null,      'Md Zahid Hasan',    'Logo',      '3 concepts each',          'Asia/Karachi', 'active', 70),
  ('d0000000-0000-4000-8000-000000000008', null,           null,      'Abiha Imran',       'Logo',      null,                       'Asia/Karachi', 'active', 80),
  ('d0000000-0000-4000-8000-000000000009', '901814946775', null,      'Shaoor Haider',     'Logo',      null,                       'Asia/Karachi', 'active', 90),
  ('d0000000-0000-4000-8000-000000000010', null,           null,      'Md Rashadul Haque', 'Logo',      '3 concepts each',          'Asia/Karachi', 'active', 100),
  ('d0000000-0000-4000-8000-000000000011', null,           null,      'Md Rezaul',         'Logo',      null,                       'Asia/Karachi', 'active', 110),
  -- Branding team
  ('d0000000-0000-4000-8000-000000000012', '901816113089', null,      'Owais Nadeem',      'Branding',  null,                       'Asia/Karachi', 'active', 10),
  ('d0000000-0000-4000-8000-000000000013', null,           null,      'Khubaib',           'Branding',  'Brand style guidelines',   'Asia/Karachi', 'active', 20),
  ('d0000000-0000-4000-8000-000000000014', '901811883441', null,      'Hamid',             'Branding',  null,                       'Asia/Karachi', 'active', 30),
  ('d0000000-0000-4000-8000-000000000015', null,           null,      'Owais Rehan',       'Branding',  null,                       'Asia/Karachi', 'active', 40),
  ('d0000000-0000-4000-8000-000000000016', null,           null,      'Afjal Hussain',     'Branding',  'Brandings, min 25 pages',  'Asia/Karachi', 'active', 50),
  -- Animation team
  ('d0000000-0000-4000-8000-000000000017', null,           null,      'Syed Mubahat',      'Animation', null,                       'Asia/Karachi', 'active', 10),
  -- Other
  ('d0000000-0000-4000-8000-000000000018', null,           null,      'Aqeel',             'PPT',       null,                       'Asia/Karachi', 'active', 10),
  ('d0000000-0000-4000-8000-000000000019', null,           null,      'Shahmeer',          'Canva',     null,                       'Asia/Karachi', 'active', 10)
on conflict do nothing;

-- ─── Schedules — effective from 2025-01-01, open-ended (effective_to null) ───
-- §8.4 shifts where given: Amin 11:00–23:00 · Owais Rehan 21:00–05:00 ·
-- Md Dulal 18:00–03:00 · Rejaul 21:00–05:00 · Nimeazad 09:00–17:00.
-- Default elsewhere: 18:00–02:00 (overnight). Weekly off default Sunday (0) —
-- §8.4 notes off-days vary per designer (Fri/Sat/Sun): confirm in the UI.
-- Later changes go through apply_schedule_change() so history stays anchored.

insert into public.designer_schedule
  (id, designer_id, effective_from, effective_to, daily_quota,
   shift_start, shift_end, weekly_off, late_grace_min, early_leave_grace_min)
values
  -- Logo
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', '2025-01-01', null, 5, '09:00', '17:00', 0, 15, 15), -- Nimeazad
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', '2025-01-01', null, 3, '21:00', '05:00', 0, 15, 15), -- Rejaul Karim
  ('e0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003', '2025-01-01', null, 3, '18:00', '03:00', 0, 15, 15), -- Md Dulal
  ('e0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000004', '2025-01-01', null, 3, '11:00', '23:00', 0, 15, 15), -- Amin Ullah (2 on two Fridays/mo → quota_exceptions via UI)
  ('e0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000005', '2025-01-01', null, 3, '18:00', '02:00', 0, 15, 15), -- Atta Razaq
  ('e0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000006', '2025-01-01', null, 2, '18:00', '02:00', 0, 15, 15), -- M. Tariq
  ('e0000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000007', '2025-01-01', null, 3, '18:00', '02:00', 0, 15, 15), -- Md Zahid Hasan
  ('e0000000-0000-4000-8000-000000000008', 'd0000000-0000-4000-8000-000000000008', '2025-01-01', null, 3, '18:00', '02:00', 0, 15, 15), -- Abiha Imran
  ('e0000000-0000-4000-8000-000000000009', 'd0000000-0000-4000-8000-000000000009', '2025-01-01', null, 2, '18:00', '02:00', 0, 15, 15), -- Shaoor Haider
  ('e0000000-0000-4000-8000-000000000010', 'd0000000-0000-4000-8000-000000000010', '2025-01-01', null, 3, '18:00', '02:00', 0, 15, 15), -- Md Rashadul Haque
  ('e0000000-0000-4000-8000-000000000011', 'd0000000-0000-4000-8000-000000000011', '2025-01-01', null, 2, '18:00', '02:00', 0, 15, 15), -- Md Rezaul
  -- Branding
  ('e0000000-0000-4000-8000-000000000012', 'd0000000-0000-4000-8000-000000000012', '2025-01-01', null, 6, '18:00', '02:00', 0, 15, 15), -- Owais Nadeem
  ('e0000000-0000-4000-8000-000000000013', 'd0000000-0000-4000-8000-000000000013', '2025-01-01', null, 2, '18:00', '02:00', 0, 15, 15), -- Khubaib
  ('e0000000-0000-4000-8000-000000000014', 'd0000000-0000-4000-8000-000000000014', '2025-01-01', null, 4, '18:00', '02:00', 0, 15, 15), -- Hamid
  ('e0000000-0000-4000-8000-000000000015', 'd0000000-0000-4000-8000-000000000015', '2025-01-01', null, 2, '21:00', '05:00', 0, 15, 15), -- Owais Rehan
  ('e0000000-0000-4000-8000-000000000016', 'd0000000-0000-4000-8000-000000000016', '2025-01-01', null, 2, '18:00', '02:00', 0, 15, 15), -- Afjal Hussain
  -- Animation
  ('e0000000-0000-4000-8000-000000000017', 'd0000000-0000-4000-8000-000000000017', '2025-01-01', null, 2, '18:00', '02:00', 0, 15, 15), -- Syed Mubahat (§8.4: 1–2)
  -- Other
  ('e0000000-0000-4000-8000-000000000018', 'd0000000-0000-4000-8000-000000000018', '2025-01-01', null, 2, '18:00', '02:00', 0, 15, 15), -- Aqeel (PPT — quota unconfirmed)
  ('e0000000-0000-4000-8000-000000000019', 'd0000000-0000-4000-8000-000000000019', '2025-01-01', null, 2, '18:00', '02:00', 0, 15, 15)  -- Shahmeer (Canva — quota unconfirmed)
on conflict do nothing;

-- quota_exceptions: intentionally not seeded — Amin Ullah's two reduced
-- Fridays (§8.4) are specific calendar dates the PM enters in the UI each
-- month. The table exists (001) and the Roster UI writes to it.
