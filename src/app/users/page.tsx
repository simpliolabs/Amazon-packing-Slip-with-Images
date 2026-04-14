import { redirect } from 'next/navigation'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import DashboardLayout from '@/components/layout/DashboardLayout'
import UsersManager from '@/components/users/UsersManager'

export default async function UsersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const adminClient = await createAdminClient()
  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('role, email')
    .eq('id', user.id)
    .single() as { data: { role: string; email: string } | null }

  if (profile?.role !== 'admin') redirect('/')

  return (
    <DashboardLayout userRole="admin" userEmail={profile?.email || user.email || ''}>
      <UsersManager />
    </DashboardLayout>
  )
}
