import { redirect } from 'next/navigation'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import DashboardLayout from '@/components/layout/DashboardLayout'
import BlanksPanel from '@/components/settings/BlanksPanel'

/**
 * Settings → Blanks (handoff/BLANKS_IN_PORTAL_DESIGN.md §5.3, PO decisions B/D, 2026-08-22).
 *
 * Decision B: the Blanks catalog lives UNDER Settings (not top-level nav) — this route is
 * `/settings/blanks`, one level under the existing `/settings` surface.
 * Decision D: ANY signed-in user may edit blanks — NOT admin-only. The rest of `/settings`
 * (Amazon/Jungle Scout/OpenAI credentials) stays admin-gated (`src/app/settings/page.tsx`); this
 * page intentionally does NOT repeat that role check, only the standing "must be signed in" gate
 * every page gets from src/middleware.ts. `set_by`/`updated_by` attribution happens server-side in
 * the API routes (resolveUserName), never trusted from the client.
 */
export default async function BlanksSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const adminClient = await createAdminClient()
  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('role, email')
    .eq('id', user.id)
    .single() as { data: { role: string; email: string } | null }

  return (
    <DashboardLayout userRole={(profile?.role as 'admin' | 'packer') || 'packer'} userEmail={profile?.email || user.email || ''}>
      <BlanksPanel />
    </DashboardLayout>
  )
}
