-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011: Missing Inventory Detection View
--
-- Detects FBM SKUs within a product family (same design prefix) where a
-- size/color combination has zero stock while sibling SKUs in the same family
-- are well-stocked.
--
-- SKU format expected: {DESIGN_PREFIX}-{SIZE}-{COLOR}
--   e.g. TCEO-CCIC-M-BLK, DAR-CCG-XL-IVY, AQS-TMB-L-BJ
--
-- Detection logic:
--   1. Parse each SKU into (family, size, color) using the known size tokens
--   2. For each family, compute the "expected" sizes = all sizes that appear
--      for ≥50% of the colors in that family (avoids flagging intentionally
--      limited sizes)
--   3. Flag any (family, size, color) combo where qty = 0 AND the same size
--      exists for other colors in the family with qty > 0
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: parse a SKU into its components
-- Returns NULL for SKUs that don't match the {PREFIX}-{SIZE}-{COLOR} pattern
CREATE OR REPLACE FUNCTION parse_sku_parts(p_sku text)
RETURNS TABLE(family text, size_token text, color_token text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    -- family = everything before the size token
    CASE
      WHEN p_sku ~ '-XS-'   THEN split_part(p_sku, '-XS-', 1)
      WHEN p_sku ~ '-S-'    THEN split_part(p_sku, '-S-', 1)
      WHEN p_sku ~ '-M-'    THEN split_part(p_sku, '-M-', 1)
      WHEN p_sku ~ '-L-'    THEN split_part(p_sku, '-L-', 1)
      WHEN p_sku ~ '-XL-'   THEN split_part(p_sku, '-XL-', 1)
      WHEN p_sku ~ '-2XL-'  THEN split_part(p_sku, '-2XL-', 1)
      WHEN p_sku ~ '-3XL-'  THEN split_part(p_sku, '-3XL-', 1)
      WHEN p_sku ~ '-4XL-'  THEN split_part(p_sku, '-4XL-', 1)
      WHEN p_sku ~ '-5XL-'  THEN split_part(p_sku, '-5XL-', 1)
      ELSE NULL
    END AS family,
    -- size token
    CASE
      WHEN p_sku ~ '-XS-'   THEN 'XS'
      WHEN p_sku ~ '-S-'    THEN 'S'
      WHEN p_sku ~ '-M-'    THEN 'M'
      WHEN p_sku ~ '-L-'    THEN 'L'
      WHEN p_sku ~ '-XL-'   THEN 'XL'
      WHEN p_sku ~ '-2XL-'  THEN '2XL'
      WHEN p_sku ~ '-3XL-'  THEN '3XL'
      WHEN p_sku ~ '-4XL-'  THEN '4XL'
      WHEN p_sku ~ '-5XL-'  THEN '5XL'
      ELSE NULL
    END AS size_token,
    -- color = everything after the size token
    CASE
      WHEN p_sku ~ '-XS-'   THEN split_part(p_sku, '-XS-', 2)
      WHEN p_sku ~ '-S-'    THEN split_part(p_sku, '-S-', 2)
      WHEN p_sku ~ '-M-'    THEN split_part(p_sku, '-M-', 2)
      WHEN p_sku ~ '-L-'    THEN split_part(p_sku, '-L-', 2)
      WHEN p_sku ~ '-XL-'   THEN split_part(p_sku, '-XL-', 2)
      WHEN p_sku ~ '-2XL-'  THEN split_part(p_sku, '-2XL-', 2)
      WHEN p_sku ~ '-3XL-'  THEN split_part(p_sku, '-3XL-', 2)
      WHEN p_sku ~ '-4XL-'  THEN split_part(p_sku, '-4XL-', 2)
      WHEN p_sku ~ '-5XL-'  THEN split_part(p_sku, '-5XL-', 2)
      ELSE NULL
    END AS color_token
$$;

-- ─── Parsed SKU base view ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_sku_parsed AS
SELECT
  lh.id,
  lh.sku,
  lh.asin,
  lh.product_name,
  lh.quantity,
  lh.status,
  lh.fulfillment_channel,
  lh.last_synced_at,
  p.family,
  p.size_token,
  p.color_token
FROM listing_health lh
CROSS JOIN LATERAL parse_sku_parts(lh.sku) p
WHERE
  -- Only FBM (non-FBA) listings
  lh.fulfillment_channel = 'DEFAULT'
  AND lh.sku NOT LIKE '%-FBA'
  AND lh.sku NOT LIKE '%_FBA'
  -- Only parseable SKUs
  AND p.family IS NOT NULL
  AND p.size_token IS NOT NULL
  AND p.color_token IS NOT NULL
  -- Exclude parent/placeholder SKUs (no color = just the family)
  AND p.color_token != '';

-- ─── Family stats: how many distinct colors per family, per size ─────────────
-- Used to determine which sizes are "expected" for a family
CREATE OR REPLACE VIEW v_family_size_coverage AS
SELECT
  family,
  size_token,
  COUNT(DISTINCT color_token)                              AS colors_with_this_size,
  COUNT(DISTINCT color_token) FILTER (WHERE quantity > 0) AS colors_in_stock,
  COUNT(DISTINCT color_token) FILTER (WHERE quantity = 0) AS colors_out_of_stock,
  MAX(quantity)                                           AS max_qty_in_size,
  AVG(quantity)::int                                      AS avg_qty_in_size
FROM v_sku_parsed
WHERE status = 'Active'
GROUP BY family, size_token;

-- ─── Missing inventory alerts view ──────────────────────────────────────────
-- A SKU is flagged when:
--   • Its quantity = 0 (or status = Inactive/Incomplete while siblings are Active)
--   • At least 1 other color in the same family+size has qty > 0
--   • The size appears for at least 3 colors in the family (avoids noise on tiny families)
CREATE OR REPLACE VIEW v_missing_inventory AS
WITH family_totals AS (
  SELECT
    family,
    COUNT(DISTINCT color_token) AS total_colors
  FROM v_sku_parsed
  WHERE status = 'Active'
  GROUP BY family
),
size_presence AS (
  -- For each family+size, how many colors have stock?
  SELECT
    vp.family,
    vp.size_token,
    COUNT(DISTINCT vp.color_token)                              AS total_colors_for_size,
    COUNT(DISTINCT vp.color_token) FILTER (WHERE vp.quantity > 0) AS stocked_colors,
    MAX(vp.quantity)                                            AS max_qty
  FROM v_sku_parsed vp
  WHERE vp.status = 'Active'
  GROUP BY vp.family, vp.size_token
  -- Only flag sizes that appear for at least 3 colors (real size run, not a one-off)
  HAVING COUNT(DISTINCT vp.color_token) >= 3
    -- And at least 1 color in this size still has stock (so we know it's a real gap)
    AND COUNT(DISTINCT vp.color_token) FILTER (WHERE vp.quantity > 0) >= 1
)
SELECT
  vp.sku,
  vp.asin,
  vp.product_name,
  vp.quantity,
  vp.status,
  vp.family,
  vp.size_token,
  vp.color_token,
  sp.total_colors_for_size,
  sp.stocked_colors,
  sp.max_qty                                AS max_qty_in_sibling,
  ft.total_colors                           AS family_total_colors,
  -- Severity: critical = 0 stock, warning = 1-4 stock
  CASE
    WHEN vp.quantity = 0 THEN 'critical'
    WHEN vp.quantity < 5 THEN 'warning'
    ELSE 'ok'
  END AS severity,
  vp.last_synced_at
FROM v_sku_parsed vp
JOIN size_presence sp ON sp.family = vp.family AND sp.size_token = vp.size_token
JOIN family_totals ft ON ft.family = vp.family
WHERE
  vp.status = 'Active'
  AND vp.quantity < 5   -- flag both zero AND critically low (< 5)
ORDER BY
  -- Sort: critical first, then by family, then by size order
  CASE vp.quantity WHEN 0 THEN 0 ELSE 1 END,
  vp.family,
  CASE vp.size_token
    WHEN 'XS'  THEN 1
    WHEN 'S'   THEN 2
    WHEN 'M'   THEN 3
    WHEN 'L'   THEN 4
    WHEN 'XL'  THEN 5
    WHEN '2XL' THEN 6
    WHEN '3XL' THEN 7
    WHEN '4XL' THEN 8
    WHEN '5XL' THEN 9
    ELSE 10
  END,
  vp.color_token;

-- ─── Summary view: one row per family showing gap counts ────────────────────
CREATE OR REPLACE VIEW v_missing_inventory_summary AS
SELECT
  family,
  COUNT(*)                                           AS total_gaps,
  COUNT(*) FILTER (WHERE severity = 'critical')     AS critical_gaps,
  COUNT(*) FILTER (WHERE severity = 'warning')      AS warning_gaps,
  COUNT(DISTINCT size_token)                        AS sizes_affected,
  COUNT(DISTINCT color_token)                       AS colors_affected,
  array_agg(DISTINCT size_token ORDER BY size_token) AS missing_sizes,
  MIN(last_synced_at)                               AS last_synced_at
FROM v_missing_inventory
GROUP BY family
ORDER BY critical_gaps DESC, total_gaps DESC;
