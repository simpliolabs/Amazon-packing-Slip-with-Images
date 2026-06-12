-- Migration 029: seller-declared audience lean (PO 2026-06-12: "we need a MALE/Female/
-- Lean Male/Lean Female/Unisex selector by the Generate AI Audit - which should influence
-- the ENTIRE listing" - the Darlin' shirt reads female even though unisex keywords dominate).
-- Stored on the score row (one per parent); the regen pipeline reads it to re-weight gendered
-- keywords across every pool and to set the title audience tail. NULL = legacy keyword-derived.

ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS audience_lean TEXT;

NOTIFY pgrst, 'reload schema';
