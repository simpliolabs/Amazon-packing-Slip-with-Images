-- Migration 065: Title learning-loop truth stamp.
-- ADDITIVE ONLY (idempotent) — safe to re-run.
--
-- WHY. poGoldCorpus.ts's `loadPoGoldTitles` (and the multi-design council's reject-pair few-shots)
-- are meant to grow from the seller's own real corrections — listing_change_log (037) already stores
-- every locked/edited title as a before/after pair, keyed on parent_asin and a nullable sku, but
-- nothing has ever mined it (three files said so: poGoldCorpus.ts:7-10, title-golds/route.ts:11,
-- titleIdiomExpander.ts:19). The miner that closes this gap must never trust a seller-typed title
-- blindly — a locked title can itself lie (a real case: a kids-tee family locked as "... Crewneck for
-- Kids & Adults" — Crewneck is a sweatshirt noun, not a tee noun). Truth-vetting a title requires
-- resolving the family's blank (garment_family, spec, audience) via resolveFamilyBlank — real DB
-- work — so it is done ONCE, at INGESTION time (when the title is locked/edited, or by the one-time
-- backfill below), and stamped here. `loadPoGoldTitles`-adjacent readers then filter on the stamped
-- column instead of re-resolving every family's blank on every read (the "expensive work at the read
-- boundary" anti-pattern this repo keeps regretting — see truth-and-band-are-one-contract memory).
--
-- WHY A COLUMN ON listing_change_log, NOT A NEW TABLE: this table is already the single history of
-- "what a seller locked/edited and when" (037's own doc). Stamping the verdict onto the row it
-- describes keeps ONE history that cannot drift from a second one describing the same events.

ALTER TABLE listing_change_log
  ADD COLUMN IF NOT EXISTS title_truth_ok     boolean,
  ADD COLUMN IF NOT EXISTS title_truth_reason text;

COMMENT ON COLUMN listing_change_log.title_truth_ok IS
  'Set only on title-lock edit rows (field=''title (locked)'', action=''edit'', source=''manual_edit''): '
  'the result of verdictForAssembledTitle(after_value, familyTruthCtx) computed AT INGESTION (lock-title '
  'route, or the one-time backfill in /api/fba/admin/backfill-title-truth). NULL = not yet vetted (a '
  'pre-migration row, a non-title row, or a row the backfill has not reached). A miner reading this '
  'table for gold titles (poGoldCorpus loadPoGoldTitles / titleLearningMiner.ts) must treat NULL as '
  '"not eligible" and never re-derive the verdict at read time.';

COMMENT ON COLUMN listing_change_log.title_truth_reason IS
  'The AssembledTitleVerdict.reason (titleBand.ts) when title_truth_ok=false, e.g. '
  '''untrue-or-foreign-segment-present'' or ''missing-youth-marker''. NULL when true or not vetted.';

-- Reload PostgREST's schema cache so the new columns are queryable immediately (027/034/035/037 precedent).
NOTIFY pgrst, 'reload schema';
