-- Migration 005: Add shipping service level fields to orders table
-- Run this at: https://supabase.com/dashboard/project/piyuvsntqqulmooslhcc/sql/new

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS ship_service_level TEXT,
  ADD COLUMN IF NOT EXISTS is_prime BOOLEAN DEFAULT FALSE;

-- Index for filtering by service level (e.g. finding Priority orders quickly)
CREATE INDEX IF NOT EXISTS idx_orders_ship_service_level ON orders (ship_service_level);
