/**
 * POST /api/ads/sync
 *
 * Syncs Amazon Ads data into the local Supabase tables:
 *   ads_campaigns, ads_ad_groups, ads_keywords, ads_performance
 *
 * Uses the Amazon Advertising API v3 (Sponsored Products).
 * Requires Ads API credentials to be configured in app_settings.
 *
 * Returns:
 *   { synced: { campaigns, adGroups, keywords }, durationMs, credentialsConfigured }
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adsApiFetch, getAdsCredentials } from '@/lib/amazon/ads-auth'

export const dynamic = 'force-dynamic'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST() {
  const start = Date.now()

  // Check if credentials are configured
  const creds = await getAdsCredentials()
  if (!creds) {
    return NextResponse.json({
      credentialsConfigured: false,
      message: 'Amazon Ads API credentials not yet configured. Add them in Settings → Amazon Ads.',
      synced: { campaigns: 0, adGroups: 0, keywords: 0 },
      durationMs: Date.now() - start,
    })
  }

  const supabase = getAdminSupabase()
  const errors: string[] = []
  let campaignsSynced = 0
  let adGroupsSynced  = 0
  let keywordsSynced  = 0

  // ── 1. Sync Campaigns ──────────────────────────────────────────────────────
  try {
    const resp = await adsApiFetch('/sp/campaigns/list', {
      method: 'POST',
      body: JSON.stringify({
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 100,
      }),
    })

    if (resp && resp.ok) {
      const data = await resp.json()
      const campaigns = data.campaigns || []

      for (const c of campaigns) {
        const { error } = await supabase
          .from('ads_campaigns')
          .upsert({
            campaign_id:      String(c.campaignId),
            name:             c.name || '',
            campaign_type:    'sponsoredProducts',
            targeting_type:   c.targetingType?.toLowerCase() || null,
            state:            c.state?.toLowerCase() || 'enabled',
            daily_budget:     c.budget?.budget ?? null,
            start_date:       c.startDate || null,
            end_date:         c.endDate   || null,
            portfolio_id:     c.portfolioId ? String(c.portfolioId) : null,
            bidding_strategy: c.bidding?.strategy || null,
            last_synced_at:   new Date().toISOString(),
          }, { onConflict: 'campaign_id' })

        if (error) {
          errors.push(`Campaign upsert error (${c.campaignId}): ${error.message}`)
        } else {
          campaignsSynced++
        }
      }
    } else {
      const errText = resp ? await resp.text() : 'No response'
      errors.push(`Campaigns API error: ${errText}`)
    }
  } catch (err) {
    errors.push(`Campaigns sync exception: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 2. Sync Ad Groups ──────────────────────────────────────────────────────
  try {
    const resp = await adsApiFetch('/sp/adGroups/list', {
      method: 'POST',
      body: JSON.stringify({
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 100,
      }),
    })

    if (resp && resp.ok) {
      const data = await resp.json()
      const adGroups = data.adGroups || []

      for (const ag of adGroups) {
        const { error } = await supabase
          .from('ads_ad_groups')
          .upsert({
            ad_group_id: String(ag.adGroupId),
            campaign_id: String(ag.campaignId),
            name:        ag.name || '',
            state:       ag.state?.toLowerCase() || 'enabled',
            default_bid: ag.defaultBid ?? null,
          }, { onConflict: 'ad_group_id' })

        if (error) {
          errors.push(`AdGroup upsert error (${ag.adGroupId}): ${error.message}`)
        } else {
          adGroupsSynced++
        }
      }
    } else {
      const errText = resp ? await resp.text() : 'No response'
      errors.push(`AdGroups API error: ${errText}`)
    }
  } catch (err) {
    errors.push(`AdGroups sync exception: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 3. Sync Keywords ───────────────────────────────────────────────────────
  try {
    const resp = await adsApiFetch('/sp/keywords/list', {
      method: 'POST',
      body: JSON.stringify({
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 500,
      }),
    })

    if (resp && resp.ok) {
      const data = await resp.json()
      const keywords = data.keywords || []

      for (const kw of keywords) {
        const { error } = await supabase
          .from('ads_keywords')
          .upsert({
            keyword_id:   String(kw.keywordId),
            ad_group_id:  String(kw.adGroupId),
            campaign_id:  String(kw.campaignId),
            keyword_text: kw.keywordText || '',
            match_type:   kw.matchType?.toLowerCase() || 'broad',
            state:        kw.state?.toLowerCase() || 'enabled',
            bid:          kw.bid ?? null,
          }, { onConflict: 'keyword_id' })

        if (error) {
          errors.push(`Keyword upsert error (${kw.keywordId}): ${error.message}`)
        } else {
          keywordsSynced++
        }
      }
    } else {
      const errText = resp ? await resp.text() : 'No response'
      errors.push(`Keywords API error: ${errText}`)
    }
  } catch (err) {
    errors.push(`Keywords sync exception: ${err instanceof Error ? err.message : String(err)}`)
  }

  return NextResponse.json({
    credentialsConfigured: true,
    synced: {
      campaigns: campaignsSynced,
      adGroups:  adGroupsSynced,
      keywords:  keywordsSynced,
    },
    errors,
    durationMs: Date.now() - start,
  })
}
