/**
 * GET/POST /api/fba/competitor-asin?parentAsin=xxx
 * Manages competitor ASIN for reverse keyword lookup.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const parentAsin = searchParams.get('parentAsin');

  if (!parentAsin) {
    return NextResponse.json({ error: 'parentAsin required' }, { status: 400 });
  }

  try {
    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from('listing_seo_scores')
      .select('competitor_asin')
      .eq('parent_asin', parentAsin)
      .single();

    if (error) {
      // Column might not exist yet
      return NextResponse.json({ competitorAsin: null });
    }

    return NextResponse.json({
      competitorAsin: (data as { competitor_asin: string | null })?.competitor_asin || null,
    });
  } catch {
    return NextResponse.json({ competitorAsin: null });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { parentAsin, competitorAsin } = body;

    if (!parentAsin) {
      return NextResponse.json({ error: 'parentAsin required' }, { status: 400 });
    }

    const supabase = await createAdminClient();
    const nextVal: string | null = competitorAsin || null;

    // Read the current value first so we only re-seed when the competitor actually CHANGES.
    const { data: cur } = await supabase
      .from('listing_seo_scores')
      .select('competitor_asin')
      .eq('parent_asin', parentAsin)
      .single();
    const prevVal = (cur as { competitor_asin: string | null } | null)?.competitor_asin || null;

    // Update the competitor_asin
    const { error } = await supabase
      .from('listing_seo_scores')
      .update({ competitor_asin: nextVal } as never)
      .eq('parent_asin', parentAsin);

    if (error) {
      console.error('[competitor-asin] Update error:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // A changed competitor is a new keyword source (force-harvested in research Phase 4). Invalidate
    // the derived keyword universe so the next regen re-researches WITH it — otherwise the empty-only
    // auto-sync gate keeps serving the stale, competitor-less universe (the reported "I set a
    // competitor and it was ignored"). Awaited (a fast DELETE); never fire-and-forget in a route.
    if (nextVal !== prevVal) {
      const { invalidateKeywordUniverse } = await import('@/lib/sync/syncKeywordIntelligence');
      await invalidateKeywordUniverse(parentAsin);
    }

    return NextResponse.json({ success: true, competitorAsin: nextVal });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
