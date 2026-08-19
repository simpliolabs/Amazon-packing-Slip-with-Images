-- 057: ONE POOL KEY PER FAMILY (task #174, 2026-08-19)
-- ─────────────────────────────────────────────────────────────────────────────
-- keyword_analysis / keyword_cache were keyed by whatever ASIN each call site derived — the
-- Intelligence route's resolved child (= the PARENT for self-parented families), the regen's
-- top_child_asin (a MUTABLE max(units_sold_30d) sales pointer), clear-cache's rollup lookup.
-- Proven live on B0DSQPZY9S: TWO pool copies under two child keys, both harvested 2026-07-24
-- six minutes apart (the family paid Jungle Scout credits twice for one universe), and every
-- judgment column NULL because the rater/selection wrote where no generator read.
--
-- From this migration on, the key is the PARENT ASIN (code: resolveKeywordPoolKey, PR #587).
-- This re-keys every existing child-keyed row onto its parent, merging duplicates (newest
-- analyzed_at / fetched_at wins).
--
-- EXCLUDED: keyword_cache rows with source = 'competitor_seo'. Those are keyed by the
-- COMPETITOR's ASIN — a deliberately separate namespace (competitorSeo.ts). Re-keying them
-- through our family tree would poison pools with a competitor's SEO surface.

BEGIN;

-- ── keyword_analysis ─────────────────────────────────────────────────────────
-- 1. Drop the older duplicate of every (future-parent-key, keyword) collision.
WITH mapping AS (
  SELECT DISTINCT lc.asin AS child, lc.parent_asin AS parent
  FROM listing_content lc
  WHERE lc.parent_asin IS NOT NULL AND lc.parent_asin <> lc.asin
),
ranked AS (
  SELECT ka.ctid AS row_id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(m.parent, ka.asin), ka.keyword
           ORDER BY ka.analyzed_at DESC NULLS LAST
         ) AS rn
  FROM keyword_analysis ka
  LEFT JOIN mapping m ON m.child = ka.asin
)
DELETE FROM keyword_analysis
WHERE ctid IN (SELECT row_id FROM ranked WHERE rn > 1);

-- 2. Re-key the survivors child → parent.
WITH mapping AS (
  SELECT DISTINCT lc.asin AS child, lc.parent_asin AS parent
  FROM listing_content lc
  WHERE lc.parent_asin IS NOT NULL AND lc.parent_asin <> lc.asin
)
UPDATE keyword_analysis ka
SET asin = m.parent
FROM mapping m
WHERE m.child = ka.asin;

-- ── keyword_cache (competitor namespace untouched) ───────────────────────────
WITH mapping AS (
  SELECT DISTINCT lc.asin AS child, lc.parent_asin AS parent
  FROM listing_content lc
  WHERE lc.parent_asin IS NOT NULL AND lc.parent_asin <> lc.asin
),
ranked AS (
  SELECT kc.ctid AS row_id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(m.parent, kc.asin), kc.source
           ORDER BY kc.fetched_at DESC NULLS LAST
         ) AS rn
  FROM keyword_cache kc
  LEFT JOIN mapping m ON m.child = kc.asin
  WHERE kc.source <> 'competitor_seo'
)
DELETE FROM keyword_cache
WHERE ctid IN (SELECT row_id FROM ranked WHERE rn > 1);

WITH mapping AS (
  SELECT DISTINCT lc.asin AS child, lc.parent_asin AS parent
  FROM listing_content lc
  WHERE lc.parent_asin IS NOT NULL AND lc.parent_asin <> lc.asin
)
UPDATE keyword_cache kc
SET asin = m.parent
FROM mapping m
WHERE m.child = kc.asin
  AND kc.source <> 'competitor_seo';

COMMIT;
