-- Migration 006: Sales analytics and listing health tables
-- Populated by the All Orders flat-file report and All Listings report from SP-API

-- ── SKU Sales Analytics ──────────────────────────────────────────────────────
-- One row per SKU, updated on every sync. Tracks rolling sales velocity.
CREATE TABLE IF NOT EXISTS sku_sales_analytics (
  id                    BIGSERIAL PRIMARY KEY,
  sku                   TEXT        NOT NULL UNIQUE,
  asin                  TEXT,
  product_name          TEXT,
  units_sold_7d         INTEGER     NOT NULL DEFAULT 0,
  units_sold_30d        INTEGER     NOT NULL DEFAULT 0,
  units_sold_90d        INTEGER     NOT NULL DEFAULT 0,
  revenue_30d           NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_daily_units       NUMERIC(8,4) NOT NULL DEFAULT 0,
  fulfillment_channel   TEXT,        -- 'Amazon' (FBA) or 'Merchant' (FBM)
  last_order_date       TIMESTAMPTZ,
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sku_sales_sku  ON sku_sales_analytics (sku);
CREATE INDEX IF NOT EXISTS idx_sku_sales_asin ON sku_sales_analytics (asin);
CREATE INDEX IF NOT EXISTS idx_sku_sales_units_30d ON sku_sales_analytics (units_sold_30d DESC);

-- ── Listing Health ────────────────────────────────────────────────────────────
-- One row per SKU from the GET_MERCHANT_LISTINGS_ALL_DATA report.
CREATE TABLE IF NOT EXISTS listing_health (
  id                    BIGSERIAL PRIMARY KEY,
  sku                   TEXT        NOT NULL UNIQUE,
  asin                  TEXT,
  product_name          TEXT,
  price                 NUMERIC(10,2),
  quantity              INTEGER     NOT NULL DEFAULT 0,
  status                TEXT,        -- 'Active', 'Inactive', 'Suppressed', etc.
  fulfillment_channel   TEXT,        -- 'AMAZON_NA' (FBA) or 'DEFAULT' (FBM)
  open_date             TIMESTAMPTZ,
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_health_sku    ON listing_health (sku);
CREATE INDEX IF NOT EXISTS idx_listing_health_asin   ON listing_health (asin);
CREATE INDEX IF NOT EXISTS idx_listing_health_status ON listing_health (status);
