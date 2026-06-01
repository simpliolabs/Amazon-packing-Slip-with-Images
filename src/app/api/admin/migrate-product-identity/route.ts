/**
 * One-time migration: Create product_identity table for Vision LLM scanner results.
 * POST /api/admin/migrate-product-identity
 */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const results: string[] = [];

  // Check if table exists by trying to query it
  const { error: checkErr } = await supabase
    .from('product_identity')
    .select('asin')
    .limit(1);

  if (!checkErr) {
    results.push('✓ product_identity table already exists');
    return NextResponse.json({ success: true, results });
  }

  // Table doesn't exist — create it via RPC (requires SQL execution)
  // Since Supabase REST API can't CREATE TABLE, we'll use a workaround:
  // upsert into the table and let Supabase auto-create if possible,
  // or instruct the user to run the SQL manually.
  results.push('⚠ product_identity table does not exist.');
  results.push('Please run this SQL in Supabase SQL Editor:');
  results.push(`
CREATE TABLE IF NOT EXISTS product_identity (
  asin TEXT PRIMARY KEY,
  identity_data JSONB NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_identity_scanned_at ON product_identity(scanned_at);

COMMENT ON TABLE product_identity IS 'Vision LLM product identity scan results. Caches what the product IS based on image analysis.';
  `);

  return NextResponse.json({ success: false, results });
}
