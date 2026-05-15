-- Migration 010: Warehouse Work Log
-- Purpose: Pre-shipment planning log for FBA replenishment.
-- Users log "we plan to print X units" for a given ASIN/SKU.
-- Reconciliation is automatic — when Amazon inbound sync updates
-- fba_inventory.inbound_working_quantity (On Way), no manual step needed.

CREATE TABLE IF NOT EXISTS fba_work_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asin          text NOT NULL,
  sku           text NOT NULL,
  qty_planned   integer NOT NULL CHECK (qty_planned > 0),
  note          text,
  logged_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  logged_at     timestamptz NOT NULL DEFAULT now(),
  edited_at     timestamptz,
  edited_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- jsonb array of {qty_planned, note, edited_by_email, edited_at}
  edit_history  jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- Index for fast lookup by ASIN (primary query pattern)
CREATE INDEX IF NOT EXISTS fba_work_log_asin_idx ON fba_work_log (asin);
-- Index for lookup by SKU
CREATE INDEX IF NOT EXISTS fba_work_log_sku_idx ON fba_work_log (sku);
-- Index for date-range queries
CREATE INDEX IF NOT EXISTS fba_work_log_logged_at_idx ON fba_work_log (logged_at DESC);

-- RLS: enable row-level security
ALTER TABLE fba_work_log ENABLE ROW LEVEL SECURITY;

-- Policy: admins can do everything
CREATE POLICY "Admins full access to work log"
  ON fba_work_log
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role = 'admin'
    )
  );

-- Policy: packers can read all entries and insert/edit their own
CREATE POLICY "Packers can read all work log entries"
  ON fba_work_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'packer')
    )
  );

CREATE POLICY "Packers can insert their own work log entries"
  ON fba_work_log
  FOR INSERT
  TO authenticated
  WITH CHECK (
    logged_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'packer')
    )
  );

CREATE POLICY "Packers can update their own work log entries"
  ON fba_work_log
  FOR UPDATE
  TO authenticated
  USING (
    logged_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'packer')
    )
  )
  WITH CHECK (
    logged_by = auth.uid()
  );
