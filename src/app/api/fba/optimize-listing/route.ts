/**
 * POST /api/fba/optimize-listing
 *
 * Pushes listing content updates back to Amazon via the Listings Items API.
 * Only handles auto-fixable issues (backend_keywords, aplus alt text).
 *
 * Request body:
 * {
 *   sku:              string   — the SKU to update
 *   field:            'backend_keywords' | 'title' | 'bullet_point'
 *   value:            string   — the new value to set
 * }
 *
 * Returns:
 * {
 *   success: boolean
 *   submissionId?: string
 *   message: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT       = process.env.AMAZON_ENDPOINT       || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

async function getSellerId(): Promise<string> {
  const supabase = await createAdminClient()
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'amazon_seller_id')
    .single()
  const row = data as { value: string } | null
  if (row?.value) return row.value
  const fromEnv = process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID
  if (fromEnv) return fromEnv
  throw new Error('amazon_seller_id not configured. Add it in Settings.')
}

// Map our field names to Amazon attribute names
const FIELD_TO_ATTRIBUTE: Record<string, string> = {
  backend_keywords: 'generic_keyword',
  title:            'item_name',
  bullet_point:     'bullet_point',
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { sku, field, value } = body as { sku: string; field: string; value: string }

    if (!sku || !field || !value) {
      return NextResponse.json({ error: 'sku, field, and value are required' }, { status: 400 })
    }

    const amazonAttribute = FIELD_TO_ATTRIBUTE[field]
    if (!amazonAttribute) {
      return NextResponse.json({ error: `Unknown field: ${field}` }, { status: 400 })
    }

    const token    = await getAccessToken()
    const sellerId = await getSellerId()
    const encodedSku = encodeURIComponent(sku)

    // Build the PATCH payload
    // For generic_keyword and item_name: single-value array
    // For bullet_point: the value should be a JSON array of strings
    let attributeValue
    if (field === 'bullet_point') {
      const bullets = typeof value === 'string' ? JSON.parse(value) : value
      attributeValue = bullets.map((b: string) => ({ value: b, marketplace_id: MARKETPLACE_ID }))
    } else {
      attributeValue = [{ value, marketplace_id: MARKETPLACE_ID }]
    }

    const patchPayload = {
      productType: 'SHIRT', // Will be overridden by Amazon based on the listing
      patches: [
        {
          op:        'replace',
          path:      `/attributes/${amazonAttribute}`,
          value:     attributeValue,
        },
      ],
    }

    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodedSku}` +
      `?marketplaceIds=${MARKETPLACE_ID}` +
      `&includedData=issues`

    const resp = await fetch(url, {
      method:  'PATCH',
      headers: {
        'x-amz-access-token': token,
        'Content-Type':       'application/json',
      },
      body: JSON.stringify(patchPayload),
    })

    if (!resp.ok) {
      const errText = await resp.text()
      console.error(`[OptimizeListing] PATCH failed for SKU ${sku}:`, errText.slice(0, 300))
      return NextResponse.json({
        success: false,
        message: `Amazon API error (${resp.status}): ${errText.slice(0, 200)}`,
      }, { status: resp.status })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await resp.json()
    const submissionId = result.submissionId || null

    // Update our local listing_content cache
    const supabase = await createAdminClient()
    const updateData: Record<string, string> = {}
    if (field === 'backend_keywords') updateData.backend_keywords = value
    if (field === 'title')            updateData.title = value

    if (Object.keys(updateData).length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase.from('listing_content') as any)
        .update({ ...updateData, content_synced_at: new Date().toISOString() })
        .eq('sku', sku)
    }

    return NextResponse.json({
      success:      true,
      submissionId,
      message:      `Successfully submitted ${field} update for SKU ${sku}. Changes typically reflect in 15-30 minutes.`,
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
