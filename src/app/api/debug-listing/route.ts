import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET(req: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  
  const asin = req.nextUrl.searchParams.get('asin') || 'B0FK9NKZBV'
  
  // Check listing_content
  const { data: listing } = await supabase
    .from('listing_content')
    .select('asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5')
    .eq('asin', asin)
    .single()
  
  // Check keyword_cache
  const { data: cache } = await supabase
    .from('keyword_cache')
    .select('asin, source, fetched_at, expires_at')
    .eq('asin', asin)
  
  // Check keyword_analysis
  const { data: analysis } = await supabase
    .from('keyword_analysis')
    .select('asin, keyword, action_type, search_volume, opportunity_score')
    .eq('asin', asin)
    .order('opportunity_score', { ascending: false })
    .limit(20)
  
  return NextResponse.json({ 
    listing,
    cache,
    analysis,
    analysisCount: analysis?.length ?? 0
  })
}
