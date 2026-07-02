/**
 * app_config access (spec §18) + the reconciliation `last_sync` cursor.
 */

import { mergeConfig, type AppConfig, type Config } from '../../shared/types'
import { expectOk, type SupabaseAdmin } from './supabaseAdmin'

/** Read app_config → typed Config with spec §18 defaults applied. */
export async function loadConfig(supa: SupabaseAdmin): Promise<Config> {
  const { data, error } = await supa.from('app_config').select('*')
  expectOk(error, 'app_config read')
  return mergeConfig((data ?? []) as AppConfig[])
}

/** ISO timestamp of the last successful reconciliation pull (spec §6.2). */
export async function getLastSync(supa: SupabaseAdmin): Promise<string | null> {
  const { data, error } = await supa
    .from('app_config')
    .select('value')
    .eq('key', 'last_sync')
    .maybeSingle()
  expectOk(error, 'last_sync read')
  const value = (data as { value?: unknown } | null)?.value
  return typeof value === 'string' && value.length > 0 ? value : null
}

export async function setLastSync(supa: SupabaseAdmin, iso: string): Promise<void> {
  const { error } = await supa
    .from('app_config')
    .upsert({ key: 'last_sync', value: iso }, { onConflict: 'key' })
  expectOk(error, 'last_sync write')
}
