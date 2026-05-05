-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Excess Inventory & FBA Notifications
--
-- Tables:
--   excess_inventory  — stores excess FBA items with AI action plans and history
--   fba_notifications — stores in-app notifications for re-analysis outcomes
-- ─────────────────────────────────────────────────────────────────────────────

-- ── excess_inventory ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS excess_inventory (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  asin                        TEXT NOT NULL,
  sku                         TEXT NOT NULL,
  fnsku                       TEXT,
  product_name                TEXT NOT NULL DEFAULT '',

  -- Snapshot data from Amazon's Inventory Health report (at time of sync)
  qty_available               INTEGER NOT NULL DEFAULT 0,
  excess_qty                  INTEGER NOT NULL DEFAULT 0,
  days_of_supply              INTEGER NOT NULL DEFAULT 0,
  units_sold_last_30_days     INTEGER NOT NULL DEFAULT 0,
  your_price                  NUMERIC(10,2) NOT NULL DEFAULT 0,
  estimated_monthly_storage_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  estimated_storage_cost_per_unit NUMERIC(10,2) NOT NULL DEFAULT 0,
  amazon_recommended_action   TEXT,           -- Amazon's raw recommendation string
  amazon_alert                TEXT,           -- Amazon's alert text

  -- AI-generated action plan
  ai_action_plan              TEXT,           -- Full LLM-generated plan text
  ai_plan_generated_at        TIMESTAMPTZ,    -- When the AI plan was generated
  ai_plan_model               TEXT,           -- Which model generated the plan (e.g. gpt-4.1-mini)

  -- Action tracking
  action_taken                TEXT,           -- User-selected: 'ran_sale' | 'created_outlet_deal' | 'removed' | 'held' | 'pending'
  action_taken_at             TIMESTAMPTZ,    -- When user marked the action
  action_notes                TEXT,           -- Optional user notes

  -- Re-analysis scheduling
  recheck_due_at              TIMESTAMPTZ,    -- When auto re-analysis should run
  recheck_completed_at        TIMESTAMPTZ,    -- When re-analysis actually ran
  recheck_outcome             TEXT,           -- AI-generated outcome summary after re-analysis

  -- Outcome snapshot (captured at re-analysis time)
  outcome_qty_available       INTEGER,
  outcome_units_sold_30d      INTEGER,
  outcome_days_of_supply      INTEGER,
  outcome_excess_qty          INTEGER,

  -- Status
  status                      TEXT NOT NULL DEFAULT 'active',
  -- 'active'    — excess item, action plan generated, awaiting action
  -- 'actioned'  — user has marked an action taken
  -- 'resolved'  — re-analysis confirmed excess cleared
  -- 'escalated' — re-analysis showed action didn't work, escalated recommendation
  -- 'dismissed' — user dismissed this item

  -- Timestamps
  first_detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique constraint: one active record per SKU
  CONSTRAINT excess_inventory_sku_unique UNIQUE (sku)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_excess_inventory_asin ON excess_inventory (asin);
CREATE INDEX IF NOT EXISTS idx_excess_inventory_status ON excess_inventory (status);
CREATE INDEX IF NOT EXISTS idx_excess_inventory_recheck_due ON excess_inventory (recheck_due_at)
  WHERE recheck_due_at IS NOT NULL AND recheck_completed_at IS NULL;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_excess_inventory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS excess_inventory_updated_at ON excess_inventory;
CREATE TRIGGER excess_inventory_updated_at
  BEFORE UPDATE ON excess_inventory
  FOR EACH ROW EXECUTE FUNCTION update_excess_inventory_updated_at();

-- RLS
ALTER TABLE excess_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to excess_inventory"
  ON excess_inventory FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read excess_inventory"
  ON excess_inventory FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update excess_inventory"
  ON excess_inventory FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');


-- ── fba_notifications ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fba_notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,
  -- 'reanalysis_complete'  — re-analysis finished for an excess item
  -- 'excess_detected'      — new excess items found after sync
  -- 'action_reminder'      — reminder to take action on an item
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  asin            TEXT,
  sku             TEXT,
  excess_id       UUID REFERENCES excess_inventory(id) ON DELETE CASCADE,
  is_read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fba_notifications_unread ON fba_notifications (is_read, created_at DESC)
  WHERE is_read = FALSE;

ALTER TABLE fba_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to fba_notifications"
  ON fba_notifications FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read fba_notifications"
  ON fba_notifications FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update fba_notifications"
  ON fba_notifications FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
