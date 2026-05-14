/**
 * API endpoint for managing label/shipment status on FBA inventory items.
 * 
 * GET  /api/fba/label-status - Get all items with pending shipments
 * POST /api/fba/label-status - Mark an item as "label created" or update shipment status
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createClient as createBrowserClient } from '@/lib/supabase/server'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET() {
  const supabase = getServiceClient()

  const { data, error } = await supabase
    .from('fba_inventory')
    .select('asin, sku, fnsku, quantity_available, quantity_inbound, label_created_at, shipment_status')
    .not('shipment_status', 'is', null)
    .order('label_created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ items: data })
}

export async function POST(req: NextRequest) {
  // Verify user is authenticated
  const serverClient = await createBrowserClient()
  const { data: { user } } = await serverClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { asin, sku, status } = body

  if (!asin) {
    return NextResponse.json({ error: 'asin is required' }, { status: 400 })
  }

  const supabase = getServiceClient()

  // Build update object
  const update: Record<string, unknown> = {}

  if (status === 'label_created') {
    update.shipment_status = 'label_created'
    update.label_created_at = new Date().toISOString()
  } else if (status === 'shipped') {
    update.shipment_status = 'shipped'
  } else if (status === 'clear') {
    // Clear the label status (e.g., when Amazon receives the inventory)
    update.shipment_status = null
    update.label_created_at = null

  } else if (status) {
    update.shipment_status = status
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No updates provided' }, { status: 400 })
  }

  // Update by ASIN (and optionally SKU for specificity)
  let query = supabase.from('fba_inventory').update(update).eq('asin', asin)
  if (sku) {
    query = query.eq('sku', sku)
  }

  const { error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, updated: count, update })
}
