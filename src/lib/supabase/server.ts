import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method is called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}

/** Service-role admin client — COOKIE-FREE (root-cause fix, verified live 2026-07-02).
 *
 *  This used to call `await cookies()` (a request-scoped Next API). Called from code that runs
 *  OUTSIDE the request scope — the streaming push's ReadableStream continuation (executePush runs
 *  minutes after the handler returned the Response), detached background jobs (pushJobs), fire-and-
 *  forget syncs — `cookies()` THROWS, every caller's best-effort try/catch swallowed it, and the
 *  writes silently never happened. Proven consequence: push_verification_tasks had ZERO rows ever
 *  (across all parents) — the auto-verify queue + self-heal enqueues were silent no-ops in
 *  production while everything constructed with a plain client worked.
 *
 *  A service-role client has NO use for cookies: auth is the service key itself, persistSession is
 *  false, and no user session is read or written. Construct it like every other admin module in this
 *  codebase (audit.ts, claims.ts, syncCatalog.ts): plain @supabase/supabase-js, request-independent,
 *  safe in ANY execution context. Kept async so all existing `await createAdminClient()` call sites
 *  are untouched. */
export async function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
