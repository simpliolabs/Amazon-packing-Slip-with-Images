/**
 * GET /api/fba/product-image?asin=...
 * Best-effort fetch of a product's main image from the Amazon Catalog Items API,
 * used when listing_seo_scores.image_url wasn't captured during sync. Returns the
 * largest available image link, or { image_url: null } on any failure (the caller
 * falls back to a placeholder).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

export async function GET(req: NextRequest) {
  const asin = new URL(req.url).searchParams.get('asin')
  if (!asin) return NextResponse.json({ error: 'asin is required' }, { status: 400 })
  try {
    const token = await getAccessToken()
    const url =
      `${ENDPOINT}/catalog/2022-04-01/items/${encodeURIComponent(asin)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=images`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return NextResponse.json({ image_url: null })
    const json = (await resp.json()) as {
      images?: { images?: { link: string; height: number; width: number }[] }[]
    }
    const imgs = json.images?.[0]?.images ?? []
    const best = [...imgs].sort((a, b) => b.height * b.width - a.height * a.width)[0]
    return NextResponse.json({ image_url: best?.link ?? null })
  } catch {
    return NextResponse.json({ image_url: null })
  }
}
