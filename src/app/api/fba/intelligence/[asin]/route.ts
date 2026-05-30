/**
 * GET  /api/fba/intelligence/[asin]
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns keyword intelligence for a specific child ASIN.
 *
 * Query params:
 *   ?refresh=true   — Force a fresh SQP fetch (ignores cache)
 *   ?stored=true    — Return stored analysis only (fastest, no API calls)
 *
 * Response shape:
 * {
 *   asin: string,
 *   analyzedAt: string,
 *   dataSource: 'sqp' | 'jungle_scout' | 'inherited',
 *   totalKeywordsAnalyzed: number,
 *   summary: { critical, upgrade, reinforce, defended, optimized },
 *   topOpportunities: AnalyzedKeyword[],  // top 25
 *   apiUsage: { jungleScout: { callsUsed, budget, percentUsed } },
 *   jungleScoutEnabled: boolean,
 * }
 *
 * POST /api/fba/intelligence/[asin]
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggers a fresh keyword sync for the ASIN.
 * Returns immediately with { status: 'syncing' } — sync runs in background.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { syncKeywordIntelligence } from '@/lib/sync/syncKeywordIntelligence';
import { getApiUsageStats, getStoredAnalysis } from '@/lib/keyword-engine';
import { getJungleScoutStatus } from '@/lib/sync/jungleScoutClient';

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  try {
    const supabase = await createAdminClient();
    const { asin: rawAsin } = await params;
    const asin = rawAsin?.toUpperCase();

    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      return NextResponse.json({ error: 'Invalid ASIN format' }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';
    const storedOnly = searchParams.get('stored') === 'true';

    // Verify the ASIN exists in our catalog
    const { data: catalogEntry } = await supabase
      .from('listing_content')
      .select('asin, title')
      .eq('asin', asin)
      .single();

    if (!catalogEntry) {
      return NextResponse.json(
        { error: `ASIN ${asin} not found in catalog. Run a listing sync first.` },
        { status: 404 }
      );
    }

    let result;

    if (storedOnly) {
      // Fast path: return stored analysis without any API calls
      const stored = await getStoredAnalysis(asin, 100);
      if (!stored || stored.length === 0) {
        return NextResponse.json(
          {
            asin,
            analyzedAt: null,
            dataSource: null,
            totalKeywordsAnalyzed: 0,
            summary: { critical: 0, upgrade: 0, reinforce: 0, defended: 0, optimized: 0 },
            topOpportunities: [],
            message: 'No analysis available yet. Trigger a sync to generate keyword intelligence.',
          },
          { status: 200 }
        );
      }
      // Group by category and apply dynamic cap:
      // CRITICAL: 5-10 (show all scoring ≥50, min 5, max 10)
      // UPGRADE/REINFORCE/DEFENDED: top 10 each
      const criticalAll = stored.filter(k => k.actionType === 'CRITICAL')
        .sort((a, b) => b.opportunityScore - a.opportunityScore);
      const criticalCapped = criticalAll.length <= 5
        ? criticalAll
        : criticalAll.filter(k => k.opportunityScore >= 50).slice(0, 10).length >= 5
          ? criticalAll.filter(k => k.opportunityScore >= 50).slice(0, 10)
          : criticalAll.slice(0, 5);

      const upgradeTop = stored.filter(k => k.actionType === 'UPGRADE')
        .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);
      const reinforceTop = stored.filter(k => k.actionType === 'REINFORCE')
        .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);
      const defendedTop = stored.filter(k => k.actionType === 'DEFENDED')
        .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);

      result = {
        asin,
        analyzedAt: new Date().toISOString(),
        dataSource: stored[0]?.dataSource ?? 'sqp',
        totalKeywordsAnalyzed: stored.length,
        topOpportunities: [...criticalCapped, ...upgradeTop, ...reinforceTop, ...defendedTop],
        allKeywords: stored,
        summary: {
          critical: criticalAll.length,
          upgrade: stored.filter(k => k.actionType === 'UPGRADE').length,
          reinforce: stored.filter(k => k.actionType === 'REINFORCE').length,
          defended: stored.filter(k => k.actionType === 'DEFENDED').length,
          optimized: stored.filter(k => k.actionType === 'OPTIMIZED').length,
        },
      };
    } else {
      // Full sync path
      result = await syncKeywordIntelligence(asin, {
        forceRefresh,
        includeJungleScout: true,
        useStoredAnalysis: !forceRefresh,
      });
    }

    // Get API usage stats for the UI meter
    const rawUsage = await getApiUsageStats();
    const jsStatus = getJungleScoutStatus();
    // Normalize to the shape page.tsx ApiUsageStats expects: { used, limit, remaining, provider }
    const apiUsage = {
      used: rawUsage.jungleScout.callsUsed,
      limit: rawUsage.jungleScout.budget,
      remaining: rawUsage.jungleScout.budget - rawUsage.jungleScout.callsUsed,
      provider: 'Jungle Scout',
    };

    return NextResponse.json({
      ...result,
      apiUsage,
      jungleScoutEnabled: jsStatus.enabled,
      jungleScoutMessage: jsStatus.message,
    });

  } catch (error) {
    console.error('[GET /api/fba/intelligence/[asin]]', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  try {
    const { asin: rawAsin } = await params;
    const asin = rawAsin?.toUpperCase();

    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      return NextResponse.json({ error: 'Invalid ASIN format' }, { status: 400 });
    }

    // Fire and forget — run sync in background
    syncKeywordIntelligence(asin, { forceRefresh: true }).catch(err => {
      console.error(`[POST /api/fba/intelligence/${asin}] Background sync error:`, err);
    });

    return NextResponse.json({
      status: 'syncing',
      asin,
      message: `Keyword intelligence sync started for ${asin}. SQP report takes 5–8 minutes to process. The panel will auto-update when ready.`,
    });

  } catch (error) {
    console.error('[POST /api/fba/intelligence/[asin]]', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
