/**
 * GET  /api/fba/intelligence/[asin]
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns keyword intelligence for an ASIN.
 * Accepts both parent and child ASINs — parent ASINs are resolved to
 * their top child ASIN automatically.
 *
 * Query params:
 *   ?refresh=true   — Force a fresh SQP fetch (ignores cache)
 *   ?stored=true    — Return stored analysis only (fastest, no API calls)
 *
 * Response shape:
 * {
 *   asin: string,            // resolved child ASIN
 *   parentAsin?: string,     // original parent ASIN (if resolved)
 *   analyzedAt: string,
 *   dataSource: 'sqp' | 'jungle_scout' | 'inherited',
 *   totalKeywordsAnalyzed: number,
 *   summary: { critical, upgrade, reinforce, defended, optimized },
 *   topOpportunities: AnalyzedKeyword[],
 *   apiUsage: { used, limit, remaining, provider },
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
import { resolveToChildAsin } from '@/lib/fba/resolveAsin';

// resolveToChildAsin extracted to @/lib/fba/resolveAsin (shared with the rank-analysis route, no fork).

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  try {
    const supabase = await createAdminClient();
    const { asin: rawAsin } = await params;
    const inputAsin = rawAsin?.toUpperCase();

    if (!inputAsin || !/^[A-Z0-9]{10}$/.test(inputAsin)) {
      return NextResponse.json({ error: 'Invalid ASIN format' }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';
    const storedOnly = searchParams.get('stored') === 'true';

    // Resolve parent → child ASIN
    const resolved = await resolveToChildAsin(inputAsin, supabase);

    if (!resolved) {
      return NextResponse.json(
        { error: `ASIN ${inputAsin} not found in catalog. Run a listing sync first.` },
        { status: 404 }
      );
    }

    const { childAsin, parentAsin } = resolved;

    let result;

    if (storedOnly) {
      // Fast path: return stored analysis without any API calls
      const stored = await getStoredAnalysis(childAsin, 100);
      if (!stored || stored.length === 0) {
        return NextResponse.json(
          {
            asin: childAsin,
            parentAsin,
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
        asin: childAsin,
        parentAsin,
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
      // Get competitor ASIN for reverse lookup fallback
      const { data: scoreData } = await supabase
        .from('listing_seo_scores')
        .select('competitor_asin')
        .eq('parent_asin', parentAsin || inputAsin)
        .single();
      const competitorAsin = (scoreData as { competitor_asin?: string } | null)?.competitor_asin || undefined;

      // Fetch listing title for seed fallback (needed when no vision identity exists)
      const { data: listingRow } = await supabase
        .from('listing_content')
        .select('title')
        .eq('asin', childAsin)
        .single();
      const listingTitle = (listingRow as { title?: string } | null)?.title || undefined;

      // Full sync path — use resolved child ASIN
      result = await syncKeywordIntelligence(childAsin, {
        forceRefresh,
        includeJungleScout: true,
        useStoredAnalysis: !forceRefresh,
        competitorAsin,
        parentAsin: parentAsin || undefined,
        listingTitle,
      });

      // Attach parent ASIN to result
      if (parentAsin) {
        result = { ...result, parentAsin };
      }
    }

    // Get API usage stats for the UI meter
    const rawUsage = await getApiUsageStats();
    const jsStatus = await getJungleScoutStatus();
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
    const supabase = await createAdminClient();
    const { asin: rawAsin } = await params;
    const inputAsin = rawAsin?.toUpperCase();

    if (!inputAsin || !/^[A-Z0-9]{10}$/.test(inputAsin)) {
      return NextResponse.json({ error: 'Invalid ASIN format' }, { status: 400 });
    }

    // Resolve parent → child ASIN
    const resolved = await resolveToChildAsin(inputAsin, supabase);

    if (!resolved) {
      return NextResponse.json(
        { error: `ASIN ${inputAsin} not found in catalog. Run a listing sync first.` },
        { status: 404 }
      );
    }

    const { childAsin } = resolved;

    // Get competitor ASIN for reverse lookup fallback
    const { data: scoreData } = await supabase
      .from('listing_seo_scores')
      .select('competitor_asin')
      .eq('parent_asin', inputAsin)
      .single();
    const competitorAsin = (scoreData as { competitor_asin?: string } | null)?.competitor_asin || undefined;

    // Fetch listing title for seed fallback
    const { data: listingRow } = await supabase
      .from('listing_content')
      .select('title')
      .eq('asin', childAsin)
      .single();
    const listingTitle = (listingRow as { title?: string } | null)?.title || undefined;

    // Fire and forget — run sync in background using resolved child ASIN
    syncKeywordIntelligence(childAsin, {
      forceRefresh: true,
      competitorAsin,
      parentAsin: inputAsin,
      listingTitle,
    }).catch(err => {
      console.error(`[POST /api/fba/intelligence/${inputAsin}] Background sync error (child: ${childAsin}):`, err);
    });

    return NextResponse.json({
      status: 'syncing',
      asin: childAsin,
      inputAsin,
      message: `Keyword intelligence sync started for ${childAsin}${inputAsin !== childAsin ? ` (resolved from parent ${inputAsin})` : ''}. SQP report takes 5–8 minutes to process. The panel will auto-update when ready.`,
    });

  } catch (error) {
    console.error('[POST /api/fba/intelligence/[asin]]', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
