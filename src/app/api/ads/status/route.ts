/**
 * GET /api/ads/status
 *
 * Returns the current Ads API integration status:
 *   - Whether credentials are configured
 *   - Whether the credentials are valid (by calling /v2/profiles)
 *   - How many campaigns/keywords are synced
 *   - Last sync timestamp
 *
 * Used by the Ads Manager UI tab to show the setup wizard or the dashboard.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAdsCredentials, adsApiFetch } from '@/lib/amazon/ads-auth'

export const dynamic = 'force-dynamic'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET() {
  const creds = await getAdsCredentials()

  if (!creds) {
    return NextResponse.json({
      configured: false,
      valid:      false,
      message:    'Amazon Ads API credentials not configured. Add them in Settings → Amazon Ads.',
      stats:      { campaigns: 0, keywords: 0, lastSynced: null },
    })
  }

  // Test credentials by calling /v2/profiles
  let valid = false
  let profileName: string | null = null
  try {
    const resp = await adsApiFetch('/v2/profiles')
    if (resp && resp.ok) {
      valid = true
      const profiles = await resp.json()
      const profile = Array.isArray(profiles)
        ? profiles.find((p: { profileId: string }) => String(p.profileId) === creds.profileId)
        : null
      profileName = profile?.accountInfo?.name || null
    }
  } catch {
    valid = false
  }

  // Get stats from Supabase
  const supabase = getAdminSupabase()
  const [{ count: campaignCount }, { count: keywordCount }] = await Promise.all([
    supabase.from('ads_campaigns').select('*', { count: 'exact', head: true }),
    supabase.from('ads_keywords').select('*',  { count: 'exact', head: true }),
  ])

  const { data: lastSync } = await supabase
    .from('ads_campaigns')
    .select('last_synced_at')
    .order('last_synced_at', { ascending: false })
    .limit(1)
    .single()

  return NextResponse.json({
    configured:  true,
    valid,
    profileId:   creds.profileId,
    profileName,
    region:      creds.region,
    message:     valid ? 'Connected' : 'Credentials configured but API validation failed',
    stats: {
      campaigns:  campaignCount  || 0,
      keywords:   keywordCount   || 0,
      lastSynced: lastSync?.last_synced_at || null,
    },
  })
}
