import { redirect } from 'next/navigation'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import DashboardLayout from '@/components/layout/DashboardLayout'
import SettingsPanel from '@/components/settings/SettingsPanel'

export default async function SettingsPage() {
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

  // Fetch current settings
  const { data: settings } = await adminClient
    .from('app_settings')
    .select('key, value') as { data: { key: string; value: string }[] | null }

  const settingsMap: Record<string, string> = {}
  settings?.forEach((s) => {
    settingsMap[s.key] = s.value || ''
  })

  return (
    <DashboardLayout userRole="admin" userEmail={profile?.email || user.email || ''}>
      <SettingsPanel
        amazonConnected={settingsMap['amazon_connected'] === 'true'}
        lastSyncStatus={settingsMap['last_sync_status'] || ''}
        amazonClientId={settingsMap['amazon_client_id'] || ''}
        amazonClientSecret={settingsMap['amazon_client_secret'] || ''}
        amazonRefreshToken={settingsMap['amazon_refresh_token'] || ''}
      />
    </DashboardLayout>
  )
}
