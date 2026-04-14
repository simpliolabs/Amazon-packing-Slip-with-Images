import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import DashboardLayout from '@/components/layout/DashboardLayout'
import OrdersTable from '@/components/orders/OrdersTable'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, email, full_name')
    .eq('id', user.id)
    .single() as { data: { role: 'admin' | 'packer'; email: string; full_name: string } | null }

  return (
    <DashboardLayout
      userRole={profile?.role || 'packer'}
      userEmail={profile?.email || user.email || ''}
    >
      <OrdersTable userRole={profile?.role || 'packer'} />
    </DashboardLayout>
  )
}
