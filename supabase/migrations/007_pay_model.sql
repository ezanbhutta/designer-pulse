-- 007_pay_model.sql
-- Per-project designers (piecework) alongside the monthly-salary designers.
-- A per-project designer is paid for what they complete in the month, has no
-- daily target and no fixed shift, so the quota / attendance / assignment-gap
-- machinery must skip them. Everything keys off this one flag; the default keeps
-- every existing designer exactly as they are (salary).

alter table designers
  add column if not exists pay_model text not null default 'salary'
    check (pay_model in ('salary', 'per_project'));

comment on column designers.pay_model is
  'salary = monthly salary, daily target + shift apply. per_project = paid per completed project, no daily target, no fixed timing.';
