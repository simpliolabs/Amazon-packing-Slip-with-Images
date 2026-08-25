# Session status — 2026-08-24 (title subsystem) — RESUME HERE

**Cooldown: weekly credits near depletion. Resume tomorrow.** Live is on the REVERT (`5eca46b`). Nothing pending on Amazon; reconcile stays `shadow` throughout.

## Live state right now

- `main` @ **`5eca46b`** = revert of #646. Deployed and confirmed live.
- **B0DSCDZC6K** (6-design sweatshirt/hoodie, `lean_male`): recovered parent = `THE CEO Motivational Entrepreneur | Business B*tch Sweatshirt for Men` (69c). KNOWN-BAD (sibling name present) but usable — this is the pre-#646 state the PO originally complained about. Children 73/72/69/73/58/65.
- **B0DP5H8QBT** (12× Gildan 64000B kids tee, `unisex`): PO LOCKED a clean gold on 2026-08-24 — `THE CEO Don't Quit Kids Tee Shirt | Motivational T-Shirt for Children` (69c, `title_source=manual`, `locked_title_truth.violations=[]`). This is a truth-clean gold and now seeds the corpus (account-wide).

## Shipped live today (all title subsystem)

#638 locked-title truth warning · #639 blank cache-bust · #640 settle path (one predicate) · #641 hold-must-not-keep-a-lie · #642 kids-audience reaches GENERATION · #643 assert kids identity + collapse redundant garment nouns · #644 dominant garment + cross-pipe dedupe · **#646 admission-is-verification → MERGED, DEPLOYED, REVERTED** (29-char parent collapse).

## IN FLIGHT (started before cooldown — may have completed)

**Floor fix** — worktree `C:\Users\Admin\AppData\Local\Temp\fba-wt-floor`, branch `fix/title-whole-name-subtraction-and-floor`, off `5eca46b`. Three changes: (1) whole-NAME subtraction (not token) so a family theme sharing a word with a design name keeps protection — this is the #646 collapse cure; (2) a **65-char floor** on `shipped-truthful-under-band` (PO ruling: shippable range 65-75, below 65 hold+keep prior); (3) surface a hold that keeps a LYING prior via the PR-#638 warning pattern; PLUS parent-producer hardening (add the reject scope the broadcast exit lacks). **When it reports: gate on BOTH paths (full regen AND section regen) with a PARENT-LENGTH FLOOR in acceptance, read decisions from Coolify runtime logs, not the stored row.** Do NOT merge without that gate.

## APPROVED FOR TOMORROW — build in a PARALLEL worktree (PO said "Parallel")

**Learning-loop miner** per `handoff/TITLE_LEARNING_LOOP.md`. Mine `listing_change_log` before/after title-edit pairs: `after_value` → gold, `(before→after)` → reject pair (feeds existing `rejectPairBlock`/adversary). Per-design attribution via the `sku` column. **Truth-vet at INGESTION (lock/edit time), not at load** — stamp `is_truth_clean` using the blank ctx already in scope; backfill existing history. PO rulings folded in: golds are LAST-WORD-only (a title left standing); ALL before→after pairs eligible as reject signal. Different files from the floor fix (poGoldCorpus.ts + new miner + migration + route), so parallel worktree is safe.

## Root findings (verified from code, 2026-08-24)

1. **The council/judge are already at parity** — both paths call `runTitleCouncil`; 5 of 7 B0DSCDZC6K titles were written by the SAME producer a single-design listing uses. "Give multi-design the council" is a non-fix.
2. **The learning corpus is one parent-keyed column.** `loadPoGoldTitles` (`poGoldCorpus.ts:453`) reads only `recommended_title WHERE title_source=manual`; never `per_child_titles`. No per-design lock exists (`lock-title/route.ts` is `parent_asin`-only, `sku:null`). → per-design successes are INVISIBLE to learning. This is the literal answer to the PO's "why doesn't the LLM learn".
3. **The parent producer has no correctness gate** — 0 `validateTitle` in `buildNicheParentTitle` (`:7330-7789`) vs 13 in the single-design path; only a length-maximizer retry; broadcast ship-door exit passes NO scope so it protects (not rejects) sibling names. This is the sibling-name defect source.
4. `listing_change_log` holds every before/after edit pair; three files say the miner over it was designed and never built. Nothing in generation reads it.

## PO rulings today (also in memory)

- **Garment truth touches EVERY surface** incl. age/department/target-gender (memory: garment-truth-touches-every-surface).
- **Fable designs+plans, Sonnet implements** (already standing).
- **65-char floor** on shipped-truthful-under-band.
- **Learning loop = mine edit history** (chose option 2 over "just widen the locked corpus").
- **#646 lesson:** a reviewer finding that NAMES A MECHANISM is not cosmetic because it's labelled Minor; any vocabulary-REMOVING change needs a LENGTH FLOOR in acceptance; a refutation is scoped only to the path it tested. (memory: minor-findings-are-not-minor-when-they-name-the-collapse)

## Still open (pre-existing, not title)

- **Age producer** — blank → `department`/`target_gender`/`age_range_description`; the ONLY route to correct catalog data on kids listings. Currently the lean map emits only Mens/Womens/Unisex and age is LLM-guessed from existing copy then frozen by stickyDetails. My recommended priority after titles stabilise.
- **Jungle Scout harvest** for pool-starved families (B0DSCDZC6K ~5 candidates/design) — credit-gated, switch DISARMED. Titles are honest-but-thin until the pool grows.

## Coverage audit (2026-08-23, 6 confirmed gaps, 24 unverified)

Item Highlights is the ONLY surface that enforces garment truth unfiltered — it's the template. Bullets/description/backend/detail-attrs/universe all have gaps. See the garment-truth-coverage workflow report. Deferred behind the title work.
MDEOF
