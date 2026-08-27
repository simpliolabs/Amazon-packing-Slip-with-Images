-- 071_blank_specs_age_class.sql
-- 070_audience_lean_by_design.sql is the highest applied. Apply BY HAND in the Supabase SQL editor.
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + a scoped UPDATE guarded by `age_class IS NULL`, so a
-- re-run is a no-op. Fail-open is unaffected either way: rowToSpec (blankSpecs.ts) silently drops
-- an unknown/absent column, so code deployed before this runs behaves byte-identically.
--
-- PO ruling 2026-08-27 (adversarial audit, 12 verified findings — see handoff): "the garment should
-- touch everything from title to Product Detail values" (PO 2026-08-22) reached title/bullets/
-- description/backend but NOT the Amazon Product Detail attributes. `age_range_description` has
-- ZERO deterministic producers — its only source is an LLM guessing from the listing's OWN EXISTING
-- COPY (never blank truth) — and `department`/`target_gender`'s one deterministic producer
-- (listingPipeline.ts's per-lean 3-way map) is the FAMILY GENDER SELECTOR, whose vocabulary
-- (male|female|lean_male|lean_female|unisex) structurally cannot say "kids": B0DP5H8QBT (12x Gildan
-- 64000B YOUTH tees) ships Department="Unisex" — a LEGAL enum member, so the push reports SUCCESS
-- while the listing is filed as adult.
--
-- WHY A NEW COLUMN, NOT A `garment_family` MEMBER (058): that enum is SILHOUETTE-shaped (tee /
-- long_sleeve_tee / sweatshirt / hoodie / kids_tee) — its ONE kids value doubles as "short-sleeve
-- tee", a kids HOODIE has no home in it, and rowToSpec SILENTLY DROPS an unknown family (058 has no
-- CHECK constraint) leaving garmentFamily undefined, which is worse than wrong. age_class is
-- ORTHOGONAL to silhouette: any garment_family value may pair with any age_class.
--
-- PO RULING (2026-08-27, this task): blank-derived garment truth MAY re-propose over a
-- PO-accepted PUSHED value — but ONLY when the blank itself STATES the fact. A guess never
-- overrides the PO; a selector-derived value (the audience-lean map) never overrides the PO either.
-- This column is the ONE stated-fact source resolveGarmentAudience (contentTruth.ts) is allowed to
-- trust for the 'blank-column' precedence rule.
--
-- NO DEFAULT, ON PURPOSE. 'adult' as a DEFAULT would be a default that is ALSO a legal enum value —
-- exactly the class of silent-failure bug this task exists to cure (Department="Unisex" reporting
-- SUCCESS while wrong). NULL = "this blank does not state its age" and must stay that way for the
-- ~600 families this migration does NOT touch: seeding only 64000B and leaving every adult family
-- UNSTATED is what makes this a no-op for them (resolveGarmentAudience never infers 'adult' from
-- silhouette — see contentTruth.ts's precedence rules).

ALTER TABLE blank_specs
  ADD COLUMN IF NOT EXISTS age_class text;

-- Idempotent CHECK add (repo idiom — see 049/019): plain `ADD CONSTRAINT IF NOT EXISTS` is not
-- valid Postgres syntax for constraints (only for columns/indexes), so guard with duplicate_object.
DO $$ BEGIN
  ALTER TABLE blank_specs ADD CONSTRAINT blank_specs_age_class_check
    CHECK (age_class IS NULL OR age_class IN ('newborn', 'infant', 'toddler', 'kids', 'adult'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN blank_specs.age_class IS
  'newborn | infant | toddler | kids | adult, orthogonal to garment_family (058)''s silhouette enum. NULL = the blank does not state its age (the ~600-family default — NEVER "adult"; a default that is also a legal value would hide total failure). Stated-fact precedence: resolveGarmentAudience (contentTruth.ts) trusts THIS column outright when set (source ''blank-column''); falls back to garment_family===''kids_tee'' (source ''garment-family''); every other family resolves null, never ''adult''. PO-EDITABLE via /api/fba/blanks, no deploy (reader caches 5 min).';

-- Seed ONLY the one live-verified kids blank (B0DP5H8QBT, 12 Gildan 64000B youth-tee children —
-- migration 058 already stamped this row garment_family=''kids_tee''; this states the SAME fact on
-- the orthogonal column so resolveGarmentAudience's rule 1 (blank-column) fires directly instead of
-- falling through to rule 2 (garment-family)). Guarded by `age_class IS NULL` — idempotent, and
-- never clobbers a PO edit to this row.
UPDATE blank_specs SET age_class = 'kids'
 WHERE style_code = '64000B' AND age_class IS NULL;

-- NO adult backfill. Every other row (~600 families) is left UNSTATED on purpose — see header.

NOTIFY pgrst, 'reload schema';
