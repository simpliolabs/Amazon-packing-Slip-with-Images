-- 066_audience_lean_by_design.sql — PER-DESIGN seller-declared audience lean for multi-design
-- families (PO ruling 2026-08-26, applying the garment per-design ruling — migration 062,
-- blank_assignments — to audience). Idempotent; safe to re-run. Apply BY HAND in the Supabase SQL
-- editor.
--
-- WHY. Family B0DSCDZC6K carries ONE family-wide audience_lean='lean_male' (migration 029), but its
-- designs are genuinely mixed: "Mother Hustler" / "Business B*tch" are female-coded; "Don't Quit" /
-- "Hustle Definiton" / "Billionare Coming Soon" / "Entrepreneur Definition" are neutral. No single
-- family value is correct — lean_male mis-genders 2 designs, lean_female would mis-gender 4, and
-- unisex unlocks the FEWEST keywords of all (asserting either gender is a lie on a genuinely
-- unisex design). The cross-gender veto (titleBand.ts, PR #651) rejects 43 of the family's
-- 69-keyword pool under lean_male even though most of those 43 are true of 2 of the family's own
-- 6 designs. "We know what the design is" (PO) — this column is where that statement lives.
--
-- SHAPE, mirroring the PROVEN per-design idiom already live TWICE on this exact table (034
-- design_name_overrides, 061's twin theme_fit_by_design on keyword_analysis): a JSONB map keyed by
-- the SAME designKey `detectDesignGroups` derives from the child SKUs (listingPipeline.ts) — the
-- key per_child_titles[] / design_name_overrides / theme_fit_by_design all already use.
--
-- NOT blank_assignments' shape (062, a scope+key TABLE keyed on a single child SKU): that table
-- exists because a SKU's OWN style code can individually be WRONG — a manufacturing/catalog fact
-- that can genuinely disagree SKU-to-SKU inside one design group. Audience is not that kind of
-- fact — every SKU inside one design group shares the same audience by construction, so it is a
-- per-DESIGN editorial judgment, the same shape as the design's own NAME. Reusing the design-name-
-- override idiom is "reuse, don't reinvent" pointed at the closer-fitting precedent: no new table,
-- no new loader, no new RLS/cache surface — colocated on the SAME row as the family-level
-- audience_lean (029) it falls back to, so "audience" stays ONE home on this table, not two.
--
-- PRECEDENCE (read by listingPipeline.ts's per-design resolution — audienceAssignment.ts's
-- resolveDesignAudienceLean, NOT a new predicate: it feeds the SAME buildPhraseTruthCtx / the SAME
-- cross-gender veto every other lean already drives):
--   1. audience_lean_by_design[designKey]   (this column)     -> source 'design-assignment'
--   2. audience_lean                        (migration 029)   -> source 'family-default'
-- An unassigned design inherits today's family value automatically — NULL/absent key = inherit, so
-- nothing changes for any family until the PO assigns a design an audience of its own.

ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS audience_lean_by_design jsonb;

COMMENT ON COLUMN listing_seo_scores.audience_lean_by_design IS
  'PER-DESIGN seller-declared audience lean for multi-design families: {"<designKey>": "male"|"female"|"lean_male"|"lean_female"|"unisex"}. Same designKey per_child_titles[]/design_name_overrides/theme_fit_by_design use. Precedence (audienceAssignment.ts): this map -> the family audience_lean (029) -> null. PO-editable via /api/fba/audience-lean, no deploy. NULL/absent key for a design = inherit the family value (safety property: nothing changes until the PO assigns).';

NOTIFY pgrst, 'reload schema';
