/** Database row types — mirror supabase/migrations/001_schema.sql exactly. */

import type { CanonicalStatus } from './statuses'

export type Role = 'admin' | 'manager' | 'pm' | 'hr' | 'ceo' | 'designer'

export type Team = 'Logo' | 'Branding' | 'Animation' | 'PPT' | 'Canva'

export interface Designer {
  id: string
  clickup_list_id: string | null
  clickup_user_id: number | null
  name: string
  team: Team
  specialty: string | null
  timezone: string
  status: 'active' | 'archived' | 'deleted'
  order_index: number
  created_at: string
  updated_at: string
}

export interface DesignerSchedule {
  id: string
  designer_id: string
  effective_from: string // date
  effective_to: string | null // date; null = current
  daily_quota: number
  shift_start: string // 'HH:MM:SS' PKT wall time
  shift_end: string
  is_overnight: boolean
  weekly_off: number | null // 0=Sun .. 6=Sat
  late_grace_min: number
  early_leave_grace_min: number
}

export interface QuotaException {
  id: string
  designer_id: string
  the_date: string
  daily_quota: number
  reason: string | null
}

export interface ClickupEvent {
  id: number
  task_id: string
  list_id: string
  designer_id: string | null
  event_type: 'created' | 'status_change' | 'deleted'
  from_status: CanonicalStatus | null
  to_status: CanonicalStatus | null
  event_time: string
  source: 'webhook' | 'reconciliation' | 'backfill'
  raw: unknown
  inserted_at: string
}

export interface TaskState {
  task_id: string
  list_id: string
  designer_id: string | null
  name: string | null
  current_status: CanonicalStatus | null
  priority: string | null
  concept_count: number | null
  scope_tags: string[] | null
  created_at: string | null // assignment time
  due_date: string | null
  closed_at: string | null
  last_event_at: string | null
  deleted: boolean
  updated_at: string
}

export interface TaskMetrics {
  task_id: string
  designer_id: string | null
  start_latency_min: number | null
  production_min: number | null
  first_pass_clean: boolean | null
  revision_rounds: number
  csr_caught_rounds: number
  client_caught_rounds: number
  revision_turnaround_min: number | null
  client_wait_min: number | null
  first_delivered_at: string | null // first entry into 'deliver to client'
  outcome: 'complete' | 'cancelled' | 'in_flight'
  is_cancelled: boolean
  metrics_confidence: 'live' | 'backfill'
  computed_at: string
}

export interface ShiftMark {
  id: number
  designer_id: string
  mark_type: 'check_in' | 'check_out'
  marked_at: string
  source: 'self' | 'auto_clickup' | 'auto_shift_end' | 'manual'
  created_at: string
}

export type AttendanceStatus =
  | 'Present'
  | 'Incomplete'
  | 'Absent'
  | 'Leave'
  | 'Holiday'
  | 'HolidayWorked'
  | 'WeeklyOff'

export interface AttendanceDaily {
  id: number
  designer_id: string
  work_date: string // shift-START day (overnight-aware)
  declared_in: string | null
  declared_out: string | null
  first_activity: string | null
  last_activity: string | null
  scheduled_in: string | null
  scheduled_out: string | null
  worked_minutes: number
  warmup_gap_min: number | null
  late_minutes: number
  early_leave_minutes: number
  is_half_day: boolean
  needs_review: boolean
  checkout_source: string | null
  status: AttendanceStatus | null
  computed_at: string
}

export interface Leave {
  id: string
  designer_id: string
  leave_type: string | null
  start_date: string
  end_date: string | null // null = single day
  paid: boolean
  status: 'approved' | 'pending' | 'rejected'
  reason: string | null
  created_by: string | null
  created_at: string
}

export interface HalfDay {
  id: string
  designer_id: string
  the_date: string
  from_time: string | null
  to_time: string | null
  paid: boolean
  reason: string | null
}

export interface Holiday {
  id: string
  the_date: string
  name: string | null
}

export interface HolidayWorker {
  the_date: string
  designer_id: string
}

export type AlertType =
  | 'assignment_gap'
  | 'task_aging'
  | 'cancellation'
  | 'quality_decay'
  | 'burnout'
  | 'forgotten_checkout'
  | 'workload_forecast'

export interface Alert {
  id: number
  alert_type: AlertType
  designer_id: string | null
  task_id: string | null
  severity: 'info' | 'warning' | 'critical'
  message: string | null
  context: Record<string, unknown> | null
  status: 'open' | 'acknowledged' | 'resolved'
  fired_at: string
  resolved_at: string | null
}

export interface AppUser {
  id: string
  email: string | null
  role: Role
  designer_id: string | null
  active: boolean
}

export interface AppConfig {
  key: string
  value: unknown
}

/** Typed view of app_config (spec §18) with defaults applied. */
export interface Config {
  timezone_default: string
  assignment_gap_check_offset_min: number
  aging_days_default: number
  aging_days_client_response: number
  late_grace_min: number
  early_leave_grace_min: number
  forgotten_checkout_mode: 'last_activity' | 'scheduled_end'
  quality_decay_pct: number
  burnout_score: number
  forecast_threshold: number
  forecast_horizon_days: number
  reconciliation_interval_min: number
  overnight_window_buffer_hours: number
}

export const CONFIG_DEFAULTS: Config = {
  timezone_default: 'Asia/Karachi',
  assignment_gap_check_offset_min: 60,
  aging_days_default: 3,
  // §12 normatively requires a LOWER threshold for client response ("revenue
  // rotting in limbo"); §18's illustrative "e.g. 4" contradicted it and the
  // normative rule wins. Editable in app_config.
  aging_days_client_response: 2,
  late_grace_min: 15,
  early_leave_grace_min: 15,
  forgotten_checkout_mode: 'last_activity',
  quality_decay_pct: 10,
  burnout_score: 70,
  forecast_threshold: 20,
  forecast_horizon_days: 7,
  reconciliation_interval_min: 15,
  overnight_window_buffer_hours: 4,
}

export function mergeConfig(rows: AppConfig[] | null | undefined): Config {
  const merged: Config = { ...CONFIG_DEFAULTS }
  for (const row of rows ?? []) {
    if (row.key in merged) {
      ;(merged as unknown as Record<string, unknown>)[row.key] = row.value
    }
  }
  return merged
}
