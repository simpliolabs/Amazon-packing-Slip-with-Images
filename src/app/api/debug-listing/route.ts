import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET(req: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  
  const asin = req.nextUrl.searchParams.get('asin') || 'B0FK9NKZBV'
  
  const { data } = await supabase
    .from('listing_content')
    .select('asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5')
    .eq('asin', asin)
    .single()
  
  return NextResponse.json({ listing: data })
}
