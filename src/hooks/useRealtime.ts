import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase, supabaseConfigured } from '../lib/supabase'

/**
 * Live-update mechanism (spec §22.4): Supabase Realtime on task_state, alerts,
 * attendance_daily → invalidate the relevant queries. Bursts are debounced
 * ~250ms so the board never janks.
 */
export function useRealtimeInvalidation() {
  const queryClient = useQueryClient()
  const pending = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!supabaseConfigured) return

    const flush = () => {
      timer.current = null
      const keys = [...pending.current]
      pending.current.clear()
      for (const key of keys) queryClient.invalidateQueries({ queryKey: [key] })
    }
    const schedule = (rootKey: string) => {
      pending.current.add(rootKey)
      if (!timer.current) timer.current = setTimeout(flush, 250)
    }

    const channel = supabase
      .channel('live-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_state' }, () => {
        schedule('tasks')
        schedule('task-metrics')
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, () =>
        schedule('alerts'),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_daily' }, () =>
        schedule('attendance'),
      )
      .subscribe()

    return () => {
      if (timer.current) clearTimeout(timer.current)
      supabase.removeChannel(channel)
    }
  }, [queryClient])
}
