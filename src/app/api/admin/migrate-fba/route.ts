/**
 * One-time migration endpoint to create FBA Intelligence tables.
 * Protected by CRON_SECRET. Run once then this route can be removed.
 * POST /api/admin/migrate-fba
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

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const steps: string[] = []
  const errors: string[] = []

  async function runSQL(label: string, sql: string) {
    const { error } = await supabase.rpc('exec_sql', { sql })
    if (error) {
      // Try direct query as fallback
      errors.push(`${label}: ${error.message}`)
    } else {
      steps.push(`✓ ${label}`)
    }
  }

  // Create catalog_products table
  const { error: e1 } = await supabase.from('catalog_products').select('asin').limit(1)
  if (e1 && e1.code === '42P01') {
    // Table doesn't exist — we need to create it via a different method
    errors.push('catalog_products table does not exist and cannot be created via REST API. Please run the SQL migration manually in Supabase SQL Editor.')
  } else if (!e1) {
    steps.push('✓ catalog_products table already exists')
  } else {
    errors.push(`catalog_products check: ${e1.message}`)
  }

  // Check fba_inventory table
  const { error: e2 } = await supabase.from('fba_inventory').select('id').limit(1)
  if (e2 && e2.code === '42P01') {
    errors.push('fba_inventory table does not exist and cannot be created via REST API. Please run the SQL migration manually in Supabase SQL Editor.')
  } else if (!e2) {
    steps.push('✓ fba_inventory table already exists')
  } else {
    errors.push(`fba_inventory check: ${e2.message}`)
  }

  return NextResponse.json({
    steps,
    errors,
    sql_to_run_manually: errors.length > 0 ? getMigrationSQL() : null
  })
}

function getMigrationSQL(): string {
  return `
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/piyuvsntqqulmooslhcc/sql

CREATE TABLE IF NOT EXISTS catalog_products (
  asin TEXT PRIMARY KEY,
  sku TEXT,
  title TEXT,
  fulfillment_channel TEXT NOT NULL CHECK (fulfillment_channel IN ('AFN', 'MFN')),
  status TEXT DEFAULT 'Active',
  parent_asin TEXT,
  item_name TEXT,
  price NUMERIC(10,2),
  quantity INTEGER DEFAULT 0,
  image_url TEXT,
  raw_data JSONB,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_products_sku ON catalog_products(sku);
CREATE INDEX IF NOT EXISTS idx_catalog_products_parent_asin ON catalog_products(parent_asin);
CREATE INDEX IF NOT EXISTS idx_catalog_products_channel ON catalog_products(fulfillment_channel);

CREATE TABLE IF NOT EXISTS fba_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asin TEXT NOT NULL,
  sku TEXT,
  fnsku TEXT,
  condition_type TEXT DEFAULT 'NewItem',
  quantity_available INTEGER DEFAULT 0,
  quantity_reserved INTEGER DEFAULT 0,
  quantity_inbound INTEGER DEFAULT 0,
  quantity_total INTEGER DEFAULT 0,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(asin, sku)
);

CREATE INDEX IF NOT EXISTS idx_fba_inventory_asin ON fba_inventory(asin);
CREATE INDEX IF NOT EXISTS idx_fba_inventory_sku ON fba_inventory(sku);

ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE fba_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access catalog_products" ON catalog_products FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read catalog_products" ON catalog_products FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access fba_inventory" ON fba_inventory FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read fba_inventory" ON fba_inventory FOR SELECT TO authenticated USING (true);
  `.trim()
}
