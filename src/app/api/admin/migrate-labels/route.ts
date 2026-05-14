/**
 * One-time migration endpoint to add label/shipment tracking columns.
 * Protected by CRON_SECRET. Run once then this route can be removed.
 * POST /api/admin/migrate-labels
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(req: NextRequest) {
  // Protect with CRON_SECRET
  const auth = req.headers.get('authorization')
  const secret = process.env.CRON_SECRET
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  // Use direct PostgreSQL REST endpoint to run DDL
  const sql = `
    ALTER TABLE fba_inventory
      ADD COLUMN IF NOT EXISTS label_created_at timestamptz DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS shipment_status text DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS shipment_id text DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS label_notes text DEFAULT NULL;

    CREATE INDEX IF NOT EXISTS idx_fba_inventory_shipment_status
      ON fba_inventory (shipment_status)
      WHERE shipment_status IS NOT NULL;
  `

  try {
    // Try using the Supabase management API (pg_query)
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    })

    if (response.ok) {
      return NextResponse.json({ success: true, method: 'rpc_exec_sql' })
    }

    // Fallback: try direct column additions via Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })

    // Check if columns already exist by trying to select them
    const { error: checkError } = await supabase
      .from('fba_inventory')
      .select('label_created_at, shipment_status, shipment_id, label_notes')
      .limit(1)

    if (!checkError) {
      return NextResponse.json({ success: true, message: 'Columns already exist' })
    }

    // If columns don't exist, return the SQL to run manually
    return NextResponse.json({
      success: false,
      message: 'Could not run DDL via API. Columns may not exist yet.',
      rpc_error: await response.text(),
      sql_to_run: sql.trim(),
      instructions: 'Run this SQL in Supabase SQL Editor: https://supabase.com/dashboard/project/piyuvsntqqulmooslhcc/sql'
    })
  } catch (err: unknown) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      sql_to_run: sql.trim(),
    }, { status: 500 })
  }
}

// Also support GET for easy browser testing (still requires auth header)
export async function GET(req: NextRequest) {
  // For GET, just check if columns exist
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  const { data, error } = await supabase
    .from('fba_inventory')
    .select('label_created_at, shipment_status')
    .limit(1)

  if (error) {
    return NextResponse.json({
      columns_exist: false,
      error: error.message,
      hint: 'POST to this endpoint with Authorization: Bearer <CRON_SECRET> to run migration'
    })
  }

  return NextResponse.json({
    columns_exist: true,
    sample: data,
    message: 'Label tracking columns are ready'
  })
}
