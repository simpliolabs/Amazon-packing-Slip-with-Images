# Title learning loop — mine the seller's edit history

**PO decision 2026-08-24 (option "Mine your edit history").** The council/judge are already at parity across single- and multi-design; the failure is the LEARNING channel. Two verified facts:

1. The gold corpus (`poGoldCorpus.loadPoGoldTitles`, `poGoldCorpus.ts:453`) reads ONE column — `recommended_title WHERE title_source='manual'`, keyed on `parent_asin`. Per-design titles (`per_child_titles`) are never read; there is no per-design lock. So on a 6-design family, **at most 1 of 7 real titles can ever become gold, and 0 of the 6 per-design ones can.**
2. Every edit already writes a `before_value`/`after_value` pair to `listing_change_log` (migration 037). Three files say a miner over it was designed and never built (`poGoldCorpus.ts:7-10`, `title-golds/route.ts:11`, `titleIdiomExpander.ts:19`). Nothing in generation reads it.

## 1. What the miner does

Read `listing_change_log` WHERE `field IN ('title','title (locked)')` AND `action='edit'` AND `source='manual_edit'` AND `after_value` is non-empty. For each row:

- `after_value` = the title the SELLER chose → a **gold candidate**.
- `(before_value → after_value)` where `before_value` is non-empty and differs → a **reject pair** (the AI wrote X, the seller changed it to Y). Feeds the EXISTING `rejectPairBlock` / adversary machinery — no new consumer.
- `sku` non-null → attribute the gold to that **design** (finally lets per-design successes into the corpus). `sku` null → family/parent gold.

Dedup: newest `changed_at` wins per (parent_asin, sku, normalized-title). Cap by `GOLD_BRIEF_LIMIT`.

## 2. The truth filter — WHERE it runs is the load-bearing decision

A seller-typed title can be wrong too (the last locked title on B0DP5H8QBT called a kids tee a "Crewneck"). A lying title must NOT become a pattern the council imitates. So every mined gold passes `verdictForAssembledTitle` before entering the corpus.

**Decision: vet at INGESTION, not at load** (standing lesson: filter at the write boundary, never the read boundary — [[research-vs-publish-boundary]], [[in-band-fast-path-skipped-verification]]).

- When a title is locked/edited, the pipeline ALREADY has the family's resolved blank ctx (`broadcastTruthCtx`/`buildPhraseTruthCtx`). Compute the verdict THEN and stamp a boolean on the log row (or a small `title_golds` table): `is_truth_clean`.
- `loadPoGoldTitles` reads only pre-vetted rows — cheap, no per-family blank resolution at load time, no N blank loads across 400 rows.
- One-time backfill vets existing history (a migration/script), so the corpus is populated on day one, not only from future edits.

Rejected alternative: vet at load time. It would resolve every family's blank on every corpus load — heavy, and it repeats the exact "expensive work at the read boundary" anti-pattern this repo keeps regretting.

## 3. What this is NOT

- NOT a new definition of truth — it calls `verdictForAssembledTitle`, the one predicate.
- NOT a new corpus consumer — golds feed the existing `poGolds`/`measureGoldShape`; rejects feed the existing `rejectPairBlock`.
- NOT auto-push — it changes what the council LEARNS, never what ships. Reconcile stays `shadow`.
- NOT a quality-by-imitation risk left open: a mined gold must be truth-clean AND shape-admissible (`measureGoldShape`/`classifyTail` already gate shape), so a trivial or malformed edit cannot become a pattern.

## 4. Ordered plan (each step verified; none pushes to Amazon)

| # | Step | Verify |
|---|---|---|
| 1 | `title_golds` table (or `is_truth_clean` column on the log) + migration | `SELECT` shows the column/table |
| 2 | Ingestion-time vet: stamp `is_truth_clean` when a title is locked/edited, using the blank ctx already in scope | a fresh lock on a clean title stamps true; on a lying one stamps false |
| 3 | Backfill script vets existing history | count of truth-clean golds > 0; the B0DP5H8QBT clean lock is present, the old lying one is not |
| 4 | `loadPoGoldTitles` reads mined golds (both scopes) + emits reject pairs | corpus for B0DSCDZC6K includes per-design golds; adversary block carries real reject pairs |
| 5 | Live regen on B0DSCDZC6K + a single-design family; confirm the mined shape reaches the council | `KW_THEME_CARD`/council logs show the mined golds; titles improve or hold honestly |

## 5. Open sub-decision for the PO

An edit is not always an endorsement — sometimes a seller types a placeholder, or edits twice. **Should a mined gold require the title to have been the seller's LAST word on that family (no subsequent edit), or is any manual edit eligible?** Recommendation: last-word-only for golds (a title the seller left standing), but ALL before→after pairs eligible as reject signal (even a superseded edit still teaches what the AI got wrong). Defer to PO.
