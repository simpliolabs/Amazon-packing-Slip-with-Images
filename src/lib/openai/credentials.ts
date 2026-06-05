/**
 * Resolve the OpenAI API key for the current request — DB-stored value wins, env var
 * falls back. Mirrors the Jungle Scout pattern (PR #82).
 *
 * Why: the Settings page lets admins paste a key without having to redeploy with a
 * new env var. When set, app_settings.openai_api_key is used; otherwise we fall back
 * to OPENAI_API_KEY env (the historical behavior, so nothing breaks for installs that
 * configured the key in Coolify before this UI existed).
 */
import { createAdminClient } from '@/lib/supabase/server'

let cachedKey: { value: string; readAt: number } | null = null
const CACHE_MS = 30_000 // small TTL — the Settings UI updates are infrequent but we
                       // don't want one stale read per request either.

export async function resolveOpenAIKey(): Promise<string> {
  const now = Date.now()
  if (cachedKey && now - cachedKey.readAt < CACHE_MS) return cachedKey.value

  let value = ''
  try {
    const admin = await createAdminClient()
    const { data } = await admin
      .from('app_settings')
      .select('value')
      .eq('key', 'openai_api_key')
      .single() as { data: { value: string } | null }
    if (data?.value) value = data.value
  } catch { /* fall through to env */ }

  if (!value) value = process.env.OPENAI_API_KEY || ''
  cachedKey = { value, readAt: now }
  return value
}

/** Bust the in-process cache after a credential save/disable from the Settings UI. */
export function invalidateOpenAIKeyCache() { cachedKey = null }
