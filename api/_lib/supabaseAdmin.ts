/**
 * Service-role Supabase client for ingestion/compute (bypasses RLS — spec §14).
 * Server-side only: SUPABASE_SERVICE_ROLE_KEY must never reach the browser.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type SupabaseAdmin = SupabaseClient

let cached: SupabaseAdmin | null = null

export function supabaseAdmin(): SupabaseAdmin {
  if (cached) return cached
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}

/** Turn a PostgREST error into a readable thrown Error. */
export function expectOk(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what} failed: ${error.message}`)
}
