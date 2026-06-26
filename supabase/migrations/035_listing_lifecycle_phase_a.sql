-- Migration 035: Listing work-queue lifecycle — PHASE A (VISIBILITY).
-- Spec: docs/lifecycle-collab-spec.md §4-A + §5 Phase A. ADDITIVE ONLY (idempotent):
-- every step is ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, safe to re-run.
--
-- WHAT THIS UNLOCKS (no collaboration/outcome tables yet — those are 036–039):
--   1. `created_at` on listing_seo_scores so the optimizer GET can sort-by-latest WITHOUT
--      reusing `scored_at` (which mutates on every re-score). Written ONCE; the upserts at
--      syncListingContent.ts:1310 / :1445 deliberately OMIT it so re-scores never reset it.
--      Backfill = scored_at for existing rows (D-3: approximate — actively-worked rows whose
--      scored_at has since moved will sort artificially "new"; a stated one-time imperfection).
--   2. pg_trgm + GIN trigram indexes so the new ?search= path can ILIKE-match product titles
--      across the ~945-listing universe (listing_content.title for unscored stubs,
--      listing_seo_scores.product_title for scored cards) without a full table scan.
--
-- listing_seo_scores has NO migration-managed base schema (runtime-created; only ALTER…ADD
-- COLUMN migrations 014/020/031/034 touch it) — so this stays an ALTER-only extension.

-- ── 1) created_at on listing_seo_scores (write-once; sort-by-recent source) ──────────────
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
COMMENT ON COLUMN listing_seo_scores.created_at IS 'First-scored timestamp. Written ONCE (omitted from every upsert payload so re-scores never reset it). Drives the optimizer GET ?sort=recent keyset. Backfilled = scored_at for pre-035 rows (approximate).';

-- Backfill existing rows so the sort-by-recent keyset has a value everywhere (no NULLs in the tuple).
UPDATE listing_seo_scores SET created_at = scored_at WHERE created_at IS NULL;

-- ── 2) Trigram search (ILIKE on titles, both scored cards and unscored stubs) ─────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- listing_content.title → powers unscored "click-to-score" stubs (search never synchronously scores N).
CREATE INDEX IF NOT EXISTS idx_listing_content_title_trgm
  ON listing_content USING gin (title gin_trgm_ops);

-- listing_seo_scores.product_title → powers the scored-card title match in the optimizer GET.
CREATE INDEX IF NOT EXISTS idx_listing_seo_scores_product_title_trgm
  ON listing_seo_scores USING gin (product_title gin_trgm_ops);

-- Reload PostgREST's schema cache so the new column is queryable immediately (027/034 precedent).
NOTIFY pgrst, 'reload schema';
