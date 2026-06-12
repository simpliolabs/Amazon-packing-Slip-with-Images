import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import DashboardLayout from '@/components/layout/DashboardLayout'
import PushJobsBar from '@/components/fba/PushJobsBar'
import { createClient as createAdminClient } from '@supabase/supabase-js'

export default async function FBALayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Check admin role
  const adminSupabase = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: profile } = await adminSupabase
    .from('user_profiles')
    .select('role, email, full_name')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'packer'].includes(profile.role)) redirect('/')

  return (
    <DashboardLayout userRole={profile.role} userEmail={profile.email}>
      {children}
      {/* Global push-queue status bar (PR #184): fixed-position, renders only while
          jobs exist; its polling also drives the queue watchdog + self-heal. */}
      <PushJobsBar />
    </DashboardLayout>
  )
}
