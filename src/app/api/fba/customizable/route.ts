/**
 * GET/POST /api/fba/customizable?parentAsin=xxx — seller-declared Amazon Custom enrollment
 * (listing_content.is_customizable, migration 052). Amazon's Listings API does not expose
 * Custom enrollment (live probe on heal-state?deep=1: 50 attributes, zero customization
 * keys), so auto-detect is impossible and this flag is a manual seller declaration.
 * Written to EVERY listing_content row of the family — the exact set the pipeline reads
 * (ai-recommendations builds PipelineInput.customizable from any-child-true on the same
 * parent_asin filter). Sync upserts never clear it: they only set the field when Amazon's
 * payload carries it, which it never does.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const parentAsin = searchParams.get('parentAsin');

  if (!parentAsin) {
    return NextResponse.json({ error: 'parentAsin required' }, { status: 400 });
  }

  // Best-effort separate query (column may predate migration 052 on this env; a combined
  // select would error the whole row) — mirrors the ai-recommendations consumer read.
  try {
    const supabase = await createAdminClient();
    const { data } = await supabase
      .from('listing_content')
      .select('is_customizable')
      .eq('parent_asin', parentAsin)
      .eq('is_customizable', true)
      .limit(1);
    return NextResponse.json({ customizable: (data?.length ?? 0) > 0 });
  } catch {
    return NextResponse.json({ customizable: false });
  }
}

export async function POST(request: NextRequest) {
  let body: { parentAsin?: string; customizable?: boolean };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const { parentAsin, customizable } = body;
  if (!parentAsin) return NextResponse.json({ error: 'parentAsin required' }, { status: 400 });
  if (typeof customizable !== 'boolean') {
    return NextResponse.json({ error: 'customizable must be true or false' }, { status: 400 });
  }

  const supabase = await createAdminClient();
  const { data: updated, error } = await supabase
    .from('listing_content')
    .update({ is_customizable: customizable } as never)
    .eq('parent_asin', parentAsin)
    .select('asin');
  if (error) {
    const friendly = /is_customizable|schema cache/i.test(error.message)
      ? 'is_customizable column not found — run supabase/migrations/052_listing_content_is_customizable.sql in the Supabase SQL editor, then retry.'
      : error.message;
    return NextResponse.json({ error: friendly }, { status: 500 });
  }
  // A 0-row match would otherwise be a silent no-op: the toggle looks flipped, the pipeline
  // (same parent_asin filter) still reads false, and the next page load snaps it back.
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: 'No listing_content rows found for this parent — sync the listing first, then retry.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, customizable, rows: updated.length });
}
