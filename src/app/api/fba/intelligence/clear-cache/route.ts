/**
 * POST /api/fba/intelligence/clear-cache
 * Clears the keyword_cache and keyword_analysis for a specific ASIN.
 * Used to force a fresh Jungle Scout fetch on the next "Run AI Audit".
 * Requires admin auth.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { asin, parentAsin } = body;

    if (!asin && !parentAsin) {
      return NextResponse.json({ error: 'asin or parentAsin required' }, { status: 400 });
    }

    const supabase = await createAdminClient();

    // ONE POOL KEY (#174): the old parent_asin_rollup lookup here was the THIRD resolver for this
    // table — it aimed the delete at the mutable sales-pointer key, so "clearing the parent" removed
    // ZERO rows while the real drawers survived (verified live on B0DSQPZY9S). One resolver, one key.
    // NOTE this route is a CREDIT TRIGGER, not a cleanup: deleting keyword_cache removes the
    // poolSize>0 guard, and the next Run AI Audit falls through to a billable Jungle Scout pull.
    const { resolveKeywordPoolKey } = await import('@/lib/keyword-engine/poolKey');
    const targetAsin = await resolveKeywordPoolKey(asin || parentAsin, supabase);

    // Clear keyword_cache (raw JS API data)
    const { error: cacheErr } = await supabase
      .from('keyword_cache')
      .delete()
      .eq('asin', targetAsin);

    // Clear keyword_analysis (processed results)
    const { error: analysisErr } = await supabase
      .from('keyword_analysis')
      .delete()
      .eq('asin', targetAsin);

    if (cacheErr || analysisErr) {
      console.error('[clear-cache] Error:', cacheErr?.message, analysisErr?.message);
    }

    console.log(`[clear-cache] Cleared keyword cache for ASIN: ${targetAsin}`);

    return NextResponse.json({
      success: true,
      asin: targetAsin,
      message: `Keyword cache cleared for ${targetAsin}. Next "Run AI Audit" will fetch fresh data from Jungle Scout.`,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
